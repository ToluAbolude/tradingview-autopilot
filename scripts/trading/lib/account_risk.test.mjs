import test from 'node:test';
import assert from 'node:assert/strict';
import { requireEquity, dailyLossPercent, readEntryEquity } from './account_risk.mjs';

test('entry sizing uses net equity even when balance is higher', async () => {
  const snapshot = await readEntryEquity(async () => ({ balance: 10000, equity: 8000 }));
  assert.equal(requireEquity(snapshot), 8000);
  assert.equal(dailyLossPercent(-400, snapshot.equity, 5), -5);
});

test('unknown, invalid or insolvent equity cannot fall back to a positive balance', async () => {
  for (const equity of [undefined, null, NaN, Infinity, -Infinity, 0, -100, '10000']) {
    await assert.rejects(readEntryEquity(async () => ({ balance: 10000, equity })), /ACCOUNT_RISK_REJECT/);
  }
  await assert.rejects(readEntryEquity(async () => { throw new Error('broker unavailable'); }), /broker unavailable/);
});

test('daily loss checks reject missing P&L or invalid limits instead of passing NaN comparisons', () => {
  for (const pnl of [undefined, null, NaN, Infinity, '0']) {
    assert.throws(() => dailyLossPercent(pnl, 10000, 5), /ACCOUNT_RISK_REJECT/);
  }
  for (const limit of [undefined, null, NaN, Infinity, 0, -1]) {
    assert.throws(() => dailyLossPercent(0, 10000, limit), /ACCOUNT_RISK_REJECT/);
  }
  assert.equal(dailyLossPercent(0, 10000, 5), 0);
});
