#!/bin/bash
# scanner_freshness_check.sh
# Cron-driven sanity guard. Auto-restarts market_scanner.mjs when any code
# file the scanner depends on is newer than the scanner's own start time.
#
# Closes the silent-stale-process hole that caused the 2026-05-29 overnight
# WTI loss cluster: code "deployed" via scp but never picked up by the
# running long-lived node process.
#
# Logic:
#   1. Find scanner PID + its start epoch
#   2. Find newest mtime across watched code files
#   3. If newest_code_mtime > scanner_start_epoch → restart
#   4. Log every action to /home/ubuntu/trading-data/scanner_freshness.log
#
# Run by cron every 5 minutes. Idempotent. Safe to run any time.
set -u

PROJECT_ROOT="/home/ubuntu/tradingview-mcp-jackson"
DATA_ROOT="/home/ubuntu/trading-data"
LOG_FILE="${DATA_ROOT}/scanner_freshness.log"
LOCK_FILE="/tmp/scanner_freshness.lock"
ENV_FILE="/home/ubuntu/.ctrader_env"
SCANNER_PATTERN="market_scanner.mjs"

WATCH_FILES=(
  "${PROJECT_ROOT}/scripts/trading/market_scanner.mjs"
  "${PROJECT_ROOT}/scripts/trading/setup_finder.mjs"
  "${PROJECT_ROOT}/scripts/trading/inline_trader.mjs"
  "${PROJECT_ROOT}/scripts/trading/broker_ctrader.mjs"
  "${PROJECT_ROOT}/scripts/trading/confluence.mjs"
  "${PROJECT_ROOT}/scripts/trading/score.mjs"
)

mkdir -p "${DATA_ROOT}"
log() { printf '[%s] %s\n' "$(date -u -Iseconds)" "$*" >> "${LOG_FILE}"; }

# Refuse to run concurrently.
exec 9>"${LOCK_FILE}" || exit 0
flock -n 9 || { log "another check holds the lock — skip"; exit 0; }

# ── Function: start a new scanner ──────────────────────────────────────────
start_scanner() {
  cd "${PROJECT_ROOT}" || { log "  cd to project root failed"; return 1; }

  # Source CTRADER_* env vars. Prefer the env file (persistent, secure).
  # Falls back to grabbing them from a still-running scanner's /proc/<pid>/environ.
  if [ -r "${ENV_FILE}" ]; then
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
  fi

  if [ -z "${CTRADER_REFRESH_TOKEN:-}" ]; then
    log "  ✗ no CTRADER_REFRESH_TOKEN in env or ${ENV_FILE} — cannot start scanner"
    return 1
  fi

  nohup env \
    BROKER_PROVIDER=ctrader \
    CTRADER_ENV="${CTRADER_ENV:-demo}" \
    CTRADER_REFRESH_TOKEN="${CTRADER_REFRESH_TOKEN}" \
    CTRADER_ACCESS_TOKEN="${CTRADER_ACCESS_TOKEN}" \
    CTRADER_CLIENT_SECRET="${CTRADER_CLIENT_SECRET}" \
    CTRADER_ACCOUNT_ID="${CTRADER_ACCOUNT_ID}" \
    CTRADER_CLIENT_ID="${CTRADER_CLIENT_ID}" \
    DISPLAY=:1 \
    node scripts/trading/market_scanner.mjs \
    >> "${DATA_ROOT}/scanner.log" 2>&1 < /dev/null &
  disown || true

  sleep 4
  local new_pid=""
  for candidate in $(pgrep -f "${SCANNER_PATTERN}" 2>/dev/null); do
    local cm
    cm="$(cat "/proc/${candidate}/comm" 2>/dev/null || echo "")"
    if [ "${cm}" = "node" ]; then new_pid="${candidate}"; break; fi
  done
  if [ -n "${new_pid}" ]; then
    log "  ✓ scanner restarted, new pid=${new_pid}"
    return 0
  else
    log "  ✗ scanner failed to start — check scanner.log"
    return 1
  fi
}

# ── Main ───────────────────────────────────────────────────────────────────
PID=""
for candidate in $(pgrep -f "${SCANNER_PATTERN}" 2>/dev/null); do
  comm="$(cat "/proc/${candidate}/comm" 2>/dev/null || echo "")"
  if [ "${comm}" = "node" ]; then PID="${candidate}"; break; fi
done

if [ -z "${PID}" ]; then
  log "scanner NOT running — starting fresh"
  start_scanner
  exit $?
fi

# Scanner start time (epoch)
if [ -r "/proc/${PID}/stat" ] && [ -r "/proc/stat" ]; then
  CLK_TCK="$(getconf CLK_TCK)"
  BOOT_EPOCH="$(awk '/^btime/ {print $2}' /proc/stat)"
  START_TICKS="$(awk '{print $22}' /proc/${PID}/stat 2>/dev/null || echo 0)"
  SCANNER_START_EPOCH=$(( BOOT_EPOCH + START_TICKS / CLK_TCK ))
else
  SCANNER_START_EPOCH="$(date -d "$(ps -o lstart= -p "${PID}")" +%s 2>/dev/null || echo 0)"
fi

# Newest watched file
NEWEST_CODE_EPOCH=0
NEWEST_CODE_FILE=""
for f in "${WATCH_FILES[@]}"; do
  if [ -f "${f}" ]; then
    M="$(stat -c %Y "${f}")"
    if [ "${M}" -gt "${NEWEST_CODE_EPOCH}" ]; then
      NEWEST_CODE_EPOCH="${M}"
      NEWEST_CODE_FILE="${f}"
    fi
  fi
done

if [ "${NEWEST_CODE_EPOCH}" -le "${SCANNER_START_EPOCH}" ]; then
  # Code older than scanner — quiet exit, don't spam log.
  exit 0
fi

DELTA=$(( NEWEST_CODE_EPOCH - SCANNER_START_EPOCH ))
log "STALE scanner pid=${PID} started @ $(date -u -d "@${SCANNER_START_EPOCH}" -Iseconds)"
log "  newest code: ${NEWEST_CODE_FILE} @ $(date -u -d "@${NEWEST_CODE_EPOCH}" -Iseconds)"
log "  code is ${DELTA}s newer — restarting"

kill -SIGTERM "${PID}" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "${PID}" 2>/dev/null; then break; fi
  sleep 1
done
if kill -0 "${PID}" 2>/dev/null; then
  log "  SIGTERM didn't take after 10s — escalating to SIGKILL"
  kill -SIGKILL "${PID}" 2>/dev/null || true
  sleep 2
fi

start_scanner
exit $?
