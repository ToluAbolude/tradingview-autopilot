/**
 * broker_ctrader.mjs — cTrader Open API v2 bridge (TCP/TLS + protobuf).
 *
 * Direct connection to BlackBull's cTrader backend. Replaces the fragile
 * TradingView-DOM execution path. Every UI-scraping bug class (silent close,
 * balance-delta PnL, sub-min-lot reject, suffix-strip mismatch, close-bracket
 * TYPE confusion) disappears here because cTrader is the source of truth.
 *
 * Wire protocol:
 *   - TLS connect to {demo,live}.ctraderapi.com:5035
 *   - Each message: 4-byte big-endian length prefix + ProtoMessage protobuf
 *   - ProtoMessage = { payloadType (uint32), payload (bytes), clientMsgId (string) }
 *   - Responses match outgoing requests by clientMsgId
 *
 * Auth chain (v2):
 *   ProtoOAApplicationAuthReq -> ProtoOAGetAccountListByAccessTokenReq -> ProtoOAAccountAuthReq
 *
 * Credentials live in /home/ubuntu/.ctrader.env (NOT committed):
 *   CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET (from openapi.ctrader.com/apps)
 *   CTRADER_ACCESS_TOKEN, CTRADER_REFRESH_TOKEN (from ctrader_oauth_helper.mjs)
 *   CTRADER_ACCOUNT_ID=2118552  (BlackBull live account)
 *   CTRADER_ENV=demo|live
 *
 * Uses protobufjs (modern) + node tls. No Spotware npm packages — those are
 * v1-only and abandoned. Proto files vendored from spotware/ctrader-open-api-v2-java-example.
 */
