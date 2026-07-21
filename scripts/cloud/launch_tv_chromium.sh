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

# snap-confine on cgroup-v2 requires a reachable user D-Bus so `snap run` can
# place Chromium in a transient snap.chromium.* scope; without one every launch
# dies in ~2s with "<cgroup> is not a snap cgroup" (2026-07-19..21 outage: only
# worked historically when an SSH session happened to keep the user bus alive).
# `loginctl enable-linger ubuntu` keeps user@$(id -u).service + this bus socket
# up permanently, including at boot with no SSH session.
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
if [ ! -S "$XDG_RUNTIME_DIR/bus" ]; then
    echo "[launch] WARNING: user bus $XDG_RUNTIME_DIR/bus missing (linger disabled?) — snap chromium will likely fail to launch"
fi

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
# 120s deadline: under restart churn a cold snap-chromium start on this ARM box
# can take well over 30s — the old 30s cutoff created a LIVELOCK (2026-07-15/16:
# 96 watchdog restarts/day; every start was killed as "not ready" while still
# booting, and the churn kept the next start just as slow; scanner blind for two
# days). Bail out early only if the Chromium process itself has died.
echo "[launch] Waiting for CDP to become available..."
MAX_WAIT=120
COUNT=0
until curl -sf "http://127.0.0.1:$TV_CDP_PORT/json/version" > /dev/null 2>&1; do
    sleep 2
    COUNT=$((COUNT + 2))
    if ! kill -0 $CHROMIUM_PID 2>/dev/null; then
        echo "[launch] ERROR: Chromium process died after ${COUNT}s (see chromium.log)"
        exit 1
    fi
    if [ $COUNT -ge $MAX_WAIT ]; then
        echo "[launch] ERROR: CDP not ready after ${MAX_WAIT}s"
        exit 1
    fi
done

echo "[launch] CDP ready at http://127.0.0.1:$TV_CDP_PORT"
echo "[launch] TradingView Web is loading..."

# Keep script alive so systemd tracks the process
wait $XVFB_PID
