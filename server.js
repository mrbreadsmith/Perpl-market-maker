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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// This server's outbound IP is shared across everyone using the site, so
// it's more exposed to Perpl/Cloudflare rate limits than a single
// person's own bot would be. Respects Retry-After if sent, otherwise
// backs off with a capped exponential delay, rather than surfacing the
// failure straight to whoever's waiting on it.
async function fetchWithRateLimitRetry(url, options, maxRetries = 4, capMs = 8000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;

    const retryAfterHeader = res.headers.get('retry-after');
    let waitMs = null;
    if (retryAfterHeader) {
      const asSeconds = Number(retryAfterHeader);
      waitMs = Number.isFinite(asSeconds) ? asSeconds * 1000 : Math.max(0, new Date(retryAfterHeader).getTime() - Date.now());
    }
    if (!waitMs || waitMs <= 0) waitMs = Math.min(capMs, 1000 * 2 ** attempt);

    if (attempt === maxRetries) return res;
    console.log(`rate limited (429) on ${url} — waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`);
    await sleep(waitMs);
  }
}

// index.html lives right next to server.js now — no public/ subfolder to
// get confused about. Serving this one specific file by name (not a
// whole directory via express.static) also avoids accidentally exposing
// server.js/whitelist.json/etc. over HTTP.
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'index.html'));
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
    const r = await fetchWithRateLimitRetry(`${PERPL_API_URL}/v1/auth/payload`, {
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
    const r = await fetchWithRateLimitRetry(`${PERPL_API_URL}/v1/pub/context`);
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

    // This is a one-time call per login, not a per-cycle refresh - worth
    // waiting longer for. Multiple different users' auth attempts all
    // come from this same server's IP, so a burst of logins can trip
    // Cloudflare's own rate-limiting in front of Perpl (separate from
    // Perpl's own API limits) - that can take longer than a few seconds
    // to clear, so this gets more attempts and a longer cap than the
    // frequent, per-cycle calls elsewhere.
    const connectRes = await fetchWithRateLimitRetry(`${PERPL_API_URL}/v1/auth/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain_id: PERPL_CHAIN_ID, address, message, nonce, issued_at, mac, signature }),
    }, 7, 15000);

    if (!connectRes.ok) {
      const body = await connectRes.text().catch(() => '');
      // Cloudflare serves its own HTML block page in front of Perpl,
      // separate from Perpl's own JSON error responses - show something
      // a person can actually read instead of a wall of raw HTML.
      const isCloudflareBlock = /cloudflare/i.test(body) && /<!doctype html>/i.test(body);
      const friendlyMessage = isCloudflareBlock
        ? 'Perpl is temporarily rate-limiting connections (likely from several people connecting close together). This usually clears within a minute or two - please try again shortly.'
        : `Perpl auth/connect failed: ${connectRes.status} ${body}`;
      return res.status(connectRes.status).json({ error: friendlyMessage });
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
    const ctxRes = await fetchWithRateLimitRetry(`${PERPL_API_URL}/v1/pub/context`);
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
      const r = await fetchWithRateLimitRetry(url, { headers: authHeaders });
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
      // A tight loop of up to 50 requests with zero delay between them,
      // on every dashboard load across everyone using the site, is a
      // real contributor to tripping rate limits in the first place -
      // this small pacing costs a few seconds on a long history but
      // meaningfully reduces how bursty this endpoint looks from
      // Cloudflare's side.
      if (page && pages < MAX_PAGES) await sleep(150);
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
//
// The WS handshake itself can get rate-limited (429) the same way REST
// calls can, but it's a completely different code path - fetchWithRateLimitRetry
// doesn't apply here at all, since this isn't a fetch() call. Confirmed
// this happens for real (not hypothetical) - a 429 during the upgrade
// request surfaces as a ws error event, and previously that just closed
// the browser's connection immediately with no recovery attempt.
function relay(browserWs, perplWsUrl, extraHeaders) {
  const queued = []; // shared across retries, so a message the browser
  // sends while we're mid-retry isn't lost when a fresh attempt starts
  let perplWs = null;
  let perplOpen = false;

  function attemptConnect(retriesLeft) {
    perplOpen = false;
    const ws = new NodeWebSocket(perplWsUrl, extraHeaders ? { headers: extraHeaders } : undefined);
    perplWs = ws;
    let hasOpened = false;

    ws.on('open', () => {
      hasOpened = true;
      perplOpen = true;
      for (const msg of queued) ws.send(msg);
      queued.length = 0;
    });
    ws.on('message', (data) => {
      if (browserWs.readyState === browserWs.OPEN) browserWs.send(data.toString());
    });
    ws.on('close', () => { if (browserWs.readyState === browserWs.OPEN) browserWs.close(); });
    ws.on('error', (err) => {
      const is429 = /429/.test(err.message || '');
      if (!hasOpened && is429 && retriesLeft > 0) {
        const waitMs = Math.min(15000, 1000 * 2 ** (5 - retriesLeft));
        console.log(`relay: perpl WS 429 on connect — retrying in ${waitMs}ms (${retriesLeft} retries left)`);
        setTimeout(() => {
          if (browserWs.readyState === browserWs.OPEN) attemptConnect(retriesLeft - 1);
        }, waitMs);
        return; // don't close the browser's connection - we're retrying
      }
      console.error('relay: perpl connection error:', err.message);
      if (browserWs.readyState === browserWs.OPEN) browserWs.close();
    });
  }

  attemptConnect(5);

  browserWs.on('message', (data) => {
    const msg = data.toString();
    if (perplOpen) perplWs.send(msg); else queued.push(msg);
  });
  browserWs.on('close', () => perplWs?.close());
  browserWs.on('error', () => perplWs?.close());
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

// Previously only pruned lazily on a new login - on a long-running
// server with sparse logins, expired sessions could sit in memory
// longer than necessary. Each one is tiny, so this is a minor
// robustness improvement rather than a fix for an actual problem seen.
setInterval(pruneSessions, 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Perpl farm site running: http://localhost:${PORT}`);
  console.log(`Whitelist: ${loadWhitelist().size} address(es) currently approved`);
});
