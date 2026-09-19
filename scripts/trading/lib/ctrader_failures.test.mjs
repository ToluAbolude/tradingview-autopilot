import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

test('cTrader entry gate uses real protobuf responses and never submits on failed checks', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ctrader-faults-'));
  const env = {
    CTRADER_CLIENT_ID: 'offline-test', CTRADER_CLIENT_SECRET: 'offline-test', CTRADER_ACCESS_TOKEN: 'offline-test',
    CTRADER_ACCOUNT_ID: '123', CTRADER_CONNECT_TRIES: '1', CTRADER_ENV: 'demo', CTRADER_HOST: 'offline.invalid', TRADING_DATA_DIR: dir,
    DEGRADED_ENTRY_GUARD: 'off', SUNDAY_REOPEN_BLOCK: 'off', PLAN_GATE: 'off', FIB_VETO: 'off',
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request in offline test'); });

  const protoDir = fileURLToPath(new URL('../../../vendor/ctrader-protos/', import.meta.url));
  const root = await protobuf.load(['OpenApiCommonModelMessages.proto', 'OpenApiCommonMessages.proto',
    'OpenApiModelMessages.proto', 'OpenApiMessages.proto'].map(file => join(protoDir, file)));
  const wrapType = root.lookupType('ProtoMessage');
  const types = new Map();
  function walk(ns) {
    for (const child of Object.values(ns.nested || {})) walk(child);
    if (ns.fields?.payloadType) types.set(ns.fields.payloadType.defaultValue, ns);
  }
  walk(root);
  let mode = 'ok';
  const sentOrders = [];
  const socket = new EventEmitter();
  socket.destroy = () => socket.emit('end');
  socket.write = buffer => {
    const wrap = wrapType.decode(buffer.subarray(4));
    const requestType = types.get(wrap.payloadType);
    const req = requestType.decode(wrap.payload);
    let name = requestType.name.replace(/Req$/, 'Res');
    let data = { ctidTraderAccountId: 456 };
    if (requestType.name === mode) {
      name = 'ProtoOAErrorRes'; data = { errorCode: 'OFFLINE_TEST_FAILURE', description: 'broker read unavailable' };
    } else switch (requestType.name) {
      case 'ProtoOAApplicationAuthReq': data = {}; break;
      case 'ProtoOAGetAccountListByAccessTokenReq':
        data = { accessToken: 'offline-test', ctidTraderAccount: [{ ctidTraderAccountId: 456, traderLogin: 123, isLive: false }] }; break;
      case 'ProtoOAAccountAuthReq': break;
      case 'ProtoOASymbolsListReq': data.symbol = [{ symbolId: 1, symbolName: 'EURUSD' }]; break;
      case 'ProtoOASymbolByIdReq':
        data.symbol = [{ symbolId: 1, digits: 5, pipPosition: 4, lotSize: 10000000, minVolume: 100000, stepVolume: 100000 }]; break;
      case 'ProtoOAReconcileReq': data.position = []; if (mode === 'wrong-account') data.ctidTraderAccountId = 999; break;
      case 'ProtoOATraderReq':
        data.trader = { ctidTraderAccountId: 456, balance: 1000000, moneyDigits: 2, depositAssetId: 1 }; break;
      case 'ProtoOAGetPositionUnrealizedPnLReq':
        data.moneyDigits = 2;
        data.positionUnrealizedPnL = [{ positionId: 7, grossUnrealizedPnL: -190000, netUnrealizedPnL: mode === 'insolvent' ? -1100000 : -200000 }]; break;
      case 'ProtoOAGetTrendbarsReq':
        data.period = req.period;
        data.trendbar = mode === 'empty-bars' ? [] : [{ volume: 100, low: 109000, deltaOpen: 1000,
          deltaClose: 1000, deltaHigh: 2000, utcTimestampInMinutes: Math.floor(Date.now() / 60000) - (mode === 'stale-bars' ? 300 : 1) }]; break;
      case 'ProtoOANewOrderReq':
        sentOrders.push(req); name = 'ProtoOAExecutionEvent'; data.executionType = 2; break;
      default: throw new Error(`Unexpected request ${requestType.name}`);
    }
    const responseType = root.lookupType(name);
    const payload = responseType.encode(responseType.fromObject(data)).finish();
    const body = wrapType.encode(wrapType.create({ payloadType: responseType.fields.payloadType.defaultValue,
      clientMsgId: wrap.clientMsgId, payload })).finish();
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
    queueMicrotask(() => socket.emit('data', Buffer.concat([length, body])));
    return true;
  };
  t.mock.method(tls, 'connect', () => { queueMicrotask(() => socket.emit('secureConnect')); return socket; });
  t.after(() => socket.destroy());
  const broker = await import('../broker_ctrader.mjs');
  const order = { symbol: 'EURUSD', direction: 'long', units: 0.1, entry: 1.1, slPrice: 1.09, tpPrice: 1.12 };

  await t.test('equity API returns balance plus net floating P&L', async () => {
    const eq = await broker.getEquity();
    assert.equal(eq.balance, 10000);
    assert.equal(eq.equity, 8000);
    assert.equal(eq.unrealizedPnl, -2000);
  });
  for (const fault of ['ProtoOAReconcileReq', 'wrong-account', 'ProtoOATraderReq',
    'ProtoOAGetPositionUnrealizedPnLReq', 'insolvent', 'ProtoOAGetTrendbarsReq', 'empty-bars', 'stale-bars']) {
    await t.test(`${fault} prevents an order from reaching transport`, async () => {
      mode = fault;
      await assert.rejects(broker.placeOrder(order), /ORDER_SAFETY_REJECT/);
      assert.equal(sentOrders.length, 0);
    });
  }
  await t.test('exposure errors produce an explicit veto', async () => {
    mode = 'ProtoOAReconcileReq';
    const result = await broker.checkExposure(order);
    assert.equal(result.ok, false);
    assert.match(result.reason, /could not be verified/);
  });
  await t.test('a healthy market order carries brackets and its immediate duplicate is rejected', async () => {
    mode = 'ok';
    await broker.placeOrder(order);
    assert.equal(sentOrders.length, 1);
    assert.equal(Number(sentOrders[0].relativeStopLoss), 1000);
    assert.equal(Number(sentOrders[0].relativeTakeProfit), 2000);
    await assert.rejects(broker.placeOrder(order), /cooldown/);
    assert.equal(sentOrders.length, 1);
  });
});
