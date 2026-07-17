#!/bin/bash
# tvo_session_check.sh — hourly guard for the Tradeify/Tradovate web session.
# The order bridge authenticates with the token the logged-in Tradovate tab
# keeps in sessionStorage; a Chrome restart or lost tab kills it (sessionStorage
# does not persist, unlike TradingView's cookie login). Since 2026-07-14 the
# check SELF-HEALS first: tvo_relogin.mjs re-opens the tab and logs back in
# with credentials from ~/.tvo_creds.env (chmod 600, TVO_USERNAME/TVO_PASSWORD —
# same pattern as ~/.ctrader.env). Only if that fails (no creds file, captcha,
# device verification, bad password) does it fall back to the alert email so a
# human fixes it BEFORE the next trading session.
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

# ── Self-heal: automated re-login before bothering a human ────────────────────
if [ -f /home/ubuntu/.tvo_creds.env ]; then
  set -a; . /home/ubuntu/.tvo_creds.env; set +a
fi
if node scripts/trading/tvo_relogin.mjs >> /home/ubuntu/trading-data/orb.log 2>&1; then
  out=$(node scripts/trading/broker_tradovate.mjs --test-token 2>&1)
  if [ $? -eq 0 ]; then
    echo "[$(date -u +%FT%TZ)] TVO auto-relogin OK — session restored without human" >> /home/ubuntu/trading-data/orb.log
    rm -f "$MARKER"
    exit 0
  fi
  echo "[$(date -u +%FT%TZ)] TVO relogin reported OK but token test still fails: $out" >> /home/ubuntu/trading-data/orb.log
fi

# throttle: skip email if we alerted within the last 6h
if [ -f "$MARKER" ] && [ $(( $(date +%s) - $(stat -c %Y "$MARKER") )) -lt 21600 ]; then
  exit 1
fi
touch "$MARKER"
printf 'Subject: [ALERT] Tradovate session dead on VM — re-login needed\n\nThe Tradeify/Tradovate web session on the VM is no longer usable and auto-relogin did not recover it (see trading-data/orb.log and tvo_relogin_fail.png):\n\n%s\n\nFix: VNC to the VM (ssh -i ~/.ssh/id_rsa_oracle -L 5900:localhost:5900 ubuntu@145.241.220.213 -N, then RealVNC to localhost:5900) and log back in at topstep.tradovate.com. If ~/.tvo_creds.env is missing, creating it (chmod 600, TVO_USERNAME=… TVO_PASSWORD=…) enables auto-relogin next time. ORB futures orders will fail until this is done.\n' "$out" | msmtp -a gmail toludavid07@gmail.com
exit 1
