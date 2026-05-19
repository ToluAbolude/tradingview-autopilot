/**
 * position_monitor.mjs
 * Polls open positions every 60s. When a position closes (TP or SL hit),
 * updates trades.csv with result (W/L) and pnl.
 *
 * Spawned by session_runner.mjs after a trade is placed (detached, logs to file).
 */
import { evaluate } from '../../src/connection.js';
import { closeAllPositions } from './execute_trade.mjs';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const TRADES_CSV  = join(DATA_ROOT, 'trade_log', 'trades.csv');
const MONITOR_LOG = join(DATA_ROOT, 'position_monitor.log');

const POLL_MS        = 60_000;
const FIRST_DELAY_MS = 30_000;
const EOD_CLOSE_HOUR = 20;  // UTC

const args       = Object.fromEntries(process.argv.slice(2).map(a => a.replace('--','').split('=')));
const SYMBOL     = (args.symbol || '').toUpperCase();
const ENTRY_PRICE = parseFloat(args.entry) || null;
const NUM_ORDERS  = parseInt(args.numOrders) || 1;
const TRADE_TIME  = args.tradeTime || null;

try { mkdirSync(join(DATA_ROOT, 'trade_log'), { recursive: true }); } catch(_) {}

function log(msg) {
  const line = `[${new Date().toISOString()}] [${SYMBOL}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(MONITOR_LOG, line); } catch(_) {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Read open positions directly from the BlackBull positions table ──
// Returns array of {symbol, side, qty, profit, positionId} for all open positions.
// This is far more reliable than equity≈balance comparison which fires falsely
// when multiple positions are flat simultaneously.
async function getOpenPositions() {
  // Click Positions tab
  await evaluate(`(function() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if ((btns[i].textContent || '').trim() === 'Positions') { btns[i].click(); break; }
    }
  })()`);
  await sleep(800);

  return evaluate(`(function() {
    var noPos = /there are no open po/i.test(document.body.innerText || '');
    if (noPos) return JSON.stringify([]);

    var rows = Array.from(document.querySelectorAll('tr'));
    var positions = [];
    rows.forEach(function(row) {
      var text = (row.innerText || '').replace(/\\s+/g, ' ').trim();
      // Row must contain a recognisable symbol and Short/Long indicator
      if (!/(Short|Long)/i.test(text)) return;
      if (text.length < 10) return;
      // Extract fields: Symbol Side Qty TP SL Profit ... PositionID
      var symMatch  = text.match(/^([A-Z0-9]{3,10})/);
      var sideMatch = text.match(/(Short|Long)/i);
      var idMatch   = text.match(/(\\d{7,})/g);
      var profMatch = text.match(/([+-]?\\d+\\.?\\d*)\\s*USD/i);
      if (!symMatch || !sideMatch) return;
      // Strip trailing S/L that gets merged when panel renders direction without whitespace
      var rawSym = symMatch[1];
      var sym = (rawSym.length > 6 && /^[SL]$/.test(rawSym.slice(-1))) ? rawSym.slice(0, -1) : rawSym;
      positions.push({
        symbol:     sym,
        side:       sideMatch[1].toLowerCase(),
        positionId: idMatch ? idMatch[idMatch.length - 1] : null,
        profit:     profMatch ? parseFloat(profMatch[1]) : null,
        raw:        text.substring(0, 80)
      });
    });
    return JSON.stringify(positions);
  })()`);
}

// ── Check if this monitor's symbol still has an open position ──
async function symbolHasOpenPosition() {
  try {
    const json = await getOpenPositions();
    const positions = JSON.parse(json || '[]');
    const mine = positions.filter(p => p.symbol.toUpperCase() === SYMBOL || p.symbol.toUpperCase().startsWith(SYMBOL));
    return { found: mine.length > 0, positions: mine, all: positions };
  } catch(e) {
    log(`getOpenPositions error: ${e.message}`);
    return { found: true, positions: [], all: [] }; // assume still open on error
  }
}

// ── Get account balance ──
async function getBalance() {
  return evaluate(`(function() {
    var titles = document.querySelectorAll('[class*="title-"]');
    for (var i = 0; i < titles.length; i++) {
      if ((titles[i].textContent||'').trim() === 'Account Balance') {
        var row = titles[i].parentElement;
        if (!row) continue;
        var valEl = row.querySelector('[class*="value-"]');
        if (valEl) return parseFloat((valEl.textContent||'').replace(/,/g,''));
      }
    }
    // Fallback: parse from body text
    var m = (document.body.innerText||'').match(/Account Balance\\s*\\n\\s*([\\d,]+\\.?\\d*)/);
    if (m) return parseFloat(m[1].replace(/,/g,''));
    return null;
  })()`);
}

// ── Update the trade row in CSV ──
function updateLastTrade(result, pnl, note) {
  if (!existsSync(TRADES_CSV)) { log(`CSV not found: ${TRADES_CSV}`); return false; }
  const lines = readFileSync(TRADES_CSV, 'utf8').split('\n');
  const suffix = `;monitor_${note}_${new Date().toISOString()}`;

  if (TRADE_TIME) {
    const prefix = TRADE_TIME.slice(0, 19);
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].startsWith(prefix)) continue;
      const cols = lines[i].split(',');
      if (cols[10] && cols[10].trim() !== '') {
        log(`Row ${i} already has result=${cols[10]} — skipping`);
        return false;
      }
      cols[10] = result;
      cols[11] = pnl != null ? String(pnl) : '';
      cols[12] = (cols[12] || '').trim() + suffix;
      lines[i] = cols.join(',');
      writeFileSync(TRADES_CSV, lines.join('\n'), 'utf8');
      log(`✓ CSV row ${i} updated → result=${result} pnl=${pnl}`);
      return true;
    }
    log(`Warning: row with timestamp ${TRADE_TIME.slice(0,19)} not found — using fallback`);
  }

  for (let i = lines.length - 1; i >= 1; i--) {
    const cols = lines[i].split(',');
    if (cols.length < 10 || !cols[0].trim()) continue;
    if ((cols[2] || '').trim() === 'NONE') continue;
    if (cols[10] && cols[10].trim() !== '') continue;
    cols[10] = result;
    cols[11] = pnl != null ? String(pnl) : '';
    cols[12] = (cols[12] || '').trim() + suffix;
    lines[i] = cols.join(',');
    writeFileSync(TRADES_CSV, lines.join('\n'), 'utf8');
    log(`✓ CSV row ${i} updated (fallback) → result=${result} pnl=${pnl}`);
    return true;
  }
  log('No unresolved trade row found.');
  return false;
}

// ── Main ──
async function main() {
  log('=== POSITION MONITOR START ===');
  if (!SYMBOL) { log('ERROR: --symbol not provided. Exiting.'); return; }
  log(`Watching symbol=${SYMBOL} entry=${ENTRY_PRICE} orders=${NUM_ORDERS}`);

  let ticks         = 0;
  let tp1Triggered  = false;
  let baseBalance   = null;
  let prevPositions = null;

  while (true) {
    ticks++;
    await sleep(ticks === 1 ? FIRST_DELAY_MS : POLL_MS);

    // EOD hard close
    const now = new Date();
    if (now.getUTCHours() >= EOD_CLOSE_HOUR) {
      log(`⏰ EOD CLOSE (${now.getUTCHours()}:${String(now.getUTCMinutes()).padStart(2,'0')} UTC)`);
      const { found } = await symbolHasOpenPosition();
      if (found) {
        try { await closeAllPositions(); log('EOD close executed.'); }
        catch(e) { log(`EOD close error: ${e.message}`); }
        await sleep(3000);
      }
      const bal = await getBalance().catch(() => null);
      const pnl = bal != null && baseBalance != null
        ? Math.round((bal - baseBalance) * 100) / 100 : null;
      updateLastTrade(pnl != null ? (pnl >= 0 ? 'W' : 'L') : '?', pnl, 'eod_close');
      log('EOD done. Exiting.');
      return;
    }

    let state;
    try {
      state = await symbolHasOpenPosition();
    } catch(e) {
      log(`Poll error: ${e.message}`);
      continue;
    }

    log(`tick=${ticks} ${SYMBOL}_open=${state.found} positions=[${state.positions.map(p=>p.positionId).join(',')}] all_open=${state.all.length}`);

    // First tick: confirm position is actually open
    if (ticks === 1) {
      if (!state.found) {
        log(`${SYMBOL} not found in positions on first tick — waiting 2 more ticks`);
        prevPositions = state;
        continue;
      }
      baseBalance = await getBalance().catch(() => null);
      log(`Position confirmed. Base balance: ${baseBalance}`);
      prevPositions = state;
      continue;
    }

    // Ticks 2-3: give broker panel time to stabilise before acting on "not found"
    if (ticks <= 3 && !state.found && prevPositions && !prevPositions.found) {
      log(`${SYMBOL} still not found on tick ${ticks} — exiting (order may have been rejected)`);
      return;
    }

    // TP1 partial close detection: one fewer position than before for this symbol
    if (NUM_ORDERS >= 2 && !tp1Triggered && prevPositions?.found && state.found) {
      const prevCount = prevPositions.positions.length;
      const currCount = state.positions.length;
      if (currCount < prevCount) {
        tp1Triggered = true;
        log(`⚡ TP1 HIT (${prevCount} → ${currCount} positions for ${SYMBOL})`);
        if (ENTRY_PRICE) log(`⚡ Consider moving SL to breakeven (${ENTRY_PRICE})`);
      }
    }

    // Position closed: was open, now gone
    if (prevPositions?.found && !state.found) {
      const bal = await getBalance().catch(() => null);
      const pnl = bal != null && baseBalance != null
        ? Math.round((bal - baseBalance) * 100) / 100 : null;
      const result = pnl != null ? (pnl >= 0 ? 'W' : 'L') : '?';
      log(`POSITION CLOSED → result=${result} pnl=${pnl}`);
      updateLastTrade(result, pnl, 'closed');
      log('Done. Exiting.');
      return;
    }

    prevPositions = state;
    if (baseBalance === null) baseBalance = await getBalance().catch(() => null);
  }
}

main().catch(e => {
  log(`Fatal: ${e.message}`);
  process.exit(1);
});
