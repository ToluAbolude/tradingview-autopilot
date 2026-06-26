/**
 * indicators.mjs — pure-math indicator + structure library for the lab.
 *
 * Lifted from the live system's setup_finder.mjs (calcATR/EMA/RSI/SmartTrail/BB,
 * detectFVGZones, buildSRZones, buildDailyContext) so ported strategies score
 * identically to production, plus helpers the .pine ports need (standalone
 * pivots, Heikin-Ashi, Wilder ADX/DMI). Every function is bars-in / numbers-out;
 * no I/O, no broker, no CDP. `bars` are ascending {t,o,h,l,c,v}.
 */

// ── Moving averages / oscillators ──────────────────────────────────────────────
export function sma(values, len) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

/** EMA over an arbitrary value series (seeded with the first value). */
export function emaSeries(values, len) {
  const k = 2 / (len + 1);
  const out = [];
  for (let i = 0; i < values.length; i++) {
    out.push(i === 0 ? values[i] : values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

/** EMA of closes. */
export function calcEMA(bars, len) {
  return emaSeries(bars.map(b => b.c), len);
}

export function calcATR(bars, len = 14) {
  const atr = [];
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0 ? bars[i].h - bars[i].l
      : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    atr.push(i < len ? tr : (atr[i - 1] * (len - 1) + tr) / len);
  }
  return atr;
}

export function calcRSI(bars, len = 14) {
  let ag = 0, al = 0;
  const rsi = new Array(bars.length).fill(50);
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= len) { ag += g / len; al += l / len; }
    else { ag = (ag * (len - 1) + g) / len; al = (al * (len - 1) + l) / len; }
    if (i >= len) rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return rsi;
}

/** SmartTrail (Chandelier-style ATR trail). Returns { trail[], dir[] } (dir ±1). */
export function calcSmartTrail(bars, len = 22, mult = 3.0) {
  const atr = calcATR(bars, len);
  const trail = [], dir = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < len) { trail.push(null); dir.push(1); continue; }
    const highs = bars.slice(Math.max(0, i - len + 1), i + 1).map(b => b.h);
    const lows = bars.slice(Math.max(0, i - len + 1), i + 1).map(b => b.l);
    const upper = Math.max(...highs) - mult * atr[i];
    const lower = Math.min(...lows) + mult * atr[i];
    if (!trail[i - 1]) { trail.push(upper); dir.push(1); continue; }
    if (bars[i].c > trail[i - 1]) { trail.push(Math.max(upper, trail[i - 1])); dir.push(1); }
    else { trail.push(Math.min(lower, trail[i - 1])); dir.push(-1); }
  }
  return { trail, dir };
}

export function calcBB(bars, len = 20, mult = 2.0) {
  return bars.map((_, i) => {
    if (i < len) return null;
    const slice = bars.slice(i - len, i);
    const sma_ = slice.reduce((s, b) => s + b.c, 0) / len;
    const std = Math.sqrt(slice.reduce((s, b) => s + (b.c - sma_) ** 2, 0) / len);
    return { mid: sma_, upper: sma_ + mult * std, lower: sma_ - mult * std, bw: std * 2 * mult / sma_ };
  });
}

/** Wilder ADX / +DI / −DI. Returns { adx[], plusDI[], minusDI[] } aligned to bars. */
export function calcADX(bars, len = 14) {
  const n = bars.length;
  const plusDI = new Array(n).fill(null), minusDI = new Array(n).fill(null), adx = new Array(n).fill(null);
  if (n < len + 1) return { adx, plusDI, minusDI };
  let trS = 0, pdmS = 0, mdmS = 0;
  // Seed with first `len` TR/DM sums.
  for (let i = 1; i <= len; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const dn = bars[i - 1].l - bars[i].l;
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    trS += tr; pdmS += pdm; mdmS += mdm;
  }
  const dxArr = [];
  for (let i = len; i < n; i++) {
    if (i > len) {
      const up = bars[i].h - bars[i - 1].h;
      const dn = bars[i - 1].l - bars[i].l;
      const pdm = up > dn && up > 0 ? up : 0;
      const mdm = dn > up && dn > 0 ? dn : 0;
      const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
      trS = trS - trS / len + tr;
      pdmS = pdmS - pdmS / len + pdm;
      mdmS = mdmS - mdmS / len + mdm;
    }
    const pDI = trS === 0 ? 0 : 100 * pdmS / trS;
    const mDI = trS === 0 ? 0 : 100 * mdmS / trS;
    plusDI[i] = pDI; minusDI[i] = mDI;
    const dx = (pDI + mDI) === 0 ? 0 : 100 * Math.abs(pDI - mDI) / (pDI + mDI);
    dxArr.push(dx);
    if (dxArr.length === len) adx[i] = dxArr.reduce((s, v) => s + v, 0) / len;
    else if (dxArr.length > len) adx[i] = (adx[i - 1] * (len - 1) + dx) / len;
  }
  return { adx, plusDI, minusDI };
}

