#!/bin/bash
# =============================================================================
#  TradingMCP — Remove Linux Cron Jobs
#  Removes all TradingMCP trading session cron jobs.
#
#  USAGE:  bash scripts/cloud/remove_cron_linux.sh
# =============================================================================

echo ""
echo "Removing TradingMCP cron jobs..."

CURRENT=$(crontab -l 2>/dev/null || true)
CLEANED=$(echo "$CURRENT" | grep -v "TradingMCP" | grep -v "session_runner" | grep -v "Asian Open\|London Open\|NY Open\|London Close\|Strategy Research")

if [ "$CURRENT" = "$CLEANED" ]; then
    echo "  No TradingMCP cron jobs found — nothing to remove."
else
    echo "$CLEANED" | crontab -
    echo "  OK  All TradingMCP cron jobs removed."
fi

echo ""
echo "To reinstall: bash scripts/cloud/install_cron_linux.sh"
echo ""
