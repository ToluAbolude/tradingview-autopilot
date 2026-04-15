#!/bin/bash
# =============================================================================
#  TradingMCP — Install systemd service (tv_browser)
#  Enables TradingView Web + Xvfb to start automatically on VM boot.
#
#  USAGE:  sudo bash scripts/cloud/install_services.sh
#  REMOVE: sudo bash scripts/cloud/remove_services.sh
# =============================================================================

set -e

SERVICE_NAME="tv_browser"
SERVICE_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${SERVICE_NAME}.service"
SERVICE_DEST="/etc/systemd/system/${SERVICE_NAME}.service"
LAUNCH_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/launch_tv_chromium.sh"

if [ "$EUID" -ne 0 ]; then
    echo "Run as root: sudo bash $0"
    exit 1
fi

echo ""
echo "=== Installing TradingMCP systemd service ==="
echo ""

# Make launch script executable
chmod +x "$LAUNCH_SCRIPT"
echo "  OK  Made launch script executable"

# Copy service file
cp "$SERVICE_SRC" "$SERVICE_DEST"
echo "  OK  Service file copied to $SERVICE_DEST"

# Reload, enable, start
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
echo "  OK  Service enabled (will start on boot)"

systemctl start "$SERVICE_NAME"
sleep 5

# Check status
STATUS=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null)
if [ "$STATUS" = "active" ]; then
    echo "  OK  Service is RUNNING"
else
    echo "  WARN: Service status: $STATUS"
    echo "        Check logs: journalctl -u $SERVICE_NAME -n 30"
fi

echo ""
echo "Useful commands:"
echo "  journalctl -u tv_browser -f          -- live logs"
echo "  systemctl status tv_browser          -- status"
echo "  systemctl restart tv_browser         -- restart"
echo "  systemctl stop tv_browser            -- stop"
echo "  curl http://localhost:9222/json/version  -- verify CDP"
echo ""
