/**
 * marco_liquidity.mjs — Marco Trades "Liquidity Strategy" (Chart Fanatics).
 * Rules source: strategies/chart_fanatics/raw/liquidity-strategy.md
 *
 * Playbook, mechanized:
 *  • A swing high/low that was RESPECTED (price moved away ≥ moveAwayATR×ATR and
 *    didn't break it for ≥ respectBars bars) = a resting liquidity pool.
 *  • Wait for price to RETURN and trade THROUGH the pool (run the stops), then
 *    REJECT back inside within rejectWithin bars → trap confirmed.
 *  • Short above swept highs / long below swept lows, entry on the rejection
 *    close. "Buy below the low — never above."
 *  • SL beyond the sweep extreme ("always cover the last high/low").
 *  • TP = the nearest OPPOSITE liquidity pool (playbook targets actual
 *    liquidity, not R-multiples). No opposite pool → no trade.
 *  • Session window variants (playbook: "have a specific session window").
 *
 * v1 simplifications: fixed SL/TP (no HL/LH trailing), single entry, no partials.
 */

const PIV = 5;              // swing pivot half-length
const RESPECT_BARS = 10;    // bars the level must hold after confirmation
const MOVE_AWAY_ATR = 1.0;  // price must leave the level by ≥ this × ATR
const REJECT_WITHIN = 2;    // bars allowed between sweep and rejection close
const MAX_POOLS = 12;       // most recent pools tracked per side
const BUF_ATR = 0.15;       // SL buffer beyond sweep extreme

export const meta = {
  name: 'Marco Trades — Liquidity Strategy (sweep → trap → reversal)',
  defaultTf: 'H1',
  note: 'TP = nearest opposite pool (no fixed R). Sessions in UTC: LDN 07-11, NY 13:30-17.',
};

export const configs = [
  { name: 'all-hours both',        session: 'off', dir: 'both', minRR: 0 },
  { name: 'all-hours both minRR1', session: 'off', dir: 'both', minRR: 1.0 },
  { name: 'london both',           session: 'ldn', dir: 'both', minRR: 0 },
  { name: 'ny both',               session: 'ny',  dir: 'both', minRR: 0 },
  { name: 'ny both minRR1',        session: 'ny',  dir: 'both', minRR: 1.0 },
  { name: 'all-hours long',        session: 'off', dir: 'long', minRR: 0 },
  { name: 'all-hours short',       session: 'off', dir: 'short', minRR: 0 },
];

const inSession = (t, session) => {
  if (session === 'off') return true;
  const d = new Date(t);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (session === 'ldn') return mins >= 7 * 60 && mins < 11 * 60;
  if (session === 'ny')  return mins >= 13 * 60 + 30 && mins < 17 * 60;
  return true;
};

