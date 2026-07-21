/**
 * trade_notion_sync.mjs — Logs every trade to Notion with an annotated TradingView
 * screenshot (entry / SL / TP lines), and updates the row with the result when it closes.
 *
 * Runs once per account (CTRADER_ACCOUNT_ID picks which): experiment 2131377 or
 * scanner 2118552. Cron every few minutes. Needs ~/.notion.env (NOTION_TOKEN, NOTION_DB)
 * and the cTrader env. Reuses the repo's CDP chart tools for the screenshot.
 *
 * Flow each run:
 *   1. open positions  -> any new positionId gets a Notion page (Status=open, NO screenshot —
 *      entry shots were tight-cropped and redundant; removed 2026-07-03 per operator)
 *   2. recently closed -> ONE outcome screenshot (wide frame: context before entry, the
 *      entry/SL/TP levels, and the path to the exit marker) + Result R + Status (win/loss)
 * State: ~/trading-data/notion_synced_<account>.json  { positionId: { pageId, risk, done } }
 *
 * Screenshotting briefly drives the shared TradingView chart; a lockfile prevents two
 * sync runs colliding. (1h experiment + 4x/day scanner => low collision risk.)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import os from 'os';
import { referenceForSymbol } from './confirm_reference.mjs';   // Phase 3: past-trade reference

const IS_LINUX  = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const REPO      = IS_LINUX ? '/home/ubuntu/tradingview-autopilot' : 'C:/Users/Tda-d/tradingview-mcp-jackson';
const ACCOUNT   = process.env.CTRADER_ACCOUNT_ID || 'unknown';
const ACCT_LABEL = ACCOUNT === '2131377' ? 'experiment' : ACCOUNT === '2118552' ? 'scanner' : ACCOUNT;
const STATE_FILE  = join(DATA_ROOT, `notion_synced_${ACCOUNT}.json`);
const LOCK_FILE   = join(DATA_ROOT, '.tv_chart.lock');
const SIGNALS_LOG = join(DATA_ROOT, 'confirm_signals.jsonl');
const NOTION_TOKEN = process.env.NOTION_TOKEN, NOTION_DB = process.env.NOTION_DB, NV = '2022-06-28';
const CONFIRM_RISK_PCT = Number(process.env.CONFIRM_RISK_PCT || 0.1);
// Optional: "Trading Notes" parent page → one sub-DATABASE per trading week, each
// trade a row inside its week. Falls back to the flat NOTION_DB if unset or if the
// integration can't access the page (share the page with the integration to enable).
const NOTION_PARENT = process.env.NOTION_PARENT || null;
const WEEK_DB_FILE  = join(DATA_ROOT, 'notion_week_dbs.json');
const WEEK_DB_SCHEMA = {
  "Name": { title: {} }, "Instrument": { rich_text: {} }, "Strategy": { select: {} },
  "Direction": { select: {} }, "Account": { select: {} }, "Entry": { number: {} },
  "SL": { number: {} }, "TP": { number: {} },
  "Status": { select: { options: [ { name: "open", color: "yellow" }, { name: "win", color: "green" }, { name: "loss", color: "red" } ] } },
  "Opened": { date: {} }, "Position ID": { rich_text: {} }, "Screenshot": { files: {} },
  "Result R": { number: {} },
};

function log(m) { process.stdout.write(`[${new Date().toISOString()}] ${m}\n`); }

// Planned $ risk from the position's OWN geometry: |entry−SL| × per-lot value
// factor × lots. Mirrors calcLots' per-class factors (inline_trader /
// zone_limit_runner) so R is measured against what the sizer intended.
// Needed because scanner-account positions have no confirm_signals.jsonl
// record — the old fallback divided net P&L by CONFIRM_RISK_PCT (0.1% of
// $10k = $10), which printed absurdities like GBPCAD R=-20.13 on a -$201
// trade (2026-07-20).
function plannedRiskUsd(symbol, entry, sl, lots) {
  const d = Math.abs(entry - sl);
  if (!(d > 0) || !(lots > 0)) return 0;
  const s = String(symbol).toUpperCase();
  if (/XAU|GOLD/.test(s))                                             return d * 100 * lots;
  if (/US30|NAS100|SPX500|GER|UK100|JP225|JPN225|AUS200|DOW/.test(s)) return d * lots;
  if (/BTC|ETH|SOL|ADA|XRP|LTC|BNB|DOT|AVAX/.test(s))                 return d * lots;
  if (/JPY/.test(s))                                                  return (d / 0.01) * 6.5 * lots;
  return (d / 0.0001) * 10 * lots;   // FX default: ~$10/pip/lot
}
function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// positionId -> {strategy, symbol} from the experiment's own log (clean attribution)
function loadSignalMap() {
  const map = {};
  try {
    for (const l of readFileSync(SIGNALS_LOG, 'utf8').trim().split('\n')) {
      const r = JSON.parse(l); if (r.positionId) map[r.positionId] = { strategy: r.strategy, symbol: r.symbol, tf: r.tf, barT: r.barT, riskPct: r.riskPct, equity: r.equity };
    }
  } catch {}
  return map;
}

// ── Notion helpers ───────────────────────────────────────────────────────────
async function nfetch(url, opts) { const r = await fetch(url, opts); const j = await r.json().catch(() => ({})); return { ok: r.ok, status: r.status, j }; }
async function uploadScreenshot(path) {
  const c = await nfetch('https://api.notion.com/v1/file_uploads', { method: 'POST',
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NV, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'trade.png', content_type: 'image/png' }) });
  if (!c.ok) throw new Error(`file_upload create ${c.status} ${c.j.message}`);
  const buf = await readFile(path); const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'image/png' }), 'trade.png');
  const s = await nfetch(c.j.upload_url, { method: 'POST', headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NV }, body: fd });
  if (!s.ok) throw new Error(`file_upload send ${s.status} ${s.j.message}`);
  return c.j.id;
}
// ── Weekly sub-database routing ──────────────────────────────────────────────
// ISO-week key + human title (Monday–Sunday of the current UTC week).
function isoWeekInfo(d = new Date()) {
  const dow = (d.getUTCDay() + 6) % 7;                                   // Mon=0
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  const th = new Date(mon); th.setUTCDate(mon.getUTCDate() + 3);          // Thursday → ISO year/week
  const firstThu = new Date(Date.UTC(th.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((th - firstThu) / 864e5 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  const ds = x => x.toISOString().slice(0, 10);
  const key = `${th.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  return { key, title: `${key} · ${ds(mon)}–${ds(sun)}` };
}
// Return this week's sub-DB id (create under NOTION_PARENT on first use, cache it).
// null => caller falls back to the flat NOTION_DB (page not shared / not configured).
async function ensureWeekDb() {
  if (!NOTION_PARENT || !NOTION_TOKEN) return null;
  const { key, title } = isoWeekInfo();
  let cache = {}; try { cache = JSON.parse(readFileSync(WEEK_DB_FILE, 'utf8')); } catch {}
  if (cache[key]) return cache[key];
  const r = await nfetch('https://api.notion.com/v1/databases', { method: 'POST',
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NV, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: { type: 'page_id', page_id: NOTION_PARENT }, title: [{ text: { content: title } }], properties: WEEK_DB_SCHEMA }) });
  if (!r.ok) { log(`week-db create failed (${r.status} ${r.j.message}) — using flat DB`); return null; }
  cache[key] = r.j.id; try { writeFileSync(WEEK_DB_FILE, JSON.stringify(cache, null, 2)); } catch {}
  log(`📁 created week DB "${title}"`);
  return r.j.id;
}

async function createTradePage(t, uploadId) {
  const dbId = (await ensureWeekDb()) || NOTION_DB;   // weekly sub-DB if available, else flat DB
  const props = {
    "Name": { title: [{ text: { content: `${t.symbol} · ${t.strategy} · ${t.dir}` } }] },
    "Instrument": { rich_text: [{ text: { content: t.symbol } }] },
    "Strategy": { select: { name: t.strategy } },
    "Direction": { select: { name: t.dir } },
    "Account": { select: { name: ACCT_LABEL } },
    "Entry": { number: t.entry }, "SL": { number: t.sl }, "TP": { number: t.tp },
    "Status": { select: { name: "open" } },
    "Opened": { date: { start: new Date().toISOString() } },
    "Position ID": { rich_text: [{ text: { content: String(t.positionId) } }] },
  };
  if (uploadId) props["Screenshot"] = { files: [{ type: "file_upload", name: "trade.png", file_upload: { id: uploadId } }] };
  // Phase 3: surface this instrument's past trades in the new trade's body ("what worked").
  let children = [];
  try {
    const ref = await referenceForSymbol(t.symbol);
    if (ref?.lines?.length) {
      children = ref.lines.map(l => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: l.slice(0, 1900) } }] } }));
      if (ref.takeaway) log(`📌 ${t.symbol} ref: ${ref.takeaway}`);
    }
  } catch (e) { log(`ref lookup failed ${t.symbol}: ${e.message}`); }
  const r = await nfetch('https://api.notion.com/v1/pages', { method: 'POST',
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NV, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: { database_id: dbId }, properties: props, ...(children.length ? { children } : {}) }) });
  if (!r.ok) throw new Error(`page create ${r.status} ${r.j.message}`);
  return r.j.id;
}
async function updateResultAndShot(pageId, R, uploadId) {
  const props = { "Result R": { number: Math.round(R * 100) / 100 }, "Status": { select: { name: R > 0 ? "win" : "loss" } } };
  if (uploadId) props["Screenshot"] = { files: [{ type: "file_upload", name: "trade.png", file_upload: { id: uploadId } }] };   // outcome shot replaces the entry shot
  const r = await nfetch(`https://api.notion.com/v1/pages/${pageId}`, { method: 'PATCH',
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NV, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: props }) });
  if (!r.ok) throw new Error(`page update ${r.status} ${r.j.message}`);
}

// Per-symbol min tick (so the position tool's stop/profit levels land at the exact prices).
function minTickFor(symbol) {
  const s = (symbol || '').toUpperCase();
  if (/JPY/.test(s)) return 0.001;
  if (/XAU|GOLD/.test(s)) return 0.01;
  if (/XAG|SILVER/.test(s)) return 0.001;
  if (/US30|NAS100|NDX|SPX500|US500|GER40|UK100|AUS200|JP225|HK50|EUSTX|DJ|DAX|FTSE/.test(s)) return 1;
  if (/WTI|OIL|BRENT|XTI|USOIL/.test(s)) return 0.01;
  if (/BTC/.test(s)) return 1;
  if (/ETH/.test(s)) return 0.1;
  return 0.00001; // FX majors/crosses (5-decimal)
}

// ── TradingView OUTCOME screenshot (taken once the trade has closed) ───────────
// Frames the WHOLE story: ~60 bars of context before entry, the native R:R box +
// entry/SL/TP lines, the path of price to the exit, and an exit marker labelled
// WIN/LOSS with the R multiple. Price axis fits the ACTUAL price action (from the
// chart's bars), not just the bracket — so nothing relevant is cropped out.
const TF_SECONDS = { '1': 60, '5': 300, '15': 900, '30': 1800, '60': 3600, '240': 14400, 'D': 86400 };
const MIN_STORY_BARS = 8, MAX_STORY_BARS = 140;

// TV-feed aliases: some cTrader names don't resolve on the BlackBull TV feed
// (GER40 is GER30 there — the known GER40→GER30 name gap). Tried in order.
const TV_ALIASES = {
  GER40: ['GER40', 'GER30', 'DE40', 'DAX40'],
  NAS100: ['NAS100', 'USTEC', 'US100'],
  US30: ['US30', 'DJ30'], SPX500: ['SPX500', 'US500'], AUS200: ['AUS200', 'AU200'],
};

// Switch the chart and VERIFY it actually landed on the requested instrument —
// setSymbol fails silently on unknown names and the chart stays on the previous
// symbol, which produced level-lines miles away from the candles (blank shots).
async function switchToSymbol(setSymbol, getState, want) {
  const candidates = TV_ALIASES[String(want).toUpperCase()] || [want];
  const onIt = async cand => {
    try { return String((await getState())?.symbol || '').toUpperCase().includes(String(cand).toUpperCase()); } catch { return false; }
  };
  // already showing one of the candidates? (re-switching to the same symbol fires
  // no change event and made verification flake on back-to-back same-instrument shots)
  for (const cand of candidates) if (await onIt(cand)) return cand;
  for (const cand of candidates) {
    try { await setSymbol({ symbol: cand }); } catch {}
    await new Promise(r => setTimeout(r, 3500));
    if (await onIt(cand)) return cand;
  }
  return null;
}

// Pick the timeframe that makes the TRADE itself readable: start from the signal's
// native tf, then zoom IN if entry→exit spans fewer than MIN_STORY_BARS candles
// (a 2-candle trade on 1h was an invisible sliver) or OUT if it exceeds MAX_STORY_BARS.
function chooseTf(nativeTf, durationSec) {
  const ladder = ['5', '15', '30', '60', '240', 'D'];
  let i = ladder.indexOf(String(nativeTf)); if (i < 0) i = ladder.indexOf('60');
  while (durationSec / TF_SECONDS[ladder[i]] < MIN_STORY_BARS && i > 0) i--;
  while (durationSec / TF_SECONDS[ladder[i]] > MAX_STORY_BARS && i < ladder.length - 1) i++;
  return ladder[i];
}

async function screenshotTrade(t) {
  const { setSymbol, setTimeframe, setVisibleRange, getState } = await import(`file://${REPO}/src/core/chart.js`);
  const { drawShape } = await import(`file://${REPO}/src/core/drawing.js`);
  const { captureScreenshot } = await import(`file://${REPO}/src/core/capture.js`);
  const { getOhlcv } = await import(`file://${REPO}/src/core/data.js`);
  const { evaluate, getChartApi } = await import(`file://${REPO}/src/connection.js`);
  const entryTime = t.entryTime || Math.floor(Date.now() / 1000);    // unix SECONDS of the entry candle
  const endTime   = t.exitTime  || Math.floor(Date.now() / 1000);    // exit candle (or now if still open)
  const tf = chooseTf(t.tf, Math.max(endTime - entryTime, 1));
  const tfSec = TF_SECONDS[tf];
  const landed = await switchToSymbol(setSymbol, getState, t.symbol);
  if (!landed) { log(`✗ ${t.symbol}: no TV symbol resolves (tried aliases) — skipping shot`); return null; }
  try { await setTimeframe({ timeframe: tf }); } catch {}
  await new Promise(r => setTimeout(r, 3500));
  const api = await getChartApi();
  const minTick = minTickFor(t.symbol);
  const stopLevel   = Math.max(1, Math.round(Math.abs(t.entry - t.sl) / minTick));
  const profitLevel = Math.max(1, Math.round(Math.abs(t.tp - t.entry) / minTick));
  const shape = (t.dir === 'long' || t.dir === 'buy') ? 'long_position' : 'short_position';
  // Context scales with the trade: ~3× the trade's own span before entry (min 20,
  // max 60 bars) and up to 20 bars after exit — so the trade never shrinks to a sliver
  const durBars  = Math.max(1, Math.ceil((endTime - entryTime) / tfSec));
  const preBars  = Math.min(60, Math.max(20, 3 * durBars));
  const postBars = Math.min(20, Math.max(8, durBars));
  const winFrom = entryTime - preBars * tfSec;
  const winTo   = endTime + postBars * tfSec;
  // setVisibleRange maps times onto the LOADED series — right after a tf switch the
  // series can still be loading and the call silently no-ops, leaving the default
  // zoom (a dense mess). Verify the achieved range and retry while data loads.
  let framed = false;
  const span = winTo - winFrom;
  for (let attempt = 0; attempt < 3 && !framed; attempt++) {
    try {
      const r = await setVisibleRange({ from: winFrom, to: winTo });
      const a = r?.actual || {};
      framed = a.from > 0 && Math.abs(a.from - winFrom) < span && Math.abs(a.to - winTo) < span;
    } catch {}
    if (!framed) await new Promise(r2 => setTimeout(r2, 2000));
  }
  // most likely cause: confirm_runner's 5-min chart sweep fighting us for the chart —
  // throw a retryable error so the caller defers to the next (quieter) cron tick
  if (!framed) throw new Error('framing-not-applied (chart contention?) — will retry next tick');
  await new Promise(r => setTimeout(r, 900));
  const ids = [];
  try {
    // 1) the native position tool (R:R zones) anchored at the REAL entry candle
    const before = (await evaluate(`${api}.getAllShapes().map(function(s){return s.id;})`)) || [];
    await evaluate(`${api}.createMultipointShape([{time:${entryTime},price:${t.entry}}],{shape:'${shape}',overrides:{stopLevel:${stopLevel},profitLevel:${profitLevel}}})`);
    await new Promise(r => setTimeout(r, 1100));
    const after = (await evaluate(`${api}.getAllShapes().map(function(s){return s.id;})`)) || [];
    const boxId = after.find(id => !before.includes(id)); if (boxId) ids.push(boxId);
    // 2) bold price-labeled lines so entry / SL / TP are unmistakable
    for (const [price, color, label] of [[t.entry, '#ffffff', `ENTRY ${t.entry}`], [t.sl, '#ff1744', `SL ${t.sl}`], [t.tp, '#00e676', `TP ${t.tp}`]]) {
      try { const r = await drawShape({ shape: 'horizontal_line', point: { time: entryTime, price }, overrides: { linecolor: color, linewidth: 2, showLabel: true, textcolor: color, fontsize: 14, horzLabelsAlign: 'left' }, text: label }); if (r?.entity_id) ids.push(r.entity_id); } catch {}
    }
    // 3) exit marker: where and how the trade ended (win/loss + R)
    if (t.exitTime && t.outcome) {
      const exitColor = t.outcome === 'WIN' ? '#00e676' : '#ff1744';
      const exitLabel = `EXIT ${t.outcome}${isFinite(t.rMultiple) ? ` ${t.rMultiple >= 0 ? '+' : ''}${t.rMultiple.toFixed(2)}R` : ''}`;
      try { const r = await drawShape({ shape: 'vertical_line', point: { time: endTime, price: t.entry }, overrides: { linecolor: exitColor, linewidth: 2, textcolor: exitColor, fontsize: 14, showLabel: true }, text: exitLabel }); if (r?.entity_id) ids.push(r.entity_id); } catch {}
    }
  } catch (e) { log(`draw failed ${t.symbol}: ${e.message}`); }
  // Price axis: fit the REAL price action of the framed window PLUS all three levels,
  // with margin — auto-scale is dominated by the user's S/R drawings (SL got clipped),
  // and the old bracket-only range cropped the surrounding structure.
  let hi = Math.max(t.entry, t.sl, t.tp), lo = Math.min(t.entry, t.sl, t.tp);
  try {
    const o = await getOhlcv({ count: 300 });
    const win = (o.bars || []).filter(b => b.time >= winFrom && b.time <= winTo);
    const bars = win.length ? win : (o.bars || []);
    // sanity: if the loaded candles are nowhere near the trade's entry, the feed is
    // showing something else — skip rather than upload a chartless shot
    if (bars.length) {
      const closes = bars.map(b => b.close).sort((a, b) => a - b);
      const median = closes[Math.floor(closes.length / 2)];
      if (Math.abs(median - t.entry) / t.entry > 0.2) { log(`✗ ${t.symbol}: chart prices (~${median}) don't match entry ${t.entry} — skipping shot`); return null; }
      // fit to the 5th–95th percentile of wicks, not absolute extremes — one outlier
      // spike in the context bars was stretching the range and leaving half the frame empty
      const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
      const lowsSorted  = bars.map(b => b.low).sort((a, b) => a - b);
      const highsSorted = bars.map(b => b.high).sort((a, b) => a - b);
      hi = Math.max(hi, q(highsSorted, 0.95));
      lo = Math.min(lo, q(lowsSorted, 0.05));
    }
  } catch (e) { log(`ohlcv for framing failed ${t.symbol}: ${e.message}`); }
  // cap the vertical span at 8× the bracket so a big unrelated swing in the window
  // (crypto especially) can't squish the trade's entry/SL/TP into a sliver
  const bspan = Math.abs(t.tp - t.sl) || (hi - lo) || 1;
  if (hi - lo > 8 * bspan) {
    const mid = (Math.max(t.entry, t.sl, t.tp) + Math.min(t.entry, t.sl, t.tp)) / 2;
    hi = Math.min(hi, mid + 4 * bspan);
    lo = Math.max(lo, mid - 4 * bspan);
  }
  const pmarg = (hi - lo) * 0.14 || Math.abs(t.tp - t.sl) * 0.30;   // 14%: enough headroom that levels/candles at the extremes never clip
  const pLo = lo - pmarg, pHi = hi + pmarg;
  try { await evaluate(`(function(){var s=${api}.getPanes()[0].getMainSourcePriceScale();s.setAutoScale(false);s.setVisiblePriceRange({from:${pLo.toFixed(5)},to:${pHi.toFixed(5)}});return 1;})()`); } catch {}
  await new Promise(r => setTimeout(r, 1500));
  const shot = await captureScreenshot({ filename: `trade_${t.symbol}_${t.positionId}_${Date.now()}`, region: 'chart' });   // crop to the chart pane
  try { await evaluate(`${api}.getPanes()[0].getMainSourcePriceScale().setAutoScale(true)`); } catch {}   // restore auto-scale — never leave the user's chart locked
  for (const id of ids) { try { await evaluate(`${api}.removeEntity('${id}')`); } catch {} }   // remove only OUR shapes (never the user's drawings)
  return shot?.file_path || null;
}

async function main() {
  if (!NOTION_TOKEN || !NOTION_DB) { log('missing NOTION_TOKEN/NOTION_DB — skipping'); return; }
  const b = await import('./broker_ctrader.mjs');
  await b.connect();
  const state = loadState();
  const sigMap = loadSignalMap();

  const positions = await b.getPositions();
  const openIds = new Set(positions.map(p => p.positionId));

  const busy = () => existsSync(LOCK_FILE) && (Date.now() - Number(readFileSync(LOCK_FILE, 'utf8') || 0) < 60000);

  // 1) NEW open positions -> entry screenshot (position tool anchored at the entry candle) + Notion row
  for (const p of positions) {
    if (state[p.positionId]) continue;
    if (!p.stopLoss || !p.takeProfit) continue;           // wait until bracketed (never-naked)
    const sig = sigMap[p.positionId] || {};
    let symbol = sig.symbol;
    if (!symbol) { try { symbol = (await b.getSymbolNameById(p.symbolId))?.name?.replace(/[^A-Za-z0-9]+$/, '') || `id${p.symbolId}`; } catch { symbol = `id${p.symbolId}`; } }
    // real entry time: experiment uses the signal bar; scanner uses the position open timestamp.
    const entryTime = sig.barT ? Math.floor(sig.barT / 1000) : (p.openTimestamp ? Math.floor(p.openTimestamp / 1000) : Math.floor(Date.now() / 1000));
    const tf = sig.tf || '60';
    const t = { positionId: p.positionId, symbol, dir: p.direction, entry: p.entryPrice, sl: p.stopLoss, tp: p.takeProfit, strategy: sig.strategy || 'scanner', tf, entryTime };
    // Planned risk: signal record when available (experiment), else the
    // position's own entry/SL/volume geometry (scanner). Last-resort constant
    // only if both are unusable.
    let risk = (sig.equity && sig.riskPct) ? sig.equity * (sig.riskPct / 100) : 0;
    if (!(risk > 0)) {
      try {
        const meta = await b.getSymbolMeta(symbol);
        const lots = meta?.lotSize > 0 ? p.volumeCents / meta.lotSize : 0;
        risk = plannedRiskUsd(symbol, p.entryPrice, p.stopLoss, lots);
      } catch { /* fall through */ }
    }
    if (!(risk > 0)) risk = (sig.equity || 10000) * (CONFIRM_RISK_PCT / 100);
    try {
      // No entry screenshot (removed 2026-07-03): the single wide-frame OUTCOME shot
      // at close is the record that matters. Row is still journaled at open.
      const pageId = await createTradePage(t, null);
      state[p.positionId] = { pageId, risk, done: false, symbol, strategy: t.strategy, dir: t.dir, entry: t.entry, sl: t.sl, tp: t.tp, tf, entryTime };
      log(`✅ synced ${t.strategy}/${symbol} pos=${p.positionId} entryTime=${entryTime} -> Notion (outcome shot on close)`);
      saveState(state);
    } catch (e) { log(`✗ sync ${symbol} pos=${p.positionId}: ${e.message}`); }
  }

  // 2) CLOSED positions -> OUTCOME screenshot (entry candle -> exit, shows TP-hit vs stopped-out) + Result R + win/loss
  const closed = await b.getAllClosedDeals(Date.now() - 14 * 86400000).catch(() => []);
  const netByPos = new Map(), exitTsByPos = new Map();
  for (const d of closed) {
    netByPos.set(d.positionId, (netByPos.get(d.positionId) || 0) + d.net);
    if ((d.execTs || 0) > (exitTsByPos.get(d.positionId) || 0)) exitTsByPos.set(d.positionId, d.execTs);
  }
  for (const [posId, s] of Object.entries(state)) {
    if (s.done) continue;
    if (openIds.has(Number(posId))) continue;             // still open
    if (!netByPos.has(Number(posId))) continue;           // not closed yet / unknown
    const R = s.risk > 0 ? netByPos.get(Number(posId)) / s.risk : 0;
    const exitTime = exitTsByPos.has(Number(posId)) ? Math.floor(exitTsByPos.get(Number(posId)) / 1000) : null;
    // chart in use by another run -> defer the WHOLE close-processing to the next cron
    // tick (previously it updated the row shot-less and marked it done forever)
    if (busy() && s.symbol && s.entry) { log(`chart busy — defer outcome pos=${posId}`); continue; }
    let uploadId = null, deferShot = false;
    if (s.symbol && s.entry) {
      writeFileSync(LOCK_FILE, String(Date.now()));
      try { const png = await screenshotTrade({ ...s, positionId: posId, exitTime, outcome: R > 0 ? 'WIN' : 'LOSS', rMultiple: R }); if (png) uploadId = await uploadScreenshot(png); }
      catch (e) { if (/framing-not-applied/.test(e.message)) deferShot = true; log(`outcome shot pos=${posId} failed: ${e.message}`); }
      finally { try { writeFileSync(LOCK_FILE, '0'); } catch {} }
    }
    if (deferShot) continue;   // transient chart contention — leave un-done, retry next cron tick
    try { await updateResultAndShot(s.pageId, R, uploadId); s.done = true; log(`📊 outcome ${s.strategy}/${s.symbol} pos=${posId} R=${R.toFixed(2)} ${uploadId ? '+outcome-shot' : ''}`); saveState(state); }
    catch (e) { log(`result update pos=${posId} failed: ${e.message}`); }
  }
  log('notion sync done');
  process.exit(0);
}
main().catch(e => { console.error('trade_notion_sync failed:', e); process.exit(1); });
