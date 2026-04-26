# BOOTSTRAP — Deploy GREED on a New Machine
### Complete setup guide + Claude Code prompt

> This document lets you reproduce the full GREED trading system from zero.  
> Read §1–§4 to understand what you're doing. Then paste §5 into Claude Code and it will do the rest.

---

## §1. What You Need Before Starting

| Item | Where to get it | Cost |
|------|----------------|------|
| Oracle Cloud account | cloud.oracle.com | Free |
| TradingView account (any plan) | tradingview.com | Free (limited) or ~$15/mo |
| BlackBull Markets account | blackbull.com | Free (real money required for live trading) |
| Claude Code (CLI) | claude.ai/code | Subscription |
| SSH client | Built into Mac/Linux terminal, or PuTTY on Windows | Free |

**You do NOT need:** a local machine running 24/7, a Windows server, or any paid VPS.

---

## §2. Get a Free Oracle Cloud VM (Always Free Tier)

Oracle gives you **always-free** virtual machines that never expire and never charge you.

### Step-by-step

1. Go to **cloud.oracle.com** → click **Start for free**
2. Sign up with an email address — you'll need a credit card for identity verification (not charged)
3. Once logged in, go to: **Compute → Instances → Create Instance**
4. Configure:
   - **Name:** `greed-trader` (anything you like)
   - **Image:** Ubuntu 22.04 (click "Change Image" to select it)
   - **Shape:** Click "Change Shape" → select **VM.Standard.A1.Flex** (ARM, Ampere) → set **2 OCPUs, 12GB RAM** (all free)
   - **Networking:** Leave defaults (a public VCN will be created)
   - **SSH keys:** Click "Generate a key pair for me" → **download both keys** (save them somewhere safe — you cannot get the private key again)
5. Scroll down to **"Show advanced options"** → **"Initialization"** tab → paste the entire contents of `cloud-init.yaml` from this repo into the **Cloud-init script** box
6. Click **Create**

The VM will boot and automatically run the entire setup (takes ~5 minutes). You'll see it in the console when the state changes to `RUNNING`.

### Open the firewall (important)

By default Oracle blocks all inbound ports. You do NOT need to open any — the trading system only makes outbound connections. But if you want to SSH in (you do), Oracle's default Security List already allows port 22.

If SSH times out, go to:  
**Networking → Virtual Cloud Networks → your VCN → Security Lists → Default Security List**  
→ Add Ingress Rule: Source `0.0.0.0/0`, Protocol `TCP`, Port `22`

### Get your VM's public IP

In the Oracle console, click your instance → copy the **Public IP address** from the Instance Information panel.

---

## §3. What the cloud-init Script Does Automatically

When the VM boots with `cloud-init.yaml`, it:

1. Installs: `git`, `curl`, `xvfb` (virtual display), `x11vnc` (VNC for initial login), `cron`
2. Installs **Node.js 20** via NodeSource
3. Installs **Google Chrome** (stable) — this is what renders TradingView
4. Clones the repo to `/opt/tradingview-autopilot/`
5. Runs `npm install`
6. Creates data directory at `/home/ubuntu/trading-data/trade_log/`
7. Installs three systemd services:
   - `xvfb.service` — virtual 1920×1080 display (Chrome needs a display even on headless server)
   - `tradingview.service` — Chrome pointed at tradingview.com with CDP on port 9222
   - `tradingview-vnc.service` — VNC server (only used for initial TradingView login setup)
8. Sets up cron jobs for all 4 trading sessions + EOD close

### After boot: log into TradingView once (manual step — required)

Chrome opens tradingview.com but you need to log in with your TradingView account and connect your BlackBull broker. This is a one-time manual step.

```bash
# SSH with port forward for VNC
ssh -i ~/path/to/your-private-key.key -L 5900:localhost:5900 ubuntu@YOUR_VM_IP -N &

# Then start VNC on the VM (in a second terminal):
ssh -i ~/path/to/your-private-key.key ubuntu@YOUR_VM_IP
sudo systemctl start tradingview-vnc
```

