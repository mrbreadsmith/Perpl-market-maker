import 'dotenv/config';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket as NodeWebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERPL_API_URL = process.env.PERPL_API_URL || 'https://app.perpl.xyz/api';
const PERPL_WS_URL = process.env.PERPL_WS_URL || PERPL_API_URL.replace(/^http/, 'ws').replace(/\/api$/, '');
const PERPL_CHAIN_ID = Number(process.env.PERPL_CHAIN_ID || 143);
const PORT = Number(process.env.PORT || 3000);
const WHITELIST_PATH = path.join(__dirname, 'whitelist.json');

const app = express();
app.use(express.json());

// index.html lives right next to server.js now — no public/ subfolder to
// get confused about. Serving this one specific file by name (not a
// whole directory via express.static) also avoids accidentally exposing
// server.js/whitelist.json/etc. over HTTP.
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Same "serve this one specific file by name" approach as above — used by
// the animated background/avatar art, not a blanket static directory.
app.get('/pfp.jpg', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'pfp.jpg'));
});

// ── Whitelist ────────────────────────────────────────────────────────
function loadWhitelist() {
  try {
    const raw = fs.readFileSync(WHITELIST_PATH, 'utf8');
    return new Set(JSON.parse(raw).map((a) => String(a).toLowerCase()));
  } catch {
    return new Set();
  }
}
function isWhitelisted(address) {
  if (!address || typeof address !== 'string') return false;
  return loadWhitelist().has(address.toLowerCase());
}

app.get('/api/check-whitelist', (req, res) => {
  const address = String(req.query.address || '').toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) return res.status(400).json({ error: 'invalid address' });
  res.json({ whitelisted: isWhitelisted(address) });
});

app.get('/api/config', (req, res) => {
  res.json({ perplApiUrl: PERPL_API_URL, chainId: PERPL_CHAIN_ID });
});

// ── Auth proxy (fallback for auth/payload — confirmed working direct
// from the browser in testing, kept here as a safety net only) ──────
app.post('/api/perpl-proxy/auth/payload', async (req, res) => {
  try {
    const r = await fetch(`${PERPL_API_URL}/v1/auth/payload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const body = await r.text();
    res.status(r.status).type('application/json').send(body);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/perpl-proxy/context', async (req, res) => {
  try {
    const r = await fetch(`${PERPL_API_URL}/v1/pub/context`);
    const body = await r.text();
    res.status(r.status).type('application/json').send(body);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Session-based auth completion ───────────────────────────────────
// The browser does everything up through signing the SIWE message —
// the private key never leaves it. But the actual auth/connect call now
// happens HERE, server-side, for two reasons: (1) it's the exact same
// call the reference Node bot has made reliably for weeks, so it's
// proven infrastructure rather than an unknown browser-CORS situation,
// and (2) the resulting session cookie needs to live somewhere the
// WebSocket relay below can use it when it opens its own connection to
// Perpl's trading socket on this session's behalf.
//
// What this does NOT do: touch a private key, sign anything, or gain
// any ability to move funds. The signature submitted here is a
// completed, one-time proof of identity for this login — not a
// capability that can be replayed to do anything else.
const sessions = new Map(); // sessionId -> { address, cookie, nonce, createdAt }
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — generous for a dev/test window

function pruneSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

app.post('/api/perpl-session/complete-auth', async (req, res) => {
  try {
    const { address, message, nonce, issued_at, mac, signature } = req.body || {};
    if (!isWhitelisted(address)) return res.status(403).json({ error: 'wallet not whitelisted' });
    if (!message || !signature) return res.status(400).json({ error: 'missing message or signature' });

    const connectRes = await fetch(`${PERPL_API_URL}/v1/auth/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain_id: PERPL_CHAIN_ID, address, message, nonce, issued_at, mac, signature }),
    });

    if (!connectRes.ok) {
      const body = await connectRes.text().catch(() => '');
      return res.status(connectRes.status).json({ error: `Perpl auth/connect failed: ${connectRes.status} ${body}` });
    }

    const cookie = typeof connectRes.headers.getSetCookie === 'function'
      ? connectRes.headers.getSetCookie().join('; ')
      : connectRes.headers.get('set-cookie');
    const authResult = await connectRes.json();

    pruneSessions();
    const sessionId = crypto.randomBytes(16).toString('hex');
    sessions.set(sessionId, { address: address.toLowerCase(), cookie, nonce: authResult.nonce, createdAt: Date.now() });

    res.json({ sessionId, nonce: authResult.nonce });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Lifetime trading volume (all pairs, all time) for the "Total Volume"
