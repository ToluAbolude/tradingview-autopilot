# cTrader Open API setup

End-to-end credentials walkthrough. ~10 minutes total.

## Why we're doing this

TradingView's broker panel scraping has been the root cause of every
broker-side bug we've fought this week: silent close failures, wrong PnL on
trades.csv, sub-min-lot rejects, suffix-strip mismatches. cTrader's Open API
talks directly to BlackBull's actual broker backend over TCP. No DOM, no
scraping, no surprises.

This document gets us from zero to a working `node scripts/trading/broker_ctrader.mjs --equity` that prints your real BlackBull balance.

## Architecture

```
TradingView (scanning + signals, on VM)
        │
        ▼
inline_trader  ──► broker_ctrader.mjs ──► TCP ──► live.ctraderapi.com:5035
                                                          │
                                                          ▼
                                                  BlackBull account 2118552
```

cTrader runs as a small persistent daemon on the same Oracle VM. It uses ~50 MB RAM (vs Chrome's ~1.5 GB) and auto-reconnects on disconnect.

## Step 1 — Register an Open API application

1. Go to <https://openapi.ctrader.com/apps> and log in with your cTrader ID (the same email/password you use for cTrader Desktop).
2. Click **Create application**.
3. Fill in:
   - **Name**: `tradingview-mcp-jackson` (or anything)
   - **Description**: `Algorithmic trading bridge`
   - **Redirect URIs**: `http://localhost:8080/` *(MUST include the trailing slash)*
   - **Scope**: tick **trading**
4. Submit. You'll be issued a **Client ID** and **Client Secret**. Save both — the secret is shown only once.

## Step 2 — Get an access token (OAuth flow)

This runs on your **local PC**, not the VM, because it needs a browser. The token then gets shipped to the VM.

```powershell
# In PowerShell, in the repo root:
$env:CTRADER_CLIENT_ID     = "<paste your Client ID>"
$env:CTRADER_CLIENT_SECRET = "<paste your Client Secret>"
node scripts/trading/ctrader_oauth_helper.mjs
```

What happens:
1. A tiny HTTP server starts on `localhost:8080`
2. Your browser opens to `id.ctrader.com` asking you to grant access to your accounts
3. Click **Allow** for the BlackBull account `2118552` (and any others you want)
4. The browser redirects back to `localhost:8080` with a code
5. The script exchanges the code for `accessToken` + `refreshToken`
6. Both are printed to the terminal

The access token is valid for **~30 days**. The refresh token can extend it indefinitely.

## Step 3 — Put credentials on the VM

```bash
ssh -i ~/.ssh/id_rsa_oracle ubuntu@145.241.220.213
cat > ~/.ctrader.env <<'EOF'
CTRADER_CLIENT_ID=<from step 1>
CTRADER_CLIENT_SECRET=<from step 1>
CTRADER_ACCESS_TOKEN=<from step 2>
CTRADER_REFRESH_TOKEN=<from step 2>
CTRADER_ACCOUNT_ID=2118552
CTRADER_ENV=demo
EOF
chmod 600 ~/.ctrader.env
```

**Start with `CTRADER_ENV=demo`** — connect to `demo.ctraderapi.com` first with a BlackBull demo account. After we've validated the full chain there, flip to `live`.

## Step 4 — Smoke-test the connection

```bash
ssh -i ~/.ssh/id_rsa_oracle ubuntu@145.241.220.213
cd tradingview-mcp-jackson
set -a; . ~/.ctrader.env; set +a
node scripts/trading/broker_ctrader.mjs --equity
```

Expected output:
```
[cTrader] Connecting to demo.ctraderapi.com:5035 (env=demo)
[cTrader] App auth OK
[cTrader] Account 2118552 → ctidTraderAccountId=12345678
[cTrader] Account auth OK — ready for trading
Equity: { balance: 10000, equity: 10000, currency: 100 }
```

If you see your real demo balance, you're connected.

```bash
node scripts/trading/broker_ctrader.mjs --positions
```

Should print `[]` (no positions on a fresh demo).

## Step 5 — Switch consumers over (incremental)

Done in three small PRs, one consumer at a time. Each PR is independently reversible.

1. **PR-A: `closeAllPositions`** → use cTrader. Eliminates the close-button selector class of bug entirely. Fixes synthetic BE, EOD close, naked-position guard.
2. **PR-B: `position_monitor` PnL** → subscribe to `ProtoOAExecutionEvent` and write real close-price PnL straight to trades.csv. Kills the balance-delta misattribution forever.
3. **PR-C: `placeOrder`** → route new trades through cTrader. Eliminates sub-min-lot silent rejects, suffix-strip false rejects, and the post-submit verifier dance entirely.

After PR-C, `execute_trade.mjs` becomes legacy / fallback only.

## Troubleshooting

- **"Account not in OAuth-granted list"** — re-run the OAuth flow with `scope=trading` and make sure to tick the BlackBull account in the grant page.
- **"Connection refused"** — confirm `CTRADER_ENV=demo` (port 5035) and you have outbound TCP to `*.ctraderapi.com:5035`. Oracle Cloud opens this by default.
- **Token expired** — use the refresh token via `POST /apps/token?grant_type=refresh_token&refresh_token=...&client_id=...&client_secret=...` — TODO: bake a refresh script.
- **Wrong account number** — the cTrader UI shows account *numbers* (e.g. 2118552) but the API uses `ctidTraderAccountId` (an internal int). The bridge does this lookup automatically; you only ever need to supply the user-facing number in `.ctrader.env`.

## Cost

Free. The Open API is included with any cTrader broker account at no extra charge.
