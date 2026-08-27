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

# Both accounts render from the SAME $HTML_FILE, and daily_trade_report.mjs exits 2
# BEFORE writing it when cTrader is unreachable. Without clearing the file between
# runs, a failed second run leaves the FIRST account's HTML in place and it gets
# copied under the second account's banner — which is exactly how the 2026-08-22
# weekly (exp_exit=0 scan_exit=2) mailed the experiment's trades as the scanner's,
# on a week the scanner had barely traded. Same guard daily_report_cron.sh got on
# 2026-08-18; the weekly was never updated to match.
fail_html() {  # $1 label, $2 exit code, $3 captured output
  printf '<pre style="font:12px monospace;color:#b91c1c;background:#fef2f2;padding:10px 14px;white-space:pre-wrap">%s 7-day report generation FAILED (exit %s) — no numbers shown (a stale report is worse than none).\n\n%s</pre>\n' \
    "$1" "$2" "$(printf %s "$3" | tail -c 1200 | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g')"
}

rm -f "$HTML_FILE"
EXP_TXT="$(gen .ctrader_confirm.env 2>&1)"; EXP_EXIT=$?
if [ $EXP_EXIT -eq 0 ] && [ -s "$HTML_FILE" ]; then cp -f "$HTML_FILE" /tmp/wk_exp.html
else fail_html "EXPERIMENT" "$EXP_EXIT" "$EXP_TXT" > /tmp/wk_exp.html; fi
rm -f "$HTML_FILE"
SCAN_TXT="$(gen .ctrader.env 2>&1)"; SCAN_EXIT=$?
if [ $SCAN_EXIT -eq 0 ] && [ -s "$HTML_FILE" ]; then cp -f "$HTML_FILE" /tmp/wk_scan.html
else fail_html "SCANNER" "$SCAN_EXIT" "$SCAN_TXT" > /tmp/wk_scan.html; fi
echo "[$TS] exp_exit=$EXP_EXIT scan_exit=$SCAN_EXIT" >> "$WEEK_LOG"

SUBJECT="[WEEKLY] $TODAY: 7-day trade report (experiment + scanner)"
if [ $EXP_EXIT -ne 0 ] || [ $SCAN_EXIT -ne 0 ]; then
  SUBJECT="[WEEKLY][FAILED] $TODAY: report generation errors (exp=$EXP_EXIT scan=$SCAN_EXIT)"
fi

hdr() { printf '<div style="font:bold 15px -apple-system,Segoe UI,sans-serif;background:#111827;color:#fff;padding:10px 14px;margin-top:10px">%s</div>\n' "$1"; }
BOUNDARY="wkb_$(date +%s)_$$"
{
  printf 'To: %s\nFrom: %s\nSubject: %s\nMIME-Version: 1.0\nContent-Type: multipart/alternative; boundary="%s"\n\n' "$MAILTO" "$MAILTO" "$SUBJECT" "$BOUNDARY"
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
