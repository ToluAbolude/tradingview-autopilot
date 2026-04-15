#!/bin/bash
# =============================================================================
#  TradingMCP — Remove systemd service (tv_browser)
#  Stops and uninstalls the auto-start browser service.
#
#  USAGE:  sudo bash scripts/cloud/remove_services.sh
# =============================================================================

set -e

if [ "$EUID" -ne 0 ]; then
    echo "Run as root: sudo bash $0"
    exit 1
fi

SERVICE_NAME="tv_browser"

echo ""
echo "Removing TradingMCP systemd service..."
echo ""

systemctl stop    "$SERVICE_NAME" 2>/dev/null && echo "  OK  Stopped" || echo "  --  Already stopped"
systemctl disable "$SERVICE_NAME" 2>/dev/null && echo "  OK  Disabled" || echo "  --  Already disabled"
rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
echo "  OK  Service file removed"
echo ""
echo "TradingView browser will no longer auto-start."
echo "To reinstall: sudo bash scripts/cloud/install_services.sh"
echo ""
