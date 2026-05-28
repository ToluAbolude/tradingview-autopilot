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
const SL_PRICE    = parseFloat(args.sl)    || null;   // for trail-distance calc
const NUM_ORDERS  = parseInt(args.numOrders) || 1;
const TRADE_TIME  = args.tradeTime || null;
const MONITOR_START_MS = Date.now();   // for cTrader deal-history filtering

const USE_CTRADER = process.env.BROKER_PROVIDER === 'ctrader';

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

// ── PnL resolution ──────────────────────────────────────────────────────────
// Truth-source PnL via cTrader Open API when BROKER_PROVIDER=ctrader.
// Falls back to TV balance-delta on any error (still better than nothing,
// even with its known cross-trade attribution bug).
//
// This is the fix for last night's wrong trades.csv rows: balance-delta over
// a window pollutes one trade's PnL with another concurrent trade's outcome.
// cTrader's deal history gives the EXACT close price and grossProfit per
// position, so we sum only the closing deals for THIS monitor's symbol that
// occurred during the monitor's lifetime.
async function resolvePnl(_reason) {
  if (USE_CTRADER) {
    try {
      const bridge = await import('./broker_ctrader.mjs');
      const r = await bridge.getRecentClosePnl(SYMBOL, MONITOR_START_MS - 5000);
      log(`PnL via cTrader: net=${r.netPnl} from ${r.count} closing deal(s)`);
      if (r.count > 0) return r.netPnl;
      // No deals found yet → fall through to balance-delta as a backstop
    } catch (e) {
      log(`PnL cTrader lookup failed: ${e.message} — falling back to balance-delta`);
    }
  }
  const bal = await getBalance().catch(() => null);
  return bal != null && baseBalance != null
    ? Math.round((bal - baseBalance) * 100) / 100
    : null;
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
  let tp2Triggered  = false;
  let baseBalance   = null;
  let prevPositions = null;
  let initialCtraderVol = null;   // captured on first cTrader poll
  let volAfterTp1       = null;   // captured when first shrink seen; next shrink = TP2
  let cTraderPositionId = null;   // remembered after first cTrader read; needed for SL modify

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
      const pnl = await resolvePnl('eod_close');
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
      log(`${SYMBOL} still not found on tick ${ticks} — broker silently rejected order. Marking VOID.`);
      updateLastTrade('VOID', 0, 'BROKER_SILENT_REJECT_not_in_positions');
      return;
    }

    // TP1 partial-close detection (Approach A path): one fewer position than before
    if (NUM_ORDERS >= 2 && !tp1Triggered && prevPositions?.found && state.found) {
      const prevCount = prevPositions.positions.length;
      const currCount = state.positions.length;
      if (currCount < prevCount) {
        tp1Triggered = true;
        log(`⚡ TP1 HIT (${prevCount} → ${currCount} positions for ${SYMBOL}) — synthetic BE armed`);
      }
    }

    // cTrader Approach B path: single position shrinks in volume as each TP
    // limit fills. We watch for two shrink events:
    //   1st shrink = TP1 → move broker SL to entry (true broker-side breakeven)
    //   2nd shrink = TP2 → enable cTrader trailing stop on the remaining runner
    if (USE_CTRADER) {
      try {
        const bridge = await import('./broker_ctrader.mjs');
        const currentVol = await bridge.getOpenVolumeForSymbol(SYMBOL);

        // First poll — snapshot baseline and capture positionId for SL modifies
        if (initialCtraderVol === null && currentVol > 0) {
          initialCtraderVol = currentVol;
          log(`cTrader initial volume for ${SYMBOL}: ${currentVol}`);
          try {
            // Pick the most recently opened position whose volume matches our
            // baseline. The bot only runs one position per symbol at a time,
            // so the largest positionId with matching volume is ours.
            const positions = await bridge.getPositions();
            const candidates = positions
              .filter(p => p.volumeCents === initialCtraderVol)
              .sort((a, b) => b.positionId - a.positionId);
            if (candidates.length > 0) cTraderPositionId = candidates[0].positionId;
            log(`cTrader positionId captured: ${cTraderPositionId} (from ${positions.length} open)`);
          } catch (e) { log(`positionId capture failed: ${e.message}`); }
        }

        // TP1: first volume shrink → move SL to entry (broker-side BE)
        else if (!tp1Triggered && initialCtraderVol != null && currentVol > 0 && currentVol < initialCtraderVol) {
          tp1Triggered = true;
          volAfterTp1 = currentVol;
          log(`⚡ TP1 HIT via cTrader volume shrink ${initialCtraderVol} → ${currentVol}`);
          if (cTraderPositionId && ENTRY_PRICE) {
            try {
              await bridge.setBreakeven(cTraderPositionId, ENTRY_PRICE);
              log(`🛡 Broker SL moved to entry ${ENTRY_PRICE} (true breakeven)`);
            } catch (e) { log(`setBreakeven failed: ${e.message} — synthetic BE remains as fallback`); }
          } else {
            log(`⚠ No positionId or entry — broker BE skipped; synthetic BE fallback only`);
          }
        }

        // TP2: second volume shrink → arm cTrader trailing stop with a REAL
        // trail distance. After TP1, broker SL was moved to entry (BE) — if we
        // just flip trailingStopLoss on now, trail distance = 0 → instant close
        // on the next adverse tick (broken). Instead: move SL to give the trail
        // half-an-R worth of room, THEN enable trailing.
        else if (tp1Triggered && !tp2Triggered && volAfterTp1 != null && currentVol > 0 && currentVol < volAfterTp1) {
          tp2Triggered = true;
          log(`⚡ TP2 HIT via cTrader volume shrink ${volAfterTp1} → ${currentVol}`);
          if (cTraderPositionId && ENTRY_PRICE && SL_PRICE) {
            try {
              const originalSlDist = Math.abs(ENTRY_PRICE - SL_PRICE);
              const trailDist = originalSlDist * 0.5;  // half-R trail width
              // Anchor near entry + 1R favorable (post-TP1 position has at least 1R unrealised).
              // Conservative — if price hasn't run much past 1R, this still locks 0.5R.
              const positions = await bridge.getPositions();
              const pos = positions.find(p => p.positionId === cTraderPositionId);
              const dir = pos?.direction || 'long';
              const anchor = dir === 'long'  ? ENTRY_PRICE + originalSlDist
                                             : ENTRY_PRICE - originalSlDist;
              await bridge.armTrailingStop(cTraderPositionId, trailDist, anchor);
              log(`📈 Trailing SL armed — anchor=${anchor.toFixed(5)} trail=${trailDist.toFixed(5)} (=0.5R)`);
            } catch (e) { log(`armTrailingStop failed: ${e.message}`); }
          } else {
            log(`⚠ Skipping trail arm — missing positionId/entry/sl (${cTraderPositionId}/${ENTRY_PRICE}/${SL_PRICE})`);
          }
        }
      } catch (e) { log(`cTrader volume check failed: ${e.message}`); }
    }

    // Synthetic breakeven (added 2026-05-26): after TP1 has hit, watch the live
    // profit on the remaining legs. If aggregate profit drops back to ≤ BE_TOLERANCE,
    // close out manually to lock the gain — no broker-side SL modification needed.
    // The original broker SL still backstops worst case.
    if (tp1Triggered && state.found) {
      const BE_TOLERANCE = -5;  // USD — small buffer to avoid spread-noise triggers
      const aggProfit = state.positions.reduce((s, p) => s + (p.profit || 0), 0);
      if (aggProfit <= BE_TOLERANCE) {
        log(`🛡 SYNTHETIC BE — remaining profit ${aggProfit} ≤ ${BE_TOLERANCE}, closing ${state.positions.length} leg(s)`);
        try { await closeAllPositions(); log('Synthetic BE close executed.'); }
        catch(e) { log(`Synthetic BE close error: ${e.message}`); }
        await sleep(3000);
        const pnl = await resolvePnl('synthetic_be_close');
        updateLastTrade(pnl != null ? (pnl >= 0 ? 'W' : 'L') : '?', pnl, 'synthetic_be_close');
        return;
      }
    }

    // Position closed: was open, now gone
    if (prevPositions?.found && !state.found) {
      const pnl = await resolvePnl('closed');
      const result = pnl != null ? (pnl >= 0 ? 'W' : 'L') : '?';
      log(`POSITION CLOSED → result=${result} pnl=${pnl}`);
      // Belt-and-braces: cancel any LIMIT close orders that were linked to the
      // closed position. cTrader normally auto-cancels, but a rare delay can
      // leave ghost pending orders behind that confuse the next scan cycle.
      if (USE_CTRADER && cTraderPositionId) {
        try {
          const bridge = await import('./broker_ctrader.mjs');
          const { cancelled } = await bridge.cancelOrphanLimits(cTraderPositionId);
          if (cancelled > 0) log(`🧹 Cancelled ${cancelled} orphan LIMIT order(s) linked to position ${cTraderPositionId}`);
        } catch (e) { log(`Orphan cleanup failed: ${e.message}`); }
      }
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