// ── Structure ──────────────────────────────────────────────────────────────────
/**
 * Confirmed swing pivots (matches ta.pivothigh/ta.pivotlow with left=right=len).
 * A pivot at i is only known at bar i+len. Returns { highs:[{idx,price}], lows:[...] }.
 */
export function findPivots(bars, len = 5) {
  const highs = [], lows = [];
  const n = bars.length - 1;
  for (let i = len; i <= n - len; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - len; j <= i + len; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isHigh = false;
      if (bars[j].l <= bars[i].l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ idx: i, price: bars[i].h });
    if (isLow) lows.push({ idx: i, price: bars[i].l });
  }
  return { highs, lows };
}

/** Heikin-Ashi candles derived from real bars (keeps t and v). */
export function heikinAshi(bars) {
  const ha = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const haClose = (b.o + b.h + b.l + b.c) / 4;
    const haOpen = i === 0 ? (b.o + b.c) / 2 : (ha[i - 1].o + ha[i - 1].c) / 2;
    const haHigh = Math.max(b.h, haOpen, haClose);
    const haLow = Math.min(b.l, haOpen, haClose);
    ha.push({ t: b.t, o: haOpen, h: haHigh, l: haLow, c: haClose, v: b.v });
  }
  return ha;
}

// ── FVG zones (3-candle imbalance) ──────────────────────────────────────────────
export function detectFVGZones(bars, atr, lookback = 30) {
  const zones = [];
  const n = bars.length - 1;
  const start = Math.max(2, n - lookback);
  for (let i = start; i <= n; i++) {
    const curATR = atr[i] || atr[n] || 1;
    if (bars[i].l > bars[i - 2].h) {
      const bottom = bars[i - 2].h, top = bars[i].l;
      if (top - bottom < curATR * 0.1) continue;
      const fresh = Math.abs(bars[i - 1].c - bars[i - 1].o) > curATR * 1.2;
      let mitigated = false;
      for (let j = i + 1; j <= n; j++) if (bars[j].l <= top && bars[j].h >= bottom) { mitigated = true; break; }
      zones.push({ type: 'bullish', top, bottom, barIdx: i, fresh, mitigated });
    }
    if (bars[i].h < bars[i - 2].l) {
      const bottom = bars[i].h, top = bars[i - 2].l;
      if (top - bottom < curATR * 0.1) continue;
      const fresh = Math.abs(bars[i - 1].c - bars[i - 1].o) > curATR * 1.2;
      let mitigated = false;
      for (let j = i + 1; j <= n; j++) if (bars[j].l <= top && bars[j].h >= bottom) { mitigated = true; break; }
      zones.push({ type: 'bearish', top, bottom, barIdx: i, fresh, mitigated });
    }
  }
  return zones;
}

