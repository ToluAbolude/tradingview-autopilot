#!/bin/bash
# =============================================================================
#  TradingMCP — Launch Xvfb + Chromium with TradingView Web
#  Used by the systemd service (tv_browser.service).
#  Can also be run manually for testing.
#
#  USAGE:
#    bash scripts/cloud/launch_tv_chromium.sh
# =============================================================================

set -e

# Load cloud config (written by oracle_setup.sh)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/cloud_config.sh" ]; then
    source "$SCRIPT_DIR/cloud_config.sh"
else
    # Fallback defaults
    CHROMIUM_BIN="${CHROMIUM_BIN:-chromium-browser}"
    TV_PROJECT_DIR="${TV_PROJECT_DIR:-/home/ubuntu/tradingview-autopilot}"
    TV_CDP_PORT="${TV_CDP_PORT:-9222}"
    TV_DISPLAY="${TV_DISPLAY:-:99}"
    TV_PROFILE_DIR="${TV_PROFILE_DIR:-/home/ubuntu/.config/chromium-trading}"
fi

LOG_DIR="$TV_PROJECT_DIR/data/trade_log/scheduler_logs"
mkdir -p "$LOG_DIR"
mkdir -p "$TV_PROFILE_DIR"

# --- Kill stale processes ----------------------------------------------------
echo "[launch] Cleaning up stale Xvfb/Chromium processes..."
pkill -f "Xvfb $TV_DISPLAY" 2>/dev/null || true
pkill -f "remote-debugging-port=$TV_CDP_PORT" 2>/dev/null || true
sleep 1

# --- Start Xvfb (virtual display) --------------------------------------------
echo "[launch] Starting Xvfb on display $TV_DISPLAY (1920x1080)..."
Xvfb "$TV_DISPLAY" -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
echo "[launch] Xvfb PID: $XVFB_PID"
sleep 2

# Verify Xvfb started
if ! kill -0 $XVFB_PID 2>/dev/null; then
    echo "[launch] ERROR: Xvfb failed to start"
    exit 1
fi

# --- Start Chromium with CDP -------------------------------------------------
echo "[launch] Starting Chromium with CDP on port $TV_CDP_PORT..."
export DISPLAY="$TV_DISPLAY"

$CHROMIUM_BIN \
    --remote-debugging-port=$TV_CDP_PORT \
    --remote-debugging-address=127.0.0.1 \
    --user-data-dir="$TV_PROFILE_DIR" \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --no-first-run \
    --no-default-browser-check \
    --disable-extensions \
    --disable-plugins \
    --disable-translate \
    --disable-background-networking \
    --disable-sync \
    --safebrowsing-disable-auto-update \
    --window-size=1920,1080 \
    --window-position=0,0 \
    --start-maximized \
    "https://www.tradingview.com/chart/" \
    >> "$LOG_DIR/chromium.log" 2>&1 &

CHROMIUM_PID=$!
echo "[launch] Chromium PID: $CHROMIUM_PID"

# --- Wait for CDP to become ready --------------------------------------------
echo "[launch] Waiting for CDP to become available..."
MAX_WAIT=30
COUNT=0
until curl -sf "http://127.0.0.1:$TV_CDP_PORT/json/version" > /dev/null 2>&1; do
    sleep 2
    COUNT=$((COUNT + 2))
    if [ $COUNT -ge $MAX_WAIT ]; then
        echo "[launch] ERROR: CDP not ready after ${MAX_WAIT}s"
        exit 1
    fi
done

echo "[launch] CDP ready at http://127.0.0.1:$TV_CDP_PORT"
echo "[launch] TradingView Web is loading..."

# Keep script alive so systemd tracks the process
wait $XVFB_PID
