/**
 * eod_close.mjs — End-of-day position closer
 *
 * Runs at 20:00 UTC AND 21:45 UTC Mon-Fri via cron (belt-and-suspenders).
 * Belt: 20:00 UTC — first attempt (30 min after London/NY entry window closes)
 * Suspenders: 21:45 UTC — catch any that slipped through
 *
 * Enforces the day-trade rule: NO carryover positions with open risk.
 * Uses 3-attempt retry with verification after each attempt.
 *
 * Cron lines to install (both needed):
 *   0  20 * * 1-5  node /path/to/eod_close.mjs >> /path/to/eod_close.log 2>&1
 *   45 21 * * 1-5  node /path/to/eod_close.mjs >> /path/to/eod_close.log 2>&1
 */
import { evaluate, getClient } from '../../src/connection.js';
import { getEquity } from './execute_trade.mjs';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const DATA_ROOT = os.platform() === 'linux'
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const LOG_DIR  = join(DATA_ROOT, 'trade_log');
const EOD_LOG  = join(LOG_DIR, 'eod_closes.csv');

const now = new Date();
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

log('═══ EOD CLOSE — day-trade enforcer ═══');

// Only run on weekdays
const dayOfWeek = now.getUTCDay();
if (dayOfWeek === 0 || dayOfWeek === 6) {
  log('Weekend — skipping');
  process.exit(0);
}

// ── Reliable position detection (does NOT rely on unrealisedPnl == 0) ──
async function hasOpenPositions() {
  // Click Positions tab
  await evaluate(`(function() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if ((btns[i].textContent || '').trim() === 'Positions') { btns[i].click(); break; }
    }
  })()`);
  await sleep(900);

  return evaluate(`(function() {
    var text = document.body.innerText || '';
    // Definitive "no positions" text from TradingView
    if (/there are no open po/i.test(text) || /no open position/i.test(text)) return false;

    // Equity != Balance means float P&L != 0 → definitely a position
    var titles = document.querySelectorAll('[class*="title-"]');
    var balance = null, equity = null;
    for (var i = 0; i < titles.length; i++) {
      var label = (titles[i].textContent || '').trim();
      var row   = titles[i].parentElement;
      if (!row) continue;
      var valEl = row.querySelector('[class*="value-"]');
      if (!valEl) continue;
      var v = parseFloat((valEl.textContent || '').replace(/,/g, ''));
      if (isNaN(v)) continue;
      if (label === 'Account Balance') balance = v;
      else if (label === 'Equity')     equity  = v;
    }
    if (equity !== null && balance !== null && Math.abs(equity - balance) > 0.50) return true;

    // Also look for close buttons — if any visible, there are positions
    var closeBtns = document.querySelectorAll('[class*="closeButton"], [aria-label*="Close position"], [title*="Close position"]');
    for (var i = 0; i < closeBtns.length; i++) {
      if (closeBtns[i].offsetParent) return true;
    }

    // Fallback: position row elements
    var posRows = document.querySelectorAll('[class*="positionRow"], [class*="position-row"]');
    return posRows.length > 0;
  })()`);
}

// ── One close attempt: click all close buttons + confirm dialogs ──
async function attemptClose() {
  const clicked = await evaluate(`(function() {
    var closed = 0;

    // Pattern 1: class/aria/title-based close buttons
    var sel = '[class*="closeButton"], [aria-label*="Close position"], [title*="Close position"]';
    var btns = document.querySelectorAll(sel);
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].offsetParent) { btns[i].click(); closed++; }
    }
    if (closed > 0) return 'closeButton×' + closed;

    // Pattern 2: text "Close all" button
    var all = Array.from(document.querySelectorAll('button'));
    var ca = all.find(function(b) {
      return b.offsetParent && /^close all$/i.test((b.textContent || '').trim());
    });
    if (ca) { ca.click(); return 'close-all-btn'; }

    // Pattern 3: individual "Close" button
    var cv = all.find(function(b) {
      return b.offsetParent && /^close$/i.test((b.textContent || '').trim());
    });
    if (cv) { cv.click(); return 'close-btn'; }

    return 'none';
  })()`);

  await sleep(700);

  // Confirm any modal dialog that appears
  const confirmed = await evaluate(`(function() {
    var btns = Array.from(document.querySelectorAll('button'));
    var conf = btns.find(function(b) {
      var t = (b.textContent || '').trim();
      return b.offsetParent !== null && (
        t === 'Close position' || t === 'Confirm' || t === 'OK' || t === 'Yes'
      );
    });
    if (conf) { conf.click(); return 'confirmed: ' + conf.textContent.trim(); }
    return 'no-dialog';
  })()`);

  return { clicked, confirmed };
}

// ── Main ──
const eqBefore = await getEquity().catch(() => ({}));
log(`Before: equity=${eqBefore.equity} balance=${eqBefore.balance} float=${eqBefore.unrealisedPnl}`);

const open = await hasOpenPositions();
if (!open) {
  log('No open positions detected — nothing to close.');
} else {
  log('Open positions found. Closing with retry...');
  let success = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await attemptClose();
    log(`  Attempt ${attempt}: clicked=${r.clicked} confirmed=${r.confirmed}`);
    await sleep(2500);

    const stillOpen = await hasOpenPositions();
    if (!stillOpen) {
      success = true;
      log(`✓ All positions closed (attempt ${attempt}).`);
      break;
    }
    log(`  Still open. Retrying in 3s...`);
    await sleep(3000);
  }

  if (!success) {
    log('⚠ WARNING: positions may still be open after 3 attempts — MANUAL ACTION REQUIRED.');
  }

  await sleep(2000);
  const eqAfter = await getEquity().catch(() => ({}));
  const realised = (eqBefore.unrealisedPnl != null)
    ? Math.round(eqBefore.unrealisedPnl * 100) / 100
    : 'unknown';
  log(`After: equity=${eqAfter.equity} balance=${eqAfter.balance} realised_pnl=${realised}`);

  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    if (!existsSync(EOD_LOG)) appendFileSync(EOD_LOG, 'date,equity_before,balance_before,float_pnl,equity_after\n');
    appendFileSync(EOD_LOG, [
      new Date().toISOString(),
      eqBefore.equity, eqBefore.balance, eqBefore.unrealisedPnl, eqAfter.equity,
    ].join(',') + '\n');
  } catch (_) {}
}

log('═══ EOD CLOSE done ═══');
try { (await getClient()).close(); } catch(_) {}
