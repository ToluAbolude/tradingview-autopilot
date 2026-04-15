#!/bin/bash
# =============================================================================
#  TradingMCP — One-Time TradingView Login via VNC
#  Run this ONCE to log in to TradingView + connect BlackBull Markets.
#  After login, credentials are saved in the Chromium profile and persist forever.
#
#  USAGE (from your LOCAL machine):
#    Step 1: On the VM — bash scripts/cloud/setup_login_vnc.sh
#    Step 2: On your PC — ssh -L 5900:localhost:5900 ubuntu@<your-vm-ip>
#    Step 3: On your PC — open a VNC viewer, connect to localhost:5900
#    Step 4: Log in to TradingView in the browser you see
#    Step 5: Connect BlackBull Markets broker inside TradingView
#    Step 6: Press ENTER in the VM terminal to stop VNC
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/cloud_config.sh" ]; then
    source "$SCRIPT_DIR/cloud_config.sh"
else
    TV_DISPLAY=":99"
    TV_PROFILE_DIR="/home/ubuntu/.config/chromium-trading"
    CHROMIUM_BIN="${CHROMIUM_BIN:-chromium-browser}"
fi

VNC_PORT=5900
VNC_PASS_FILE="/tmp/vncpass"

echo ""
echo "=== TradingMCP One-Time Login Setup ==="
echo ""

# Ensure Xvfb is running on the right display
if ! pgrep -f "Xvfb $TV_DISPLAY" > /dev/null; then
    echo "Starting Xvfb..."
    Xvfb "$TV_DISPLAY" -screen 0 1920x1080x24 -ac &
    sleep 2
fi

export DISPLAY="$TV_DISPLAY"

# Start fluxbox window manager (so browser renders correctly)
if ! pgrep fluxbox > /dev/null; then
    echo "Starting fluxbox..."
    fluxbox &>/dev/null &
    sleep 1
fi

# Start x11vnc with a simple password
echo ""
echo "Enter a temporary VNC password (min 6 chars):"
read -s VNC_PASS
echo "$VNC_PASS" | x11vnc -storepasswd "$VNC_PASS" "$VNC_PASS_FILE" 2>/dev/null
echo ""

echo "Starting VNC server on port $VNC_PORT..."
x11vnc -display "$TV_DISPLAY" -rfbauth "$VNC_PASS_FILE" -rfbport $VNC_PORT -forever -bg -quiet

echo ""
echo "================================================================"
echo "  VNC is running. On your LOCAL machine, run:"
echo ""
echo "    ssh -L 5900:localhost:5900 ubuntu@<your-vm-ip>"
echo ""
echo "  Then open a VNC viewer and connect to:  localhost:5900"
echo "  Password: the one you just entered"
echo ""
echo "  In the VNC window:"
echo "    1. TradingView should be open in Chromium"
echo "    2. Log in to your TradingView account"
echo "    3. Connect BlackBull Markets as your broker"
echo "       (Chart -> Trading Panel -> BlackBull Markets -> Log in)"
echo "    4. Confirm the chart is on a symbol with BlackBull data"
echo ""
echo "  When done, press ENTER here to stop VNC."
echo "================================================================"
echo ""

read -p "Press ENTER when login is complete..."

# Stop VNC
pkill x11vnc 2>/dev/null || true
rm -f "$VNC_PASS_FILE"

echo ""
echo "VNC stopped. Login credentials saved to Chromium profile."
echo "The trading sessions will now use your saved login automatically."
echo ""
echo "Verify the session is ready:"
echo "  curl http://localhost:9222/json/version"
echo ""
