import test from 'node:test';
import assert from 'node:assert/strict';
import { placeProtectedMarketOrder } from './tradovate_entry.mjs';

function fixture(fault) {
  const calls = [];
  let recovering = false;
  let bracketed = false;
  let orders = [];
  let position = { accountId: 1, contractId: 2, netPos: 1, netPrice: 100 };
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path === '/order/placeorder') {
      if (fault === 'submit-timeout') throw new Error('submit response lost');
      if (fault === 'rejected') return { failureReason: 'AccountClosed' };
      return { orderId: 10 };
    }
    if (path === '/position/list') {
      if (!recovering && fault === 'poll-error') throw new Error('position read failed');
      if (!recovering && fault === 'no-fill') return [];
      return position ? [position] : [];
    }
    if (path === '/order/placeoco') {
      bracketed = true;
      if (fault === 'oco-error') throw new Error('OCO request failed');
      if (fault === 'oco-rejected') return { failureReason: 'TooLate' };
      orders = [20, 21].map(id => ({ id, accountId: 1, contractId: 2, action: 'Sell', ordStatus: 'Working' }));
      if (fault === 'wrong-brackets') orders = orders.map(o => ({ ...o, id: o.id + 100 }));
      return { orderId: 20, ocoId: 21 };
    }
    if (path === '/order/list') {
      if (fault === 'all-order-reads-fail') throw new Error('order reads unavailable');
      if (!recovering && bracketed && fault === 'verify-error') {
        recovering = true;
        throw new Error('verification read failed');
      }
      recovering = recovering || !bracketed;
      return [...orders, { id: 99, accountId: 3, contractId: 2, action: 'Sell', ordStatus: 'Working' }];
    }
    if (path === '/order/cancelorder') {
      recovering = true;
      orders = orders.filter(o => o.id !== body.orderId);
      if (fault === 'cancel-error') throw new Error('cancel failed');
      return {};
    }
    if (path === '/order/liquidateposition') {
      recovering = true;
      if (fault === 'liquidate-rejected') return { failureReason: 'NotAuthorized' };
      position = null;
      return {};
    }
    throw new Error(`Unexpected endpoint ${path}`);
  };
  const execute = () => placeProtectedMarketOrder({ api, account: { id: 1, name: 'test' }, contract: { id: 2, name: 'TEST' },
    direction: 'long', units: 1, slDist: 2, tpDist: 4, tick: 1, riskUsd: 20, sleep: async () => {} });
  return { calls, execute };
}

test('verified OCO IDs return a protected fill without emergency cleanup', async () => {
  const { execute, calls } = fixture();
  const result = await execute();
  assert.deepEqual(result, { ok: true, orderId: 10, fillPrice: 100, sl: 98, tp: 104, riskUsd: 20 });
  assert.equal(calls.some(c => c.path === '/order/liquidateposition'), false);
});

for (const fault of ['submit-timeout', 'poll-error', 'no-fill', 'oco-error', 'oco-rejected', 'verify-error', 'wrong-brackets', 'all-order-reads-fail']) {
  test(`${fault} invokes recovery and never returns a successful entry`, async () => {
    const { execute, calls } = fixture(fault);
    await assert.rejects(execute(), /Tradovate entry failed/);
    const close = calls.find(c => c.path === '/order/liquidateposition');
    assert.equal(close.body.accountId, 1);
    assert.equal(close.body.contractId, 2);
    assert.equal(calls.some(c => c.path === '/order/cancelorder' && c.body.orderId === 99), false);
    assert.equal(calls.filter(c => c.path === '/order/placeorder').length, 1);
    if (fault === 'all-order-reads-fail') {
      assert.deepEqual(calls.filter(c => c.path === '/order/cancelorder').map(c => c.body.orderId).sort(), [10, 20, 21]);
    }
  });
}

test('a definitive entry rejection does not liquidate anything', async () => {
  const { execute, calls } = fixture('rejected');
  await assert.rejects(execute(), /AccountClosed/);
  assert.equal(calls.length, 1);
});

test('failed recovery is explicitly reported, and a cancel failure cannot prevent liquidation', async () => {
  for (const failedOperation of ['cancel-error', 'liquidate-rejected']) {
    // A throwing wait enters recovery immediately after the market acknowledgement.
    const calls = [];
    const api = async (path, body) => {
      calls.push({ path, body });
      if (path === '/order/placeorder') return { orderId: 10 };
      if (path === '/order/list') return [];
      if (path === '/position/list') return [];
      if (path === '/order/cancelorder' && failedOperation === 'cancel-error') throw new Error('cancel failed');
      if (path === '/order/liquidateposition' && failedOperation === 'liquidate-rejected') return { failureReason: 'NotAuthorized' };
      return {};
    };
    await assert.rejects(placeProtectedMarketOrder({ api, account: { id: 1, name: 'test' }, contract: { id: 2, name: 'TEST' },
      direction: 'long', units: 1, slDist: 2, tpDist: 4, tick: 1, riskUsd: 20,
      sleep: async () => { throw new Error('poll interrupted'); } }), /Recovery unverified/);
    assert.ok(calls.some(c => c.path === '/order/liquidateposition'));
  }
});
