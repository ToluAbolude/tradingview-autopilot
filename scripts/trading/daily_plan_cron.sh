#!/bin/bash
# daily_plan_cron.sh — pre-market analyst. Runs daily_plan.mjs before London, then
# emails the plan. The plan file it writes is what inline_trader's plan gate reads
# all day: if this fails, NOTHING trades (the gate fails closed by design), so a
# failure is loud in the subject line rather than silent.
#
# Cron: 0 6 * * *  (06:00 UTC daily — 7 days, because BTCUSD trades weekends)
# PLUS catch-up runs (see below) — this script is idempotent: if today's plan
# already exists it exits immediately without re-planning or re-emailing.
#
# Why catch-up runs exist: the plan failed 7 of the 12 days to 2026-08-18, every
# time as a cTrader connect timeout in the 05:00Z window, and each failure meant
# a whole day of no trading (the gate fails closed). One missed connection must
# not cost a session, so schedule retries alongside the main run:
#   0  6 * * * .../daily_plan_cron.sh
#   20 6 * * * .../daily_plan_cron.sh
#   50 6 * * * .../daily_plan_cron.sh     (still ahead of the 07:00Z London window)
set -u
MAILTO="toludavid07@gmail.com"
PROJECT_ROOT="/home/ubuntu/tradingview-mcp-jackson"
DATA_ROOT="/home/ubuntu/trading-data"
CRON_LOG="${DATA_ROOT}/daily_plan.cron.log"
HTML_FILE="${DATA_ROOT}/daily_plan.html"
PLAN_FILE="${DATA_ROOT}/daily_plan.json"
TODAY="$(date -u +%Y-%m-%d)"; TS="$(date -Iseconds)"

cd "${PROJECT_ROOT}" || { echo "[$TS] cd failed" >> "$CRON_LOG"; exit 99; }

# Idempotence guard — makes the catch-up runs free. Today's plan already on
# disk? Nothing to do, and no duplicate email.
if [ -s "$PLAN_FILE" ] && grep -q "\"date\": *\"$TODAY\"" "$PLAN_FILE" 2>/dev/null; then
  echo "[$TS] plan for $TODAY already present — skipping" >> "$CRON_LOG"
  exit 0
fi

# A stale HTML from yesterday emailed as today's plan is exactly the failure the
# EOD report hit during the July token outage. Remove it first; only a same-run
# success can produce one.
rm -f "$HTML_FILE"

OUT="$( set -a
        . /home/ubuntu/.ctrader.env  2>/dev/null
        . /home/ubuntu/.notion.env   2>/dev/null
        . /home/ubuntu/.anthropic.env 2>/dev/null
        set +a
        export BROKER_PROVIDER=ctrader
        node scripts/trading/daily_plan.mjs 2>&1 )"
EXIT=$?
echo "[$TS] daily_plan exit=$EXIT" >> "$CRON_LOG"

if [ $EXIT -eq 0 ] && [ -s "$HTML_FILE" ]; then
  ZONES="$(grep -o '"tradeable": true' "$PLAN_FILE" 2>/dev/null | wc -l)"
  SUBJECT="[PLAN] $TODAY: ${ZONES} tradeable zone(s)"
  BODY="$(cat "$HTML_FILE")"
else
  # Fail loudly. No plan = no trading today, and that needs to be visible by 06:05.
  SUBJECT="[PLAN][FAILED] $TODAY: no plan generated — NOTHING WILL TRADE TODAY"
  BODY="$(printf '<pre style="font:12px monospace;color:#b91c1c;background:#fef2f2;padding:10px 14px;white-space:pre-wrap">daily_plan.mjs FAILED (exit %s).\n\nThe plan gate fails closed, so no trades will be opened until this is fixed and the plan regenerated.\n\n%s</pre>' \
    "$EXIT" "$(printf %s "$OUT" | tail -c 3000 | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g')")"
fi

{
  printf 'To: %s\nFrom: %s\nSubject: %s\nMIME-Version: 1.0\nContent-Type: text/html; charset=utf-8\n\n' \
    "$MAILTO" "$MAILTO" "$SUBJECT"
  printf '%s\n' "$BODY"
} | msmtp -t -a gmail || echo "[$TS] msmtp send failed (see msmtp.log)" >> "$CRON_LOG"

exit 0
