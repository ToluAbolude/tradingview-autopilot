/**
 * leap_runner.mjs v6 — Bidirectional 24/7 Competition Runner
 * "The Leap Crypto Series May 2026"
 *
 * Strategy:
 *   Every 10 minutes, scan all 5 assets. Pick the STRONGEST trade:
 *     - Best UPTREND  → go LONG  (buy low, sell high)
 *     - Best DOWNTREND → go SHORT (sell high, buy low)
 *   Take profit at +4%. Cut loss at -4%.
 *   Always re-enter the best trade immediately after closing.
 *
 * Price reading:
 *   Watchlist DOM — "last-RsFlttSS" cell for actual price,
 *   "changeInPercents-RsFlttSS" for daily % change.
 *   (bars() reads wrong chart widget for .P competition symbols)
 *
 * Order execution:
 *   LONG  → marketBuy to open,  marketSell to close
 *   SHORT → marketSell to open, marketBuy  to close
 */

import { evaluate } from '../../src/connection.js';
import { appendFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// ── Config ──────────────────────────────────────────────────────────────────
const CYCLE_MIN  = 10;       // check every 10 minutes
const PROFIT_PCT = 4.0;      // close position when up +4%
const CUT_PCT    = 4.0;      // close position when down -4%
const ALLOC_PCT  = 90;       // 90% of starting capital per trade
const BASE_CAPITAL = 100000;

const LOG_DIR    = '/home/ubuntu/trading-data/leap';
const LOG_RUN    = join(LOG_DIR, 'leap_runner.log');
const LOG_CSV    = join(LOG_DIR, 'leap_trades.csv');
const STATE_FILE = join(LOG_DIR, 'state.json');

// Higher vol = better for both longs and shorts (more movement = more profit)
const ASSETS = [
  { sym: 'COINBASE:DOGEUSDC.P', label: 'DOGE', vol: 3.0 },
  { sym: 'COINBASE:SOLUSDC.P',  label: 'SOL',  vol: 2.5 },
  { sym: 'COINBASE:XRPUSDC.P',  label: 'XRP',  vol: 2.0 },
  { sym: 'COINBASE:ETHUSDC.P',  label: 'ETH',  vol: 1.2 },
  { sym: 'COINBASE:BTCUSDC.P',  label: 'BTC',  vol: 1.0 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Logging ──────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_RUN, line + '\n'); } catch {}
}

function logTrade(e) {
  try {
    if (!existsSync(LOG_CSV)) appendFileSync(LOG_CSV, 'ts,action,sym,price,qty,dollars,pnlPct,notes\n');
    const row = [new Date().toISOString(), e.action, e.sym, e.price||'', e.qty||'', e.dollars||'', e.pnlPct||'', e.notes||''].join(',');
    appendFileSync(LOG_CSV, row + '\n');
  } catch {}
}

// ── State ─────────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}
function clearState() { saveState(null); }

// ── Read all prices from watchlist DOM (single call, no symbol switching) ────
async function readAllPrices() {
  return evaluate(`(function(){
    var syms = [
      'COINBASE:DOGEUSDC.P',
      'COINBASE:SOLUSDC.P',
      'COINBASE:XRPUSDC.P',
      'COINBASE:ETHUSDC.P',
      'COINBASE:BTCUSDC.P',
    ];

    function cleanNum(t) {
      // Strip commas, em-dashes, percent, letters — keep digits and dot
      return parseFloat((t || '').replace(/,/g, '').replace(/[^0-9.]/g, ''));
    }

    var results = {};
    for (var i = 0; i < syms.length; i++) {
      var sym = syms[i];
      try {
        var row = document.querySelector('[data-symbol-full="' + sym + '"]');
        if (!row) { results[sym] = null; continue; }

        // Actual price (hidden span in the "last" cell)
        var lastCell = row.querySelector('[class*="last-RsFlttSS"]');
        var priceSpan = lastCell && lastCell.querySelector('[class*="inner-RsFlttSS"]');
        var price = priceSpan ? cleanNum(priceSpan.textContent) : NaN;

        // Daily % change
        var pctCell  = row.querySelector('[class*="changeInPercents-RsFlttSS"]');
        var pctSpan  = pctCell && pctCell.querySelector('[class*="inner-RsFlttSS"]');
        var pctSign  = (pctSpan && (pctSpan.className || '').indexOf('minus') >= 0) ? -1 : 1;
        var pctAbs   = pctSpan ? cleanNum(pctSpan.textContent) : NaN;
        var pctChange = isNaN(pctAbs) ? 0 : pctSign * pctAbs;

        results[sym] = (!isNaN(price) && price > 0)
          ? { price: price, pctChange: pctChange }
          : null;
      } catch(e) {
        results[sym] = { error: e.message };
      }
    }
    return results;
  })()`);
}