export function signals(bars, atr, cfg) {
  const n = bars.length;
  const sigs = [];
  // liquidity pools: { price, piv, born, swept:false, sweepStart }
  const highPools = [], lowPools = [];
  // candidate pivots awaiting "respected" status: { price, piv (pivot idx), conf (confirm idx) }
  const candHi = [], candLo = [];
  // active sweeps awaiting rejection: { pool, start, extreme }
  const sweepHi = [], sweepLo = [];

  for (let i = PIV * 2; i < n; i++) {
    const a = atr[i];
    if (!a) continue;

    // 1) new confirmed pivots (center bar i-PIV, causal: needs PIV bars after)
    const p = i - PIV;
    let isPH = true, isPL = true;
    for (let k = p - PIV; k <= p + PIV; k++) {
      if (k === p) continue;
      if (bars[k].h >= bars[p].h) isPH = false;
      if (bars[k].l <= bars[p].l) isPL = false;
      if (!isPH && !isPL) break;
    }
    if (isPH) candHi.push({ price: bars[p].h, piv: p, conf: i });
    if (isPL) candLo.push({ price: bars[p].l, piv: p, conf: i });

    // 2) promote candidates to pools once respected (held + moved away)
    for (let ci = candHi.length - 1; ci >= 0; ci--) {
      const c = candHi[ci];
      if (bars[i].h > c.price) { candHi.splice(ci, 1); continue; }      // broken before respected
      if (i - c.conf >= RESPECT_BARS && c.price - bars[i].c >= MOVE_AWAY_ATR * a) {
        highPools.push({ price: c.price, piv: c.piv, born: i });
        if (highPools.length > MAX_POOLS) highPools.shift();
        candHi.splice(ci, 1);
      }
    }
    for (let ci = candLo.length - 1; ci >= 0; ci--) {
      const c = candLo[ci];
      if (bars[i].l < c.price) { candLo.splice(ci, 1); continue; }
      if (i - c.conf >= RESPECT_BARS && bars[i].c - c.price >= MOVE_AWAY_ATR * a) {
        lowPools.push({ price: c.price, piv: c.piv, born: i });
        if (lowPools.length > MAX_POOLS) lowPools.shift();
        candLo.splice(ci, 1);
      }
    }

    // 3) detect sweeps of pools (price trades through resting liquidity)
    for (let pi = highPools.length - 1; pi >= 0; pi--) {
      const pool = highPools[pi];
      if (bars[i].h > pool.price) {
        sweepHi.push({ pool, start: i, extreme: bars[i].h });
        highPools.splice(pi, 1);                                        // pool is consumed
      }
    }
    for (let pi = lowPools.length - 1; pi >= 0; pi--) {
      const pool = lowPools[pi];
      if (bars[i].l < pool.price) {
        sweepLo.push({ pool, start: i, extreme: bars[i].l });
        lowPools.splice(pi, 1);
      }
    }

    // 4) rejection back inside within REJECT_WITHIN bars → signal
    for (let si = sweepHi.length - 1; si >= 0; si--) {
      const s = sweepHi[si];
      s.extreme = Math.max(s.extreme, bars[i].h);
      if (i - s.start > REJECT_WITHIN) { sweepHi.splice(si, 1); continue; }   // no trap → expansion, stand down
      if (bars[i].c < s.pool.price) {                                   // closed back below the run high
        sweepHi.splice(si, 1);
        if (cfg.dir === 'long' || !inSession(bars[i].t, cfg.session)) continue;
        const entry = bars[i].c;
        const stop = s.extreme + BUF_ATR * a;
        const below = lowPools.filter(pl => pl.price < entry).sort((x, y) => y.price - x.price)[0];
        if (!below) continue;                                           // no opposite liquidity → no trade
        const tp = below.price;
        const risk = stop - entry, reward = entry - tp;
        if (!(risk > 0) || !(reward > 0)) continue;
        if (cfg.minRR && reward / risk < cfg.minRR) continue;
        sigs.push({ i, dir: 'short', entry, stop, tp, label: 'sweep-high' });
      }
    }
    for (let si = sweepLo.length - 1; si >= 0; si--) {
      const s = sweepLo[si];
      s.extreme = Math.min(s.extreme, bars[i].l);
      if (i - s.start > REJECT_WITHIN) { sweepLo.splice(si, 1); continue; }
      if (bars[i].c > s.pool.price) {
        sweepLo.splice(si, 1);
        if (cfg.dir === 'short' || !inSession(bars[i].t, cfg.session)) continue;
        const entry = bars[i].c;
        const stop = s.extreme - BUF_ATR * a;
        const above = highPools.filter(pl => pl.price > entry).sort((x, y) => x.price - y.price)[0];
        if (!above) continue;
        const tp = above.price;
        const risk = entry - stop, reward = tp - entry;
        if (!(risk > 0) || !(reward > 0)) continue;
        if (cfg.minRR && reward / risk < cfg.minRR) continue;
        sigs.push({ i, dir: 'long', entry, stop, tp, label: 'sweep-low' });
      }
    }
  }
  return sigs;
}
