#!/bin/bash
# =============================================================================
#  TradingMCP — Install Linux Cron Jobs (mirrors Windows Task Scheduler setup)
#  Same 5 sessions, same times (Europe/London timezone).
#
#  USAGE:  bash scripts/cloud/install_cron_linux.sh
#  REMOVE: bash scripts/cloud/remove_cron_linux.sh
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SESSION_SCRIPT="$PROJECT_DIR/scripts/trading/session_runner.mjs"
LOG_DIR="$PROJECT_DIR/data/trade_log/scheduler_logs"
NODE_BIN="$(command -v node)"

if [ -z "$NODE_BIN" ]; then
    echo "ERROR: node not found. Run oracle_setup.sh first."
    exit 1
fi

mkdir -p "$LOG_DIR"

echo ""
echo "=== Installing TradingMCP Linux cron jobs ==="
echo ""
echo "Project: $PROJECT_DIR"
echo "Node:    $NODE_BIN"
echo "Logs:    $LOG_DIR"
echo ""

# Build the cron entry command — logs each run with timestamp in filename
CRON_CMD="cd $PROJECT_DIR && $NODE_BIN $SESSION_SCRIPT >> $LOG_DIR/session_\$(date +\%Y\%m\%d_\%H\%M).log 2>&1"

# --- Define cron schedule (Europe/London local time) -------------------------
# cron format: minute hour day month weekday
#   0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
#
# Times match the Windows Task Scheduler setup:
#   01:07 - Asian Open   (daily)
#   09:07 - London Open  (weekdays)
#   14:07 - NY Open      (weekdays, highest priority)
#   18:03 - London Close (weekdays)
#   04:03 - Research     (Sundays)

CRON_BLOCK="# TradingMCP — automated trading sessions (Europe/London time)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
# Asian Open — daily 01:07
7 1 * * *   $CRON_CMD
# London Open — weekdays 09:07
7 9 * * 1-5  $CRON_CMD
# NY Open — weekdays 14:07 (HIGHEST PRIORITY)
7 14 * * 1-5 $CRON_CMD
# London Close — weekdays 18:03
3 18 * * 1-5 $CRON_CMD
# Strategy Research — Sundays 04:03
3 4 * * 0   $CRON_CMD
# END TradingMCP"

# Remove any existing TradingMCP cron block, then add fresh
CURRENT_CRON=$(crontab -l 2>/dev/null | grep -v "TradingMCP" | grep -v "session_runner" || true)
echo "$CURRENT_CRON" > /tmp/tradingmcp_cron_tmp
echo "" >> /tmp/tradingmcp_cron_tmp
echo "$CRON_BLOCK" >> /tmp/tradingmcp_cron_tmp
crontab /tmp/tradingmcp_cron_tmp
rm /tmp/tradingmcp_cron_tmp

echo "Cron jobs installed:"
echo ""
crontab -l | grep -A1 "TradingMCP\|session_runner\|Asian\|London\|NY Open\|Research" | grep -v "^--$"

echo ""
echo "Verify with:  crontab -l"
echo "Live logs:    tail -f $LOG_DIR/session_*.log"
echo "To remove:    bash scripts/cloud/remove_cron_linux.sh"
echo ""
echo "NOTE: Cron uses the system timezone."
echo "      Current: $(timedatectl | grep 'Time zone')"
echo ""
