/**
 * auto_trendline.mjs — the AutoTL trendline read. ONE copy.
 *
 * Mirrors the "Auto Trendlines — Zone & Break" Pine indicator on the chart:
 * best-fit line across recent pivots, >=3 touches within 1/2 ATR, full containment,
 * body close through the 1/4-ATR zone flips it.
 *
 * Zero imports on purpose. setup_finder pulls chrome-remote-interface at module load
 * via a hardcoded Linux path, and daily_plan has to produce a plan when the chart is
 * down — which is why the geometry was copy-pasted into both in the first place.
 *
 * The two copies were "kept in sync by comment" and were NOT in sync: setup_finder fed
 * it Wilder/RMA ATR while daily_plan fed it an SMA of TR. Since tol = 0.5*ATR and
 * zoneHalf = 0.25*ATR, they could disagree on touch counts and on whether a line was
 * broken — i.e. return a different `dir` for identical bars. This module owns its ATR
 * so that can't recur, and uses Wilder because Pine's ta.atr() is Wilder: the chart is
 * the reference.
 */

/** Wilder/RMA ATR — matches Pine ta.atr(). */
function wilderATR(bars, len = 14) {
  const atr = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0 ? bars[i].h - bars[i].l
      : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    atr.push(i < len ? tr : (atr[i - 1] * (len - 1) + tr) / len);
  }
  return atr;
}

const r5 = x => Number(Number(x).toPrecision(6));

/**
 * @returns {{dir:'long'|'short'|null, detail:string, touches:number,
 *            supportAt:number|null, resistanceAt:number|null}}
 *   dir is null for contraction (both lines intact), conflicting breaks, or no
 *   validated line — a valid answer meaning "no clear trend", not an error.
 */
export function autoTrendline(bars) {
  const n = (bars?.length ?? 0) - 1;
  if (n < 30) return { dir: null, detail: 'insufficient bars', touches: 0, supportAt: null, resistanceAt: null };

  const a = wilderATR(bars);
  const pivLen = 5, maxPiv = 8, minTouch = 3, minSpan = 10;
  const tol = (a[n] || 0) * 0.5, zoneHalf = (a[n] || 0) * 0.25;

  const pivotsOf = (type) => {
    const out = [];
    for (let i = pivLen; i <= n - pivLen; i++) {
      let ok = true;
      for (let j = i - pivLen; j <= i + pivLen; j++) {
        if (j !== i && (type === 'high' ? bars[j].h >= bars[i].h : bars[j].l <= bars[i].l)) { ok = false; break; }
      }
      if (ok) out.push({ idx: i, price: type === 'high' ? bars[i].h : bars[i].l });
    }
    return out.slice(-maxPiv);
  };

  const fit = (type) => {
    const pv = pivotsOf(type);
    if (pv.length < 2) return null;
    let best = null;
    for (let x = 0; x < pv.length - 1; x++) {
      for (let y = x + 1; y < pv.length; y++) {
        const span = pv[y].idx - pv[x].idx;
        if (span < minSpan) continue;
        const slope = (pv[y].price - pv[x].price) / span;
        if (type === 'high' && slope > 0) continue;   // resistance must slope down
        if (type === 'low' && slope < 0) continue;    // support must slope up
        let touches = 0, contained = true;
        for (const p of pv) {
          const diff = p.price - (pv[x].price + slope * (p.idx - pv[x].idx));
          if (type === 'high' ? diff > tol : diff < -tol) { contained = false; break; }
          if (Math.abs(diff) <= tol) touches++;
        }
        if (!contained || touches < minTouch) continue;
        if (!best || touches > best.touches || (touches === best.touches && span > best.span)) {
          best = { x1: pv[x].idx, y1: pv[x].price, slope, touches, span };
        }
      }
    }
    if (!best) return null;
    best.at = i => best.y1 + best.slope * (i - best.x1);
    return best;
  };

  const sup = fit('low'), res = fit('high');
  const last = bars[n];
  const supBroken = sup != null && last.c < sup.at(n) - zoneHalf;   // body close below support zone
  const resBroken = res != null && last.c > res.at(n) + zoneHalf;   // body close above resistance zone
  const out = { supportAt: sup ? r5(sup.at(n)) : null, resistanceAt: res ? r5(res.at(n)) : null };

  if (sup && res) {
    if (supBroken && !resBroken) return { ...out, dir: 'short', detail: `rising support ×${sup.touches} BROKEN`, touches: sup.touches };
    if (resBroken && !supBroken) return { ...out, dir: 'long',  detail: `falling resistance ×${res.touches} BROKEN`, touches: res.touches };
    return { ...out, dir: null, detail: `contraction (support ×${sup.touches} + resistance ×${res.touches} both intact)`, touches: Math.max(sup.touches, res.touches) };
  }
  if (sup) return supBroken
    ? { ...out, dir: 'short', detail: `rising support ×${sup.touches} BROKEN`,               touches: sup.touches }
    : { ...out, dir: 'long',  detail: `rising support ×${sup.touches} intact (higher lows)`, touches: sup.touches };
  if (res) return resBroken
    ? { ...out, dir: 'long',  detail: `falling resistance ×${res.touches} BROKEN`,               touches: res.touches }
    : { ...out, dir: 'short', detail: `falling resistance ×${res.touches} intact (lower highs)`, touches: res.touches };
  return { ...out, dir: null, detail: 'no validated trendline (3+ touches required)', touches: 0 };
}

// ── self-check: node scripts/trading/auto_trendline.mjs ──────────────────────
if (process.argv[1] && process.argv[1].endsWith('auto_trendline.mjs')) {
  const assert = (await import('assert')).default;
  // 60 bars climbing a line; pivot lows sit exactly on it every 15 bars.
  const line = i => 100 + 0.1 * i;
  const mk = (closeAt) => Array.from({ length: 60 }, (_, i) => {
    const isPivot = [10, 25, 40, 55].includes(i);
    const l = isPivot ? line(i) : line(i) + 2;
    return { t: i, o: l + 1, h: l + 3, l, c: i === 59 ? closeAt : l + 1.5 };
  });

  const intact = autoTrendline(mk(line(59) + 1.5));
  assert.equal(intact.dir, 'long', `intact rising support should read long, got ${intact.dir}`);
  assert.ok(intact.touches >= 3, `expected 3+ touches, got ${intact.touches}`);

  const broken = autoTrendline(mk(line(59) - 10));      // body close far below the zone
  assert.equal(broken.dir, 'short', `broken rising support should flip short, got ${broken.dir}`);

  assert.equal(autoTrendline([]).dir, null);
  assert.equal(autoTrendline(Array.from({ length: 10 }, (_, i) => ({ h: 1, l: 1, c: 1, t: i }))).dir, null);
  console.log('auto_trendline self-check OK:', intact.detail, '|', broken.detail);
}
