/**
 * confirm_reference.mjs — Phase 3: surface an instrument's past trades when a new
 * one is made. Queries the Notion journal for the same instrument's reconciled
 * trades and returns a compact "what worked" summary + the recent outcomes.
 *
 * Module:  referenceForSymbol(symbol) -> { n, wr, avgR, totalR, byDir, recent[], takeaway, lines[] }
 * CLI:     node confirm_reference.mjs GBPUSD        (needs ~/.notion.env)
 *
 * Wired into trade_notion_sync.mjs: each NEW trade page gets a "📌 Past on <SYMBOL>"
 * body section so every trade card carries its instrument's history.
 */
const NV = '2022-06-28';
const TOKEN = process.env.NOTION_TOKEN, DB = process.env.NOTION_DB;

const sel = p => p?.select?.name ?? null;
const num = p => (typeof p?.number === 'number' ? p.number : null);
const normDir = d => (/long|buy/i.test(d || '') ? 'long' : /short|sell/i.test(d || '') ? 'short' : (d || '?'));
const fmt = x => (x >= 0 ? '+' : '') + x.toFixed(2);

export async function referenceForSymbol(symbol, { max = 5 } = {}) {
  if (!TOKEN || !DB || !symbol) return null;
  let j;
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': NV, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: { and: [
          { property: 'Instrument', rich_text: { equals: symbol } },
          { property: 'Result R', number: { is_not_empty: true } },   // reconciled only
        ]},
        sorts: [{ property: 'Opened', direction: 'descending' }],
        page_size: 50,
      }),
    });
    if (!r.ok) return null;
    j = await r.json();
  } catch { return null; }

  const trades = (j.results || []).map(pg => ({
    dir: normDir(sel(pg.properties['Direction'])),
    R: num(pg.properties['Result R']),
    status: sel(pg.properties['Status']),
    strat: sel(pg.properties['Strategy']) || '',
    opened: (pg.properties['Opened']?.date?.start || '').slice(0, 10),
    url: pg.url,
  })).filter(t => t.R !== null);

  const n = trades.length;
  if (!n) return { symbol, n: 0, lines: [`📌 Past on ${symbol}: no prior trades logged yet — first one on record.`] };

  const wins = trades.filter(t => t.R > 0).length;
  const wr = Math.round(wins / n * 100);
  const totalR = trades.reduce((s, t) => s + t.R, 0);
  const avgR = totalR / n;
  const dirStat = dir => {
    const ts = trades.filter(t => t.dir === dir);
    if (!ts.length) return null;
    const w = ts.filter(t => t.R > 0).length, tot = ts.reduce((s, t) => s + t.R, 0);
    return { n: ts.length, wr: Math.round(w / ts.length * 100), totalR: tot, avgR: tot / ts.length };
  };
  const byDir = { long: dirStat('long'), short: dirStat('short') };
  const recent = trades.slice(0, max);

  let takeaway = totalR > 0 ? `net positive (${fmt(totalR)}R, ${wr}% WR) — instrument has paid here.`
                            : `net NEGATIVE (${fmt(totalR)}R over ${n}) — be selective.`;
  if (byDir.long && byDir.short) {
    const better = byDir.long.avgR >= byDir.short.avgR ? 'long' : 'short';
    const b = byDir[better];
    takeaway += ` ${better}s have worked better (${b.wr}% WR, ${fmt(b.avgR)}R avg).`;
  }
  const last3 = recent.slice(0, 3);
  if (last3.length === 3 && last3.every(t => t.R < 0)) takeaway += ` ⚠ last 3 all losses — caution.`;
  else if (last3.length === 3 && last3.every(t => t.R > 0)) takeaway += ` 🔥 last 3 all wins.`;

  const lines = [`📌 Past on ${symbol}: ${n} trades · ${wr}% WR · avg ${fmt(avgR)}R · total ${fmt(totalR)}R`];
  if (byDir.long)  lines.push(`longs: ${byDir.long.n} · ${byDir.long.wr}% WR · ${fmt(byDir.long.totalR)}R`);
  if (byDir.short) lines.push(`shorts: ${byDir.short.n} · ${byDir.short.wr}% WR · ${fmt(byDir.short.totalR)}R`);
  lines.push(`takeaway: ${takeaway}`);
  for (const t of recent) lines.push(`• ${t.opened} ${t.dir}${t.strat ? ' ' + t.strat : ''} → ${fmt(t.R)}R (${t.status})`);
  return { symbol, n, wr, avgR, totalR, byDir, recent, takeaway, lines };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const sym = (process.argv[2] || '').toUpperCase();
  if (!sym) { console.error('usage: node confirm_reference.mjs <SYMBOL>'); process.exit(1); }
  referenceForSymbol(sym).then(ref => {
    if (!ref) { console.error('no NOTION_TOKEN/NOTION_DB or query failed'); process.exit(1); }
    console.log((ref.lines || []).join('\n'));
    process.exit(0);
  });
}
