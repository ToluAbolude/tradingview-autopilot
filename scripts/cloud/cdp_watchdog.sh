#!/bin/bash
# CDP watchdog (VM cron, */5). Jobs, in order:
#   0. Ensure the snap-confine user D-Bus precondition (linger). Without it every
#      `snap run chromium` dies in ~2s ("not a snap cgroup") and NO restart can
#      ever succeed — the root cause of the 2026-07-19..21 47h outage (ubuntu is
#      uid 1001, linger was off, so launches only worked while an SSH session
#      kept the user bus alive). Self-heal it so that cause can never persist.
#   1. Kill duplicate/runaway session_runner processes.
#   2. Restart tv_browser after 3 consecutive CDP failures; if plain restarts are
#      not sticking (streak >=3, ~45 min), HARD-RESET first: kill every
#      chrome/Xvfb and clear the Chrome singleton locks an unclean exit leaves
#      behind (they silently block a fresh instance).
#   3. EMAIL after ~30 min of continuous downtime (was ~1h). The scanner's
#      degraded-entry guard now BLOCKS new scanner positions while CDP is down,
#      so a silent outage is opportunity lost, not blind trading — still worth
#      knowing fast. Throttled to one email per 6h.
# Deployed to /home/ubuntu/cdp_watchdog.sh on the Oracle VM.
UID_N=$(id -u)
PROFILE=/home/ubuntu/snap/chromium/common/cdp-profile
CNT=/home/ubuntu/trading-data/.cdp_fail_count
STREAK=/home/ubuntu/trading-data/.cdp_restart_streak
AMARK=/home/ubuntu/trading-data/.cdp_outage_alerted

# ── 0. snap-confine precondition: the per-user D-Bus must exist ──
if [ ! -S "/run/user/$UID_N/bus" ]; then
  echo "$(date -u +%FT%TZ) HEAL: user bus /run/user/$UID_N/bus missing -> enabling linger"
  sudo loginctl enable-linger ubuntu 2>/dev/null
fi

# ── 1. kill duplicate session_runner processes (lock-bypass symptom under OOM) ──
# session_runner's PID lock self-heals dead-PID stale locks, but cannot kill a
# live duplicate/hung instance still holding the lock. Keep the newest, kill the
# rest; acquireLock reclaims the now dead-PID lock next cycle.
SR_PIDS=$(ps -eo pid=,args= | grep 'session_runner\.mjs' | grep -vE ' grep |sh -c |timeout ' | awk '{print $1}' | sort -n)
SR_COUNT=$(echo "$SR_PIDS" | grep -c .)
if [ "$SR_COUNT" -ge 2 ]; then
  KEEP=$(echo "$SR_PIDS" | tail -1)
  for pid in $(echo "$SR_PIDS" | head -n -1); do kill "$pid" 2>/dev/null; done
  echo "$(date -u +%FT%TZ) HEAL: killed $((SR_COUNT-1)) excess session_runner(s), kept $KEEP"
fi

# ── 2. CDP health: healthy resets all state ──
if curl -sf --max-time 20 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo 0 > "$CNT"; echo 0 > "$STREAK"; rm -f "$AMARK"; exit 0
fi
n=$(( $(cat "$CNT" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$CNT"
echo "$(date -u +%FT%TZ) CDP check failed ($n/3)"
[ "$n" -ge 3 ] || exit 0

# ── 3. restart, with hard-reset escalation when restarts aren't sticking ──
s=$(( $(cat "$STREAK" 2>/dev/null || echo 0) + 1 )); echo "$s" > "$STREAK"; echo 0 > "$CNT"
if [ "$s" -ge 3 ]; then
  echo "$(date -u +%FT%TZ) HARD-RESET (streak $s): killing chrome/xvfb + clearing singleton locks"
  sudo systemctl stop tv_browser 2>/dev/null
  pkill -9 -f "remote-debugging-port=9222" 2>/dev/null
  pkill -9 -f "Xvfb :99" 2>/dev/null
  rm -f "$PROFILE"/Singleton* 2>/dev/null
  sleep 2
fi
echo "$(date -u +%FT%TZ) CDP down x3 (streak $s) -> restarting tv_browser"
sudo systemctl restart tv_browser

# ── 4. prolonged-outage alert (~30 min continuous downtime) ──
if [ "$s" -ge 2 ]; then
  if [ ! -f "$AMARK" ] || [ $(( $(date +%s) - $(stat -c %Y "$AMARK") )) -ge 21600 ]; then
    touch "$AMARK"
    printf 'Subject: [ALERT] VM Chrome/CDP down ~%s min (%s restart cycles, not sticking)\n\nCDP on the trading VM is down and tv_browser restarts are not recovering it.\n\nImpact: the market scanner still SCANS (cTrader broker-bars fallback), but its degraded-entry guard BLOCKS new scanner positions while CDP is down — scanning-only continues, no new scanner trades open until Chrome recovers. The per-strategy experiment still trades; already-bracketed positions still close at the broker. Chart, trade screenshots, watchlist sync and the Tradovate web tab are down until recovery.\n\nThe watchdog has already tried a hard-reset (kill + clear locks). If this email repeats, VNC in and check:\n  journalctl -u tv_browser -n 50\n  tail -30 /home/ubuntu/tradingview-autopilot/data/trade_log/scheduler_logs/chromium.log\n  tail -20 /home/ubuntu/trading-data/cdp_watchdog.log\n' "$((s*15))" "$s" | msmtp -a gmail toludavid07@gmail.com
    echo "$(date -u +%FT%TZ) ALERT emailed: CDP down streak $s"
  fi
fi
