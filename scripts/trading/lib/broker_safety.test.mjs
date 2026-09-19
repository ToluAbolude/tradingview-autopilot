import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { accountEquity, claimEntryCooldown, validateOrderInputs, validateMarketBars } from './broker_safety.mjs';

const trader = { ctidTraderAccountId: 42, balance: 1000000, moneyDigits: 2, depositAssetId: 1 };
const pnl = { ctidTraderAccountId: 42, moneyDigits: 3, positionUnrealizedPnL: [
  { positionId: 1, netUnrealizedPnL: -2000000 }, { positionId: 2, netUnrealizedPnL: 125500 },
] };

test('equity includes every net unrealized P&L with independent money precision', () => {
  assert.deepEqual(accountEquity(trader, pnl, 42), {
    balance: 10000, unrealizedPnl: -1874.5, equity: 8125.5, currency: 1,
  });
  assert.equal(accountEquity({ ...trader, balance: 100, moneyDigits: 0 }, { ...pnl, positionUnrealizedPnL: [] }, 42).equity, 100);
  const { moneyDigits, ...legacyTrader } = trader;
  assert.equal(accountEquity(legacyTrader, { ...pnl, positionUnrealizedPnL: [] }, 42).equity, 10000);
});

test('equity rejects incomplete, duplicated, mismatched or invalid broker data', () => {
  for (const bad of [null, { ...pnl, ctidTraderAccountId: 43 }, { ...pnl, moneyDigits: undefined },
    { ...pnl, positionUnrealizedPnL: undefined },
    { ...pnl, positionUnrealizedPnL: [pnl.positionUnrealizedPnL[0], pnl.positionUnrealizedPnL[0]] },
    { ...pnl, positionUnrealizedPnL: [{ positionId: 1 }] }]) {
    assert.throws(() => accountEquity(trader, bad, 42));
  }
  assert.throws(() => accountEquity({ ...trader, balance: NaN }, pnl, 42));
});

test('order inputs reject missing prices, NaN, invalid sides and unprotected targets', () => {
  const order = { symbol: 'EURUSD', direction: 'long', units: 0.1, entry: 1.1, slPrice: 1.09, tpPrices: [1.12] };
  assert.equal(validateOrderInputs(order), 'long');
  for (const patch of [{ entry: undefined }, { units: NaN }, { slPrice: Infinity }, { units: 0 },
    { direction: 'oops' }, { slPrice: 1.11 }, { tpPrices: [] }, { tpPrices: [1.08] }, { tpPrices: [NaN] }]) {
    assert.throws(() => validateOrderInputs({ ...order, ...patch }), /ORDER_SAFETY_REJECT/);
  }
});

test('missing, stale, future or malformed quotes reject new entries', () => {
  const bar = { t: 100000, o: 10, h: 11, l: 9, c: 10.5 };
  const opts = { now: 120000, maxAgeMs: 60000 };
  assert.equal(validateMarketBars('TEST', [bar], opts), bar);
  for (const bars of [[], [{ ...bar, t: 1 }], [{ ...bar, t: 999999 }],
    [{ ...bar, c: NaN }], [{ ...bar, h: 9 }], [bar, bar]]) {
    assert.throws(() => validateMarketBars('TEST', bars, opts), /ORDER_SAFETY_REJECT/);
  }
});

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'entry-cooldown-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('cooldown scopes by account and strategy, expires, and rejects corrupt persistence', t => {
  const dir = temp(t);
  const claim = { dir, accountId: 42, symbol: 1, now: 100000 };
  claimEntryCooldown(claim);
  assert.throws(() => claimEntryCooldown(claim), /cooldown/);
  claimEntryCooldown({ ...claim, accountId: 43 });
  claimEntryCooldown({ ...claim, label: 'second-strategy' });
  claimEntryCooldown({ ...claim, now: 160000 });
  for (const file of readdirSync(dir)) writeFileSync(join(dir, file), '{broken');
  assert.throws(() => claimEntryCooldown({ ...claim, now: 300000 }), /unavailable/);
  const file = join(dir, 'not-a-directory');
  writeFileSync(file, 'x');
  assert.throws(() => claimEntryCooldown({ ...claim, dir: file }), /unavailable/);
});

test('simultaneous processes admit exactly one market entry', async t => {
  const dir = temp(t);
  const source = `import { claimEntryCooldown } from ${JSON.stringify(new URL('./broker_safety.mjs', import.meta.url).href)};
    process.on('message', () => {
      try { claimEntryCooldown({dir: process.argv[1], accountId: 42, symbol: 1}); process.send({ok:true}); }
      catch (e) { process.send({ok:false, error:e.message}); }
      process.disconnect();
    }); process.send({ready:true});`;
  const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['--input-type=module', '-e', source, dir], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  }));
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill(); }));
  const results = children.map(child => new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('message', msg => { if (msg.ready) child.send('go'); else resolve(msg); });
    child.on('exit', code => { if (code) reject(new Error(`child exited ${code}`)); });
  }));
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter(r => r.ok).length, 1);
  assert.ok(outcomes.filter(r => !r.ok).every(r => r.error.includes('ORDER_SAFETY_REJECT')));
  await Promise.all(children.map(child => child.exitCode !== null ? null : new Promise(resolve => child.once('exit', resolve))));
});
