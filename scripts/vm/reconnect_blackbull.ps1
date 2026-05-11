# reconnect_blackbull.ps1
# Run this whenever BlackBull broker disconnects on the VM (after reboots etc.)
# Takes ~30 seconds. Can be closed once it prints "Done."

$SSH_KEY = "$env:USERPROFILE\.ssh\id_rsa_oracle"
$VM = "ubuntu@132.145.44.68"

Write-Host "=== BlackBull Reconnect ==="
Write-Host ""

# Step 1: Start SSH reverse SOCKS tunnel (VM port 1080 -> this PC)
Write-Host "[1/3] Opening proxy tunnel..."
$tunnel = Start-Process ssh -ArgumentList "-i `"$SSH_KEY`" -R 1080 -N -o ServerAliveInterval=20 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=no $VM" -PassThru -WindowStyle Hidden
Start-Sleep 5

# Step 2: Click Connect on VM via CDP
Write-Host "[2/3] Connecting BlackBull on VM..."
$script = @'
node --input-type=module << 'EOF'
import CDP from '/home/ubuntu/tradingview-mcp-jackson/node_modules/chrome-remote-interface/index.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 10; i++) {
  try {
    const targets = await CDP.List({ host: 'localhost', port: 9222 });
    const tv = targets.find(t => t.url && /tradingview/i.test(t.url));
    if (tv) {
      const c = await CDP({ host: 'localhost', port: 9222, target: tv.id });
      await c.Runtime.enable();
      await sleep(2000);
      const r = await c.Runtime.evaluate({
        expression: `(function(){
          var btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Connect' && b.offsetParent);
          if (btn) { btn.click(); return 'clicked'; }
          var acct = Array.from(document.querySelectorAll('*')).find(e => /blackbull/i.test(e.textContent) && e.offsetParent && e.textContent.length < 80);
          if (acct) return 'already_connected';
          return 'no_button';
        })()`, returnByValue: true
      });
      console.log(r.result.value);
      await sleep(15000);
      const r2 = await c.Runtime.evaluate({
        expression: `(function(){
          var hdr = Array.from(document.querySelectorAll('*')).find(e => /blackbull/i.test(e.textContent) && e.offsetParent && e.textContent.length < 80);
          var err = Array.from(document.querySelectorAll('*')).find(e => /timed out|failed|cancelled/i.test(e.textContent) && e.offsetParent && e.textContent.length < 200);
          return JSON.stringify({ connected: !!hdr, error: err ? err.textContent.trim().substring(0,100) : null });
        })()`, returnByValue: true
      });
      console.log('result:', r2.result.value);
      await c.close();
      break;
    }
  } catch(e) { console.error(e.message); }
  await sleep(2000);
}
EOF
'@
$result = ssh -i $SSH_KEY $VM $script
Write-Host $result

# Step 3: Kill tunnel — session persists without it
Write-Host "[3/3] Closing tunnel (session stays active)..."
Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done. BlackBull session is active on VM."
Write-Host "You can close this window."