import tls from 'tls';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const protobuf = require('protobufjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = path.join(__dirname, '..', '..', 'vendor', 'ctrader-protos');

const ENDPOINTS = {
  demo: { host: 'demo.ctraderapi.com', port: 5035 },
  live: { host: 'live.ctraderapi.com', port: 5035 },
};

const ENV = process.env.CTRADER_ENV || 'demo';
const endpoint = ENDPOINTS[ENV] || ENDPOINTS.demo;

// ── Load protos ─────────────────────────────────────────────────────────────
const root = await protobuf.load([
  path.join(PROTO_DIR, 'OpenApiCommonModelMessages.proto'),
  path.join(PROTO_DIR, 'OpenApiCommonMessages.proto'),
  path.join(PROTO_DIR, 'OpenApiModelMessages.proto'),
  path.join(PROTO_DIR, 'OpenApiMessages.proto'),
]);

const ProtoMessage = root.lookupType('ProtoMessage');

// Build name <-> payloadType maps from the proto enums.
// In v2 every request/response has a `payloadType` field with a default of
// the enum value, so we can pre-build the lookup table.
const _nameToType = {};
const _typeToName = {};
function indexMessage(type) {
  const f = type.fields?.payloadType;
  if (!f || !Number.isInteger(f.defaultValue)) return;
  _nameToType[type.name] = f.defaultValue;
  _typeToName[f.defaultValue] = type.name;
}
function walk(ns) {
  if (ns.nested) for (const k of Object.keys(ns.nested)) walk(ns.nested[k]);
  if (typeof ns.fields === 'object') indexMessage(ns);
}
walk(root);

const lookupType = (name) => {
  const t = root.lookupType(name);
  if (!t) throw new Error(`Proto type not found: ${name}`);
  return t;
};

// ── Connection singleton ────────────────────────────────────────────────────
let _socket   = null;
let _ready    = false;
let _readyPromise = null;
let _accountId = null;
let _msgCounter = 0;
const _pending = new Map();   // clientMsgId -> { resolve, reject, timer }
const _eventHandlers = new Map();  // payloadName -> [handler, ...]

function _frame(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function _sendRaw(payloadType, payloadObj, clientMsgId) {
  const name = _typeToName[payloadType];
  const T = lookupType(name);
  const errMsg = T.verify(payloadObj);
  if (errMsg) throw new Error(`Verify failed for ${name}: ${errMsg}`);
  const payload = T.encode(T.create(payloadObj)).finish();
  const wrap = ProtoMessage.encode(ProtoMessage.create({ payloadType, payload, clientMsgId })).finish();
  _socket.write(_frame(wrap));
}

function send(name, payload, { timeoutMs = 10_000 } = {}) {
  if (!_socket) throw new Error('cTrader not connected. Call connect() first.');
  const payloadType = _nameToType[name];
  if (payloadType == null) throw new Error(`Unknown cTrader request: ${name}`);
  const clientMsgId = `m${++_msgCounter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(clientMsgId);
      reject(new Error(`${name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    _pending.set(clientMsgId, { resolve, reject, timer });
    try { _sendRaw(payloadType, payload || {}, clientMsgId); }
    catch (e) { clearTimeout(timer); _pending.delete(clientMsgId); reject(e); }
  });
}

function _handleIncoming(wrap) {
  const name = _typeToName[wrap.payloadType] || `Unknown(${wrap.payloadType})`;
  let decoded = null;
  try {
    const T = lookupType(name);
    decoded = T.decode(wrap.payload);
  } catch (_) { /* unknown type — leave decoded null */ }

  // Match to pending request by clientMsgId
  if (wrap.clientMsgId && _pending.has(wrap.clientMsgId)) {
    const { resolve, reject, timer } = _pending.get(wrap.clientMsgId);
    clearTimeout(timer);
    _pending.delete(wrap.clientMsgId);
    if (name === 'ProtoOAErrorRes' || name === 'ProtoErrorRes') {
      reject(new Error(`cTrader error: ${decoded?.errorCode} ${decoded?.description || ''}`));
    } else {
      resolve(decoded);
    }
    return;
  }

  // Otherwise treat as an event
  const handlers = _eventHandlers.get(name) || [];
  for (const h of handlers) { try { h(decoded); } catch (e) { console.error(`[cTrader] handler ${name}:`, e); } }
}

export function on(name, handler) {
  const arr = _eventHandlers.get(name) || [];
  arr.push(handler);
  _eventHandlers.set(name, arr);
}

export async function connect() {
  if (_ready) return;
  if (_readyPromise) return _readyPromise;

  const clientId     = process.env.CTRADER_CLIENT_ID;
  const clientSecret = process.env.CTRADER_CLIENT_SECRET;
  const accessToken  = process.env.CTRADER_ACCESS_TOKEN;
  const accountNum   = process.env.CTRADER_ACCOUNT_ID;

  if (!clientId || !clientSecret || !accessToken || !accountNum) {
    throw new Error('Missing CTRADER_* env vars. See docs/CTRADER_SETUP.md');
  }

  console.log(`[cTrader] Connecting to ${endpoint.host}:${endpoint.port} (env=${ENV})`);

  _readyPromise = new Promise((resolve, reject) => {
    _socket = tls.connect(endpoint.port, endpoint.host, { servername: endpoint.host });

    let recvBuf = Buffer.alloc(0);
    _socket.on('data', (chunk) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);
      while (recvBuf.length >= 4) {
        const len = recvBuf.readUInt32BE(0);
        if (recvBuf.length < 4 + len) break;
        const payload = recvBuf.subarray(4, 4 + len);
        recvBuf = recvBuf.subarray(4 + len);
        try { _handleIncoming(ProtoMessage.decode(payload)); }
        catch (e) { console.error('[cTrader] decode error:', e.message); }
      }
    });

    _socket.on('error', (e) => { console.error('[cTrader] socket error:', e.message); if (!_ready) reject(e); });
    _socket.on('end',   ()  => { console.log('[cTrader] connection ended'); _ready = false; _socket = null; _readyPromise = null; });

    _socket.on('secureConnect', async () => {
      try {
        // Heartbeat every 25s
        setInterval(() => { try { _sendRaw(_nameToType['ProtoHeartbeatEvent'], {}, ''); } catch (_) {} }, 25_000).unref();

        await send('ProtoOAApplicationAuthReq', { clientId, clientSecret });
        console.log('[cTrader] App auth OK');

        const accountsRes = await send('ProtoOAGetAccountListByAccessTokenReq', { accessToken });
        const accounts = accountsRes?.ctidTraderAccount || [];
        const match = accounts.find(a => String(a.traderLogin) === String(accountNum));
        if (!match) {
          throw new Error(`Account ${accountNum} not in OAuth-granted list (got: ${accounts.map(a=>a.traderLogin).join(', ')}). Re-grant scope=trading.`);
        }
        _accountId = Number(match.ctidTraderAccountId);
        console.log(`[cTrader] Account ${accountNum} -> ctidTraderAccountId=${_accountId}`);

        await send('ProtoOAAccountAuthReq', { ctidTraderAccountId: _accountId, accessToken });
        console.log('[cTrader] Account auth OK — ready');
        _ready = true;
        resolve();
      } catch (e) { reject(e); }
    });
  });

  return _readyPromise;
}

// ── Public API (matches execute_trade.mjs surface) ──────────────────────────

