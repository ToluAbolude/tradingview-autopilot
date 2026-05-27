/**
 * broker_ctrader.mjs — cTrader Open API bridge.
 *
 * Exposes the same surface as execute_trade.mjs so consumers (inline_trader,
 * position_monitor, naked_position_guard, eod_close) can be switched from
 * TradingView DOM scraping to authoritative broker API calls.
 *
 * Architecture: a singleton long-lived TLS connection to Spotware's cTrader
 * infrastructure (BlackBull is hosted on Spotware). Auth chain on connect:
 *   ProtoOAApplicationAuthReq → ProtoOAGetAccountListByAccessTokenReq → ProtoOAAccountAuthReq
 *
 * Why we need this:
 *   - Truth-source PnL (cTrader knows the exact close price, no balance-delta noise)
 *   - Native modify-SL (replaces the broken closeAllPositions DOM dance)
 *   - Reliable bracket/OCO orders (no sub-min-lot silent rejects)
 *   - Per-position events stream → position_monitor becomes a thin event consumer
 *
 * Credentials live in /home/ubuntu/.ctrader.env (NOT committed):
 *   CTRADER_CLIENT_ID=...
 *   CTRADER_CLIENT_SECRET=...
 *   CTRADER_ACCESS_TOKEN=...   (from OAuth flow — see ctrader_oauth_helper.mjs)
 *   CTRADER_REFRESH_TOKEN=...
 *   CTRADER_ACCOUNT_ID=2118552 (BlackBull live account)
 *   CTRADER_ENV=demo|live
 *
 * Status: skeleton. Auth + connection are implemented but UNTESTED until
 * credentials are provisioned. See docs/CTRADER_SETUP.md for the credential
 * walkthrough.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ProtoMessages = require('connect-protobuf-messages');
const AdapterTLS    = require('connect-js-adapter-tls');
const EncodeDecode  = require('connect-js-encode-decode');
const Connect       = require('connect-js-api');

// ── Endpoints ───────────────────────────────────────────────────────────────
const ENDPOINTS = {
  demo: { host: 'demo.ctraderapi.com',  port: 5035 },
  live: { host: 'live.ctraderapi.com',  port: 5035 },
  // Spotware's own sandbox used by the official samples (kept as fallback):
  spotware_sandbox: { host: 'sandbox-tradeapi.spotware.com', port: 5032 },
};

const ENV = process.env.CTRADER_ENV || 'demo';
const endpoint = ENDPOINTS[ENV] || ENDPOINTS.demo;

// ── Protocol setup ──────────────────────────────────────────────────────────
const path = require('path');
const protoRoot = path.join(
  path.dirname(require.resolve('connect-protobuf-messages/package.json')),
  'src/main/protobuf'
);

const protocol = new ProtoMessages([
  { file: path.join(protoRoot, 'CommonMessages.proto') },
  { file: path.join(protoRoot, 'OpenApiMessages.proto') },
]);
protocol.load();
protocol.build();

// ── Connection singleton ────────────────────────────────────────────────────
let _connect = null;
let _ready   = false;
let _readyPromise = null;
let _accountId = null;  // ctidTraderAccountId (the numeric API-side ID, NOT the user's account number)

function payloadType(name) { return protocol.getPayloadTypeByName(name); }

function send(name, payload) {
  if (!_connect) throw new Error('cTrader not connected. Call connect() first.');
  return _connect.sendGuaranteedCommand(name, payload || {});
}

function on(name, handler) {
  _connect.on(payloadType(name), handler);
}

export async function connect() {
  if (_ready) return;
  if (_readyPromise) return _readyPromise;

  const clientId     = process.env.CTRADER_CLIENT_ID;
  const clientSecret = process.env.CTRADER_CLIENT_SECRET;
  const accessToken  = process.env.CTRADER_ACCESS_TOKEN;
  const accountNum   = process.env.CTRADER_ACCOUNT_ID;  // user-facing account number e.g. 2118552

  if (!clientId || !clientSecret || !accessToken || !accountNum) {
    throw new Error('Missing CTRADER_* env vars. See docs/CTRADER_SETUP.md');
  }

  console.log(`[cTrader] Connecting to ${endpoint.host}:${endpoint.port} (env=${ENV})`);

  const adapter      = new AdapterTLS({ host: endpoint.host, port: endpoint.port });
  const encodeDecode = new EncodeDecode();
  _connect = new Connect({ adapter, encodeDecode, protocol });

  _readyPromise = new Promise((resolve, reject) => {
    _connect.onConnect = async () => {
      try {
        // Heartbeat
        setInterval(() => send('ProtoOAVersionReq'), 25_000).unref();

        // Step 1: app auth
        await send('ProtoOAApplicationAuthReq', { clientId, clientSecret });
        console.log('[cTrader] App auth OK');

        // Step 2: list accounts to find ctidTraderAccountId for our account number
        const accountsRes = await send('ProtoOAGetAccountListByAccessTokenReq', { accessToken });
        const match = (accountsRes.ctidTraderAccount || []).find(
          a => String(a.traderLogin) === String(accountNum)
        );
        if (!match) {
          throw new Error(`Account ${accountNum} not in OAuth-granted list. Re-grant scope=trading.`);
        }
        _accountId = match.ctidTraderAccountId;
        console.log(`[cTrader] Account ${accountNum} → ctidTraderAccountId=${_accountId}`);

        // Step 3: authorize account for trading
        await send('ProtoOAAccountAuthReq', { ctidTraderAccountId: _accountId, accessToken });
        console.log('[cTrader] Account auth OK — ready for trading');

        _ready = true;
        resolve();
      } catch (e) { reject(e); }
    };

    _connect.onEnd   = () => { _ready = false; _connect = null; _readyPromise = null; console.log('[cTrader] Connection ended'); };
    _connect.onError = (e) => { console.error('[cTrader] error:', e); reject(e); };

    _connect.start();
  });

  return _readyPromise;
}

// ── Public API — same shape as execute_trade.mjs ──────────────────────────

/** Open a position. Returns { positionId, entryPrice, lots }. */
export async function placeOrder({ symbol, direction, units, tpPrice, slPrice }) {
  await connect();
  if (!tpPrice || !slPrice) throw new Error('tpPrice + slPrice required.');
  const symbolId = await _symbolNameToId(symbol);
  const tradeSide = (direction === 'long' || direction === 'buy') ? 1 /*BUY*/ : 2 /*SELL*/;

  const res = await send('ProtoOANewOrderReq', {
    ctidTraderAccountId: _accountId,
    symbolId,
    orderType:    1,         // MARKET
    tradeSide,
    volume:       Math.round(units * 100),  // cTrader uses cents/lots×100
    stopLoss:     slPrice,
    takeProfit:   tpPrice,
    timeInForce:  3,         // IMMEDIATE_OR_CANCEL
  });
  return { positionId: res?.position?.positionId, raw: res };
}

