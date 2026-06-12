#!/bin/bash
# eod_close_cron.sh — wrapper for eod_close.mjs (sources cTrader creds so the
# API-first flatten path works; the bare-node cron line left it on the TV-DOM
# fallback, which reads the same UI that freezes).
#
# Crontab (UTC):
#   0  20 * * 1-5  eod_close_cron.sh                  # first pass
#   45 21 * * 1-5  eod_close_cron.sh                  # backup pass
#   30 0  * * 6    eod_close_cron.sh --weekend-check  # Saturday flat backstop
set -u
PROJECT_ROOT="/home/ubuntu/tradingview-mcp-jackson"
cd "${PROJECT_ROOT}" || exit 99
set -a
[ -r /home/ubuntu/.ctrader.env ] && . /home/ubuntu/.ctrader.env
set +a
export BROKER_PROVIDER=ctrader
export DISPLAY=:1
exec node scripts/trading/eod_close.mjs "$@"
