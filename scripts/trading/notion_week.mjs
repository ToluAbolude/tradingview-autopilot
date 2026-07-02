/**
 * notion_week.mjs — shared "Trading Notes → one sub-DB per ISO week" helpers.
 *
 * Used by trade_notion_sync.mjs (each trade → a row in its week's sub-DB) and
 * confirm_weekly_review.mjs (the weekly PASS/WATCH/CUT review → a row in the
 * SAME week's sub-DB, so everything for a week lives together).
 *
 * Env: NOTION_TOKEN, NOTION_PARENT (the "Trading Notes" page id). Week-DB ids are
 * cached in trading-data/notion_week_dbs.json so each week's DB is created once.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

const DATA_ROOT = os.platform() === 'linux' ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const WEEK_DB_FILE = join(DATA_ROOT, 'notion_week_dbs.json');
const NV = '2022-06-28';

// Trade schema for a week sub-database (matches trade_notion_sync's row props).
export const WEEK_DB_SCHEMA = {
  "Name": { title: {} }, "Instrument": { rich_text: {} }, "Strategy": { select: {} },
  "Direction": { select: {} }, "Account": { select: {} }, "Entry": { number: {} },
  "SL": { number: {} }, "TP": { number: {} }, "Status": { select: {} },
  "Opened": { date: {} }, "Position ID": { rich_text: {} }, "Screenshot": { files: {} },
  "Result R": { number: {} },
};

// ISO-week key + human title (Monday–Sunday of the given UTC week).
export function isoWeekInfo(d = new Date()) {
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

async function nf(url, opts) { const r = await fetch(url, opts); const j = await r.json().catch(() => ({})); return { ok: r.ok, status: r.status, j }; }

// This week's sub-DB id — created under NOTION_PARENT on first use, then cached.
// null => caller falls back to the flat NOTION_DB (page not shared / not configured).
export async function ensureWeekDb(log = () => {}) {
  const TOKEN = process.env.NOTION_TOKEN, PARENT = process.env.NOTION_PARENT;
  if (!TOKEN || !PARENT) return null;
  const { key, title } = isoWeekInfo();
  let cache = {}; try { cache = JSON.parse(readFileSync(WEEK_DB_FILE, 'utf8')); } catch {}
  if (cache[key]) return cache[key];
  const r = await nf('https://api.notion.com/v1/databases', { method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': NV, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: { type: 'page_id', page_id: PARENT }, title: [{ text: { content: title } }], properties: WEEK_DB_SCHEMA }) });
  if (!r.ok) { log(`week-db create failed (${r.status} ${r.j.message}) — using flat DB`); return null; }
  cache[key] = r.j.id; try { writeFileSync(WEEK_DB_FILE, JSON.stringify(cache, null, 2)); } catch {}
  log(`📁 created week DB "${title}"`);
  return r.j.id;
}