// ── Signal scoring ────────────────────────────────────────────────────────────
// Returns { direction: 'LONG'|'SHORT', strength: number }
function getSignal(asset, data) {
  if (!data || !data.price || data.price <= 0) return { direction: null, strength: -99 };
  const pct = data.pctChange || 0;
  const vol = asset.vol;

  // Long signal: strong when asset is up today
  let longStr = 0;
  if      (pct > 5)  longStr += 5;
  else if (pct > 3)  longStr += 4;
  else if (pct > 1)  longStr += 2;
  else if (pct > 0)  longStr += 1;
  else if (pct > -1) longStr += 0;
  else               longStr -= 1;  // slight penalty for mildly down assets
  longStr += vol;

  // Short signal: strong when asset is down today
  let shortStr = 0;
  if      (pct < -5) shortStr += 5;
  else if (pct < -3) shortStr += 4;
  else if (pct < -1) shortStr += 2;
  else if (pct < 0)  shortStr += 1;
  else if (pct < 1)  shortStr += 0;
  else               shortStr -= 1; // slight penalty for mildly up assets
  shortStr += vol;

  if (longStr >= shortStr) {
    return { direction: 'LONG', strength: longStr };
  } else {
    return { direction: 'SHORT', strength: shortStr };
  }
}

// ── Switch chart to symbol (only needed before placing orders) ────────────────
async function switchForOrder(sym) {
  await evaluate(`(function(){
    var row = document.querySelector('[data-symbol-full="' + '${sym}' + '"]');
    if (row) { row.click(); return; }
    try { window.TradingViewApi._activeChartWidgetWV.value().setSymbol('${sym}', null, true); } catch(e) {}
  })()`);
  await sleep(400);
  // Dismiss any symbol search dialog
  await evaluate(`(function(){
    var s = document.querySelector('[class*="symbolSearch"],[class*="search-ZXzPWcCf"]');
    if (s && s.offsetParent) document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:27,bubbles:true}));
  })()`);
  await sleep(2000);
}

// ── Open paper trading order panel ───────────────────────────────────────────
async function openOrderPanel() {
  await evaluate(`(function(){
    var btns = Array.from(document.querySelectorAll('button'));
    var t = btns.find(function(b){ return b.offsetParent && (b.textContent||'').trim() === 'Trade'; });
    if (t) { t.click(); return; }
    var pt = btns.find(function(b){ return b.offsetParent && (b.textContent||'').trim() === 'Paper Trading'; });
    if (pt) pt.click();
  })()`);
  await sleep(700);
}

// ── Wait for order ticket to appear ──────────────────────────────────────────
async function waitForTicket() {
  for (let i = 0; i < 8; i++) {
    const found = await evaluate(`!!(document.querySelector('[class*="orderTicket"]') || document.querySelector('[class*="order-ticket"]'))`);
    if (found) return true;
    await sleep(1000);
  }
  return false;
}

