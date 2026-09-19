# Strategies

Every folder here is one plugged-in strategy. `strategy_runner.mjs` (cron, every 5 minutes, one run per account) loads every `*/manifest.json`, checks it, and runs the enabled strategies for its account. Adding, replacing or pausing a strategy needs no code change — only a folder.

## Add a strategy

1. Create `strategies/<id>/manifest.json`. The folder name must equal `id`.
2. Point `logic` at the signal logic:
   - `{ "module": "orb" }` reuses a module from `scripts/trading/confirm/strategies/`, or
   - `{ "file": "logic.mjs" }` uses a module you put in the same folder.
3. Start with `"mode": "paper"`. The runner logs what it would trade (mode `paper` in the signals log) and places nothing.
4. Check that it loads: `node --test scripts/trading/lib/` fails on any invalid manifest.
5. Copy the folder to the VM. When the paper results look right, change it to `"mode": "live"`.

## Replace or pause a strategy

Set `"enabled": false` on the old one — it stops on the next tick — and enable the new one. Keep the old folder: its `id` is how its past trades are attributed.

## Manifest fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | a–z, 0–9 and `_`, at most 40 characters, equal to the folder name. It becomes the cTrader order label, so every position records which strategy opened it. |
| `description` | no | What the strategy is and why it is here. |
| `enabled` | yes | `false` means the runner ignores it. |
| `mode` | yes | `paper` logs only; `live` places orders when the runner runs with `--live`. |
| `account` | yes | cTrader account number as a string, e.g. `"2131377"` (experiment). A runner only runs manifests for the account it was started with. |
| `logic` | yes | `{ "module": "<name>" }` or `{ "file": "<name>.mjs" }`. |
| `instruments` | yes | Symbols, e.g. `["EURUSD", "XAUUSD"]`. Each runs independently. |
| `timeframe` | yes | `"5"`, `"15"`, `"30"`, `"60"`, `"240"` or `"D"`. |
| `history_days` | no (20) | Days of bars fetched each tick. |
| `params` | no (`{}`) | Passed to the logic as `ctx.params`. |
| `filters` | no (`[]`) | `prior_day_range`: only trade outside yesterday's range. `news_recent`: only trade 5–180 minutes after high-impact news for the symbol. |
| `target` | yes | `{ "r": 2 }`: take profit at r × risk, unless the signal brings its own `tp`. `"own": false` always uses r × risk. |
| `risk` | yes | `{ "per_trade_pct": 0.1 }`: percent of equity lost if the stop is hit (at most 2). `"stop_mult": 1.5` puts the stop 1.5× the strategy's own distance from entry (1–3), and `r` is measured against that wider stop. |
| `gates` | no (all on) | Switch off a system gate the strategy's backtest never saw: `"plan"` (the scanner account's daily-plan rule), `"fib_veto"`, `"daily_eod"` (the 20:00 UTC close of losing positions) — e.g. `{ "plan": false }`. Safety gates — stop floors, lot caps, exposure, the Friday flatten — cannot be switched off. |

## The logic contract

A logic module's default export has `generateSignals(bars, ctx)`:

- `bars`: closed bars `{ t, o, h, l, c, v }`, oldest first, `t` in unix **milliseconds**.
- `ctx`: `{ symbol, tf, params, sessions, instrument: { symbol, class } }`.
- It returns signals `{ ts, dir: 'long' | 'short', entry, sl, tp?, reason? }`. The runner only acts on a signal whose `ts` is the last closed bar, and skips any whose stop is on the wrong side of entry.

The logic decides; it must not place orders, read files or keep state. Sizing, the order, the stop and target, and logging are the runner's job.

## What the system enforces, whatever the strategy

- `assertOrderSafety` on every order: stop-distance floors, lot caps, frozen-price check, fib veto — and on the scanner account (2118552), the daily plan gate, so orders there must sit at a planned zone inside the trade windows. A manifest can switch the fib veto and the plan gate off (`gates`); nothing else.
- Both accounts run `strategy_runner.mjs` every 5 minutes: the experiment (2131377) and the scanner (2118552).
- The exposure policy (`scripts/trading/lib/exposure.mjs`): by default one position per symbol per account. Raise it per account in `trading_params.json` → `exposure` to let several strategies share an instrument.
- One entry per strategy × symbol × bar, the account's daily loss kill switch, and demo-only placement.

## Not yet supported

- JSON rules and Pine Script conversion — logic must be a JavaScript module for now.
- Per-manifest exit settings (trailing, EOD behaviour): brackets are fixed at entry.
