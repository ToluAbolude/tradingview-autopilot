/**
 * position_monitor.mjs
 * Polls open positions every 60s. When a position closes (TP or SL hit),
 * updates the trades.csv with result (W/L) and pnl.
 *
 * Run once per session after a trade is placed:
 *   node scripts/trading/position_monitor.mjs
 *
 * Exits automatically when no open positions remain or after MAX_HOURS.
 */
import { evaluate } from '../../src/connection.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const TRADES_CSV  = 'C:/Users/Tda-d/tradingview-autopilot/data/trade_log/trades.csv';
const POLL_MS     = 60_000;   // check every 60 seconds
const MAX_HOURS   = 12;       // auto-exit after 12h even if position still open
const MAX_TICKS   = (MAX_HOURS * 60 * 60 * 1000) / POLL_MS;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// ── Read open positions from TradingView broker panel ──
async function getOpenPositions() {
  return evaluate(`(function() {
    try {
      // Click Positions tab to ensure it's visible
      var tabs = document.querySelectorAll('button');
      for (var i = 0; i < tabs.length; i++) {
        if ((tabs[i].textContent || '').trim() === 'Positions') { tabs[i].click(); break; }
      }
    } catch(e) {}

    // Scrape positions table
    try {
      var rows = document.querySelectorAll('[class*="positionRow"], [class*="position-row"], tr[data-symbol]');
      if (rows.length === 0) {
        // Try generic table rows in the trading panel
        var panel = document.querySelector('[class*="bottomWidgetBar"], [class*="trading-panel"]');
        if (panel) rows = panel.querySelectorAll('tr');
      }
      var positions = [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var text = (row.textContent || '').trim();
        if (!text || text.length < 5) continue;
        // Extract symbol, qty, pnl from row text
        var cells = row.querySelectorAll('td');
        if (cells.length < 3) continue;
        var sym  = (cells[0] ? cells[0].textContent : '').trim().replace(/[^A-Z0-9]/g,'');
        var qty  = parseFloat((cells[1] ? cells[1].textContent : '0').replace(/[^0-9.-]/g,'')) || 0;
        var pnl  = parseFloat((cells[cells.length-1] ? cells[cells.length-1].textContent : '0').replace(/[^0-9.-]/g,'')) || 0;
        if (sym && qty !== 0) positions.push({ sym, qty, pnl, raw: text.substring(0, 100) });
      }

      // Fallback: check Positions count badge
      var badge = document.querySelector('[class*="positionCount"], [class*="position-count"]');
      var count = badge ? parseInt(badge.textContent) || 0 : positions.length;

      return { positions, count };
    } catch(e) {
      return { positions: [], count: 0, error: e.message };
    }
  })()`);
}

// ── Get account P&L summary from broker panel ──
async function getPnlSummary() {
  return evaluate(`(function() {
    var text = document.body.textContent || '';
    var eq   = text.match(/Equity[\\s\\n]*\\$?([\\d,\\.]+)/);
    var bal  = text.match(/Balance[\\s\\n]*\\$?([\\d,\\.]+)/);
    var pnl  = text.match(/(?:Unrealized|Open\\s+P\\/L|P\\/L)[\\s\\n]*(-?\\$?[\\d,\\.]+)/);
    return {
      equity:  eq  ? parseFloat(eq[1].replace(/,/g,''))  : null,
      balance: bal ? parseFloat(bal[1].replace(/,/g,'')) : null,
      openPnl: pnl ? parseFloat(pnl[1].replace(/[$,]/g,'')) : null,
    };
  })()`);
}

// ── Update the last trade entry in CSV with result + pnl ──
function updateLastTrade(result, pnl, notes) {
  if (!existsSync(TRADES_CSV)) return;
  const lines = readFileSync(TRADES_CSV, 'utf8').split('\n');

  // Find last non-empty row that has no result yet (col 10 = result)
  for (let i = lines.length - 1; i >= 1; i--) {
    const cols = lines[i].split(',');
    if (cols.length < 10) continue;
    if (cols[0].trim() === '') continue;
    if (cols[10] && cols[10].trim() !== '') continue; // already has result

    cols[10] = result;                          // W or L
    cols[11] = pnl != null ? String(pnl) : ''; // pnl
    if (notes) cols[12] = notes;
    lines[i] = cols.join(',');
    writeFileSync(TRADES_CSV, lines.join('\n'), 'utf8');
    log(`✓ CSV updated: row ${i} → result=${result} pnl=${pnl}`);
    return true;
  }
  return false;
}

// ── Main monitor loop ──
async function main() {
  log('=== POSITION MONITOR START ===');
  log(`Polling every ${POLL_MS/1000}s, max ${MAX_HOURS}h`);

  let prevCount  = null;
  let prevPnl    = null;
  let ticks      = 0;
  let openAtStart = null;

  while (ticks < MAX_TICKS) {
    ticks++;
    await sleep(ticks === 1 ? 3000 : POLL_MS); // first check after 3s, then every 60s

    let pos, pnlSummary;
    try {
      [pos, pnlSummary] = await Promise.all([getOpenPositions(), getPnlSummary()]);
    } catch(e) {
      log(`Poll error: ${e.message}`);
      continue;
    }

    const count = pos.count ?? pos.positions.length;
    const openPnl = pnlSummary.openPnl;

    if (openAtStart === null) {
      openAtStart = count;
      log(`Positions at start: ${count}`);
      if (count === 0) {
        log('No open positions. Nothing to monitor. Exiting.');
        return;
      }
    }

    // Detect position closed
    if (prevCount !== null && prevCount > 0 && count === 0) {
      // Position just closed — determine W/L from pnl delta
      const pnl = openPnl != null ? openPnl : null;
      const closedPnl = prevPnl != null ? prevPnl : pnl;
      const result = closedPnl == null ? '?' : closedPnl >= 0 ? 'W' : 'L';

      log(`Position CLOSED. Result: ${result} | Last PnL: ${closedPnl}`);
      updateLastTrade(result, closedPnl, `monitor_closed_${new Date().toISOString()}`);

      log('All positions closed. Exiting monitor.');
      return;
    }

    // Log heartbeat every 5 ticks
    if (ticks % 5 === 1 || count !== prevCount) {
      log(`Open: ${count} position(s) | P&L: ${openPnl != null ? openPnl : 'n/a'} | Equity: ${pnlSummary.equity ?? 'n/a'}`);
    }

    prevCount = count;
    prevPnl   = openPnl;
  }

  log(`Max time reached (${MAX_HOURS}h). Exiting without close confirmation.`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
