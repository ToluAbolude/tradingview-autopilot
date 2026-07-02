#!/bin/bash
# weekly_report_cron.sh — 7-day trade report for BOTH accounts (experiment
# 2131377 + scanner 2118552) in ONE email. Same pipeline as daily_report_cron.sh
# but with a 168h (7-day) window via daily_trade_report.mjs --hours=168.
# Scheduled Saturdays (market closed → no cTrader connection contention).
set -u
MAILTO="toludavid07@gmail.com"
PROJECT_ROOT="/home/ubuntu/tradingview-autopilot"
DATA_ROOT="/home/ubuntu/trading-data"
LOG_DIR="${DATA_ROOT}/pf_reflection"
WEEK_LOG="${LOG_DIR}/weekly_report.cron.log"
HTML_FILE="${LOG_DIR}/daily_report.html"      # daily_trade_report.mjs always writes here
TODAY="$(date -u +%Y-%m-%d)"; TS="$(date -Iseconds)"
mkdir -p "${LOG_DIR}"
cd "${PROJECT_ROOT}" || { echo "[$TS] cd failed" >> "$WEEK_LOG"; exit 99; }

gen() { ( set -a; . "/home/ubuntu/$1" 2>/dev/null; set +a; export BROKER_PROVIDER=ctrader
          node scripts/trading/daily_trade_report.mjs --hours=168 ); }

EXP_TXT="$(gen .ctrader_confirm.env 2>&1)"; EXP_EXIT=$?; cp -f "$HTML_FILE" /tmp/wk_exp.html 2>/dev/null || true
SCAN_TXT="$(gen .ctrader.env 2>&1)";        SCAN_EXIT=$?; cp -f "$HTML_FILE" /tmp/wk_scan.html 2>/dev/null || true
echo "[$TS] exp_exit=$EXP_EXIT scan_exit=$SCAN_EXIT" >> "$WEEK_LOG"

hdr() { printf '<div style="font:bold 15px -apple-system,Segoe UI,sans-serif;background:#111827;color:#fff;padding:10px 14px;margin-top:10px">%s</div>\n' "$1"; }
BOUNDARY="wkb_$(date +%s)_$$"
{
  printf 'To: %s\nFrom: %s\nSubject: [WEEKLY] %s: 7-day trade report (experiment + scanner)\nMIME-Version: 1.0\nContent-Type: multipart/alternative; boundary="%s"\n\n' "$MAILTO" "$MAILTO" "$TODAY" "$BOUNDARY"
  printf -- '--%s\nContent-Type: text/plain; charset=utf-8\n\n' "$BOUNDARY"
  printf '===== WEEKLY (last 7 days) =====\n\n===== EXPERIMENT  acct 2131377 =====\n%s\n\n===== SCANNER  acct 2118552 =====\n%s\n' "$EXP_TXT" "$SCAN_TXT"
  printf -- '\n--%s\nContent-Type: text/html; charset=utf-8\n\n' "$BOUNDARY"
  hdr 'WEEKLY (last 7 days) &middot; EXPERIMENT &middot; acct 2131377'; [ -s /tmp/wk_exp.html ] && cat /tmp/wk_exp.html
  printf '<hr style="border:none;border-top:2px solid #888;margin:26px 0">'
  hdr 'SCANNER &middot; acct 2118552'; [ -s /tmp/wk_scan.html ] && cat /tmp/wk_scan.html
  printf '\n--%s--\n' "$BOUNDARY"
} | msmtp -t -a gmail || echo "[$TS] msmtp send failed (see msmtp.log)" >> "$WEEK_LOG"
rm -f /tmp/wk_exp.html /tmp/wk_scan.html
exit 0
