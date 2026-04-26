#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# refresh_cookies.sh
# Run this on your LOCAL PC whenever TradingView logs out on the VM.
# It copies your local Chrome session to the VM and restarts TradingView.
#
# Usage: bash refresh_cookies.sh
# ─────────────────────────────────────────────────────────────────────────────

VM_USER="ubuntu"
VM_IP="132.145.44.68"
SSH_KEY="$HOME/Downloads/ssh-key-2026-04-15.key"
CHROME_PROFILE="$APPDATA/../Local/Google/Chrome/User Data/Default"

echo ""
echo "=== TradingView Cookie Refresh ==="
echo ""

# Step 1 — Close Chrome locally (files must be unlocked)
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
ssh -i "$SSH_KEY" "$VM_USER@$VM_IP" "
  sudo systemctl stop tradingview
  cp /tmp/Cookies_local /home/ubuntu/chrome-profile/Default/Cookies
  cp -r /tmp/LocalStorage_local/leveldb/* '/home/ubuntu/chrome-profile/Default/Local Storage/leveldb/'
  sudo systemctl start tradingview
  sleep 8
  # Click Connect if session-disconnected popup appears
  cd ~/cdp-tool && node --input-type=module << 'EOF'
import CDP from 'chrome-remote-interface';
import http from 'http';
const tabs = JSON.parse(await new Promise(r => {
  http.get('http://localhost:9222/json', res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>r(d)); });
}));
const tv = tabs.find(t => t.url && t.url.includes('tradingview.com'));
if (!tv) { console.log('No TradingView tab'); process.exit(0); }
const client = await CDP({target: tv.id, port: 9222});
await new Promise(r => setTimeout(r, 3000));
const r = await client.Runtime.evaluate({
  expression: \`(function(){
    var btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Connect');
    if (btn) { btn.click(); return 'Clicked Connect'; }
    return 'No Connect button - session OK';
  })()\`,
  returnByValue: true
});
console.log(r.result?.value);
await client.close();
EOF
"
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
  echo "✓ Cookie refresh complete. Trading resumes automatically."
else
  echo "      WARNING: Could not verify TradingView. Check VM manually."
fi

echo ""
