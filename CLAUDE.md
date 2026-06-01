# TradingView MCP — Claude Instructions

68 tools for reading and controlling a live TradingView Desktop chart via CDP (port 9222).

## Decision Tree — Which Tool When

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps)

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "greater_than", "less_than")
- `alert_list` → view active alerts
- `alert_delete` → remove alerts

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Architecture

```
Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
```

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`

---

## VM Infrastructure

The trading system runs on an Oracle Cloud VM (ubuntu@132.145.44.68). TradingView runs as Google Chrome (not Electron) managed by systemd.

> **Live status:** see the **Current Operational Status** section at the top of [TRADING_SYSTEM.md](TRADING_SYSTEM.md) for up-to-date account state, params, blocks, ORB dry-run, automations, and known issues. Order execution is via the **cTrader Open API** (`scripts/trading/broker_ctrader.mjs`); TradingView/CDP is chart-reading only.

### Services on the VM

| Service | Purpose |
| --- | --- |
| `xvfb.service` | Virtual display :1 at 1920×1080, 96 DPI |
| `openbox.service` | Window manager — provides minimize/maximize/close controls |
| `tradingview.service` | Google Chrome with CDP on port 9222 |
| `market_scanner.mjs` | Node.js scanner process (tmux session "tradingview") |

### Key files on VM

- `/etc/systemd/system/tradingview.service` — Chrome launch config (proxy PAC, scale factor, etc.)
- `/home/ubuntu/proxy.pac` — Routes `*.blackbull.com` and `*.ctrader.com` through SOCKS5 proxy; all other traffic goes direct
- `/home/ubuntu/trading-data/scanner.log` — Live scanner output
- `/home/ubuntu/trading-data/live_signals.json` — Current signals

### Key files on local PC

- `scripts/vm/proxy_tunnel.ps1` — Starts SSH reverse SOCKS5 proxy (VM port 1080 → home IP). Only needed during BlackBull reconnection.
- `scripts/vm/reconnect_blackbull.ps1` — Full automated reconnect script (starts tunnel, clicks Connect, closes tunnel)
- `scripts/vm/sync_cookies.mjs` — Extracts cookies from local Chrome (port 9223) and injects into VM Chrome (port 9222)
- `scripts/vm/watchdog.mjs` — Runs every 5 min via cron; checks TradingView + BlackBull are alive, heals if not

### SSH access

```bash
ssh -i ~/.ssh/id_rsa_oracle ubuntu@132.145.44.68
```

### VNC access (for manual UI interaction)

```bash
ssh -i ~/.ssh/id_rsa_oracle -L 6080:localhost:6080 -N ubuntu@132.145.44.68
```

Then open <http://localhost:6080/vnc.html> in browser.

---

## BlackBull Markets Broker — Reconnection Guide

### Why it disconnects

BlackBull session persists for days/weeks while Chrome keeps running. It disconnects when:

- Chrome crashes and systemd restarts it
- VM reboots
- TradingView session expires

### Why reconnection needs a proxy

BlackBull blocks OAuth logins from VM/datacenter IPs (Oracle Cloud IP is flagged). The fix: route the OAuth flow through your home PC's IP via SSH reverse SOCKS5 proxy. Once authenticated, ongoing API calls work directly from the VM — the proxy is only needed during the login step.

### Reconnect steps

1. **Start proxy tunnel** — run `scripts/vm/proxy_tunnel.ps1` in a PowerShell window (keep it open)
2. **Run reconnect script** — run `scripts/vm/reconnect_blackbull.ps1` (auto-clicks BlackBull card + Connect button)
3. **If CAPTCHA appears** — open VNC (see above), check "I am human" in the popup
4. **Close proxy tunnel** — once Account Manager shows balance, close the `scripts/vm/proxy_tunnel.ps1` window

The full reconnect takes ~2 minutes. The session then holds 24/7 without the proxy.

### Reconnect via CDP manually (if scripts fail)

```javascript
// On VM port 9222 — click BlackBull card (3rd card in broker grid, at approx x=721, y=260)
await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: 721, y: 260, button: 'left', clickCount: 1 });
await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: 721, y: 260, button: 'left', clickCount: 1 });
// Then click Connect button (appears at approx x=640, y=328)
await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: 640, y: 328, button: 'left', clickCount: 1 });
await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: 640, y: 328, button: 'left', clickCount: 1 });
```

### 24/7 trading status

| Component | Always on? |
| --- | --- |
| Market scanner | Yes — independent Node.js process |
| BlackBull session | Yes — persists after proxy is closed |
| After Chrome crash/restart | No — needs manual reconnect (steps above) |

---

## VM Display & Zoom Notes

Chrome runs at DPR 1.5 on the virtual display (Chrome ignores `--force-device-scale-factor=1` on Xvfb). To compensate:

- Chrome profile default zoom is set to 67% (`partition.default_zoom_level = -2.2239`) so TradingView renders at full 1920×1080 equivalent content
- openbox WM is set to auto-maximize Chrome via `wmctrl` in `ExecStartPost`
- Xft.dpi=96 is set via `xrdb` on Xvfb startup

If the display looks zoomed in after a VM restart, run:

```bash
DISPLAY=:1 xrdb -merge <<< 'Xft.dpi: 96'
DISPLAY=:1 wmctrl -r 'Google Chrome' -b add,maximized_vert,maximized_horz
```
