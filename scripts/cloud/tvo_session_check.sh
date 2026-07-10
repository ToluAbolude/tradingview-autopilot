#!/bin/bash
# tvo_session_check.sh — hourly guard for the Tradeify/Tradovate web session.
# The order bridge authenticates with the token the logged-in Tradovate tab
# keeps in sessionStorage; if Chrome restarts or the tab is lost, only a human
# re-login fixes it. This check fails loudly by email so that happens BEFORE
# the next trading session, not after silent order failures.
# No-op unless the live flag is on. Emails at most once per 6h.
[ -f /home/ubuntu/.tvo_live ] || exit 0
cd /home/ubuntu/tradingview-autopilot || exit 1

MARKER=/home/ubuntu/trading-data/.tvo_session_alerted
out=$(node scripts/trading/broker_tradovate.mjs --test-token 2>&1)
if [ $? -eq 0 ]; then
  rm -f "$MARKER"
  exit 0
fi

echo "[$(date -u +%FT%TZ)] TVO SESSION CHECK FAILED: $out" >> /home/ubuntu/trading-data/orb.log

# throttle: skip email if we alerted within the last 6h
if [ -f "$MARKER" ] && [ $(( $(date +%s) - $(stat -c %Y "$MARKER") )) -lt 21600 ]; then
  exit 1
fi
touch "$MARKER"
printf 'Subject: [ALERT] Tradovate session dead on VM — re-login needed\n\nThe Tradeify/Tradovate web session on the VM is no longer usable:\n\n%s\n\nFix: VNC to the VM (ssh -i ~/.ssh/id_rsa_oracle -L 5900:localhost:5900 ubuntu@145.241.220.213 -N, then RealVNC to localhost:5900) and log back in at topstep.tradovate.com. ORB futures orders will fail until this is done.\n' "$out" | msmtp -a gmail toludavid07@gmail.com
exit 1