/** Close one position by id. */
export async function closePosition(positionId) {
  await connect();
  return send('ProtoOAClosePositionReq', {
    ctidTraderAccountId: _accountId,
    positionId,
    volume: 0,  // 0 = close full
  });
}

/** Close every open position (replaces the broken DOM closeAllPositions). */
export async function closeAllPositions() {
  await connect();
  const positions = await getPositions();
  let closed = 0;
  for (const p of positions) {
    try { await closePosition(p.positionId); closed++; }
    catch (e) { console.error(`[cTrader] close ${p.positionId} failed: ${e.message}`); }
  }
  return { closed, remaining: positions.length - closed };
}

/** Modify SL and/or TP on an open position. Enables real synthetic-BE. */
export async function modifyPosition(positionId, { stopLoss, takeProfit }) {
  await connect();
  return send('ProtoOAAmendPositionSLTPReq', {
    ctidTraderAccountId: _accountId,
    positionId,
    ...(stopLoss   != null && { stopLoss }),
    ...(takeProfit != null && { takeProfit }),
  });
}

/** Get all open positions for the account. */
export async function getPositions() {
  await connect();
  const res = await send('ProtoOAReconcileReq', { ctidTraderAccountId: _accountId });
  return (res.position || []).map(p => ({
    positionId:  p.positionId,
    symbolId:    p.tradeData?.symbolId,
    direction:   p.tradeData?.tradeSide === 1 ? 'long' : 'short',
    volume:      p.tradeData?.volume / 100,
    entryPrice:  p.price,
    stopLoss:    p.stopLoss,
    takeProfit:  p.takeProfit,
    swap:        p.swap,
    commission:  p.commission,
  }));
}

/** Account equity + balance — replaces DOM-scraped getEquity(). */
export async function getEquity() {
  await connect();
  const res = await send('ProtoOATraderReq', { ctidTraderAccountId: _accountId });
  return {
    balance: (res.trader?.balance || 0) / 100,
    equity:  (res.trader?.balance || 0) / 100,  // exact equity requires reconcile + mark-to-market
    currency: res.trader?.depositAssetId,
  };
}

/** Subscribe to position events (opened/closed/modified). Stream replaces polling. */
export function onPositionEvent(handler) {
  on('ProtoOAExecutionEvent', evt => {
    if (!evt.position) return;
    handler({
      type:        ['', 'ORDER_ACCEPTED', 'ORDER_FILLED', 'ORDER_REPLACED', 'ORDER_CANCELLED', 'ORDER_EXPIRED', 'ORDER_REJECTED', 'SWAP', 'DEPOSIT_WITHDRAW', 'ORDER_PARTIAL_FILL', 'BONUS_DEPOSIT_WITHDRAW'][evt.executionType] || 'UNKNOWN',
      positionId:  evt.position.positionId,
      raw:         evt,
    });
  });
}

// ── Internal: cache symbol-name → symbolId lookups ─────────────────────────
const _symbolCache = new Map();
async function _symbolNameToId(name) {
  if (_symbolCache.has(name)) return _symbolCache.get(name);
  const res = await send('ProtoOASymbolsListReq', { ctidTraderAccountId: _accountId });
  for (const s of (res.symbol || [])) {
    _symbolCache.set(s.symbolName, s.symbolId);
  }
  if (!_symbolCache.has(name)) throw new Error(`cTrader: symbol "${name}" not found in account symbol list.`);
  return _symbolCache.get(name);
}

// ── Smoke-test entry point ─────────────────────────────────────────────────
if (process.argv[1]?.endsWith('broker_ctrader.mjs')) {
  const args = process.argv.slice(2);
  (async () => {
    try {
      await connect();
      if (args.includes('--equity')) {
        console.log('Equity:', await getEquity());
      } else if (args.includes('--positions')) {
        console.log('Positions:', JSON.stringify(await getPositions(), null, 2));
      } else {
        console.log('OK — connected + authed. Try --equity or --positions');
      }
      process.exit(0);
    } catch (e) {
      console.error('Smoke test failed:', e);
      process.exit(1);
    }
  })();
}
