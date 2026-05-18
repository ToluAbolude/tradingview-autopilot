#!/bin/bash
export DISPLAY=:1
export HOME=/home/ubuntu
LOG=/home/ubuntu/trading-data/cron_runner.log
echo "" >> $LOG
echo "========================================" >> $LOG
echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] CRON FIRED" >> $LOG
cd /home/ubuntu/tradingview-mcp-jackson

# Kill any session_runner instance stuck longer than 20 minutes.
# Normally the PID lock prevents concurrent runs, but if Chrome crashes mid-scan
# the process hangs on a CDP fetch() indefinitely and never releases the lock.
STALE_PIDS=$(pgrep -f session_runner.mjs 2>/dev/null)
if [ -n "$STALE_PIDS" ]; then
  for PID in $STALE_PIDS; do
    AGE=$(ps -o etimes= -p $PID 2>/dev/null | tr -d ' ')
    if [ -n "$AGE" ] && [ "$AGE" -gt 1200 ]; then
      echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Killing stuck session_runner PID $PID (age ${AGE}s)" >> $LOG
      kill $PID 2>/dev/null
    fi
  done
  sleep 1
  rm -f /home/ubuntu/trading-data/session_runner.lock
fi

# Hard 14-minute timeout — cron fires every 15 min.
# On timeout, also remove the lock file so the next run starts clean.
timeout 840 node scripts/trading/session_runner.mjs >> $LOG 2>&1
EXIT=$?
if [ $EXIT -eq 124 ]; then
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] TIMEOUT after 840s — cleaned lock" >> $LOG
  rm -f /home/ubuntu/trading-data/session_runner.lock
fi
echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] DONE (exit $EXIT)" >> $LOG
