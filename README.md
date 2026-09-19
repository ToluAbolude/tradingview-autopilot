# TradingView Autopilot

A TradingView MCP server and CLI, with optional strategy research and automated broker execution. The chart bridge builds on [tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp) by [@tradesdontlie](https://github.com/tradesdontlie), with the morning-brief workflow from the Jackson fork.

The repository now includes cTrader and Tradovate adapters, strategy plug-ins, position management, journals, and cloud job scripts. Starting the MCP server does **not** start the trading runners.

## Capabilities and boundaries

| Component | Purpose |
|---|---|
| `src/core`, `src/tools`, `src/cli` | Shared chart/Pine logic exposed through MCP and the `tv` CLI |
| Morning brief | Scan a watchlist and return chart data plus rules for an assistant to interpret |
| `scripts/trading/strategies` | Strategy manifests with instruments, accounts, risk settings and logic modules |
| `scripts/trading/lib` | Shared sizing, exposure, clock, validation and execution-state functions |
| Broker adapters and runners | Submit and manage orders through cTrader Open API or Tradovate |
| Research and backtests | Strategy evaluation, costs, walk-forward tests and robustness checks |
| Cloud scripts and reports | Scheduling, health checks, Notion journals and optional email reports |

TradingView chart automation uses undocumented application internals over Chrome DevTools Protocol (CDP). TradingView changes can break selectors or data access. Broker execution and cloud deployments require separate configuration; historical machine paths and account settings are still present in several scripts.

## Quick start: chart tools

Use Node.js 20 or newer and npm. The offline CI matrix covers Node 20, 22 and 24 on Windows and Ubuntu. Chart tools need TradingView Desktop, a logged-in account and the appropriate data entitlements. No broker credentials are needed for offline tests or CLI help.

```sh
git clone https://github.com/ToluAbolude/tradingview-autopilot.git
cd tradingview-autopilot
npm ci
npm test
node src/cli/index.js --help
```

Edit the existing [rules.json](rules.json) for your watchlist, timeframe, bias criteria and brief instructions. These natural-language rules are context for the morning brief; automated execution has separate parameters and strategy manifests. There is no `rules.example.json` file.

Launch TradingView with CDP enabled on port **9222**:

- Windows: `scripts\launch_tv_debug.bat`
- macOS: `bash scripts/launch_tv_debug_mac.sh`
- Linux: `bash scripts/launch_tv_debug_linux.sh`

Keep the debugging port on localhost. The bridge can control the authenticated app, so do not expose the port publicly. Launch scripts may restart TradingView; save open work first.

```sh
node src/cli/index.js status
node src/cli/index.js brief
```

The CLI brief returns structured chart data and configured rules. Your MCP assistant can interpret that output into a session brief. Saved briefs live in `~/.tradingview-mcp/sessions/`.

Optionally run `npm link` to make `tv` available globally, then use `tv --help` for commands and options.

### MCP configuration

Add this server entry to your MCP client's configuration, retaining existing servers. The configuration location depends on the client.

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/absolute/path/to/tradingview-autopilot/src/server.js"]
    }
  }
}
```

On Windows, use an absolute path such as `C:/projects/tradingview-autopilot/src/server.js`. Restart the client and call `tv_health_check`.

## Automated execution

Read [cTrader setup](docs/CTRADER_SETUP.md), the [service map](docs/SERVICE_MAP.md), and the [strategy manifest reference](scripts/trading/strategies/README.md) before configuring a runner. Some older operational notes describe previous deployments; verify paths and account IDs against the code you run.

- cTrader uses `CTRADER_CLIENT_ID`, `CTRADER_CLIENT_SECRET`, `CTRADER_ACCESS_TOKEN`, `CTRADER_ACCOUNT_ID` and `CTRADER_ENV`. `BROKER_PROVIDER=ctrader` selects it in the scanner execution path. Supply credentials in the process environment; scripts do not universally load `.env` automatically.
- Tradovate uses an authenticated browser session plus its `TVO_*` settings. ORB Tradovate routing can be enabled by `TVO_LIVE=on` **or** the deployment's `.tvo_live` flag, independently of the runner's `--live` argument. Check both before using a dry run.
- `strategy_runner.mjs` defaults to dry-run; its `--live` mode also requires `CTRADER_ENV=demo` and a manifest with `mode: "live"`. Other runners have their own activation rules.
- Keep credentials outside source control. Review accounts, symbol mappings, risk parameters, manifests, data directories and schedules before enabling orders. Committed settings describe an existing deployment, not a portable account template.

### Entry safeguards

The cTrader entry path rejects unavailable exposure, invalid equity, invalid order prices, and unavailable or stale market data for enabled checks. Equity uses balance plus the broker's net unrealized P&L in the deposit currency, respecting the separate money precision of each response. See [cTrader's P&L documentation](https://help.ctrader.com/open-api/profit-loss-calculation/).

Execution runners no longer substitute a fixed account balance when equity reads fail. Daily-loss checks block new entries when required data cannot be read. Closing positions and cancelling orders remain separate from entry checks. The zone-limit runner continues cancellation when account risk is unavailable and retains failed cancellations for retry.

Tradovate wraps submission, fill polling, bracket placement and verification in one recovery boundary. Failures after a potentially accepted entry trigger cancellation and liquidation attempts for that contract, with explicit reporting when recovery cannot be confirmed. Bracket verification checks the two IDs returned by [placeOCO](https://partner.tradovate.com/api/rest-api-endpoints/orders/place-oco). A lost acknowledgement still requires reconciliation before retrying.

Market-entry cooldowns use an atomic filesystem mutex and durable timestamp, scoped to broker account and symbol, and to strategy when the exposure policy permits sharing. The cooldown is 60 seconds; it is not a broker-side exactly-once guarantee. Resting limits are exempt because the zone runner can deliberately rest both directions.

The signal executor uses an exclusive process lock and persists each signal attempt **before** calling execution. A failed or ambiguous execution is still an attempt; it will not automatically replay the same signal emission.

These locks require a **single host and shared local data directory**. They are not distributed locks for multiple VMs. Set `TRADING_DATA_DIR` consistently for the broker cooldown and signal executor; review other scripts for deployment-specific paths.

A crashed process may leave `signal_executor.lock` or `.entry_cooldown_*.json.lock`. Entries stop rather than stealing the lock. Before manually removing a stale lock, confirm the owner is stopped and reconcile broker positions, pending orders and the attempt ledger. Do not delete cooldown timestamps or the ledger simply to retry an uncertain fill.

## Data flows and external services

This is **not an entirely local-only system**. Services receive data according to the commands and integrations enabled.

| Path | External service / data |
|---|---|
| Chart tools | Local CDP controls TradingView; the logged-in app uses TradingView services |
| `pine_check` / `tv pine check` | Sends supplied Pine source to TradingView's compile API |
| MCP client | Receives tool output; its configured model provider may process that output |
| Broker adapters | Account, market data and order requests go to cTrader or Tradovate |
| Planning/review scripts | Selected workflows send market context to Anthropic's API |
| Notion journal | Configured jobs upload trade records and chart screenshots to Notion |
| Email reports | Configured jobs send reports through the email provider |
| News and research jobs | May fetch calendars and other external source data |

Sessions, state, logs and cached research can also remain on the host. Not every runtime file is ignored by Git; review changes before committing.

## Tests and CI

| Command | What it runs |
|---|---|
| `npm test` | Offline Pine/CLI tests, shared trading libraries and institutional research tests |
| `npm run test:unit` / `npm run test:all` | Aliases for the complete offline suite |
| `npm run test:cli` | Offline CLI tests |
| `npm run test:verbose` | Offline suite with the spec reporter |
| `npm run test:external` | Explicit network tests submitting sample Pine source to TradingView |
| `npm run test:e2e` | Explicit live TradingView tests; requires CDP and can change app state |

Default tests exercise production logic and simulated broker failures without credentials, real broker requests or orders. They cover exposure failures, net equity, invalid prices, competing entry attempts and durable signal records. GitHub Actions runs `npm ci` and `npm test` for the supported matrix. Passing tests does not establish broker compatibility in every deployment or strategy profitability.

## MCP tool reference

### Morning brief

| Tool | What it does |
|------|-------------|
| `morning_brief` | Scan watchlist, read indicators, return structured data for session bias. Reads `rules.json` automatically. |
| `session_save` | Save the generated brief to `~/.tradingview-mcp/sessions/YYYY-MM-DD.json` |
| `session_get` | Retrieve today's brief (or yesterday's if today not saved yet) |

### Chart Reading

| Tool | When to use | Output size |
|------|------------|-------------|
| `chart_get_state` | First call — get symbol, timeframe, all indicator names + IDs | ~500B |
| `data_get_study_values` | Read current RSI, MACD, BB, EMA values from all indicators | ~500B |
| `quote_get` | Get latest price, OHLC, volume | ~200B |
| `data_get_ohlcv` | Get price bars. **Use `summary: true`** for compact stats | 500B (summary) / 8KB (100 bars) |

### Custom Indicator Data (Pine Drawings)

Read `line.new()`, `label.new()`, `table.new()`, `box.new()` output from any visible Pine indicator.

| Tool | When to use |
|------|------------|
| `data_get_pine_lines` | Horizontal price levels (support/resistance, session levels) |
| `data_get_pine_labels` | Text annotations + prices ("PDH 24550", "Bias Long") |
| `data_get_pine_tables` | Data tables (session stats, analytics dashboards) |
| `data_get_pine_boxes` | Price zones as {high, low} pairs |

**Always use `study_filter`** to target a specific indicator: `study_filter: "MyIndicator"`.

### Chart Control

| Tool | What it does |
|------|-------------|
| `chart_set_symbol` | Change ticker (BTCUSD, AAPL, ES1!, NYMEX:CL1!) |
| `chart_set_timeframe` | Change resolution (1, 5, 15, 60, D, W, M) |
| `chart_set_type` | Change style (Candles, HeikinAshi, Line, Area, Renko) |
| `chart_manage_indicator` | Add/remove indicators. **Use full names**: "Relative Strength Index" not "RSI" |
| `chart_scroll_to_date` | Jump to a date (ISO: "2025-01-15") |
| `indicator_set_inputs` / `indicator_toggle_visibility` | Change indicator settings, show/hide |

### Pine Script Development

| Tool | Step |
|------|------|
| `pine_set_source` | 1. Inject code into editor |
| `pine_smart_compile` | 2. Compile with auto-detection + error check |
| `pine_get_errors` | 3. Read compilation errors if any |
| `pine_get_console` | 4. Read log.info() output |
| `pine_save` | 5. Save to TradingView cloud |
| `pine_analyze` | Offline static analysis (no chart needed) |
| `pine_check` | Server-side compile check (no chart needed) |

### Replay Mode

| Tool | Step |
|------|------|
| `replay_start` | Enter replay at a date |
| `replay_step` | Advance one bar |
| `replay_autoplay` | Auto-advance (set speed in ms) |
| `replay_trade` | Buy/sell/close positions |
| `replay_status` | Check position, P&L, date |
| `replay_stop` | Return to realtime |

### Multi-Pane, Alerts, Drawings, UI

| Tool | What it does |
|------|-------------|
| `pane_set_layout` | Change grid: `s`, `2h`, `2v`, `2x2`, `4`, `6`, `8` |
| `pane_set_symbol` | Set symbol on any pane |
| `draw_shape` | Draw horizontal_line, trend_line, rectangle, text |
| `alert_create` / `alert_list` / `alert_delete` | Manage price alerts |
| `batch_run` | Run action across multiple symbols/timeframes |
| `watchlist_get` / `watchlist_add` | Read/modify watchlist |
| `capture_screenshot` | Screenshot (regions: full, chart, strategy_tester) |
| `tv_launch` / `tv_health_check` | Launch TradingView and verify connection |

---

## CLI examples

```sh
tv status
tv quote
tv symbol BTCUSD
tv ohlcv --summary
tv brief
tv session get
tv screenshot -r chart
tv pine --help
```

## Troubleshooting

| Symptom | Check |
|---|---|
| CDP connection refused | TradingView is running with port 9222 enabled on localhost |
| MCP server missing | Client configuration contains the correct absolute server path |
| `tv` not found | Run `npm link`, or call `node src/cli/index.js` directly |
| Morning rules missing | Restore/customize tracked `rules.json`, or supply a rules path |
| Order rejected after a broker read error | Restore the connection and inspect the rejection; entries stop when risk is unknown |
| Executor/cooldown lock persists | Verify the owner is stopped and reconcile broker state before manual recovery |
| Wrong paths or accounts on a new machine | Audit deployment scripts and configs; many were built around a specific VM |

## Further documentation

- [Service map](docs/SERVICE_MAP.md): architecture and module boundaries.
- [Strategy manifests](scripts/trading/strategies/README.md): strategy registration and validation.
- [cTrader setup](docs/CTRADER_SETUP.md): authentication and deployment.
- [Cloud setup](scripts/cloud/ORACLE_CLOUD_SETUP.md): existing VM deployment workflow.
- [Research findings](research/institutional_algo/FINDINGS.md): out-of-sample results, including rejected candidates.
- [Contributing](CONTRIBUTING.md): development and verification workflow.

## License and attribution

MIT; see [LICENSE](LICENSE) for the full license and additional notices. This project is not affiliated with TradingView, Anthropic, cTrader or Tradovate. Obtain account access, subscriptions and data entitlements through the relevant providers. The software includes automated order execution; backtests and safeguards do not guarantee future results or eliminate execution risk.
