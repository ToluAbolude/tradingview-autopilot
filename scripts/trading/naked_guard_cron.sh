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
# Hard timeout: the guard runs every 2 min; a hung cTrader connect must not pile
# up zombie processes (777 of them were strangling the VM on 2026-06-11).
exec timeout -k 15 110 node scripts/trading/naked_position_guard.mjs --enforce
