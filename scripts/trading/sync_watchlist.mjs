/**
 * sync_watchlist.mjs
 * Mirrors the scanner's ACTUAL daily scan list into the TradingView
 * "Today's Interest" custom watchlist so it's easy to follow along live.
 *
 * Source of truth = daily_watchlist.json (today's daily_selector picks) MINUS
 * the same block set setup_finder applies at scan time (trading_params
 * blockedSymbols + active broker_rejects). That difference is exactly the set
 * of instruments the scanner actually loads each cycle.
 *
 * Writes via TradingView's REST API from page context (same-origin fetch carries
 * the session cookie) — atomic replace, no fragile DOM automation.
 *
 *   node scripts/trading/sync_watchlist.mjs            # replace the watchlist
 *   node scripts/trading/sync_watchlist.mjs --dry-run  # print, don't write
 *
 * Cron: 40 6 * * 1-5  (10 min after daily_selector at 06:30 UTC)
 */
import CDP from '/home/ubuntu/tradingview-mcp-jackson/node_modules/chrome-remote-interface/index.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const HOST = 'localhost', PORT = 9222, TIMEOUT = 12000;
const WL_ID   = 144014562;          // "Today's Interest"
const DRY_RUN = process.argv.includes('--dry-run');

// Direction grouping (operator request 2026-07-07): each section header states
// which trades are being hunted for the symbols under it, straight from the
// daily_selector's biasDir. Replaces the old asset-category grouping — tickers
// make the asset class obvious; the bias is the information that isn't visible.
const DIR_SECTIONS = [
  ['long',  '🟢 BULLISH — BUY TRADES ONLY'],
  ['short', '🔴 BEARISH — SELL TRADES ONLY'],
];

const withTimeout = (p, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), TIMEOUT)),
]);
const log = msg => process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);

// ── Build the effective scan list (daily picks − blocked) ─────────────────────
function buildSymbolList() {
  const wlPath = join(DATA_ROOT, 'daily_watchlist.json');
  if (!existsSync(wlPath)) throw new Error(`daily_watchlist.json not found at ${wlPath}`);
  const wl = JSON.parse(readFileSync(wlPath, 'utf8'));
  const instruments = wl.instruments || [];

  // Same block set setup_finder uses: blockedSymbols + active broker_rejects.
  const blocked = new Set();
  try {
    const p = JSON.parse(readFileSync(join(DATA_ROOT, 'trading_params.json'), 'utf8'));
    (p.blockedSymbols || []).forEach(s => blocked.add(s));
  } catch (_) {}
  try {
    const r = JSON.parse(readFileSync(join(DATA_ROOT, 'broker_rejects.json'), 'utf8'));
    const now = Date.now();
    for (const [sym, rec] of Object.entries(r)) if (rec && rec.until > now) blocked.add(sym);
  } catch (_) {}

  const eff = instruments.filter(i => !blocked.has(i.label));
  const dropped = instruments.filter(i => blocked.has(i.label)).map(i => i.label);

  // Group by bias direction, header only when the group is non-empty,
  // score-sorted within each so the strongest conviction sits on top.
  const symbols = [`###${wl.date || new Date().toISOString().slice(0, 10)} SCAN (${eff.length})`];
  for (const [dir, label] of DIR_SECTIONS) {
    const members = eff
      .filter(i => i.biasDir === dir)
      .sort((a, b) => (b.biasScore || 0) - (a.biasScore || 0));
    if (!members.length) continue;
    symbols.push(`###${label} (${members.length})`);
    members.forEach(m => symbols.push(m.sym));
  }
  // Anything without a long/short bias shouldn't silently vanish from the mirror.
  const unbiased = eff.filter(i => i.biasDir !== 'long' && i.biasDir !== 'short');
  if (unbiased.length) {
    symbols.push('###⚪ NO CLEAR BIAS');
    unbiased.forEach(m => symbols.push(m.sym));
  }
  // Never wipe to empty — leave a marker so the panel still reads cleanly.
  if (eff.length === 0) return { symbols: [`###${wl.date || ''} NO LIVE SETUPS`.trim()], eff, dropped, date: wl.date };
  return { symbols, eff, dropped, date: wl.date };
}

// ── CDP: replace the watchlist via in-page REST call ──────────────────────────
async function replaceWatchlist(symbols) {
  let scannerTabId = null;
  try { scannerTabId = readFileSync('/tmp/.scanner_tab_id', 'utf8').trim(); } catch (_) {}
  const targets = await (await fetch(`http://${HOST}:${PORT}/json/list`)).json();
  const tvTabs = targets.filter(t => t.type === 'page' && /tradingview\.com/i.test(t.url));
  const tab = tvTabs.find(t => t.id !== scannerTabId) || tvTabs[0];
  if (!tab) throw new Error('no tradingview tab on 9222');

  const c = await withTimeout(CDP({ host: HOST, port: PORT, target: tab.id }), 'connect');
  try {
    await withTimeout(c.Runtime.enable(), 'Runtime.enable');
    const r = await withTimeout(c.Runtime.evaluate({
      expression: `fetch('/api/v1/symbols_list/custom/${WL_ID}/replace/?unsafe=true', {
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(${JSON.stringify(symbols)})
      }).then(r => r.status + ' ' + r.statusText).catch(e => 'ERR ' + e.message)`,
      awaitPromise: true, returnByValue: true,
    }), 'evaluate');
    const status = r.result?.value ?? JSON.stringify(r.exceptionDetails);

    // The watchlist widget renders a cached copy and won't re-fetch after a
    // server-side replace — reload the visible chart tab so the panel updates.
    if (/^200/.test(status)) {
      try {
        await withTimeout(c.Page.enable(), 'Page.enable');
        await withTimeout(c.Page.reload({ ignoreCache: false }), 'Page.reload');
        await new Promise(res => setTimeout(res, 1500)); // let navigation commit before close
      } catch (e) { log(`⚠ tab reload failed (list is still updated server-side): ${e.message}`); }
    }
    return status;
  } finally {
    try { await c.close(); } catch (_) {}
  }
}

async function main() {
  const { symbols, eff, dropped, date } = buildSymbolList();
  log(`daily_watchlist date=${date} | live=${eff.length} dropped(blocked)=${dropped.length} [${dropped.join(',')}]`);
  log(`New "Today's Interest" → ${symbols.join(' | ')}`);
  if (DRY_RUN) { log('DRY-RUN — no write performed.'); return; }
  const status = await replaceWatchlist(symbols);
  log(`Replace POST → ${status}`);
  if (!/^200/.test(status)) process.exit(1);
  log('✓ Watchlist synced.');
}
main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