// ── Set qty in order ticket and submit ───────────────────────────────────────
async function submitTicket(qty, side) {
  // side: 'buy' or 'sell'
  await evaluate(`(function(){
    var inp = document.getElementById('quantity-field') ||
              document.querySelector('[class*="orderQty"] input, input[placeholder*="Qty"], input[placeholder*="Amount"]');
    if (!inp) return;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '${qty}');
    inp.dispatchEvent(new Event('input',  { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(500);

  const r = await evaluate(`(function(){
    var ticket = document.querySelector('[class*="orderTicket"],[class*="order-ticket"]');
    if (!ticket) return 'no-ticket';
    var btns = Array.from(ticket.querySelectorAll('button'));
    // Look for the side-matching button first
    for (var b of btns) {
      if (b.offsetParent && /${side === 'buy' ? 'buy|blue|primary' : 'sell|red'}$/i.test(b.className||'')) {
        b.click(); return 'submitted';
      }
    }
    // Fallback: any submit button
    for (var b of btns) {
      if (b.offsetParent) { b.click(); return 'submitted-fallback'; }
    }
    return 'btn-not-found';
  })()`);
  await sleep(700);

  // Confirm dialog
  await evaluate(`(function(){
    var c = Array.from(document.querySelectorAll('button')).find(function(b){
      return b.offsetParent && /(^confirm$|^ok$|^place order$|^${side}$)/i.test((b.textContent||'').trim());
    });
    if (c) c.click();
  })()`);
  await sleep(800);
  return r;
}

// ── Place MARKET BUY (open LONG or close SHORT) ───────────────────────────────
async function marketBuy(label, price, dollars) {
  const qty = +(dollars / price).toFixed(6);
  log(`  → BUY  ${qty} ${label} @ $${price}  (~$${Math.round(dollars).toLocaleString()})`);
  await evaluate(`(function(){
    var b = document.querySelector('[data-name="buy-order-button"]');
    if (b && b.offsetParent) { b.click(); return; }
    var btns = Array.from(document.querySelectorAll('button'));
    var buy = btns.find(function(b2){ return b2.offsetParent && /^buy$/i.test((b2.textContent||'').trim()); });
    if (buy) buy.click();
  })()`);
  await sleep(1500);
  const found = await waitForTicket();
  if (!found) { log(`  ⚠ buy ticket not found`); return { success: false }; }
  const r = await submitTicket(qty, 'buy');
  return { success: r.startsWith('submitted'), qty, price };
}

// ── Place MARKET SELL (open SHORT or close LONG) ──────────────────────────────
async function marketSell(label, qty, price) {
  const qtyStr = typeof qty === 'number' ? qty : (+(price && qty/1 || qty)).toFixed(6);
  log(`  → SELL ${qtyStr} ${label} @ $${price || '?'}`);
  await evaluate(`(function(){
    var b = document.querySelector('[data-name="sell-order-button"]');
    if (b && b.offsetParent) { b.click(); return; }
    var btns = Array.from(document.querySelectorAll('button'));
    var sell = btns.find(function(b2){ return b2.offsetParent && /^sell$/i.test((b2.textContent||'').trim()); });
    if (sell) sell.click();
  })()`);
  await sleep(1500);
  const found = await waitForTicket();
  if (!found) { log(`  ⚠ sell ticket not found`); return { success: false }; }
  const r = await submitTicket(qtyStr, 'sell');
  return { success: r.startsWith('submitted'), qty: +qtyStr, price };
}

// ── Close existing position (direction-aware) ─────────────────────────────────
async function closePosition(state, curPrice) {
  log(`  Closing ${state.direction} ${state.qty} ${state.label} @ $${curPrice}`);
  await switchForOrder(state.sym);
  await openOrderPanel();
  if (state.direction === 'LONG') {
    return marketSell(state.label, state.qty, curPrice);
  } else {
    // SHORT: close by buying back
    return marketBuy(state.label, curPrice, state.qty * curPrice);
  }
}

// ── Open new position ─────────────────────────────────────────────────────────
async function openPosition(asset, price, direction) {
  const dollars = BASE_CAPITAL * ALLOC_PCT / 100;
  await switchForOrder(asset.sym);
  await openOrderPanel();
  await sleep(500);
  let r;
  if (direction === 'LONG') {
    r = await marketBuy(asset.label, price, dollars);
  } else {
    // SHORT: sell first
    const qty = +(dollars / price).toFixed(6);
    r = await marketSell(asset.label, qty, price);
    r.qty = qty;
  }
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN CYCLE
// ─────────────────────────────────────────────────────────────────────────────
async function cycle(num) {
  log(`\n══ CYCLE ${num} [${new Date().toUTCString()}] ══`);

  const state = loadState();
  if (state) {
    log(`  State: ${state.direction} ${state.qty} ${state.label} @ $${state.entry}`);
  } else {
    log(`  State: no position`);
  }

  // 1. Read all prices in one shot
  const prices = await readAllPrices();

  // 2. Score each asset — find best LONG and best SHORT
  const results = [];
  for (const asset of ASSETS) {
    const data = prices[asset.sym];
    const sig = getSignal(asset, data);
    const p = data?.price;
    const pct = data?.pctChange;
    log(`  ${asset.label.padEnd(5)} $${p?.toString().padEnd(12) || '?'.padEnd(12)} day:${pct !== undefined ? (pct > 0 ? '+' : '') + pct + '%' : '?'
      }  → ${sig.direction || '?'} str:${sig.strength.toFixed(1)}`);
    results.push({ ...asset, data, price: p, sig });
  }

  // Find the single best trade (highest strength signal across all assets and directions)
  const valid = results.filter(r => r.price > 0 && r.sig.direction);
  valid.sort((a, b) => b.sig.strength - a.sig.strength);
  const best = valid[0];

  if (!best) { log(`  ⚠ No valid prices. Skipping.`); return; }
  log(`  → Best: ${best.sig.direction} ${best.label} @ $${best.price}  str:${best.sig.strength.toFixed(1)}`);

  // 3. Manage existing position
  if (state && state.qty > 0) {
    const curData  = prices[state.sym];
    const curPrice = curData?.price;

    if (!curPrice || curPrice <= 0) {
      log(`  ⚠ Cannot read ${state.label} price. Holding.`);
      return;
    }

    // P&L depends on direction
    const pnlPct = state.direction === 'LONG'
      ? (curPrice - state.entry) / state.entry * 100
      : (state.entry - curPrice) / state.entry * 100;

    log(`  P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}%  (${state.direction} entry:$${state.entry} → now:$${curPrice})`);

    const shouldClose = pnlPct >= PROFIT_PCT || pnlPct <= -CUT_PCT;
    const reason = pnlPct >= PROFIT_PCT ? `PROFIT +${pnlPct.toFixed(2)}%` : `LOSS ${pnlPct.toFixed(2)}%`;

    if (shouldClose) {
      log(`  ✓ Close (${reason}) → entering ${best.sig.direction} ${best.label}`);
      const closeR = await closePosition(state, curPrice);
      const action = pnlPct >= PROFIT_PCT ? 'CLOSE_PROFIT' : 'CLOSE_LOSS';
      logTrade({ action, sym: state.label, price: curPrice, qty: state.qty, pnlPct: pnlPct.toFixed(3), notes: `${state.direction} ${closeR.result||''}` });

      if (closeR.success) {
        clearState();
        await sleep(2000);
        // Re-enter immediately with best trade
        if (best.price > 0) {
          const openR = await openPosition(best, best.price, best.sig.direction);
          if (openR.success) {
            saveState({ sym: best.sym, label: best.label, direction: best.sig.direction, qty: openR.qty, entry: best.price, ts: new Date().toISOString() });
            logTrade({ action: 'OPEN', sym: best.label, price: best.price, qty: openR.qty, dollars: Math.round(BASE_CAPITAL * ALLOC_PCT / 100), notes: `${best.sig.direction} str:${best.sig.strength.toFixed(1)}` });
            log(`  ✓ Opened ${best.sig.direction} ${best.label} ${openR.qty} @ $${best.price}`);
          }
        }
      }
      return;
    }

    log(`  ↔ Holding ${state.direction} — P&L in range. Next check in ${CYCLE_MIN}m.`);
    return;
  }

  // 4. No position — enter best trade now
  log(`  No position. Opening ${best.sig.direction} ${best.label}...`);
  const openR = await openPosition(best, best.price, best.sig.direction);
  if (openR.success) {
    saveState({ sym: best.sym, label: best.label, direction: best.sig.direction, qty: openR.qty, entry: best.price, ts: new Date().toISOString() });
    logTrade({ action: 'OPEN', sym: best.label, price: best.price, qty: openR.qty, dollars: Math.round(BASE_CAPITAL * ALLOC_PCT / 100), notes: `${best.sig.direction} str:${best.sig.strength.toFixed(1)}` });
    log(`  ✓ Opened ${best.sig.direction} ${best.label} ${openR.qty} @ $${best.price}`);
  } else {
    log(`  ✗ Order failed`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STARTUP
// ─────────────────────────────────────────────────────────────────────────────
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

log('═══════════════════════════════════════════════════════');
log(' THE LEAP COMPETITION RUNNER v6 — BIDIRECTIONAL');
log(`  Cycle: ${CYCLE_MIN}min | Profit: +${PROFIT_PCT}% | Cut: -${CUT_PCT}% | Alloc: ${ALLOC_PCT}%`);
log(`  LONG (uptrend) + SHORT (downtrend) on all 5 assets`);
log('═══════════════════════════════════════════════════════');

// Restore state from CSV on startup (handles restarts)
if (!loadState()) {
  try {
    const csv = existsSync(LOG_CSV) ? readFileSync(LOG_CSV, 'utf8') : '';
    const lines = csv.trim().split('\n').slice(1).filter(Boolean);
    let lastOpen = null;
    for (const line of lines) {
      const [ts, action, sym, price, qty] = line.split(',');
      if (action === 'OPEN' || action === 'BUY')  lastOpen = { sym, price: parseFloat(price), qty: parseFloat(qty), ts };
      if (/CLOSE/.test(action))                   lastOpen = null;
    }
    if (lastOpen) {
      const asset = ASSETS.find(a => a.label === lastOpen.sym);
      if (asset) {
        // Default direction LONG for legacy entries without direction field
        const s = { sym: asset.sym, label: lastOpen.sym, direction: 'LONG', qty: lastOpen.qty, entry: lastOpen.price, ts: lastOpen.ts };
        saveState(s);
        log(`  ⚡ Restored: ${s.direction} ${s.qty} ${s.label} @ $${s.entry}`);
      }
    }
  } catch {}
}

let n = 0;
while (true) {
  n++;
  try { await cycle(n); }
  catch(e) { log(`CYCLE ERROR: ${e.message}\n${e.stack}`); await sleep(15000); }
  log(`  ── next in ${CYCLE_MIN}m ──`);
  await sleep(CYCLE_MIN * 60 * 1000);
}