// card. Requires the session cookie the same way the trading WebSocket
// does — the browser never had this to begin with, so this has to be a
// server-side call, not something the frontend could do directly even if
// CORS allowed it. Bounded to a reasonable number of pages so a single
// request can't hang indefinitely on a very active account; `capped: true`
// tells the frontend there's more history than what got summed.
app.get('/api/account-volume', async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) return res.status(403).json({ error: 'invalid session' });

  try {
    const ctxRes = await fetch(`${PERPL_API_URL}/v1/pub/context`);
    if (!ctxRes.ok) throw new Error(`context fetch failed: ${ctxRes.status}`);
    const ctx = await ctxRes.json();
    const marketMap = new Map(ctx.markets.map((m) => [m.id, m]));

    const authHeaders = {
      'X-Auth-Nonce': session.nonce,
      ...(session.cookie ? { Cookie: session.cookie } : {}),
    };

    let totalUsd = 0;
    let page;
    let pages = 0;
    const MAX_PAGES = 50; // ~5000 fills at count=100 — bounded so this request can't hang forever

    do {
      const url = new URL(`${PERPL_API_URL}/v1/trading/fills`);
      if (page) url.searchParams.set('page', page);
      url.searchParams.set('count', '100');
      const r = await fetch(url, { headers: authHeaders });
      if (!r.ok) break;
      const data = await r.json();
      for (const f of data.d || []) {
        const m = marketMap.get(f.mkt);
        if (!m) continue;
        const price = (f.p ?? 0) / 10 ** m.config.price_decimals;
        const size = f.s / 10 ** m.config.size_decimals;
        totalUsd += price * size;
      }
      page = data.np;
      pages += 1;
    } while (page && pages < MAX_PAGES);

    res.json({ totalVolumeUsd: totalUsd, capped: Boolean(page) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── WebSocket relay ──────────────────────────────────────────────────
// Browser <-> this server <-> Perpl. The browser only ever talks to
// this server (same-origin, always reachable, no CORS/origin questions
// possible); this server does the actual Perpl connection using the
// exact same approach the reference Node bot already uses reliably.
// Pure message forwarding both directions — this process never
// interprets, modifies, or acts on the trading messages itself.
function relay(browserWs, perplWsUrl, extraHeaders) {
  const perplWs = new NodeWebSocket(perplWsUrl, extraHeaders ? { headers: extraHeaders } : undefined);
  const queued = [];
  let perplOpen = false;

  perplWs.on('open', () => {
    perplOpen = true;
    for (const msg of queued) perplWs.send(msg);
    queued.length = 0;
  });
  perplWs.on('message', (data) => {
    if (browserWs.readyState === browserWs.OPEN) browserWs.send(data.toString());
  });
  perplWs.on('close', () => { if (browserWs.readyState === browserWs.OPEN) browserWs.close(); });
  perplWs.on('error', (err) => {
    console.error('relay: perpl connection error:', err.message);
    if (browserWs.readyState === browserWs.OPEN) browserWs.close();
  });

  browserWs.on('message', (data) => {
    const msg = data.toString();
    if (perplOpen) perplWs.send(msg); else queued.push(msg);
  });
  browserWs.on('close', () => perplWs.close());
  browserWs.on('error', () => perplWs.close());
}

const server = http.createServer(app);
const wssMarket = new WebSocketServer({ noServer: true });
const wssTrading = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host}`); }
  catch { socket.destroy(); return; }

  if (url.pathname === '/relay/market-data') {
    wssMarket.handleUpgrade(req, socket, head, (browserWs) => {
      relay(browserWs, `${PERPL_WS_URL}/ws/v1/market-data`);
    });
    return;
  }

  if (url.pathname === '/relay/trading') {
    const sessionId = url.searchParams.get('sessionId');
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session) { socket.destroy(); return; }
    wssTrading.handleUpgrade(req, socket, head, (browserWs) => {
      relay(browserWs, `${PERPL_WS_URL}/ws/v1/trading`, session.cookie ? { Cookie: session.cookie } : undefined);
    });
    return;
  }

  socket.destroy();
});

server.listen(PORT, () => {
  console.log(`Perpl farm site running: http://localhost:${PORT}`);
  console.log(`Whitelist: ${loadWhitelist().size} address(es) currently approved`);
});
