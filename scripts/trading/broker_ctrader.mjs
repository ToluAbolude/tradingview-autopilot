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

const _symbolCache = new Map();
async function _symbolNameToId(name) {
  if (_symbolCache.size === 0) {
    const res = await send('ProtoOASymbolsListReq', { ctidTraderAccountId: _accountId });
    for (const s of (res.symbol || [])) _symbolCache.set(s.symbolName, Number(s.symbolId));
  }
  if (!_symbolCache.has(name)) throw new Error(`cTrader: symbol "${name}" not found in account.`);
  return _symbolCache.get(name);
}

export async function placeOrder({ symbol, direction, units, tpPrice, slPrice }) {
  await connect();
  if (!tpPrice || !slPrice) throw new Error('tpPrice + slPrice required.');
  const symbolId = await _symbolNameToId(symbol);
  const tradeSide = (direction === 'long' || direction === 'buy') ? 1 : 2;
  const res = await send('ProtoOANewOrderReq', {
    ctidTraderAccountId: _accountId,
    symbolId,
    orderType:   1,                                  // MARKET
    tradeSide,
    volume:      Math.round(units * 100),            // cTrader uses lots * 100
    stopLoss:    slPrice,
    takeProfit:  tpPrice,
    timeInForce: 3,                                  // IMMEDIATE_OR_CANCEL
  });
  return res;
}

export async function closePosition(positionId, volume = 0) {
  await connect();
  return send('ProtoOAClosePositionReq', {
    ctidTraderAccountId: _accountId, positionId, volume,
  });
}

export async function closeAllPositions() {
  const positions = await getPositions();
  let closed = 0;
  for (const p of positions) {
    try { await closePosition(p.positionId); closed++; }
    catch (e) { console.error(`[cTrader] close ${p.positionId} failed: ${e.message}`); }
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

export async function getPositions() {
  await connect();
  const res = await send('ProtoOAReconcileReq', { ctidTraderAccountId: _accountId });
  return (res.position || []).map(p => ({
    positionId:  Number(p.positionId),
    symbolId:    Number(p.tradeData?.symbolId),
    direction:   p.tradeData?.tradeSide === 1 ? 'long' : 'short',
    volume:      Number(p.tradeData?.volume || 0) / 100,
    entryPrice:  p.price,
    stopLoss:    p.stopLoss,
    takeProfit:  p.takeProfit,
    swap:        p.swap,
    commission:  p.commission,
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
