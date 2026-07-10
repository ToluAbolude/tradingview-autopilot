#!/bin/bash
# tvo_eod_flatten.sh — EOD safety net for the Tradeify Lightning prop account.
# Tradeify force-flattens at 4:59pm ET with potentially bad fills; we flatten
# ourselves first (cron 20:30 UTC weekdays = 4:30pm EDT / 3:30pm EST).
# No-ops unless the Tradovate kill switch flag file exists (same switch that
# lets orb_runner route orders there), so manual-only phases are untouched.
[ -f /home/ubuntu/.tvo_live ] || exit 0
cd /home/ubuntu/tradingview-autopilot || exit 1
echo "[$(date -u +%FT%TZ)] tvo_eod_flatten:" >> /home/ubuntu/trading-data/orb.log
node scripts/trading/broker_tradovate.mjs --flatten >> /home/ubuntu/trading-data/orb.log 2>&1
