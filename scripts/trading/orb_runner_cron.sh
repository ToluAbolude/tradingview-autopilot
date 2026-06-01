#!/bin/bash
# orb_runner_cron.sh — wrapper for orb_runner.mjs (sources cTrader creds).
# Runs every 5 min during the three session breakout windows (see crontab).
# DEFAULT = dry-run (logs would-be trades, places nothing). To go live, change
# the crontab to pass --live (and you've reviewed a week of orb_signals.jsonl).
set -u
PROJECT_ROOT="/home/ubuntu/tradingview-mcp-jackson"
cd "${PROJECT_ROOT}" || exit 99
set -a
[ -r /home/ubuntu/.ctrader_env ] && . /home/ubuntu/.ctrader_env
set +a
export BROKER_PROVIDER=ctrader
exec node scripts/trading/orb_runner.mjs "$@"
