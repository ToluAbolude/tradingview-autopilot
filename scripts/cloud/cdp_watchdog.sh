#!/bin/bash
# CDP watchdog (VM cron, */5). Three jobs:
#   1. Kill duplicate/runaway session_runner processes (folded in from the retired watchdog.mjs).
#   2. Restart tv_browser after 3 consecutive CDP failures.
#   3. EMAIL after 4 consecutive failed restart cycles (~1h down) — the 07-15/16
#      outage ran 2 days with zero notification; the operator found out from
#      missing trades. Throttled to one email per 6h.
# Deployed to /home/ubuntu/cdp_watchdog.sh on the Oracle VM.
CNT=/home/ubuntu/trading-data/.cdp_fail_count
STREAK=/home/ubuntu/trading-data/.cdp_restart_streak
AMARK=/home/ubuntu/trading-data/.cdp_outage_alerted

# ── Heal: kill duplicate session_runner processes (lock-bypass symptom under OOM) ──
# session_runner's PID lock self-heals dead-PID stale locks, but it cannot kill a live
# duplicate/hung instance that is still holding the lock. If 2+ are running, keep the
# newest (highest PID) and kill the rest; session_runner's acquireLock then reclaims
# the now dead-PID lock on the next cycle.
SR_PIDS=$(ps -eo pid=,args= | grep 'session_runner\.mjs' | grep -vE ' grep |sh -c |timeout ' | awk '{print $1}' | sort -n)
SR_COUNT=$(echo "$SR_PIDS" | grep -c .)
if [ "$SR_COUNT" -ge 2 ]; then
  KEEP=$(echo "$SR_PIDS" | tail -1)
  for pid in $(echo "$SR_PIDS" | head -n -1); do kill "$pid" 2>/dev/null; done
  echo "$(date -u +%FT%TZ) HEAL: killed $((SR_COUNT-1)) excess session_runner(s), kept $KEEP"
fi

# ── CDP health: restart tv_browser after 3 consecutive failures ──
if curl -sf --max-time 20 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo 0 > "$CNT"; echo 0 > "$STREAK"; rm -f "$AMARK"; exit 0
fi
n=$(( $(cat "$CNT" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$CNT"
echo "$(date -u +%FT%TZ) CDP check failed ($n/3)"
[ "$n" -ge 3 ] || exit 0
echo "$(date -u +%FT%TZ) CDP down x3 -> restarting tv_browser"; sudo systemctl restart tv_browser; echo 0 > "$CNT"

# ── Prolonged-outage alert: 4 restart cycles ≈ an hour of continuous downtime ──
s=$(( $(cat "$STREAK" 2>/dev/null || echo 0) + 1 )); echo "$s" > "$STREAK"
if [ "$s" -ge 4 ]; then
  if [ ! -f "$AMARK" ] || [ $(( $(date +%s) - $(stat -c %Y "$AMARK") )) -ge 21600 ]; then
    touch "$AMARK"
    printf 'Subject: [ALERT] VM Chrome/CDP down through %s restart cycles (~%s min)\n\nCDP on the trading VM keeps failing after tv_browser restarts. The market scanner auto-falls back to cTrader broker bars (SCANNER_BARS=auto) so signal scanning and trading CONTINUE, but the chart, trade screenshots, watchlist sync and the Tradovate web tab are down until Chrome recovers (tvo_session_check re-logs-in hourly once it does).\n\nDiagnose:\n  journalctl -u tv_browser -n 50\n  tail -30 /home/ubuntu/tradingview-autopilot/data/trade_log/scheduler_logs/chromium.log\n  tail -20 /home/ubuntu/trading-data/cdp_watchdog.log\n' "$s" "$((s*15))" | msmtp -a gmail toludavid07@gmail.com
    echo "$(date -u +%FT%TZ) ALERT emailed: CDP down through $s restart cycles"
  fi
fi
