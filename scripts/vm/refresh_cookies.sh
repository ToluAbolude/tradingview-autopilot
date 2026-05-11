#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# refresh_cookies.sh
# Run this on your LOCAL PC whenever TradingView loses BlackBull broker connection.
# It copies your local Chrome session (cookies + localStorage) to the VM and
# restarts TradingView so it picks up the fresh BlackBull auth.
#
# Usage: bash refresh_cookies.sh
# ─────────────────────────────────────────────────────────────────────────────

VM_USER="ubuntu"
VM_IP="132.145.44.68"
SSH_KEY="$HOME/.ssh/id_rsa_oracle"
CHROME_PROFILE="$APPDATA/../Local/Google/Chrome/User Data/Default"

echo ""
echo "=== TradingView Cookie Refresh ==="
echo ""

# Step 1 — Close Chrome locally (files must be unlocked to copy)
echo "[1/5] Closing Chrome on this PC..."
powershell.exe -Command "Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue" 2>/dev/null
sleep 3
echo "      Done."

# Step 2 — Upload Cookies
echo "[2/5] Uploading cookies to VM..."
scp -i "$SSH_KEY" -q \
  "$CHROME_PROFILE/Network/Cookies" \
  "$VM_USER@$VM_IP:/tmp/Cookies_local"

if [ $? -ne 0 ]; then
  echo "      ERROR: Could not find Chrome cookies."
  echo "      Make sure Chrome is fully closed and try again."
  exit 1
fi
echo "      Cookies uploaded."

# Step 3 — Upload Local Storage
echo "[3/5] Uploading session data to VM..."
scp -r -i "$SSH_KEY" -q \
  "$CHROME_PROFILE/Local Storage/leveldb" \
  "$VM_USER@$VM_IP:/tmp/LocalStorage_local"
echo "      Session data uploaded."

# Step 4 — Apply on VM + restart TradingView
echo "[4/5] Applying on VM and restarting TradingView..."
ssh -i "$SSH_KEY" "$VM_USER@$VM_IP" '
  sudo systemctl stop tradingview
  sleep 2

  cp /tmp/Cookies_local /home/ubuntu/chrome-profile/Default/Cookies
  cp -r /tmp/LocalStorage_local/* "/home/ubuntu/chrome-profile/Default/Local Storage/leveldb/"

  sudo systemctl start tradingview
  sleep 12

  # Click Connect button if a broker-reconnect dialog appears
  node /home/ubuntu/tradingview-mcp-jackson/node_modules/chrome-remote-interface/bin/inspect.js 2>/dev/null || true
  node --input-type=module << '"'"'EOF'"'"'
import CDP from "/home/ubuntu/tradingview-mcp-jackson/node_modules/chrome-remote-interface/index.js";
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  for (let i = 0; i < 10; i++) {
    try {
      const targets = await CDP.List({ host: "localhost", port: 9222 });
      const tv = targets.find(t => t.url && t.url.includes("tradingview.com"));
      if (tv) {
        const client = await CDP({ host: "localhost", port: 9222, target: tv.id });
        await sleep(3000);
        const r = await client.Runtime.evaluate({
          expression: `(function(){
            var btn = Array.from(document.querySelectorAll("button"))
              .find(b => /^connect$/i.test((b.textContent||"").trim()));
            if (btn) { btn.click(); return "Clicked Connect"; }
            var bb = Array.from(document.querySelectorAll("button"))
              .find(b => (b.textContent||"").trim() === "BlackBull Markets");
            if (bb) { bb.click(); return "Clicked BlackBull Markets tab"; }
            return "No connect button found - session may already be active";
          })()`,
          returnByValue: true
        });
        console.log(r.result?.value);
        await client.close();
        return;
      }
    } catch {}
    await sleep(2000);
  }
  console.log("TradingView tab not found after 20s - check VM manually");
}
main().catch(e => console.error("CDP error:", e.message));
EOF
'
echo "      TradingView restarted."

# Step 5 — Verify
echo "[5/5] Verifying connection..."
RESULT=$(ssh -i "$SSH_KEY" "$VM_USER@$VM_IP" "
  node -e \"
const http = require('http');
http.get('http://localhost:9222/json', res => {
  let d=''; res.on('data',c=>d+=c);
  res.on('end',()=>{
    const tabs = JSON.parse(d);
    const tv = tabs.find(t => t.url && t.url.includes('tradingview'));
    console.log(tv ? 'OK' : 'FAIL');
  });
}).on('error', () => console.log('FAIL'));
\" 2>/dev/null
")

if [ "$RESULT" = "OK" ]; then
  echo "      TradingView is live."
  echo ""
  echo "Done. Cookie refresh complete. BlackBull broker should reconnect within 30 seconds."
  echo "Verify by opening VNC: ssh -i ~/.ssh/id_rsa_oracle -L 5901:localhost:5901 -N ubuntu@132.145.44.68"
  echo "Then connect RealVNC Viewer to localhost:5901"
else
  echo "      WARNING: Could not verify TradingView. Check VM manually."
fi

echo ""
