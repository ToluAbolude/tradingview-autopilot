#!/bin/bash
# heartbeat.sh (VM cron, */5) — dead-man's switch to an OFF-VM monitor.
#
# The on-VM cdp_watchdog can only alert while the VM itself is alive and can send
# mail. It is structurally blind to: the VM being down, a network/Oracle outage,
# a reboot loop, or msmtp failing. This closes that gap: it pings an external
# check URL ONLY when CDP is healthy, so the external service (healthchecks.io or
# similar) raises the alarm — entirely off this VM — whenever the ping stops:
# CDP down, Chrome dead, VM down, network gone, or rebooting.
#
# Setup (one-time): create a free check at https://healthchecks.io with period
# 5m / grace ~20m, then drop its ping URL into ~/.healthcheck_url (chmod 600).
# No-op until that file exists, so deploying this ahead of setup is safe.
URL_FILE=/home/ubuntu/.healthcheck_url
[ -f "$URL_FILE" ] || exit 0
URL=$(tr -d ' \t\r\n' < "$URL_FILE"); [ -n "$URL" ] || exit 0
if curl -sf --max-time 20 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  curl -fsS -m 10 "$URL" >/dev/null 2>&1
fi
