const active = order => !['Filled', 'Cancelled', 'Canceled', 'Rejected', 'Expired', 'Completed'].includes(order.ordStatus);
const checked = (result, operation) => {
  if (!result || result.failureReason || result.failureText) {
    throw new Error(`${operation} failed: ${result?.failureReason || ''} ${result?.failureText || 'invalid response'}`);
  }
  return result;
};

/** The accepted/uncertain submission and every subsequent read share one recovery boundary. */
export async function placeProtectedMarketOrder({ api, account, contract, direction, units, slDist, tpDist, tick, riskUsd,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const action = direction === 'long' ? 'Buy' : 'Sell';
  const opposite = direction === 'long' ? 'Sell' : 'Buy';
  const target = item => item.accountId === account.id && item.contractId === contract.id;
  const round = price => Math.round(price / tick) * tick;
  let entry;
  let rejected = false;
  const knownOrderIds = new Set();
  try {
    entry = await api('/order/placeorder', {
      accountSpec: account.name, accountId: account.id, action, symbol: contract.name,
      orderQty: units, orderType: 'Market', isAutomated: true,
    });
    rejected = !!(entry?.failureReason || entry?.failureText);
    checked(entry, 'market entry');
    if (!Number.isSafeInteger(entry.orderId) || entry.orderId <= 0) throw new Error('Market entry acknowledgement has no order ID');
    knownOrderIds.add(entry.orderId);

    let fillPrice;
    for (let i = 0; i < 20 && fillPrice == null; i++) {
      await sleep(500);
      const positions = await api('/position/list');
      if (!Array.isArray(positions)) throw new Error('Invalid position response');
      const position = positions.find(p => target(p) && p.netPos !== 0);
      if (position) {
        if (!Number.isFinite(position.netPrice) || position.netPrice <= 0) throw new Error('Invalid fill price');
        fillPrice = position.netPrice;
      }
    }
    if (fillPrice == null) throw new Error('Market fill not confirmed within 10s');

    const sl = round(direction === 'long' ? fillPrice - slDist : fillPrice + slDist);
    const tp = round(direction === 'long' ? fillPrice + tpDist : fillPrice - tpDist);
    const oco = checked(await api('/order/placeoco', {
      accountSpec: account.name, accountId: account.id, action: opposite, symbol: contract.name,
      orderQty: units, orderType: 'Limit', price: tp, isAutomated: true,
      other: { action: opposite, orderType: 'Stop', stopPrice: sl },
    }), 'bracket placement');
    const bracketIds = [oco.orderId, oco.ocoId];
    for (const id of bracketIds) if (Number.isSafeInteger(id) && id > 0) knownOrderIds.add(id);
    if (new Set(bracketIds).size !== 2 || !bracketIds.every(id => Number.isSafeInteger(id) && id > 0)) {
      throw new Error('Bracket acknowledgement must identify both OCO orders');
    }

    for (let i = 0; i < 4; i++) {
      await sleep(2500);
      const orders = await api('/order/list');
      if (!Array.isArray(orders)) throw new Error('Invalid bracket verification response');
      const working = orders.filter(o => target(o) && o.action === opposite && o.ordStatus === 'Working');
      // Order entities do not carry orderType (that lives on OrderVersion).
      // Verify the exact IDs returned by placeoco, not two unrelated exit orders.
      if (bracketIds.every(id => working.some(o => o.id === id))) {
        return { ok: true, orderId: entry.orderId, fillPrice, sl, tp, riskUsd };
      }
    }
    throw new Error('Bracket legs were not verified working');
  } catch (error) {
    // A definitive rejection has no position to clean up. Timeouts and missing
    // acknowledgements are uncertain and must enter recovery, never a new entry retry.
    if (rejected) throw error;
    const failures = [];
    const attempt = async (name, fn) => {
      try { return await fn(); } catch (e) { failures.push(`${name}: ${e.message}`); }
    };
    const ids = new Set(knownOrderIds);
    await attempt('list orders', async () => {
      const orders = await api('/order/list');
      if (!Array.isArray(orders)) throw new Error('invalid response');
      for (const order of orders.filter(o => target(o) && active(o))) ids.add(order.id);
    });
    for (const orderId of ids) await attempt(`cancel ${orderId}`, async () => {
      checked(await api('/order/cancelorder', { orderId, isAutomated: true }), 'cancel');
    });
    // Always attempt liquidation, even if cancellation or a read failed.
    await attempt('liquidate', async () => {
      checked(await api('/order/liquidateposition', {
        accountId: account.id, contractId: contract.id, admin: false, isAutomated: true,
      }), 'liquidation');
    });
    await attempt('verify recovery', async () => {
      const positions = await api('/position/list');
      const orders = await api('/order/list');
      if (!Array.isArray(positions) || !Array.isArray(orders)
          || positions.some(p => target(p) && p.netPos !== 0)
          || orders.some(o => target(o) && active(o))) throw new Error('flat position and cancelled orders could not be confirmed');
    });
    throw new Error(`Tradovate entry failed: ${error.message}. Recovery ${failures.length
      ? `unverified (${failures.join('; ')}); reconcile this contract before retrying`
      : 'completed: contract flat and no working orders observed'}`, { cause: error });
  }
}
