#!/bin/bash
# kurisko_flag_cron.sh — wrapper for kurisko_flag_runner.mjs (sources cTrader creds).
# Runs every 5 min during the active western session (8-21 UTC) via crontab.
# Pass --live in the crontab to place real orders; no arg = dry-run.
# Strategy = Kurisko 20/20 flag on indices+metals, ~1% risk, validated slice only.
set -u
PROJECT_ROOT="/home/ubuntu/tradingview-mcp-jackson"
cd "${PROJECT_ROOT}" || exit 99
set -a
[ -r /home/ubuntu/.ctrader_env ] && . /home/ubuntu/.ctrader_env
set +a
export BROKER_PROVIDER=ctrader
exec node scripts/trading/kurisko_flag_runner.mjs "$@"