Then open a VNC client (e.g. RealVNC Viewer, TigerVNC) → connect to `localhost:5900`.  
You'll see the TradingView chart in Chrome. Log in, connect your broker, make sure the chart is on the right symbol.  
**After logging in, stop VNC** (it's a security risk to leave running):

```bash
sudo systemctl stop tradingview-vnc
sudo systemctl disable tradingview-vnc
```

Chrome stays running in the background. TradingView stays logged in.

---

## §4. Cron Schedule (UTC Times)

These run automatically. No action needed.

```
7  0  * * 1-5   session_runner.mjs   → Asian open (00:07 UTC)
7  8  * * 1-5   session_runner.mjs   → London open (08:07 UTC)
7  13 * * 1-5   session_runner.mjs   → London-NY overlap (13:07 UTC) ← BEST SESSION
7  17 * * 1-5   session_runner.mjs   → NY continuation (17:07 UTC)
45 21 * * 1-5   eod_close.mjs        → Force-close all positions (21:45 UTC)
```

**BST/GMT offset note:** The markets don't move — the cron is in UTC so it's always correct regardless of daylight saving.

---

## §5. Claude Code Bootstrap Prompt

**How to use:** Open Claude Code on your new machine (or SSH into your VM first), navigate to the project directory, then paste the following prompt. Claude will handle the rest.

---

```
You are setting up the GREED automated trading system from scratch. The system uses:
- TradingView (via Chrome + CDP on port 9222)
- Node.js 20 scripts for scanning setups and placing trades
- BlackBull Markets as the broker
- Oracle Cloud Ubuntu VM as the host

Here is everything you need to do. Work through each step, confirm it worked before moving on, and fix any errors you encounter.

═══════════════════════════════════════
STEP 1 — CHECK ENVIRONMENT
═══════════════════════════════════════
Run these checks and report what you find:

1a. node --version  (need v20+)
1b. google-chrome --version OR chromium-browser --version  (need any recent version)
1c. systemctl status xvfb  (should be active/running)
1d. systemctl status tradingview  (should be active/running)
1e. ls /opt/tradingview-autopilot/scripts/trading/  (should show session_runner.mjs, setup_finder.mjs, etc.)
1f. ls /home/ubuntu/trading-data/  (data directory — may not exist yet, that's OK)

If Node.js is missing: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs
If Chrome is missing: wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb && sudo apt-get install -y libgtk-3-0 xdg-utils && sudo dpkg -i /tmp/chrome.deb
If Xvfb is missing: sudo apt-get install -y xvfb x11vnc

═══════════════════════════════════════
STEP 2 — CLONE OR VERIFY REPO
═══════════════════════════════════════
Check if the repo is already cloned:
  ls /opt/tradingview-autopilot/package.json

If NOT present, clone it:
  sudo git clone https://github.com/ToluAbolude/tradingview-autopilot.git /opt/tradingview-autopilot
  sudo chown -R ubuntu:ubuntu /opt/tradingview-autopilot
  cd /opt/tradingview-autopilot && npm install

If present, update it:
  cd /opt/tradingview-autopilot && git pull && npm install

Verify these key files exist after clone:
  /opt/tradingview-autopilot/scripts/trading/setup_finder.mjs
  /opt/tradingview-autopilot/scripts/trading/session_runner.mjs
  /opt/tradingview-autopilot/scripts/trading/eod_close.mjs
  /opt/tradingview-autopilot/scripts/trading/execute_trade.mjs
  /opt/tradingview-autopilot/scripts/trading/news_checker.mjs
  /opt/tradingview-autopilot/scripts/trading/pattern_recognition.mjs
  /opt/tradingview-autopilot/scripts/trading/performance_tracker.mjs
  /opt/tradingview-autopilot/scripts/trading/twitter_feed.mjs
  /opt/tradingview-autopilot/scripts/weekly_review.mjs
  /opt/tradingview-autopilot/GREED.md

═══════════════════════════════════════
STEP 3 — CREATE DATA DIRECTORIES
═══════════════════════════════════════
mkdir -p /home/ubuntu/trading-data/trade_log
mkdir -p /home/ubuntu/trading-data/daily_context
chown -R ubuntu:ubuntu /home/ubuntu/trading-data

═══════════════════════════════════════
STEP 4 — SET UP SYSTEMD SERVICES
═══════════════════════════════════════
Check if services exist:
  systemctl status xvfb
  systemctl status tradingview

If xvfb service is missing, create it at /etc/systemd/system/xvfb.service:

[Unit]
Description=X Virtual Frame Buffer
After=network.target

[Service]
Type=simple
ExecStartPre=/bin/rm -f /tmp/.X1-lock
ExecStart=/usr/bin/Xvfb :1 -screen 0 1920x1080x24 -ac -noreset
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target

If tradingview service is missing, create it at /etc/systemd/system/tradingview.service:

[Unit]
Description=TradingView Chrome CDP port 9222
After=network.target xvfb.service
Requires=xvfb.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
Environment=HOME=/home/ubuntu
Environment=DISPLAY=:1
ExecStart=/usr/bin/google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=/home/ubuntu/chrome-profile --no-first-run --no-default-browser-check --disable-dev-shm-usage --disable-gpu --no-sandbox --window-size=1920,1080 https://www.tradingview.com/chart/
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target

After creating any missing service files:
  sudo systemctl daemon-reload
  sudo systemctl enable xvfb tradingview
  sudo systemctl start xvfb
  sleep 3
  sudo systemctl start tradingview
  sleep 5
  systemctl status xvfb tradingview

═══════════════════════════════════════
STEP 5 — VERIFY CDP CONNECTION
═══════════════════════════════════════
Test that Chrome is accepting CDP connections:
  curl -s http://localhost:9222/json/version | head -5

You should see JSON with "Browser", "webSocketDebuggerUrl", etc.
If you get "connection refused", Chrome is not running — check: journalctl -u tradingview -n 30

Then run a quick connectivity test from the repo:
  cd /opt/tradingview-autopilot && node -e "
    import('./src/connection.js').then(m => 
      m.evaluate('document.title').then(t => console.log('CDP OK — page title:', t))
    ).catch(e => console.error('CDP FAIL:', e.message))
  "

═══════════════════════════════════════
STEP 6 — SET UP CRON JOBS
═══════════════════════════════════════
Check current crontab:
  crontab -u ubuntu -l

Set the full crontab (replaces existing):
  crontab -u ubuntu - << 'CRON'
# GREED Trading System — all times UTC
# Asian open
7 0 * * 1-5  cd /opt/tradingview-autopilot && /usr/bin/node scripts/trading/session_runner.mjs >> /home/ubuntu/trading-data/asian.log 2>&1
# London open
7 8 * * 1-5  cd /opt/tradingview-autopilot && /usr/bin/node scripts/trading/session_runner.mjs >> /home/ubuntu/trading-data/london.log 2>&1
# London-NY overlap (BEST SESSION)
7 13 * * 1-5 cd /opt/tradingview-autopilot && /usr/bin/node scripts/trading/session_runner.mjs >> /home/ubuntu/trading-data/overlap.log 2>&1
# NY continuation
7 17 * * 1-5 cd /opt/tradingview-autopilot && /usr/bin/node scripts/trading/session_runner.mjs >> /home/ubuntu/trading-data/ny.log 2>&1
# EOD force-close — no carryover positions
45 21 * * 1-5 cd /opt/tradingview-autopilot && /usr/bin/node scripts/trading/eod_close.mjs >> /home/ubuntu/trading-data/eod.log 2>&1
CRON

Verify:
  crontab -u ubuntu -l

═══════════════════════════════════════
STEP 7 — ONE-TIME: LOG INTO TRADINGVIEW
═══════════════════════════════════════
This step CANNOT be automated — TradingView requires a human login.

Instructions to give the user:

1. On the VM, install x11vnc if not present: sudo apt-get install -y x11vnc
2. Start VNC: x11vnc -display :1 -forever -localhost -rfbport 5900 &
3. On your LOCAL machine, open a new terminal and run:
   ssh -i /path/to/your-ssh-key.key -L 5900:localhost:5900 ubuntu@YOUR_VM_IP -N
4. Open VNC viewer (RealVNC, TigerVNC) → connect to localhost:5900
5. You will see Chrome with TradingView open
6. Log in to TradingView with your account
7. Click the "Trading Panel" button at the bottom → connect BlackBull Markets broker
8. Log in to BlackBull, confirm the account is connected and shows your balance
9. Set the chart to your preferred default symbol (e.g. NAS100, 15M timeframe)
10. Close VNC viewer
11. Back on the VM: pkill x11vnc
12. Chrome stays running and logged in permanently

═══════════════════════════════════════
STEP 8 — TEST A MANUAL SCAN
═══════════════════════════════════════
Run the scanner manually to confirm everything works end-to-end:
  cd /opt/tradingview-autopilot && node scripts/trading/setup_finder.mjs 2>&1 | head -60

You should see it scanning instruments (NAS100, US30, WTI, etc.) and printing scores.
If you see "CDP FAIL" or "no data" on every instrument, Chrome has lost the TradingView session — repeat Step 7.

═══════════════════════════════════════
STEP 9 — TEST NEWS CHECKER
═══════════════════════════════════════
  cd /opt/tradingview-autopilot && node -e "
    import('./scripts/trading/news_checker.mjs').then(m =>
      m.fetchHighImpactNews().then(news => {
        const safety = m.isSafeToTrade(news);
        console.log('Safe to trade:', safety.safe);
        console.log('Reason:', safety.reason || 'All clear');
        console.log('Events today:', news.filter(n => new Date(n.date).toDateString() === new Date().toDateString()).length);
      })
    ).catch(e => console.error('News check failed:', e.message))
  "

═══════════════════════════════════════
STEP 10 — VERIFY TRADE LOGGING
═══════════════════════════════════════
  ls -la /home/ubuntu/trading-data/trade_log/
  cat /home/ubuntu/trading-data/trade_log/trades.csv 2>/dev/null || echo "(no trades yet — normal on fresh install)"

═══════════════════════════════════════
STEP 11 — FINAL HEALTH CHECK
═══════════════════════════════════════
Run this checklist and report pass/fail for each:

□ node --version → v20+
□ systemctl is-active xvfb → active
□ systemctl is-active tradingview → active
□ curl -s http://localhost:9222/json/version → returns JSON
□ CDP connection test (Step 5) → "CDP OK"
□ Scanner test (Step 8) → scans instruments without errors
□ News checker (Step 9) → returns safe/unsafe status
□ Cron jobs set (Step 6) → 5 entries visible
□ Data directories exist → /home/ubuntu/trading-data/trade_log/
□ TradingView logged in + broker connected (Step 7) → confirmed by user

If all 10 pass: the system is live. Cron jobs will fire automatically at the scheduled UTC times.

═══════════════════════════════════════
TROUBLESHOOTING
═══════════════════════════════════════

Problem: "Cannot connect to CDP / ECONNREFUSED"
Fix: sudo systemctl restart tradingview && sleep 10 && curl http://localhost:9222/json/version

Problem: Scanner scans but finds 0 setups every session
Check: Is EMA flat across all instruments? Check if it's a low-volatility period.
Check: Is the score threshold too high for current conditions? (default: 11)
Check: Run node scripts/trading/setup_finder.mjs and read the per-instrument scores.

Problem: Orders not placing (execute_trade.mjs errors)
Fix: The BlackBull broker panel must be open and connected in TradingView. Repeat Step 7.

Problem: "session skipped — position already open"
Normal: The system refuses to stack trades. Wait for the current trade to close, or run eod_close.mjs to force close.

Problem: Chrome crashes / tradingview service keeps restarting
Fix: sudo systemctl stop tradingview && sudo rm -rf /home/ubuntu/chrome-profile/Singleton* && sudo systemctl start tradingview

Problem: VNC shows black screen
Fix: sudo systemctl restart xvfb && sleep 3 && sudo systemctl restart tradingview
```

---

## §6. Keeping the System Updated

When new strategies or fixes are pushed to the repo:

```bash
ssh -i /path/to/key.key ubuntu@YOUR_VM_IP
cd /opt/tradingview-autopilot
git pull
# No restart needed — cron jobs always run the latest code on each fire
```

To run the weekly review after each trading week:
```bash
cd /opt/tradingview-autopilot && node scripts/weekly_review.mjs
cat /tmp/weekly_review.txt
```

Read `GREED.md` to understand what the results mean and how to update the instrument tier rankings.

---

## §7. Quick Reference

> **Rule:** Cron jobs are always safe. For ANY manual script run over SSH, always use `./run.sh` — never `node script.mjs` directly. If the SSH connection drops, `run.sh` keeps the process alive.

```bash
# SSH in
ssh -i ~/path/to/key.key ubuntu@YOUR_VM_IP

# Check all services
systemctl status xvfb tradingview

# Watch live logs
tail -f /home/ubuntu/trading-data/overlap.log

# View trade history
cat /home/ubuntu/trading-data/trade_log/trades.csv

# ── All manual runs use run.sh ──
cd /home/ubuntu/tradingview-mcp-jackson

./run.sh scripts/trading/setup_finder.mjs   # manual scan
./run.sh scripts/weekly_review.mjs          # weekly audit
./run.sh scripts/trading/eod_close.mjs      # force close all positions
./run.sh scripts/backtest_uv.mjs            # any backtest

# Check output from any run (replace <name> with script name):
tail -f /tmp/<name>.log
cat  /tmp/<name>.log
```

---

*For a full explanation of what every component does, read `GREED.md`.*
