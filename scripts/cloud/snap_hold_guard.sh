#!/bin/bash
# snap_hold_guard.sh (VM cron, daily). Chromium + mesa-2404 auto-refresh swaps
# the binary/GL stack under the running browser → CDP breaks (outages 2026-07-04
# and 07-14). Both are held, but a hold can silently drop (a general `snap
# refresh`, an `--unhold`, or a VM rebuild resets it — the 07-07 hold was gone by
# 07-14). Re-assert daily; alert only if it had actually dropped.
DROP=""
for s in chromium mesa-2404; do
  notes=$(snap list "$s" 2>/dev/null | awk 'NR==2{print $NF}')
  case "$notes" in *held*) : ;; *) DROP="$DROP $s" ;; esac
done
[ -z "$DROP" ] && exit 0
echo "$(date -u +%FT%TZ) snap hold dropped for:$DROP — re-holding"
sudo snap refresh --hold $DROP 2>&1
printf 'Subject: [ALERT] VM snap hold had dropped:%s — re-held\n\nThe chromium/mesa snap refresh hold was NOT in place — snap auto-refresh (runs 4x/day) can swap the binary under the running browser and break CDP, which is what caused the 2026-07-04 and 07-14 outages. It has been re-held automatically.\n\nIf this recurs, the durable fix is to move off snap chromium to a non-snap Chrome (no auto-refresh, no snap-confine).\n' "$DROP" | msmtp -a gmail toludavid07@gmail.com
