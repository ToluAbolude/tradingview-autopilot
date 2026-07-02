/**
 * trade_notion_sync.mjs — Logs every trade to Notion with an annotated TradingView
 * screenshot (entry / SL / TP lines), and updates the row with the result when it closes.
 *
 * Runs once per account (CTRADER_ACCOUNT_ID picks which): experiment 2131377 or
 * scanner 2118552. Cron every few minutes. Needs ~/.notion.env (NOTION_TOKEN, NOTION_DB)
 * and the cTrader env. Reuses the repo's CDP chart tools for the screenshot.
 *
 * Flow each run:
 *   1. open positions  -> any new positionId gets a screenshot + a Notion page (Status=open)
 *   2. recently closed -> matching synced rows get Result R + Status (win/loss)
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
  "SL": { number: {} }, "TP": { number: {} }, "Status": { select: {} },
  "Opened": { date: {} }, "Position ID": { rich_text: {} }, "Screenshot": { files: {} },
  "Result R": { number: {} },
};

function log(m) { process.stdout.write(`[${new Date().toISOString()}] ${m}\n`); }
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

// ── TradingView screenshot using the native Long/Short Position tool ───────────
// Draws the proper risk/reward box (entry → green TP zone, entry → red SL zone),
// captures it, then removes ONLY that shape (never the user's own drawings).
async function screenshotTrade(t) {
  const { setSymbol, setTimeframe, setVisibleRange } = await import(`file://${REPO}/src/core/chart.js`);
  const { drawShape } = await import(`file://${REPO}/src/core/drawing.js`);
  const { captureScreenshot } = await import(`file://${REPO}/src/core/capture.js`);
  const { evaluate, getChartApi } = await import(`file://${REPO}/src/connection.js`);
  await setSymbol({ symbol: t.symbol });
  if (t.tf) { try { await setTimeframe({ timeframe: String(t.tf) }); } catch {} }
  await new Promise(r => setTimeout(r, 4500));
  const api = await getChartApi();
  const minTick = minTickFor(t.symbol);
  const stopLevel   = Math.max(1, Math.round(Math.abs(t.entry - t.sl) / minTick));
  const profitLevel = Math.max(1, Math.round(Math.abs(t.tp - t.entry) / minTick));
  const shape = (t.dir === 'long' || t.dir === 'buy') ? 'long_position' : 'short_position';
  const entryTime = t.entryTime || Math.floor(Date.now() / 1000);    // unix SECONDS of the entry candle
  const endTime   = t.exitTime  || Math.floor(Date.now() / 1000);    // exit candle (or now if still open)
  // Frame so the entry candle AND the price action through to exit/now are visible
  // (shows whether it reached the TP zone or got stopped out).
  try { await setVisibleRange({ from: entryTime - 36 * 3600, to: endTime + 8 * 3600 }); } catch {}   // zoomed out for context
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
  } catch (e) { log(`draw failed ${t.symbol}: ${e.message}`); }
  // Set the price axis DIRECTLY so entry/SL/TP all fit with margin — auto-scale
  // ignores horizontal lines and is dominated by the user's S/R drawings, so SL got clipped.
  const pmarg = Math.abs(t.tp - t.sl) * 0.30;
  const pLo = Math.min(t.sl, t.tp) - pmarg, pHi = Math.max(t.sl, t.tp) + pmarg;
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
    const risk = (sig.equity || 10000) * ((sig.riskPct || CONFIRM_RISK_PCT) / 100);
    try {
      if (busy()) { log(`chart busy — defer ${symbol}`); continue; }
      writeFileSync(LOCK_FILE, String(Date.now()));
      let pngPath = null; try { pngPath = await screenshotTrade(t); } catch (e) { log(`screenshot failed ${symbol}: ${e.message}`); }
      let uploadId = null; if (pngPath) { try { uploadId = await uploadScreenshot(pngPath); } catch (e) { log(`upload failed: ${e.message}`); } }
      const pageId = await createTradePage(t, uploadId);
      state[p.positionId] = { pageId, risk, done: false, symbol, strategy: t.strategy, dir: t.dir, entry: t.entry, sl: t.sl, tp: t.tp, tf, entryTime };
      log(`✅ synced ${t.strategy}/${symbol} pos=${p.positionId} entryTime=${entryTime} -> Notion ${uploadId ? '+shot' : '(no shot)'}`);
      saveState(state);
    } catch (e) { log(`✗ sync ${symbol} pos=${p.positionId}: ${e.message}`); }
    finally { try { if (existsSync(LOCK_FILE)) writeFileSync(LOCK_FILE, '0'); } catch {} }
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
    let uploadId = null;
    if (!busy() && s.symbol && s.entry) {
      writeFileSync(LOCK_FILE, String(Date.now()));
      try { const png = await screenshotTrade({ ...s, positionId: posId, exitTime }); if (png) uploadId = await uploadScreenshot(png); }
      catch (e) { log(`outcome shot pos=${posId} failed: ${e.message}`); }
      finally { try { writeFileSync(LOCK_FILE, '0'); } catch {} }
    }
    try { await updateResultAndShot(s.pageId, R, uploadId); s.done = true; log(`📊 outcome ${s.strategy}/${s.symbol} pos=${posId} R=${R.toFixed(2)} ${uploadId ? '+outcome-shot' : ''}`); saveState(state); }
    catch (e) { log(`result update pos=${posId} failed: ${e.message}`); }
  }
  log('notion sync done');
  process.exit(0);
}
main().catch(e => { console.error('trade_notion_sync failed:', e); process.exit(1); });
