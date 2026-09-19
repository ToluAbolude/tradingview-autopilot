import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function rejectOrder(symbol, reason) {
  throw new Error(`ORDER_SAFETY_REJECT ${symbol}: ${reason}`);
}

export function orderDirection(direction) {
  if (direction === 'long' || direction === 'buy') return 'long';
  if (direction === 'short' || direction === 'sell') return 'short';
  throw new Error(`Invalid order direction: ${direction}`);
}

export function validateOrderInputs({ symbol, direction, units, entry, slPrice, tpPrices, label = '' }) {
  if (typeof symbol !== 'string' || !/^[A-Z0-9][A-Z0-9._-]*$/.test(symbol)) rejectOrder(symbol, 'invalid symbol');
  let dir;
  try { dir = orderDirection(direction); } catch (e) { rejectOrder(symbol, e.message); }
  for (const [name, value] of Object.entries({ units, entry, slPrice })) {
    if (!Number.isFinite(value) || value <= 0) rejectOrder(symbol, `${name} must be finite and positive`);
  }
  if (typeof label !== 'string' || label.length > 100) rejectOrder(symbol, 'label must be a string of at most 100 characters');
  if (dir === 'long' ? slPrice >= entry : slPrice <= entry) rejectOrder(symbol, 'SL on wrong side of entry');
  if (tpPrices !== undefined) {
    if (!Array.isArray(tpPrices) || !tpPrices.length) rejectOrder(symbol, 'at least one TP is required');
    for (const tp of tpPrices) {
      if (!Number.isFinite(tp) || tp <= 0 || (dir === 'long' ? tp <= entry : tp >= entry)) {
        rejectOrder(symbol, 'TP must be finite, positive and on the profitable side of entry');
      }
    }
  }
  return dir;
}

export function validateMarketBars(symbol, bars, { now = Date.now(), maxAgeMs, minBars = 1 } = {}) {
  if (!Array.isArray(bars) || bars.length < minBars) rejectOrder(symbol, `insufficient broker bars (need ${minBars})`);
  let previous = -Infinity;
  for (const bar of bars) {
    if (!bar || !Number.isFinite(bar.t) || bar.t <= previous ||
        !['o', 'h', 'l', 'c'].every(k => Number.isFinite(bar[k]) && bar[k] > 0) ||
        bar.l > Math.min(bar.o, bar.c) || bar.h < Math.max(bar.o, bar.c) || bar.l > bar.h) {
      rejectOrder(symbol, 'malformed broker bars');
    }
    previous = bar.t;
  }
  const age = now - bars[bars.length - 1].t;
  if (age < -60_000 || age > maxAgeMs) rejectOrder(symbol, 'broker price data is stale or dated in the future');
  return bars[bars.length - 1];
}

function money(value, digits, name) {
  if (value == null || !Number.isInteger(digits) || digits < 0 || digits > 15) throw new Error(`Invalid ${name} money data`);
  const raw = Number(value);
  if (!Number.isSafeInteger(raw)) throw new Error(`Invalid ${name} amount`);
  return raw / (10 ** digits);
}

// P&L is already converted to the deposit currency by cTrader. Its response and
// the trader balance have independent precision; net P&L excludes a potential
// closing commission (OpenApiModelMessages.proto, ProtoOAPositionUnrealizedPnL).
export function accountEquity(trader, pnl, accountId) {
  if (!trader || !pnl || String(trader.ctidTraderAccountId) !== String(accountId) ||
      String(pnl.ctidTraderAccountId) !== String(accountId)) throw new Error('Equity response account mismatch');
  const digits = Object.hasOwn(trader, 'moneyDigits') ? trader.moneyDigits : 2;
  const balance = money(trader.balance, digits, 'balance');
  if (!Array.isArray(pnl.positionUnrealizedPnL)) throw new Error('Missing unrealized P&L positions');
  // Validate the required precision even for an account with no open positions.
  money(0, pnl.moneyDigits, 'unrealized P&L');
  let unrealizedPnl = 0;
  const ids = new Set();
  for (const position of pnl.positionUnrealizedPnL) {
    const id = Number(position?.positionId);
    if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) throw new Error('Invalid/duplicate unrealized P&L position');
    ids.add(id);
    unrealizedPnl += money(position.netUnrealizedPnL, pnl.moneyDigits, 'unrealized P&L');
  }
  return { balance, equity: balance + unrealizedPnl, unrealizedPnl, currency: trader.depositAssetId };
}

// mkdir is the exclusive cross-process operation. Never steal an existing
// mutex: a crashed holder must be inspected and its .lock directory removed by
// an operator. That deliberately favors stopping entries over duplicate risk.
export function claimEntryCooldown({ dir, accountId, symbol, label = '', now = Date.now(), cooldownMs = 60_000 }) {
  if (!dir || !accountId || !symbol || !Number.isFinite(now)) rejectOrder(symbol, 'invalid cooldown identity');
  const key = createHash('sha256').update(JSON.stringify([String(accountId), String(symbol), label])).digest('hex');
  const file = path.join(dir, `.entry_cooldown_${key}.json`);
  const mutex = `${file}.lock`;
  let acquired = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(mutex);
    acquired = true;
    let previous;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (previous !== undefined) {
      if (!Number.isFinite(previous.at)) throw new Error('corrupt cooldown timestamp');
      if (now - previous.at < cooldownMs) rejectOrder(symbol, 'entry already attempted within cooldown');
    }
    const fd = fs.openSync(file, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ at: now })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch (e) {
    if (/ORDER_SAFETY_REJECT/.test(e.message)) throw e;
    rejectOrder(symbol, `entry cooldown unavailable: ${e.message}`);
  } finally {
    if (acquired) {
      try { fs.rmdirSync(mutex); }
      catch (e) { rejectOrder(symbol, `entry cooldown release failed: ${e.message}`); }
    }
  }
}
