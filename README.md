# Perpl Market Maker — Website

People connect their own wallet, get checked against your whitelist, authenticate
with Perpl, and run the market maker themselves — entirely in their own browser
tab. Nothing here ever touches funds or private keys; every signature happens in
the visitor's own wallet extension, and only once (SIWE login) — placing and
cancelling orders afterward is just authenticated messages over an already-signed-in
WebSocket connection, so it never prompts the wallet again mid-session.

## What's included now

- Wallet connect → whitelist check → Perpl SIWE auth (confirmed working live,
  direct browser-to-Perpl calls, no CORS issues found)
- The actual trading core, ported from the reference Node bot with its
  hard-won safety fixes intact and regression-tested:
  - Two-sided quoting with the minimum-tick-size floor and cross-side guard
    (prevents the bid/ask crossing bug we hit on low-priced pairs)
  - Order tracking with request-ID matching and a staleness timeout (a
    lost confirmation doesn't block that side forever)
  - Instant-close: the moment a fill opens a position, it's flattened via
    an aggressive order priced against the real order book, following
    Perpl's documented retry protocol (no duplicate in-flight close
    requests racing each other)
  - Live order book maintained from the exchange's snapshot + diff stream
  - Reconnect logic + a staleness watchdog on both WebSocket connections
- A live status view: balance, position, mid price, resting bid/ask,
  recent fills, pause/resume, stop, and an on-page log

## What's not in yet (next pass)

- Lifetime PnL / account-wide volume / points / CPM — the fuller stats
  the Node bot's dashboard has
- Balance-over-time chart
- Per-pair presets and a proper settings side panel (currently: plain
  input fields set once before starting)
- Auto-pause on volume cap, auto-restart on no-trades

## Setup

```bash
npm install
cp .env.example .env
node server.js
```

Open `http://localhost:3000`.

## Managing the whitelist

Edit `whitelist.json` directly — plain JSON array, checked case-insensitively,
reloaded fresh on every check (no restart needed after an edit):

```json
[
  "0x29f8C7d2FDCeB4E93eD3Ca2fb27A16731E9B54b9",
  "0xAnotherApprovedWallet..."
]
```

## Confirmed: direct-to-Perpl calls work, no proxy needed

Tested live: the browser calls Perpl's auth endpoints directly
(`credentials: 'include'`), no CORS blocking, and the browser's own cookie
jar for `app.perpl.xyz` picks up the session cookie exactly like Perpl's own
web app does. The `/api/perpl-proxy/*` fallback in `server.js` is still there
as a safety net, but isn't needed in the observed setup.

## Architecture notes

- **All files live in one flat folder now** — `index.html` sits right next
  to `server.js`, no `public/` subfolder. (This used to be split out, but
  it kept landing in the wrong place after downloads — one folder removes
  that class of mistake entirely.)
- `server.js` — Express + a `ws`-based WebSocket relay. Serves `index.html`
  by name (not a blanket static directory, so `server.js`/`whitelist.json`
  aren't accidentally exposed over HTTP), checks the whitelist, completes
  Perpl SIWE auth server-side, and relays both WebSocket connections
  (market-data and trading) between the browser and Perpl.
- `index.html` — the entire frontend and trading engine, self-contained.
  Uses `window.ethereum` (MetaMask and compatible injected wallets) for
  wallet connect/signing. WalletConnect (for mobile wallets without a
  browser extension) isn't wired up yet.
- **Why there's a relay instead of the browser talking to Perpl directly**:
  direct browser WebSocket connections to Perpl were closing immediately
  (code 1006, no response at all — confirmed via DevTools, not just
  assumed) on both the market-data and trading sockets. Rather than keep
  guessing at the exact cause, the browser now only ever talks to this
  server (same-origin, always reachable), and this server makes the actual
  Perpl connection the same way the reference Node bot always has.
- **What this means for custody**: still nothing here touches a private
  key or can move funds. What's different from the original design is
  that this server now briefly holds a *session* (the post-login cookie)
  for as long as your bot is running — comparable to any website holding
  your login session, not comparable to holding your wallet.
- Auth session: the session ID and Perpl auth nonce live in
  `sessionStorage` — cleared when the tab closes.
- If you navigate away or close the tab while holding a position or
  resting orders, the browser warns before letting you leave
  (`beforeunload`) — but there's no server-side supervisor watching over
  this the way `run.bat` does for the Node bot, so a genuinely closed tab
  means the bot stops running, full stop.
