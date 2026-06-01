#!/bin/bash
# morning_review_cron.sh — emails the 06:00 UTC performance read + tuning proposals.
# Sources cTrader creds (cron doesn't inherit them) and mails stdout via msmtp.
set -u
MAILTO="toludavid07@gmail.com"
PROJECT_ROOT="/home/ubuntu/tradingview-mcp-jackson"
LOG="/home/ubuntu/trading-data/morning_review.log"
cd "${PROJECT_ROOT}" || exit 99
set -a
[ -r /home/ubuntu/.ctrader_env ] && . /home/ubuntu/.ctrader_env
set +a
export BROKER_PROVIDER=ctrader

OUT="$(node scripts/trading/morning_review.mjs --days=14 2>&1)"
TS="$(date -Iseconds)"
echo "[${TS}]" >> "${LOG}"; echo "${OUT}" >> "${LOG}"

{
  printf 'To: %s\n' "${MAILTO}"
  printf 'From: %s\n' "${MAILTO}"
  printf 'Subject: [Morning review] %s\n' "$(date -u +%Y-%m-%d)"
  printf 'Content-Type: text/plain; charset=utf-8\n\n'
  printf '%s\n' "${OUT}"
} | msmtp -t -a gmail || echo "[${TS}] msmtp failed" >> "${LOG}"
