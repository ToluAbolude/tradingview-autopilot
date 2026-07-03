/**
 * okala_8020.mjs — Okala "80/20 Nasdaq Strategy" (Chart Fanatics).
 * Rules source: strategies/chart_fanatics/raw/80-20-nasdaq-strategy.md
 *
 * Nasdaq intraday levels ending in 20/80, mechanized on M5 (playbook executes
 * on a 200-second chart — M5 is the closest cTrader TF with usable history):
 *  • Level: nearest price with last-two-digits 20 or 80 (…x20 / …x80), price
 *    must be within LEVEL_TOL points of it.
 *  • FORK (long reversal): strong down-push, a rejection candle with a long
 *    lower wick at the level, next candle FAILS to break that low and turns up
 *    → long on the failure bar's close.
 *  • H (short continuation): bounce into an …80 level rejects (upper wick),
 *    price rolls over and retests → short.
 *  • Fixed 10-point stop (the playbook's core risk rule), first scale +15pt.
 *    Sim variants: tp15 (1.5R single target), tp30 w/ BE at +15 (runner-ish).
 *  • NY-session filter (13:30–20:00 UTC); playbook says the open is best.
 * NAS100-only by design. Costs matter: 1.5-pt spread ≈ 15% of the 10-pt stop.
 */

const LEVEL_TOL = 12;     // must be within this many points of a 20/80 level
const STOP_PTS = 10;      // fixed stop (points)
const WICK_MIN = 0.5;     // rejection wick ≥ 50% of candle range
const PUSH_ATR = 1.2;     // preceding push ≥ this × ATR over PUSH_BARS
const PUSH_BARS = 6;

export const meta = {
  name: 'Okala — 80/20 Nasdaq (Fork reversal / H continuation at x20/x80 levels)',
  defaultTf: 'M5',
  note: 'NAS100 only. Fixed 10-pt stop per playbook; spread 1.5pt = 15% of stop — cost-fragile by design.',
};

export const configs = [
  { name: 'fork tp15 ny',      setup: 'fork', tp: 15, ny: true },
  { name: 'fork tp30+be ny',   setup: 'fork', tp: 30, be: 15, ny: true },
  { name: 'h tp15 ny',         setup: 'h',    tp: 15, ny: true },
  { name: 'both tp15 ny',      setup: 'both', tp: 15, ny: true },
  { name: 'both tp15 allday',  setup: 'both', tp: 15, ny: false },
];

const hourUTC = t => { const d = new Date(t); return d.getUTCHours() + d.getUTCMinutes() / 60; };
// distance to the nearest …20/…80 level (last two digits of the integer price)
function levelDist(px) {
  const mod = ((px % 100) + 100) % 100;
  const dists = [20, 80].map(L => Math.min(Math.abs(mod - L), 100 - Math.abs(mod - L)));
  return Math.min(...dists);
}

export function signals(bars, atr, cfg) {
  const n = bars.length;
  const sigs = [];

  for (let i = PUSH_BARS + 2; i < n - 1; i++) {
    const b = bars[i], a = atr[i];
    if (!a) continue;
    if (cfg.ny) { const h = hourUTC(b.t); if (h < 13.5 || h >= 20) continue; }

    // ── FORK: down-push → rejection wick at level → this bar fails the low & turns up
    if (cfg.setup === 'fork' || cfg.setup === 'both') {
      const rej = bars[i - 1];
      const rng = rej.h - rej.l;
      const push = bars[i - 1 - PUSH_BARS].h - rej.l;
      const lowerWick = Math.min(rej.o, rej.c) - rej.l;
      if (rng > 0 && push >= PUSH_ATR * a * PUSH_BARS / 3
          && lowerWick >= WICK_MIN * rng
          && levelDist(rej.l) <= LEVEL_TOL
          && b.l > rej.l && b.c > b.o && b.c > rej.c) {
        const entry = b.c;
        const stop = rej.l - STOP_PTS;
        // stop must stay ~10pts: skip if entry drifted too far from the low
        if (entry - stop <= STOP_PTS * 2.2) {
          const risk = entry - stop;
          const sig = { i, dir: 'long', entry, stop, tp: entry + cfg.tp, label: 'fork' };
          if (cfg.be) sig.beTrigger = entry + cfg.be;
          if (risk > 0) sigs.push(sig);
        }
      }
    }

    // ── H: bounce into an …80/…20 level rejects (upper wick) → rollover retest short
    if (cfg.setup === 'h' || cfg.setup === 'both') {
      // find a rejection bar 2–8 bars back whose HIGH tagged a level with an upper wick
      for (let r = i - 2; r >= i - 8 && r > 0; r--) {
        const rej = bars[r];
        const rng = rej.h - rej.l;
        const upperWick = rej.h - Math.max(rej.o, rej.c);
        if (rng <= 0 || upperWick < WICK_MIN * rng || levelDist(rej.h) > LEVEL_TOL) continue;
        // bounce preceded it, and price has rolled over since (lower closes)
        const bounce = rej.h - bars[r - Math.min(PUSH_BARS, r)].l;
        if (bounce < PUSH_ATR * a * PUSH_BARS / 3) continue;
        let rolled = true;
        for (let k = r + 1; k <= i - 1; k++) if (bars[k].c > rej.h) { rolled = false; break; }
        if (!rolled) break;
        // retest: this bar trades back up near the rejection area and closes weak
        if (b.h >= rej.h - LEVEL_TOL && b.h <= rej.h + 3 && b.c < b.o) {
          const entry = b.c;
          const stop = Math.max(rej.h, b.h) + STOP_PTS;
          const risk = stop - entry;
          if (risk <= STOP_PTS * 2.2 && risk > 0) {
            const sig = { i, dir: 'short', entry, stop, tp: entry - cfg.tp, label: 'h-pattern' };
            if (cfg.be) sig.beTrigger = entry - cfg.be;
            sigs.push(sig);
          }
        }
        break;
      }
    }
  }
  return sigs;
}
