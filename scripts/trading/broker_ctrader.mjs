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

// Scanner uses TradingView symbol names (e.g. GER40, JP225). BlackBull cTrader
// demo carries some of these under different names — translate on lookup so
// callers don't need to know.
const CTRADER_NAME_MAP = {
  GER40: 'GER30',
  JP225: 'JPN225',
};
// Reverse map (cTrader name -> TradingView/scanner name) for resolving a
// position's symbolId back to the name the scanner + trades.csv use.
const CTRADER_NAME_REV = Object.fromEntries(
  Object.entries(CTRADER_NAME_MAP).map(([tv, ct]) => [ct, tv]),
);
// Symbols we know are NOT carried by cTrader on this account. Throwing a
// recognizable error keeps the inline_trader's fallback-to-TV-DOM logic clean.
const CTRADER_UNSUPPORTED = new Set(['HK50']);

async function _loadSymbolList() {
  if (_symbolIdMap.size > 0) return;
  const res = await send('ProtoOASymbolsListReq', { ctidTraderAccountId: _accountId });
  for (const s of (res.symbol || [])) _symbolIdMap.set(s.symbolName, Number(s.symbolId));
}

async function _symbolMetaFor(name) {
  if (_symbolMeta.has(name)) return _symbolMeta.get(name);
  if (CTRADER_UNSUPPORTED.has(name)) {
    throw new Error(`cTrader: symbol "${name}" not supported on this account (broker doesn't carry it).`);
  }
  const cTraderName = CTRADER_NAME_MAP[name] || name;
  await _loadSymbolList();
  const id = _symbolIdMap.get(cTraderName);
  if (id == null) throw new Error(`cTrader: symbol "${name}" (cTrader name: "${cTraderName}") not in account symbol list.`);
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
  // Quantize to broker step + enforce min volume
  const step = meta.stepVolume > 0 ? meta.stepVolume : 1;
  const minV = meta.minVolume  > 0 ? meta.minVolume  : step;
  const rawVol = Math.round(units * meta.lotSize);
  const volume = Math.max(minV, Math.floor(rawVol / step) * step);

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

/**
 * Approach B — open ONE market position with the full volume and SL, then place
 * N LIMIT orders on the opposite side at each TP, each closing 1/N of the volume
 * (linked to the parent positionId so they reduce the position instead of opening
 * new hedged ones).
 *
 * The advantages over N separate positions (Approach A):
 *   - one position on the books, one SL to manage (synthetic BE = 1 modify call)
 *   - one entry fill in deal history (cleaner PnL attribution)
 *   - position list view is uncluttered
 *
 * Caller passes:
 *   symbol, direction ('long'|'short'|'buy'|'sell')
 *   totalUnits   — total lots across all legs (e.g. 0.03 for 3 legs of 0.01)
 *   entry        — expected entry price (for relative SL)
 *   slPrice      — absolute SL price
 *   tpPrices     — array of N absolute TP prices, ordered nearest→furthest
 *
 * Returns: { positionId, openRes, tpOrderIds: [N], failedTps: [...] }
 */
export async function placeMultiTpPosition({ symbol, direction, totalUnits, legUnits, entry, slPrice, tpPrices }) {
  await connect();
  if (!slPrice) throw new Error('slPrice required.');
  if (!Array.isArray(tpPrices) || tpPrices.length === 0) throw new Error('tpPrices must be a non-empty array.');

  const meta = await _symbolMetaFor(symbol);
  const tradeSide  = (direction === 'long' || direction === 'buy') ? 1 : 2;  // BUY | SELL
  const closeSide  = tradeSide === 1 ? 2 : 1;
  // cTrader requires volume to be a multiple of meta.stepVolume (in cents) and
  // >= meta.minVolume. Round DOWN to the step so we don't accidentally inflate risk.
  const step = meta.stepVolume > 0 ? meta.stepVolume : 1;
  const minV = meta.minVolume  > 0 ? meta.minVolume  : step;
  const _quantize = (v) => Math.max(minV, Math.floor(v / step) * step);
  const totalVol   = _quantize(Math.round(totalUnits * meta.lotSize));

  // Per-leg volume. If caller supplied legUnits (used for oil's uneven int split
  // e.g. 5 → [1,2,2]), honor it but quantize each leg to the step. Otherwise
  // divide totalVol evenly across N legs in step units.
  const N = tpPrices.length;
  let legVols;
  if (Array.isArray(legUnits) && legUnits.length === N) {
    legVols = legUnits.map(u => _quantize(Math.round(u * meta.lotSize)));
    // After per-leg quantization the sum can drift below totalVol. Push the
    // remainder onto the last leg (still in step units) so totals reconcile.
    const sum = legVols.reduce((a, b) => a + b, 0);
    if (sum !== totalVol) legVols[N - 1] = Math.max(minV, legVols[N - 1] + (totalVol - sum));
  } else {
    // Divide in step-multiple chunks so each leg is broker-legal
    const totalSteps = Math.floor(totalVol / step);
    const baseSteps  = Math.floor(totalSteps / N);
    const remSteps   = totalSteps - baseSteps * N;
    legVols = Array(N).fill(baseSteps * step);
    legVols[N - 1] += remSteps * step;
    legVols = legVols.map(v => Math.max(minV, v));
  }

  // ── 1. Open the parent position ──
  // MARKET order with relativeStopLoss AND relativeTakeProfit at TP3 (the final
  // target). The intermediate TP1/TP2 partial fills happen via the linked LIMIT
  // close orders placed below. Setting position-level TP at TP3 ensures every
  // position visibly shows SL + TP in the broker UI (no "naked TP=0" appearance)
  // and acts as a safety-net close if price runs through all targets before any
  // of the LIMITs fill (e.g. on a gap or fast move).
  const slDist  = Math.round(Math.abs(entry  - slPrice)              * 100_000);
  const tpFinal = tpPrices[tpPrices.length - 1];
  const tpDist  = Math.round(Math.abs(tpFinal - entry)               * 100_000);
  const openRes = await send('ProtoOANewOrderReq', {
    ctidTraderAccountId: _accountId,
    symbolId:    meta.id,
    orderType:   1,                   // MARKET
    tradeSide,
    volume:      totalVol,
    relativeStopLoss:   slDist,
    relativeTakeProfit: tpDist,
    timeInForce: 3,                   // IMMEDIATE_OR_CANCEL
  });
  const positionId = _toNum(openRes?.position?.positionId);
  if (!positionId) throw new Error(`placeMultiTpPosition: open did not return positionId — ${JSON.stringify(openRes).slice(0,200)}`);

  // ── 2. Place N partial-close LIMIT orders ──
  const tpOrderIds = [];
  const failedTps  = [];
  for (let i = 0; i < N; i++) {
    try {
      const r = await send('ProtoOANewOrderReq', {
        ctidTraderAccountId: _accountId,
        symbolId:    meta.id,
        orderType:   2,                   // LIMIT
        tradeSide:   closeSide,
        volume:      legVols[i],
        limitPrice:  tpPrices[i],
        positionId,                       // ← links exit to parent position
        timeInForce: 1,                   // GOOD_TILL_CANCEL
      });
      tpOrderIds.push(_toNum(r?.order?.orderId));
    } catch (e) {
      console.error(`[cTrader] partial-close limit ${i + 1}/${N} at ${tpPrices[i]} failed: ${e.message}`);
      failedTps.push({ tpPrice: tpPrices[i], legVol: legVols[i], error: e.message });
    }
  }

  return { positionId, openRes, tpOrderIds, failedTps };
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

export async function modifyPosition(positionId, { stopLoss, takeProfit, trailingStopLoss }) {
  await connect();
  return send('ProtoOAAmendPositionSLTPReq', {
    ctidTraderAccountId: _accountId,
    positionId: Number(positionId),
    ...(stopLoss         != null && { stopLoss }),
    ...(takeProfit       != null && { takeProfit }),
    ...(trailingStopLoss != null && { trailingStopLoss }),
  });
}

/**
 * Move broker-side SL of a position to its entry price (true breakeven).
 * Survives bot crashes — once set, the broker enforces it server-side.
 */
export async function setBreakeven(positionId, entryPrice) {
  return modifyPosition(positionId, { stopLoss: entryPrice });
}

/**
 * Enable cTrader trailing stop on a position. The trailing distance is implicit:
 * cTrader trails at whatever the current SL distance is from the entry/current
 * price. So call setBreakeven() (or modifyPosition with a tightened stopLoss)
 * BEFORE enabling trailing to lock the trail distance in.
 */
export async function enableTrailingStop(positionId) {
  return modifyPosition(positionId, { trailingStopLoss: true });
}

/**
 * Arm trailing stop with a SENSIBLE distance. Calling enableTrailingStop()
 * after setBreakeven() trails at distance 0 → instant close on next adverse
 * tick. This helper instead:
 *   1. Reads the current position
 *   2. Moves SL to (currentPrice ± trailDistance) — locking trailDistance as
 *      the trail width
 *   3. Enables trailingStopLoss
 *
 *   trailDistance — absolute price distance (e.g. 0.5 for $0.50 trail on WTI).
 *                   Caller computes this; typically originalSlDist × 0.5.
 *   currentPrice  — current bid (for long) or ask (for short). If not provided,
 *                   we use the position's stored entry as a fallback (degrades
 *                   gracefully to BE trail).
 */
export async function armTrailingStop(positionId, trailDistance, currentPrice) {
  await connect();
  const positions = await getPositions();
  const pos = positions.find(p => p.positionId === Number(positionId));
  if (!pos) throw new Error(`armTrailingStop: positionId ${positionId} not open`);
  const anchor = (currentPrice != null && isFinite(currentPrice)) ? currentPrice : pos.entryPrice;
  const newSL = pos.direction === 'long'
    ? anchor - Math.abs(trailDistance)
    : anchor + Math.abs(trailDistance);
  // Two-step: move SL to give the trail real distance, THEN flip trailing on.
  await modifyPosition(positionId, { stopLoss: newSL });
  return modifyPosition(positionId, { trailingStopLoss: true });
}

/** Cancel a single pending order. */
export async function cancelOrder(orderId) {
  await connect();
  return send('ProtoOACancelOrderReq', {
    ctidTraderAccountId: _accountId,
    orderId: Number(orderId),
  });
}

/**
 * Cancel any pending orders linked to a positionId. Called after the parent
 * position closes to clean up TP-limit children, even though cTrader normally
 * auto-cancels them — belt-and-braces for the rare case the cleanup is delayed.
 * Returns { cancelled: N }.
 */
export async function cancelOrphanLimits(positionId) {
  await connect();
  const res = await send('ProtoOAReconcileReq', { ctidTraderAccountId: _accountId });
  const orders = res.order || [];
  let cancelled = 0;
  for (const o of orders) {
    if (_toNum(o.positionId) === Number(positionId)) {
      try {
        await cancelOrder(_toNum(o.orderId));
        cancelled++;
      } catch (e) {
        console.error(`[cTrader] orphan cancel ${o.orderId} failed: ${e.message}`);
      }
    }
  }
  return { cancelled };
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

/**
 * Sum of open volume (in cents) for all positions on the given symbol name.
 * Used by position_monitor's synthetic-BE detection on the Approach B path:
 * a single position shrinks in volume as each TP limit fills, so we watch
 * for volume reduction instead of position-count drop.
 */
export async function getOpenVolumeForSymbol(symbolName) {
  await connect();
  const meta = await _symbolMetaFor(symbolName);
  const positions = await getPositions();
  return positions.filter(p => p.symbolId === meta.id).reduce((s, p) => s + p.volumeCents, 0);
}

/**
 * Return open positions missing a stop-loss or take-profit, with symbolId
 * resolved back to the scanner/TradingView name. Used by naked_position_guard
 * to repair (modifyPosition) or close via the cTrader API — the DOM path lags
 * and closes netted positions piecemeal.
 */
export async function getNakedPositions() {
  await connect();
  await _loadSymbolList();
  const idToName = new Map();
  for (const [name, id] of _symbolIdMap) idToName.set(id, name);
  const positions = await getPositions();
  return positions
    .filter(p => !p.stopLoss || !p.takeProfit)
    .map(p => {
      const ctName = idToName.get(p.symbolId) || String(p.symbolId);
      return {
        positionId:  p.positionId,
        symbolName:  CTRADER_NAME_REV[ctName] || ctName,
        direction:   p.direction,
        entryPrice:  p.entryPrice,
        volumeCents: p.volumeCents,
        stopLoss:    p.stopLoss,
        takeProfit:  p.takeProfit,
      };
    });
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

const TRENDBAR_PERIOD = { M1:1, M2:2, M3:3, M4:4, M5:5, M10:6, M15:7, M30:8, H1:9, H4:10, H12:11, D1:12, W1:13, MN1:14 };

/**
 * Fetch historical trendbars (OHLCV) for `symbolName` over [fromMs, toMs].
 * Walks backward in `windowDays`-sized windows so each request stays under
 * cTrader's per-request bar cap, then dedupes + sorts ascending.
 *
 * ProtoOATrendbar encodes prices as deltas off `low`, scaled ×100000:
 *   low=raw/1e5, open=(low+deltaOpen)/1e5, etc. timestamp = utcTimestampInMinutes×60000.
 * (Absolute scale is irrelevant to R-normalized backtests, but we divide so
 *  prices read normally.)
 *
 * Returns: [{ t (unix ms), o, h, l, c, v }] ascending. Deep history source for
 * backtests — TradingView getBars only serves ~300 loaded bars.
 */
export async function getTrendbars(symbolName, { period = 'M5', fromMs, toMs = Date.now(), windowDays = 5 } = {}) {
  await connect();
  const meta = await _symbolMetaFor(symbolName);
  const periodEnum = TRENDBAR_PERIOD[period];
  if (!periodEnum) throw new Error(`Unknown trendbar period: ${period}`);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const byTs = new Map();
  let winTo = toMs;

  while (winTo > fromMs) {
    const winFrom = Math.max(fromMs, winTo - windowMs);
    let attempt = 0;
    while (attempt < 3) {
      try {
        const res = await send('ProtoOAGetTrendbarsReq', {
          ctidTraderAccountId: _accountId,
          fromTimestamp: winFrom,
          toTimestamp:   winTo,
          period:        periodEnum,
          symbolId:      meta.id,
        }, { timeoutMs: 20_000 });
        for (const tb of (res.trendbar || [])) {
          const low = _toNum(tb.low);
          const t   = _toNum(tb.utcTimestampInMinutes) * 60000;
          byTs.set(t, {
            t,
            o: (low + _toNum(tb.deltaOpen))  / 100000,
            h: (low + _toNum(tb.deltaHigh))  / 100000,
            l:  low / 100000,
            c: (low + _toNum(tb.deltaClose)) / 100000,
            v: _toNum(tb.volume),
          });
        }
        break;
      } catch (e) {
        if (/rate limited|BLOCKED_PAYLOAD_TYPE/i.test(e.message) && attempt < 2) {
          attempt++; await sleep(2000 * attempt); continue;
        }
        throw e;
      }
    }
    winTo = winFrom;
    await sleep(300);
  }
  return [...byTs.values()].sort((a, b) => a.t - b.t);
}

/**
 * Pull EVERY closing deal for the whole account over [fromMs, toMs] — no symbol
 * filter, paginated in weekly windows so nothing is missed or truncated.
 * Use this (not per-symbol getRecentClosePnl) for account-wide P&L reconciliation.
 * Returns: [{ dealId, positionId, symbolId, symbolName, execTs, net }] ascending.
 */
export async function getAllClosedDeals(fromMs, toMs = Date.now(), { windowDays = 7 } = {}) {
  await connect();
  await _loadSymbolList();
  const idToName = new Map();
  for (const [name, id] of _symbolIdMap) idToName.set(id, name);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const byDeal = new Map();
  let winTo = toMs;

  while (winTo > fromMs) {
    const winFrom = Math.max(fromMs, winTo - windowMs);
    let attempt = 0;
    while (attempt < 3) {
      try {
        const res = await send('ProtoOADealListReq', {
          ctidTraderAccountId: _accountId, fromTimestamp: winFrom, toTimestamp: winTo, maxRows: 1000,
        }, { timeoutMs: 20_000 });
        for (const d of (res.deal || [])) {
          if (!d.closePositionDetail) continue;            // only closing deals carry realised PnL
          const st = _toNum(d.dealStatus);
          if (st !== 2 && st !== 3) continue;              // FILLED / PARTIALLY_FILLED
          const cpd = d.closePositionDetail;
          const scale = Math.pow(10, _toNum(cpd.moneyDigits) || 2);
          const net = (_toNum(cpd.grossProfit) + _toNum(cpd.commission) + _toNum(cpd.swap)) / scale;
          const sid = _toNum(d.symbolId);
          const ctName = idToName.get(sid);
          byDeal.set(_toNum(d.dealId), {
            dealId:     _toNum(d.dealId),
            positionId: _toNum(d.positionId),
            symbolId:   sid,
            symbolName: (ctName && (CTRADER_NAME_REV[ctName] || ctName)) || `id${sid}`,
            execTs:     _toNum(d.executionTimestamp),
            execPrice:  d.executionPrice,
            net,
            balance:        _toNum(cpd.balance) / scale,   // account balance AFTER this deal (cTrader ledger)
            balanceVersion: _toNum(cpd.balanceVersion),
          });
        }
        break;
      } catch (e) {
        if (/rate limited|BLOCKED_PAYLOAD_TYPE/i.test(e.message) && attempt < 2) { attempt++; await sleep(2000 * attempt); continue; }
        throw e;
      }
    }
    winTo = winFrom;
    await sleep(250);
  }
  return [...byDeal.values()].sort((a, b) => a.execTs - b.execTs);
}

/**
 * Today's REALISED P&L (sum of net on all closing deals since 00:00 UTC), from
 * the cTrader ledger. This is the authoritative figure for the daily-drawdown
 * kill-switch — trades.csv P&L is unreliable (often VOID/0).
 */
/** Resolve a raw cTrader symbolId to its name (incl. archived/delisted symbols). */
export async function getSymbolNameById(id) {
  await connect();
  const res = await send('ProtoOASymbolsListReq', { ctidTraderAccountId: _accountId, includeArchivedSymbols: true });
  const hit = (res.symbol || []).find(s => Number(s.symbolId) === Number(id));
  return hit ? { id: Number(id), name: hit.symbolName, enabled: hit.enabled, baseAssetId: hit.baseAssetId } : null;
}

export async function getTodayRealizedPnl() {
  const now = new Date();
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0);
  const deals = await getAllClosedDeals(startOfDay);
  return deals.reduce((s, d) => s + d.net, 0);
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
