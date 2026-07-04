/**
 * notion_status_colors.mjs — set the Status select colors (open=yellow, win=green,
 * loss=red) on the flat NOTION_DB and on every cached weekly sub-DB.
 *
 * Notion forbids recoloring an EXISTING option, so where a direct update fails we
 * do the swap dance: add temp colored options -> repoint every page -> drop the
 * old options -> rename the temps back to the original names. Safe to re-run.
 *
 * Usage (VM): set -a; . ~/.notion.env; set +a; node scripts/trading/notion_status_colors.mjs
 */
import { readFileSync } from 'fs';
import os from 'os';

const IS_LINUX = os.platform() === 'linux';
const DATA_ROOT = IS_LINUX ? '/home/ubuntu/trading-data' : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const NV = '2022-06-28';
const TOKEN = process.env.NOTION_TOKEN, DB = process.env.NOTION_DB;
const COLORS = { open: 'yellow', win: 'green', loss: 'red' };
const H = { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': NV, 'Content-Type': 'application/json' };

const getDb = async id => { const r = await fetch(`https://api.notion.com/v1/databases/${id}`, { headers: H }); return { ok: r.ok, j: await r.json().catch(() => ({})) }; };
const patchOptions = async (id, options) => { const r = await fetch(`https://api.notion.com/v1/databases/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ properties: { Status: { select: { options } } } }) }); return { ok: r.ok, j: await r.json().catch(() => ({})) }; };
const setStatus = async (pageId, name) => fetch(`https://api.notion.com/v1/pages/${pageId}`, { method: 'PATCH', headers: H, body: JSON.stringify({ properties: { Status: { select: { name } } } }) });

async function queryAll(dbId) {
  const pages = []; let cursor;
  do {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, { method: 'POST', headers: H, body: JSON.stringify(cursor ? { start_cursor: cursor } : {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) break;
    pages.push(...(j.results || []));
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return pages;
}

async function recolor(dbId) {
  const g = await getDb(dbId);
  if (!g.ok) { console.log(`✗ ${dbId}: ${g.j.message}`); return; }
  const title = g.j.title?.[0]?.plain_text || dbId;
  const prop = g.j.properties?.Status;
  if (!prop?.select) { console.log(`- ${title}: no Status select, skipped`); return; }

  const already = Object.entries(COLORS).every(([n, c]) => prop.select.options.find(o => o.name === n && o.color === c));
  if (already) { console.log(`✓ ${title} (already colored)`); return; }

  // attempt 1: direct recolor (works when the option doesn't exist yet or color matches)
  const direct = prop.select.options.map(o => COLORS[o.name] ? { id: o.id, name: o.name, color: COLORS[o.name] } : { id: o.id, name: o.name });
  for (const name of Object.keys(COLORS)) if (!direct.find(o => o.name === name)) direct.push({ name, color: COLORS[name] });
  const d = await patchOptions(dbId, direct);
  if (d.ok) { console.log(`✓ ${title} (direct)`); return; }

  // attempt 2: swap dance
  const keep = prop.select.options.map(o => ({ id: o.id, name: o.name }));
  const temps = Object.entries(COLORS).map(([n, c]) => ({ name: `${n}_`, color: c }));
  let r = await patchOptions(dbId, [...keep, ...temps]);
  if (!r.ok) { console.log(`✗ ${title}: temp add failed: ${r.j.message}`); return; }

  const pages = await queryAll(dbId);
  let moved = 0;
  for (const pg of pages) {
    const cur = pg.properties?.Status?.select?.name;
    if (COLORS[cur]) { await setStatus(pg.id, `${cur}_`); moved++; }
  }

  const g2 = await getDb(dbId);
  const withoutOld = g2.j.properties.Status.select.options.filter(o => !COLORS[o.name]).map(o => ({ id: o.id, name: o.name }));
  r = await patchOptions(dbId, withoutOld);
  if (!r.ok) { console.log(`✗ ${title}: old-option removal failed: ${r.j.message}`); return; }

  const g3 = await getDb(dbId);
  const renamed = g3.j.properties.Status.select.options.map(o => {
    const base = o.name.endsWith('_') ? o.name.slice(0, -1) : null;
    return base && COLORS[base] ? { id: o.id, name: base } : { id: o.id, name: o.name };
  });
  r = await patchOptions(dbId, renamed);
  console.log(`${r.ok ? '✓' : '✗'} ${title} (swap dance, ${moved} pages repointed)${r.ok ? '' : ': ' + r.j.message}`);
}

const dbs = new Set([DB].filter(Boolean));
try {
  const weeks = JSON.parse(readFileSync(`${DATA_ROOT}/notion_week_dbs.json`, 'utf8'));
  for (const id of Object.values(weeks)) dbs.add(id);
} catch {}
if (!TOKEN || !dbs.size) { console.error('need NOTION_TOKEN/NOTION_DB env'); process.exit(1); }
for (const d of dbs) await recolor(d);