// Symbol metadata cache.
//   id      = numeric symbolId
//   lotSize = base currency units per 1.0 lot, in CENTS (cTrader convention).
//             EURUSD typically returns 10_000_000  (= 100_000 EUR × 100 cents).
//             volume field on ProtoOANewOrderReq is also in CENTS, so:
//                volume = round(units_in_lots * lotSize)
// ProtoOASymbolsListReq returns ProtoOALightSymbol (no lotSize). We then call
// ProtoOASymbolByIdReq to fetch the full ProtoOASymbol for each id we need.
const _symbolMeta  = new Map();   // name -> { id, lotSize, minVolume, stepVolume }
const _symbolIdMap = new Map();   // name -> id (populated from light list)

async function _loadSymbolList() {
  if (_symbolIdMap.size > 0) return;
  const res = await send('ProtoOASymbolsListReq', { ctidTraderAccountId: _accountId });
  for (const s of (res.symbol || [])) _symbolIdMap.set(s.symbolName, Number(s.symbolId));
}

async function _symbolMetaFor(name) {
  if (_symbolMeta.has(name)) return _symbolMeta.get(name);
  await _loadSymbolList();
  const id = _symbolIdMap.get(name);
  if (id == null) throw new Error(`cTrader: symbol "${name}" not in account symbol list.`);
  const res = await send('ProtoOASymbolByIdReq', { ctidTraderAccountId: _accountId, symbolId: [id] });
  const full = (res.symbol || [])[0];
  if (!full) throw new Error(`cTrader: ProtoOASymbolByIdReq returned no symbol for ${name} (id=${id}).`);
  const meta = {
    id,
    lotSize:    Number(full.lotSize    || 0),
    minVolume:  Number(full.minVolume  || 0),
    stepVolume: Number(full.stepVolume || 0),
  };
  _symbolMeta.set(name, meta);
  return meta;
}

/**
 * Place a market order.
 *   entry  = expected entry price (used to convert absolute slPrice/tpPrice
 *            into the relativeStopLoss / relativeTakeProfit that cTrader
 *            requires for MARKET orders). If omitted, falls back to a two-step
 *            place-then-amend flow.
 *   tpPrice, slPrice = absolute price targets matching the existing
 *                      execute_trade.placeOrder API.
 */
export async function placeOrder({ symbol, direction, units, entry, tpPrice, slPrice }) {
  await connect();
  if (!tpPrice || !slPrice) throw new Error('tpPrice + slPrice required.');
  const meta = await _symbolMetaFor(symbol);
  const tradeSide = (direction === 'long' || direction === 'buy') ? 1 : 2;
  const volume = Math.round(units * meta.lotSize);

  const req = {
    ctidTraderAccountId: _accountId,
    symbolId:    meta.id,
    orderType:   1,                                  // MARKET
    tradeSide,
    volume,
    timeInForce: 3,                                  // IMMEDIATE_OR_CANCEL
  };

  if (entry != null) {
    // Convert absolute prices → relative distances (in 1/100000 of price units).
    // For BUY: SL is below entry, TP is above. For SELL: reversed.
    const slDist = Math.round(Math.abs(entry - slPrice) * 100_000);
    const tpDist = Math.round(Math.abs(tpPrice - entry) * 100_000);
    req.relativeStopLoss   = slDist;
    req.relativeTakeProfit = tpDist;
    return send('ProtoOANewOrderReq', req);
  }

  // Two-step fallback: open naked, then amend with absolute SL/TP after fill.
  const orderRes = await send('ProtoOANewOrderReq', req);
  const posId = Number(orderRes?.position?.positionId);
  if (!posId) return orderRes;
  try {
    await send('ProtoOAAmendPositionSLTPReq', {
      ctidTraderAccountId: _accountId, positionId: posId,
      stopLoss: slPrice, takeProfit: tpPrice,
    });
  } catch (e) {
    console.error(`[cTrader] placeOrder: amend SL/TP failed for ${posId}: ${e.message}`);
  }
  return orderRes;
}

/** Close a position. `volumeCents` defaults to the position's current full volume. */
export async function closePosition(positionId, volumeCents = null) {
  await connect();
  if (volumeCents == null) {
    const positions = await getPositions();
    const p = positions.find(x => x.positionId === Number(positionId));
    if (!p) throw new Error(`closePosition: positionId ${positionId} not open`);
    volumeCents = p.volumeCents;
  }
  if (!volumeCents) throw new Error('closePosition: volumeCents must be > 0');
  return send('ProtoOAClosePositionReq', {
    ctidTraderAccountId: _accountId, positionId: Number(positionId), volume: volumeCents,
  });
}

export async function closeAllPositions() {
  const positions = await getPositions();
  let closed = 0;
  for (const p of positions) {
    try {
      await send('ProtoOAClosePositionReq', {
        ctidTraderAccountId: _accountId,
        positionId: p.positionId,
        volume:     p.volumeCents,
      });
      closed++;
    } catch (e) { console.error(`[cTrader] close ${p.positionId} failed: ${e.message}`); }
  }
  return { closed, remaining: positions.length - closed };
}

