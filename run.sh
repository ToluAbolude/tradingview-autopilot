#!/bin/bash
# run.sh — nohup wrapper for all manual script runs
# Usage: ./run.sh scripts/weekly_review.mjs
#        ./run.sh scripts/trading/setup_finder.mjs
#        ./run.sh scripts/backtest_uv.mjs
#
# Output goes to /tmp/<scriptname>.log — always survives SSH disconnection.
# Check progress: tail -f /tmp/<scriptname>.log

if [ -z "$1" ]; then
  echo "Usage: ./run.sh <script.mjs> [args...]"
  echo "Examples:"
  echo "  ./run.sh scripts/weekly_review.mjs"
  echo "  ./run.sh scripts/trading/setup_finder.mjs"
  echo "  ./run.sh scripts/trading/eod_close.mjs"
  exit 1
fi

export DISPLAY=:1
export HOME=/home/ubuntu

SCRIPT="$1"
shift  # remaining args passed to node

# Log file named after the script
LOGNAME=$(basename "$SCRIPT" .mjs)
LOGFILE="/tmp/${LOGNAME}.log"

cd /home/ubuntu/tradingview-mcp-jackson

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Starting: node $SCRIPT $@" >> "$LOGFILE"

nohup node "$SCRIPT" "$@" >> "$LOGFILE" 2>&1 &
PID=$!

echo "Started: $SCRIPT (PID $PID)"
echo "Log:     $LOGFILE"
echo ""
echo "To watch live:  tail -f $LOGFILE"
echo "To check later: cat $LOGFILE"
