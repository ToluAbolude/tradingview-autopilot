/**
 * broker_history.mjs — Scrape BlackBull's actual Order History via TradingView's
 * broker panel (CDP). This is the AUTHORITATIVE ledger — the broker's own record
 * of orders that actually reached them. Compare against trades.csv to detect
 * silent submit failures (e.g. the WTI VOIDs of 2026-05-22).
 *
 * Usage:
 *   node scripts/trading/broker_history.mjs              # scrape + dedupe-append to CSV
 *   node scripts/trading/broker_history.mjs --since=24h  # show last 24h
 *   node scripts/trading/broker_history.mjs --today      # only today
 *   node scripts/trading/broker_history.mjs --verify SYMBOL TIMESTAMP  # for post-submit checks
 *
 * Output: /home/ubuntu/trading-data/broker_history.csv
 *   columns: scrape_ts, update_time, symbol, side, type, qty, remaining_qty, tp, sl
 */
import { evaluate } from '../../src/connection.js';
import { readFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const CSV_PATH  = join(DATA_ROOT, 'broker_history.csv');
const LOCK_FILE = join(DATA_ROOT, 'broker_history.lock');
const HEADER    = 'scrape_ts,update_time,symbol,side,type,qty,remaining_qty,tp,sl';

// ── DOM interaction ─────────────────────────────────────────────────────────
async function clickButtonExact(text) {
  const js = `(function(){
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if ((btns[i].textContent || '').trim() === ${JSON.stringify(text)}) { btns[i].click(); return true; }
    }
    return false;
  })()`;
  return await evaluate(js);
}

async function getOrderHistoryRows() {
  // The broker panel's Order history table renders as a flat list of <tr> elements
  // with no clear semantic class. We grab them by structure: rows containing a
  // symbol token followed by Buy/Sell and a recognised Type.
  const js = `(function(){
    var typeWords = ['Market', 'Limit', 'Stop Limit', 'Stop', 'Stop Loss', 'Take Profit'];
    var rows = Array.from(document.querySelectorAll('tr'));
    var out = [];
    var seen = new Set();
    rows.forEach(function(r){
      var t = (r.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!t || t.length < 12) return;
      // Must contain a Buy or Sell and one of the type words
      if (!/\\b(Buy|Sell)\\b/.test(t)) return;
      var matchedType = null;
      for (var i = 0; i < typeWords.length; i++) {
        if (t.indexOf(typeWords[i]) >= 0) { matchedType = typeWords[i]; break; }
      }
      if (!matchedType) return;
      if (seen.has(t)) return; seen.add(t);
      // Extract a YYYY-MM-DD HH:MM:SS timestamp
      var tsMatch = t.match(/(20\\d{2}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})/);
      if (!tsMatch) return;
      out.push(t);
    });
    return JSON.stringify(out);
  })()`;
  const raw = await evaluate(js);
  return JSON.parse(raw);
}

// ── Row parsing ─────────────────────────────────────────────────────────────
// Sample inputs (post normalisation to single spaces):
//   "XAGUSD Sell Market 0.32 0 2026-05-22 09:33:41"
//   "XAGUSD Buy Stop Loss 0.32 0 2026-05-22 09:36:13"
//   "XAGUSD Buy Take Profit 0.32 75.130 2026-05-22 09:36:13"
//   "NAS100 Buy Market 5 0 2026-05-22 01:17:15"
// The split between fields isn't comma-delimited — it's TradingView's tabular
// layout where adjacent cells collapse to single space. Parse positionally.
function parseRow(text) {
  const tsMatch = text.match(/(20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  if (!tsMatch) return null;
  const updateTime = tsMatch[1];

  // Determine side
  const sideMatch = text.match(/\b(Buy|Sell)\b/);
  if (!sideMatch) return null;
  const side = sideMatch[1];

  // Determine type — longest match wins (Stop Limit > Stop)
  const types = ['Stop Limit', 'Stop Loss', 'Take Profit', 'Market', 'Limit', 'Stop'];
  let type = null;
  for (const tw of types) {
    if (text.indexOf(tw) >= 0) { type = tw; break; }
  }
  if (!type) return null;

  // Symbol = capitalised letters/digits at the start of the row
  // Handles XAGUSD, NAS100, GER40, BTCUSD, US30, AUS200 etc.
  const symMatch = text.match(/^([A-Z][A-Z0-9]{2,9})/);
  if (!symMatch) return null;
  const symbol = symMatch[1];

  // Strip the leading "SYM Side Type" and trailing timestamp to isolate numeric fields
  const idxAfterType = text.indexOf(type) + type.length;
  const idxBeforeTs  = text.indexOf(updateTime);
  const middle = text.slice(idxAfterType, idxBeforeTs).trim();
  const nums = middle.split(/\s+/).filter(s => /^[\d.,-]+$/.test(s)).map(s => s.replace(/,/g, ''));

  // Best-effort positional extraction; broker columns: Qty, RemQty, [LimitPrice], TP, SL
  // Most market orders surface as: Qty, RemQty (=0 if filled).
  // SL rows show: Qty, RemQty (often blank).
  // TP rows show: Qty, RemQty, TP price.
  const qty          = nums[0] || '';
  const remainingQty = nums[1] || '';
  // TP/SL columns vary by row type — use type to disambiguate
  let tp = '', sl = '';
  if (type === 'Take Profit')      tp = nums[2] || nums[1] || '';
  else if (type === 'Stop Loss')   sl = nums[2] || nums[1] || '';
  // For Market/Limit rows, we don't expose TP/SL here; those live on linked Position rows

  return { updateTime, symbol, side, type, qty, remainingQty, tp, sl };
}

// ── CSV write w/ dedupe on (symbol,side,type,qty,updateTime) ─────────────────
function ensureCsv() {
  if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true });
  if (!existsSync(CSV_PATH)) appendFileSync(CSV_PATH, HEADER + '\n');
}

function loadKnownKeys() {
  if (!existsSync(CSV_PATH)) return new Set();
  const lines = readFileSync(CSV_PATH, 'utf8').trim().split('\n').slice(1);
  return new Set(lines.map(l => {
    const c = l.split(',');
    return [c[2], c[3], c[4], c[5], c[1]].join('|'); // symbol|side|type|qty|update_time
  }));
}

function rowKey(r) {
  return [r.symbol, r.side, r.type, r.qty, r.updateTime].join('|');
}

function csvEscape(v) {
  v = String(v ?? '');
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

// ── Main capture ────────────────────────────────────────────────────────────
export async function captureOrderHistory() {
  // Single-instance lock — prevent racing with the scanner's chart-tab operations
  if (existsSync(LOCK_FILE)) {
    const pid = parseInt(readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    try { process.kill(pid, 0); return { skipped: true, reason: 'lock held by ' + pid }; }
    catch (_) { /* stale lock */ }
  }
  if (existsSync(DATA_ROOT)) {
    try { writeFileSync(LOCK_FILE, String(process.pid)); } catch (_) {}
  }

  try {
    const tabClicked = await clickButtonExact('Order history');
    if (!tabClicked) return { error: 'Order history tab not found' };

    // Wait for table to populate
    await new Promise(r => setTimeout(r, 1500));

    const rawRows = await getOrderHistoryRows();
    const parsed  = rawRows.map(parseRow).filter(Boolean);

    ensureCsv();
    const known = loadKnownKeys();
    const scrapeTs = new Date().toISOString();
    let added = 0;
    for (const r of parsed) {
      const key = rowKey(r);
      if (known.has(key)) continue;
      const row = [scrapeTs, r.updateTime, r.symbol, r.side, r.type, r.qty, r.remainingQty, r.tp, r.sl]
        .map(csvEscape).join(',');
      appendFileSync(CSV_PATH, row + '\n');
      known.add(key);
      added++;
    }
    return { scraped: parsed.length, added, scrapeTs };
  } finally {
    try { unlinkSync(LOCK_FILE); } catch (_) {}
  }
}

// ── Verifier API — used by inline_trader after a submit click ───────────────
// Returns true if a Market order matching (symbol, dir) exists with updateTime
// within ± windowSec seconds of `nearTs`.
// `dir` accepts 'long' | 'short' | 'Buy' | 'Sell'
export async function verifyOrderLanded(symbol, dir, nearTs, windowSec = 90) {
  // Map dir to broker-side label
  const dirNorm = (dir || '').toLowerCase();
  const wantSide = (dirNorm === 'long' || dirNorm === 'buy')  ? 'Buy'
                 : (dirNorm === 'short' || dirNorm === 'sell') ? 'Sell'
                 : null;
  if (!wantSide) return false;

  await clickButtonExact('Order history');
  await new Promise(r => setTimeout(r, 1500));
  const rawRows = await getOrderHistoryRows();
  const parsed  = rawRows.map(parseRow).filter(Boolean);

  // Broker sometimes shows futures contract names with a trailing year (e.g.
  // ETHUSD2026, LTCUSD2026, XAGUSD2026) while the scanner uses the spot label
  // (ETHUSD, LTCUSD, XAGUSD). Normalise both sides before comparing — without
  // this, valid fills get marked BROKER_SILENT_REJECT (observed 2026-05-26:
  // ETHUSD/LTCUSD/US30 all filled but flagged void, masking a real win).
  const stripSuffix = s => (s || '').replace(/20\d{2}$/, '');
  const wantSym = stripSuffix(symbol);

  const target  = new Date(nearTs).getTime();
  for (const r of parsed) {
    if (stripSuffix(r.symbol) !== wantSym) continue;
    if (r.type !== 'Market') continue;
    if (r.side !== wantSide) continue;
    // BlackBull timestamps appear as broker-local UTC (matches our scanner clock)
    const t = new Date(r.updateTime.replace(' ', 'T') + 'Z').getTime();
    if (Math.abs(t - target) <= windowSec * 1000) return true;
  }
  return false;
}

// ── Auto-run when invoked directly ──────────────────────────────────────────
if (process.argv[1].endsWith('broker_history.mjs')) {
  const args = process.argv.slice(2);
  if (args.includes('--verify')) {
    const symbol = args[args.indexOf('--verify') + 1];
    const dir    = args[args.indexOf('--verify') + 2];   // 'long' | 'short' | 'Buy' | 'Sell'
    const ts     = args[args.indexOf('--verify') + 3] || new Date().toISOString();
    const ok     = await verifyOrderLanded(symbol, dir, ts).catch(e => { console.error(e); return false; });
    console.log(`Verify ${symbol} ${dir} @ ${ts}: ${ok ? 'FOUND' : 'MISSING'}`);
    process.exit(ok ? 0 : 1);
  }

  const res = await captureOrderHistory();
  if (res.skipped) { console.log(`[broker_history] skipped: ${res.reason}`); process.exit(0); }
  if (res.error)   { console.error(`[broker_history] ${res.error}`); process.exit(1); }
  console.log(`[broker_history] ${res.scrapeTs} — scraped=${res.scraped} added=${res.added}`);
  if (args.includes('--today') || args.includes('--since=24h')) {
    const today = new Date().toISOString().slice(0, 10);
    const lines = readFileSync(CSV_PATH, 'utf8').trim().split('\n').slice(1);
    const todays = lines.filter(l => l.includes(',' + today + ' '));
    console.log(`\n=== Today's orders at the broker (${todays.length}) ===`);
    todays.forEach(l => console.log('  ' + l));
  }
  process.exit(0);
}