// ── S/R wick-to-body supply/demand zones (matches the live Pine indicator) ──────
export function buildSRZones(bars, atr, { pivotLen = 5, maxSR = 5 } = {}) {
  const n = bars.length - 1;
  const currentATR = atr[n] || 1;
  const pivotHighs = [], pivotLows = [];
  for (let i = pivotLen; i <= n - pivotLen; i++) {
    let hi = true;
    for (let j = i - pivotLen; j <= i + pivotLen; j++) if (j !== i && bars[j].h >= bars[i].h) { hi = false; break; }
    if (hi) pivotHighs.push({ wickTip: bars[i].h, idx: i });
    let lo = true;
    for (let j = i - pivotLen; j <= i + pivotLen; j++) if (j !== i && bars[j].l <= bars[i].l) { lo = false; break; }
    if (lo) pivotLows.push({ wickTip: bars[i].l, idx: i });
  }
  function buildZones(pivots, type, cap) {
    const zones = [];
    for (const { wickTip, idx } of pivots) {
      if (type === 'resistance') {
        const hit = zones.find(z => !z.broken && wickTip >= z.bodyLevel && wickTip <= z.wickTip);
        if (hit) { hit.retests++; continue; }
        let bodyLevel = null, minDist = Infinity;
        for (let k = idx; k <= n; k++) { const bt = Math.max(bars[k].o, bars[k].c); const d = wickTip - bt; if (d >= 0 && d < minDist) { minDist = d; bodyLevel = bt; } }
        if (bodyLevel === null) bodyLevel = Math.max(bars[idx].o, bars[idx].c);
        if (zones.filter(z => !z.broken).length < cap) zones.push({ wickTip, bodyLevel, type, bar: idx, retests: 0, broken: false, flipped: false });
      } else {
        const hit = zones.find(z => !z.broken && wickTip >= z.wickTip && wickTip <= z.bodyLevel);
        if (hit) { hit.retests++; continue; }
        let bodyLevel = null, minDist = Infinity;
        for (let k = idx; k <= n; k++) { const bb = Math.min(bars[k].o, bars[k].c); const d = bb - wickTip; if (d >= 0 && d < minDist) { minDist = d; bodyLevel = bb; } }
        if (bodyLevel === null) bodyLevel = Math.min(bars[idx].o, bars[idx].c);
        if (zones.filter(z => !z.broken).length < cap) zones.push({ wickTip, bodyLevel, type, bar: idx, retests: 0, broken: false, flipped: false });
      }
    }
    return zones;
  }
  const capR = Math.ceil(maxSR / 2), capS = maxSR - capR;
  const resZones = buildZones(pivotHighs, 'resistance', capR);
  const suppZones = buildZones(pivotLows, 'support', capS);
  for (const z of resZones) for (let i = z.bar + 1; i <= n; i++) if (Math.min(bars[i].o, bars[i].c) > z.wickTip) { z.broken = true; break; }
  for (const z of suppZones) for (let i = z.bar + 1; i <= n; i++) if (Math.max(bars[i].o, bars[i].c) < z.wickTip) { z.broken = true; break; }
  for (const z of resZones) { if (!z.broken) continue; for (let i = z.bar + 1; i <= n; i++) if (bars[i].l <= z.wickTip && bars[i].c > z.bodyLevel) { z.flipped = true; break; } }
  for (const z of suppZones) { if (!z.broken) continue; for (let i = z.bar + 1; i <= n; i++) if (bars[i].h >= z.wickTip && bars[i].c < z.bodyLevel) { z.flipped = true; break; } }
  const all = [...resZones, ...suppZones];
  return { active: all.filter(z => !z.broken), broken: all.filter(z => z.broken && !z.flipped), flipped: all.filter(z => z.flipped), currentATR };
}

// ── Daily context (PDH/PDL/PDC, ADR, bias) ──────────────────────────────────────
export function buildDailyContext(bars) {
  const dayOf = t => Math.floor(t / 86400000);
  const byDay = new Map();
  for (const b of bars) { const d = dayOf(b.t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(b); }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  if (days.length < 2) return null;
  const todayBars = byDay.get(days.at(-1)), ydayBars = byDay.get(days.at(-2));
  const PDH = Math.max(...ydayBars.map(b => b.h)), PDL = Math.min(...ydayBars.map(b => b.l)), PDC = ydayBars.at(-1).c;
  const todayH = Math.max(...todayBars.map(b => b.h)), todayL = Math.min(...todayBars.map(b => b.l));
  const completeDays = days.slice(-6, -1);
  const adr = completeDays.length
    ? completeDays.reduce((s, d) => { const db = byDay.get(d); return s + Math.max(...db.map(b => b.h)) - Math.min(...db.map(b => b.l)); }, 0) / completeDays.length
    : PDH - PDL;
  const lastClose = bars.at(-1).c;
  return {
    PDH, PDL, PDC, todayH, todayL, adr,
    rangeConsumed: adr > 0 ? (todayH - todayL) / adr : 0,
    pricePos: PDH > PDL ? (lastClose - PDL) / (PDH - PDL) : 0.5,
    bias: lastClose > PDC ? 'bullish' : lastClose < PDC ? 'bearish' : 'neutral',
  };
}

// ── Small shared helpers used across ports ──────────────────────────────────────
export const utcHour = tsMs => new Date(tsMs).getUTCHours();
export const utcMinutes = tsMs => new Date(tsMs).getUTCHours() * 60 + new Date(tsMs).getUTCMinutes();
export const dayKeyUTC = tsMs => new Date(tsMs).toISOString().slice(0, 10);
export const bodyRatio = b => { const r = b.h - b.l; return r > 0 ? Math.abs(b.c - b.o) / r : 0; };
export const isBull = b => b.c > b.o;
export const isBear = b => b.c < b.o;
