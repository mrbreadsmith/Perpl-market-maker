# Perpl Market Maker

A non-custodial, whitelist-gated website where approved wallets connect and run a two-sided market-making bot on [Perpl](https://app.perpl.xyz) — entirely from their own browser. Nobody's private key or funds ever touch the server; every trade is signed by the connected wallet itself.

Live at: **perpl.breadsbakery.xyz**

---

## How it works, at a glance

Perpl's actual trading (placing orders, cancelling, receiving fills) happens over an **authenticated WebSocket** — not a normal REST API. That's the key fact the whole architecture is built around:

1. **Connect & sign in** — you connect an EVM wallet (MetaMask, etc.) and sign one SIWE (Sign-In With Ethereum) message. That's the *only* signature the whole session ever needs.
2. **Session lives on the server** — the resulting Perpl session cookie is held server-side (never in your browser, never exposed to you or anyone else), because the trading WebSocket specifically requires that cookie to authenticate, and browsers can't attach it to a WebSocket connection they didn't originate the login on.
3. **The server relays two WebSockets** for you: one for public market data, one for your authenticated trading session. Your browser talks only to this server (same-origin, always reachable); this server talks to Perpl using the exact same connection logic already proven reliable in the original desktop version of this bot.
4. **Your browser runs the actual trading loop** — computing quotes, deciding when to place/cancel orders, reacting to fills. The server is a dumb pipe for the WebSocket traffic; it never inspects or acts on trading messages itself.

This means: no one — including whoever operates this server — can access your funds or act on your behalf beyond relaying the messages your own browser already decided to send.

---

## The trading strategy

Two-sided market making, per selected pair:

- Posts a bid and an ask around the current mid price, sized and spaced by your settings
- **Tick-size floor** — the half-spread is never allowed to collapse below one tick, preventing a degenerate order that's effectively at the same price as its own opposite side
- **Cross-side guard** — before posting either side, checks it won't cross the *other* resting order; prevents an inverted book state (bid priced above ask) that showed up as a real bug during development
- **Instant-close on fill** — the moment either side fills and opens a position, the bot immediately submits an aggressive IOC (immediate-or-cancel) order to flatten it, rather than waiting for the position to sit exposed
- **Retry protocol** — close attempts track their own request ID and expiry block; a new close is only issued after an explicit failure or expiry, preventing duplicate in-flight requests from racing each other (this was the fix for a real "Incorrect Side for Reduce-Only" bug)
- **Per-pair presets** — selecting a pair (BTC, MON, ETH, SOL, HYPE, ZEC) auto-fills spread/requote/leverage/refresh with tuned defaults where one exists; order size always stays independently set
- **Requote suppression** — on each fixed-interval refresh, if price hasn't moved at least the configured requote threshold since the last quote, that cycle is skipped rather than re-posting an effectively-identical order — avoids unnecessary order churn when the market is quiet
- **Auto-restart on idle** — if no fill happens within the configured idle window, the bot does a soft restart (cancels resting orders, reconnects fresh) rather than sitting silently stalled

---

## Dashboard

Once connected and whitelisted, the live dashboard shows:

- **Starting Balance / Current Balance / Since Start** — real account balance, not an internally-tracked running total (an earlier version tracked PnL internally and it drifted from the real balance; this was corrected to always read the ground-truth balance)
- **Position, Mid Price, Bid, Ask**
- **CPM (Cost per $1M)** — `(Since Start ÷ Total Volume) × 1,000,000`, using the same ground-truth balance delta. Negative = losing money at the current rate, positive = net profit while generating volume
- **Session Volume** — accumulated this run
- **Total Volume** — lifetime, fetched via a paginated background fetch of fill history on startup, added to session volume as it grows
- **Recent Trades** and a live **Log** panel
- **Settings panel** — pair selector (pill buttons), order size, spread, requote, leverage, refresh interval — all adjustable live, no restart needed
- **Pause / Resume / Restart / Stop** controls

---

## Repo layout

Deliberately flat — no `public/` subfolder. This used to be split out, but files kept landing in the wrong place after downloads; one folder removes that entire class of mistake.

```
server.js       Express server: whitelist check, SIWE auth relay, WebSocket relay, rate-limit retry
index.html      Entire frontend + trading engine, self-contained (single file)
whitelist.json  Approved wallet addresses (plain array, case-insensitive)
package.json
.env.example
```

`server.js` serves `index.html` by name (not via a blanket static directory), so `server.js` and `whitelist.json` themselves are never accidentally exposed over HTTP.

---

## Setup

```cmd
npm install
copy .env.example .env
node server.js
```

No private key needed anywhere — this server never signs anything. The only thing in `.env` is the Perpl API URL, chain ID, and port.

To approve a wallet, add its address to `whitelist.json`:

```json
["0xYourWalletAddressHere"]
```

---

## Why the WebSocket relay exists

Early versions tried having the browser connect directly to Perpl's WebSocket endpoints. That failed — the connection closed immediately (code 1006, no response at all) — confirmed via browser DevTools, not just assumed. Rather than keep guessing at the exact cause, the architecture was changed so the browser only ever talks to this server (same-origin, no cross-origin questions possible), and this server makes the actual Perpl connection using the same approach already proven reliable in the original desktop bot.

This does mean the server briefly holds a *session* (the post-login cookie) for as long as your bot runs — comparable to any website holding your login session after you sign in. It is **not** comparable to holding your wallet: your private key never leaves your browser, and what the server holds can prove who you are for this session but can't move funds or be replayed to sign anything else.

Also handles: 429 rate-limit responses from Perpl/Cloudflare are automatically retried with backoff (respecting `Retry-After` when present) rather than surfacing the failure — this server's IP is shared across everyone using the site, so it's more exposed to rate limits than a single person's own bot would be.

---

## Deployment

Deployed on [Render](https://render.com) as a Web Service (not a Static Site — this has a real backend), with `perpl.breadsbakery.xyz` pointed at it via a CNAME record. No environment secrets beyond the defaults already in `.env.example`.

---

## Non-custodial, concretely

- Private key: never leaves your browser, ever
- Funds: stay in your own Perpl account the entire time
- What this server can see: your wallet address and an active login session, for as long as your bot is running
- What this server *cannot* do: withdraw funds, sign anything beyond relaying your browser's own decisions, or act after your session ends

Access is whitelist-gated. For access, contact us on [X](https://x.com/BreadsBakeryxyz) or [Telegram](https://t.me/BreadsBakeryxyz).
