#!/bin/bash
# naked_guard_cron.sh — cron wrapper for the naked-position guard.
# Sources cTrader creds and selects the cTrader provider so the guard uses the
# API path (source of truth) to repair/close naked positions, instead of the
# laggy DOM path. Runs every 2 min via cron.
export DISPLAY=:1
export HOME=/home/ubuntu
cd /home/ubuntu/tradingview-mcp-jackson || exit 1
set -a
[ -r /home/ubuntu/.ctrader_env ] && . /home/ubuntu/.ctrader_env
set +a
export BROKER_PROVIDER=ctrader
exec node scripts/trading/naked_position_guard.mjs --enforce
