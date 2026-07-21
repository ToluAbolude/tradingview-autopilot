#!/bin/bash
# ctrader_refresh_cron.sh — weekly cTrader OAuth token rotation (cron: Sun 03:10 local).
# Access tokens die every ~30 days; the 2026-07-19..21 expiry silently killed BOTH
# accounts' entire cTrader path (orders, guards, notion sync, EOD report) for a
# weekend+. Weekly rotation keeps ~3 weeks of headroom. Both env files share one
# grant, so they MUST rotate together (refresh tokens are single-use — see
# scripts/trading/ctrader_refresh.mjs).
set -u
LOG=/home/ubuntu/trading-data/ctrader_refresh.log
cd /home/ubuntu/tradingview-autopilot || exit 99
if node scripts/trading/ctrader_refresh.mjs /home/ubuntu/.ctrader.env /home/ubuntu/.ctrader_confirm.env >> "$LOG" 2>&1; then
  exit 0
fi
printf 'Subject: [ALERT] cTrader token refresh FAILED — trading dies when the access token expires\n\nWeekly token rotation failed; see trading-data/ctrader_refresh.log on the VM.\n\nIf the refresh token is dead (ACCESS_DENIED), redo the browser OAuth flow with scripts/trading/ctrader_oauth_helper.mjs on the local PC and paste the new tokens into BOTH ~/.ctrader.env and ~/.ctrader_confirm.env.\n\nThe access token lasts ~30 days from the last successful rotation, so there is time — but do not sit on this.\n' | msmtp -a gmail toludavid07@gmail.com
exit 1
