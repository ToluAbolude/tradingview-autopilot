#!/bin/bash
# morning_review_cron.sh — emails the 06:00 UTC performance read + tuning proposals.
# Sends multipart/alternative: rich HTML body (tables + CSS bar-chart graphs,
# written by the .mjs to morning_review.html) with the plain-text read as fallback.
set -u
MAILTO="toludavid07@gmail.com"
PROJECT_ROOT="/home/ubuntu/tradingview-mcp-jackson"
DATA_ROOT="/home/ubuntu/trading-data"
LOG="${DATA_ROOT}/morning_review.log"
HTML_FILE="${DATA_ROOT}/morning_review.html"
cd "${PROJECT_ROOT}" || exit 99
set -a
[ -r /home/ubuntu/.ctrader_env ] && . /home/ubuntu/.ctrader_env
set +a
export BROKER_PROVIDER=ctrader

OUT="$(node scripts/trading/morning_review.mjs --days=14 2>&1)"
EXIT=$?
TS="$(date -Iseconds)"
echo "[${TS}] EXIT=${EXIT}" >> "${LOG}"; echo "${OUT}" >> "${LOG}"

BOUNDARY="mrb_$(date +%s)_$$"
INCLUDE_HTML=0
[ "${EXIT}" = "0" ] && [ -s "${HTML_FILE}" ] && INCLUDE_HTML=1

{
  printf 'To: %s\n' "${MAILTO}"
  printf 'From: %s\n' "${MAILTO}"
  printf 'Subject: [Morning review] %s\n' "$(date -u +%Y-%m-%d)"
  printf 'MIME-Version: 1.0\n'
  printf 'Content-Type: multipart/alternative; boundary="%s"\n\n' "${BOUNDARY}"

  printf -- '--%s\n' "${BOUNDARY}"
  printf 'Content-Type: text/plain; charset=utf-8\n\n'
  printf '%s\n' "${OUT}"

  if [ "${INCLUDE_HTML}" = "1" ]; then
    printf -- '\n--%s\n' "${BOUNDARY}"
    printf 'Content-Type: text/html; charset=utf-8\n\n'
    cat "${HTML_FILE}"
    printf '\n'
  fi

  printf -- '--%s--\n' "${BOUNDARY}"
} | msmtp -t -a gmail || echo "[${TS}] msmtp failed" >> "${LOG}"
