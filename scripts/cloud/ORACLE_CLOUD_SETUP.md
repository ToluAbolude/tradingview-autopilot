# TradingMCP — Oracle Cloud Free Tier Setup Guide

Runs the full automated trading system 24/7 on Oracle Cloud's **always-free** ARM VM.
No PC required. No time limit. No cost.

---

## What you get

- Oracle Cloud ARM VM (4 CPU, 24 GB RAM) — always free
- TradingView Web (tradingview.com) running in headless Chromium
- Xvfb virtual display — no monitor needed
- Same 5 trading sessions as the Windows setup, same times
- All logs, trades.csv, and strategy research written to the VM

---

## Step 1 — Create Oracle Cloud account + VM

1. Go to **cloud.oracle.com** and create a free account (credit card required but never charged on free tier)
2. Once logged in: **Compute → Instances → Create Instance**
3. Settings:
   - **Image**: Ubuntu 22.04 (Canonical)
   - **Shape**: `VM.Standard.A1.Flex` (ARM) — click *Change Shape*, select Ampere, set **4 OCPUs + 24 GB RAM**
   - **SSH keys**: Upload your public key or generate one (save the private key)
   - **Boot volume**: 50 GB (free allowance is 200 GB total)
4. Click **Create** — VM will be ready in ~2 minutes
5. Note the **Public IP address** shown on the instance page

---

## Step 2 — Open firewall (Security List)

Oracle blocks all ports by default. You only need port 22 (SSH).

1. Instance page → **Primary VNIC** → **Subnet** → **Security List**
2. **Ingress Rules** — confirm port 22 TCP is allowed (it should be)
3. Port 9222 (CDP) does **NOT** need to be open — it stays internal

---

## Step 3 — Copy project to the VM

**Option A — from GitHub (recommended):**
```bash
# On the VM (after SSH in)
git clone https://github.com/YOUR_USERNAME/tradingview-autopilot.git ~/tradingview-autopilot
```

**Option B — copy from your Windows PC:**
```bash
# Run this on your Windows PC (Git Bash / PowerShell)
scp -r "C:/Users/Tda-d/tradingview-autopilot" ubuntu@<your-vm-ip>:~/
```

---

## Step 4 — SSH into the VM

```bash
ssh ubuntu@<your-vm-ip>
```

---

## Step 5 — Run the one-time setup script

```bash
cd ~/tradingview-autopilot
chmod +x scripts/cloud/oracle_setup.sh
sudo bash scripts/cloud/oracle_setup.sh
```

This installs Node.js, Chromium, Xvfb, sets timezone to Europe/London, and creates all needed directories (~5 minutes).

---

## Step 6 — Install the browser service (auto-start on boot)

```bash
sudo bash scripts/cloud/install_services.sh
```

Verify it's running:
```bash
systemctl status tv_browser
curl http://localhost:9222/json/version
```

You should see a JSON response with Chromium version info.

---

## Step 7 — One-time TradingView login via VNC

You need to log in to TradingView and connect BlackBull Markets once. After that, the session is saved permanently.

**On the VM:**
```bash
bash scripts/cloud/setup_login_vnc.sh
```
Enter a temporary VNC password when prompted.

**On your Windows PC — open a new terminal and run:**
```bash
ssh -L 5900:localhost:5900 ubuntu@<your-vm-ip>
```
Keep this terminal open (it's an SSH tunnel).

**Then open a VNC viewer on your PC:**
- Free VNC viewers: **RealVNC Viewer**, **TigerVNC**, **UltraVNC**
- Connect to: `localhost:5900`
- Password: what you entered above

**In the VNC window, you'll see Chromium with TradingView:**
1. Log in to your TradingView account
2. Open the Trading Panel: Chart → bottom toolbar → **Connect a broker**
3. Select **BlackBull Markets** and log in with your demo credentials
4. Confirm a chart is showing with BlackBull data (bid/ask prices visible)

**Back on the VM terminal — press ENTER** to close VNC.

Your login is now saved in the Chromium profile at `/home/ubuntu/.config/chromium-trading`.

---

## Step 8 — Install cron jobs (trading schedule)

```bash
bash scripts/cloud/install_cron_linux.sh
```

Verify:
```bash
crontab -l
```

Expected output:
```
# TradingMCP — automated trading sessions (Europe/London time)
7 1 * * *    ...  # Asian Open
7 9 * * 1-5  ...  # London Open
7 14 * * 1-5 ...  # NY Open
3 18 * * 1-5 ...  # London Close
3 4 * * 0    ...  # Research
```

---

## Step 9 — Verify everything end-to-end

```bash
# Check browser is running and CDP is live
curl http://localhost:9222/json/version

# Do a manual test run of the session runner
cd ~/tradingview-autopilot
node scripts/trading/session_runner.mjs
```

Watch the output — it should go through: news check → scan → setup found → trade placed.

---

## Monitoring & logs

```bash
# Live browser service logs
journalctl -u tv_browser -f

# Latest trading session log
ls -t ~/tradingview-autopilot/data/trade_log/scheduler_logs/ | head -5
tail -f ~/tradingview-autopilot/data/trade_log/scheduler_logs/<latest>.log

# trades.csv
cat ~/tradingview-autopilot/data/trade_log/trades.csv
```

---

## Control commands

| Action | Command |
|--------|---------|
| Stop browser service | `sudo systemctl stop tv_browser` |
| Start browser service | `sudo systemctl start tv_browser` |
| Restart browser | `sudo systemctl restart tv_browser` |
| Disable auto-start | `sudo systemctl disable tv_browser` |
| Re-enable auto-start | `sudo systemctl enable tv_browser` |
| Remove service entirely | `sudo bash scripts/cloud/remove_services.sh` |
| Remove cron jobs | `bash scripts/cloud/remove_cron_linux.sh` |
| Re-add cron jobs | `bash scripts/cloud/install_cron_linux.sh` |

---

## Keeping login alive

TradingView sessions can expire after ~30 days. If trades stop working:

1. SSH into VM
2. Run `bash scripts/cloud/setup_login_vnc.sh` again
3. Re-authenticate in the VNC browser window

To avoid this, TradingView Pro/Pro+ accounts stay logged in longer. The free account may need periodic re-login.

---

## GMT/BST clock changes

The VM timezone is set to `Europe/London` by `oracle_setup.sh`, so cron times automatically shift with UK clock changes (same as your PC). No manual adjustment needed.

---

## Differences from Windows setup

| | Windows PC | Oracle Cloud |
|--|-----------|-------------|
| TradingView | Desktop app (Electron) | Web app (Chromium) |
| Scheduler | Windows Task Scheduler | Linux cron |
| Auto-start | Windows Startup folder | systemd service |
| Display | Physical monitor | Xvfb virtual display |
| CDP selectors | Same | Same (Electron wraps web app) |
| Login persistence | Windows session | Chromium profile directory |
| Cost | £0 (your PC) | £0 (Oracle Always Free) |

Both setups are fully independent — either can run alone or both can run simultaneously.