export async function modifyPosition(positionId, { stopLoss, takeProfit }) {
  await connect();
  return send('ProtoOAAmendPositionSLTPReq', {
    ctidTraderAccountId: _accountId,
    positionId,
    ...(stopLoss   != null && { stopLoss }),
    ...(takeProfit != null && { takeProfit }),
  });
}

// Helper — protobufjs returns int64 as either a JS number, a Long object
// { low, high }, or a string depending on options. Normalise to JS Number.
function _toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (typeof v.toNumber === 'function') return v.toNumber();
  if (typeof v.low === 'number') return v.low + (v.high || 0) * 0x100000000;
  return Number(v);
}

export async function getPositions() {
  await connect();
  const res = await send('ProtoOAReconcileReq', { ctidTraderAccountId: _accountId });
  return (res.position || []).map(p => ({
    positionId:  _toNum(p.positionId),
    symbolId:    _toNum(p.tradeData?.symbolId),
    direction:   p.tradeData?.tradeSide === 1 ? 'long' : 'short',
    volumeCents: _toNum(p.tradeData?.volume),   // raw cTrader volume (cents)
    entryPrice:  p.price,
    stopLoss:    p.stopLoss,
    takeProfit:  p.takeProfit,
    swap:        _toNum(p.swap),
    commission:  _toNum(p.commission),
  }));
}

export async function getEquity() {
  await connect();
  const res = await send('ProtoOATraderReq', { ctidTraderAccountId: _accountId });
  const t = res.trader || {};
  return {
    balance:  Number(t.balance || 0) / 100,
    equity:   Number(t.balance || 0) / 100,
    currency: t.depositAssetId,
  };
}

/**
 * Sum REAL net PnL of all closing deals for `symbolName` since `fromMs` (unix ms).
 * grossProfit/commission/swap are int64 cents; if `moneyDigits` is set on the
 * deal, divide by 10^moneyDigits (cTrader's high-precision currency encoding).
 *
 * Returns: { netPnl, count, deals: [...] } — netPnl in account currency.
 * Replaces position_monitor's balance-delta computation, which mis-attributes
 * one trade's win to another when multiple trades close near each other.
 */
export async function getRecentClosePnl(symbolName, fromMs, toMs = Date.now()) {
  await connect();
  const meta = await _symbolMetaFor(symbolName);
  const res = await send('ProtoOADealListReq', {
    ctidTraderAccountId: _accountId,
    fromTimestamp: fromMs,
    toTimestamp:   toMs,
    maxRows: 1000,
  });

  const matching = [];
  for (const d of (res.deal || [])) {
    if (_toNum(d.symbolId) !== meta.id) continue;
    if (!d.closePositionDetail) continue;     // only closing deals carry realised PnL
    const dealStatus = _toNum(d.dealStatus);
    if (dealStatus !== 2 && dealStatus !== 3) continue;  // FILLED or PARTIALLY_FILLED

    const cpd = d.closePositionDetail;
    const md  = _toNum(cpd.moneyDigits) || 2;            // default cents (×100)
    const scale = Math.pow(10, md);
    const gross = _toNum(cpd.grossProfit) / scale;
    const comm  = _toNum(cpd.commission)  / scale;
    const swap  = _toNum(cpd.swap)        / scale;
    const net   = gross + comm + swap;

    matching.push({
      dealId:     _toNum(d.dealId),
      positionId: _toNum(d.positionId),
      execTs:     _toNum(d.executionTimestamp),
      execPrice:  d.executionPrice,
      tradeSide:  d.tradeSide === 1 ? 'buy' : 'sell',
      gross, comm, swap, net,
    });
  }

  const netPnl = matching.reduce((s, d) => s + d.net, 0);
  return { netPnl: Math.round(netPnl * 100) / 100, count: matching.length, deals: matching };
}

export function onPositionEvent(handler) {
  on('ProtoOAExecutionEvent', (evt) => {
    if (!evt?.position) return;
    handler({
      executionType: evt.executionType,
      positionId:    Number(evt.position.positionId),
      raw:           evt,
    });
  });
}

// ── Smoke test ─────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('broker_ctrader.mjs')) {
  (async () => {
    const args = process.argv.slice(2);
    try {
      await connect();
      if (args.includes('--equity'))     console.log('Equity:',    JSON.stringify(await getEquity(),    null, 2));
      else if (args.includes('--positions')) console.log('Positions:', JSON.stringify(await getPositions(), null, 2));
      else console.log('OK — connected. Try --equity / --positions.');
      process.exit(0);
    } catch (e) { console.error('Smoke test FAILED:', e.message); process.exit(1); }
  })();
}
