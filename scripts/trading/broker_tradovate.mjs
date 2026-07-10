/**
 * broker_tradovate.mjs — Tradovate REST bridge for the Tradeify Lightning 25k
 * prop account (FTDFYL25512034507, id 55798247, demo.tradovateapi.com).
 *
 * Auth: NO api key needed — the logged-in Tradovate web tab on this VM holds a
 * Bearer token in sessionStorage['api_authenticator_state'] (auto-renewed by
 * the app, ~80 min windows). We pull it via CDP (localhost:9222) and call the
 * REST API directly from Node. If the tab is gone or the token is expired the
 * bridge fails loudly — re-login on the VM is the only fix.
 *
 * Interface mirrors broker_ctrader.mjs where it matters so orb_runner can swap
 * brokers: getEquity(), placeOrder({symbol,direction,units,entry,tpPrice,slPrice}),
 * getPositions(), closeAllPositions().
 *
 * Hard rules baked in (prop account survival):
 *   • Brackets are DISTANCE-based: signals come from cTrader CFD prices, which
 *     sit on a basis offset from the futures (ES ~+60 over SPX500 CFD). We place
 *     the market entry, read the futures FILL price, then place an OCO bracket
 *     at fill ± the signal's SL/TP distances. Absolute CFD levels are never sent.
 *   • Naked window between fill and OCO is seconds; OCO failure → immediate
 *     liquidate (bracket-attach-bug lesson from cTrader). isAutomated:true on
 *     all orders (CME requirement for bots).
 *   • Per-trade dollar-risk cap, contract cap, anti-stack, weekend block, entry
 *     cutoff before the 4:59pm ET forced flat.
 *
 * CLI:  node broker_tradovate.mjs --status        read-only account summary
 *       node broker_tradovate.mjs --flatten       liquidate all + cancel orders
 *       node broker_tradovate.mjs --test-token    token extraction only
 */
import CDP from 'chrome-remote-interface';

const HOST = process.env.TVO_HOST || 'https://demo.tradovateapi.com/v1';
const ACCT_PREFIX = process.env.TVO_ACCOUNT_PREFIX || 'FTDFY';
const MAX_CONTRACTS = +(process.env.TVO_MAX_CONTRACTS || 2);
const MAX_RISK_USD = +(process.env.TVO_MAX_RISK || 150);        // per trade, incl. all contracts
const ENTRY_CUTOFF_UTC = +(process.env.TVO_ENTRY_CUTOFF || 19); // no new entries at/after this UTC hour (flat is forced 20:59 UTC in DST)

// Scanner symbol → front-month MICRO contract. Quarterly roll: update codes
// (U6=Sep26 equities; MGC uses even months, Q6=Aug26). validateContracts()
// confirms these resolve at startup — a failed lookup means we must roll.
const CONTRACTS = {
  XAUUSD: { name: 'MGCQ6', pointValue: 10, tick: 0.1 },
  NAS100: { name: 'MNQU6', pointValue: 2, tick: 0.25 },
  SPX500: { name: 'MESU6', pointValue: 5, tick: 0.25 },
  US30:   { name: 'MYMU6', pointValue: 0.5, tick: 1 },
};

// ── Token via CDP ─────────────────────────────────────────────────────────────
let tokenState = null; // { token, expiration, userId }

async function fetchTokenFromTab() {
  const targets = await CDP.List({ port: 9222 });
  const t = targets.find(x => x.type === 'page' && x.url.includes('tradovate'));
  if (!t) throw new Error('No Tradovate tab in VM Chrome — open/log in topstep.tradovate.com');
  const c = await CDP({ target: t });
  try {
    const timer = setTimeout(() => c.close().catch(() => {}), 15000);
    const { result, exceptionDetails } = await c.Runtime.evaluate({
      expression: "sessionStorage.getItem('api_authenticator_state')",
      returnByValue: true,
    });
    clearTimeout(timer);
    if (exceptionDetails || !result.value) throw new Error('api_authenticator_state missing — session logged out?');
    const st = JSON.parse(result.value);
    if (!st.token) throw new Error('No token in authenticator state');
    return { token: st.token, expiration: new Date(st.expiration).getTime(), userId: st.userId };
  } finally {
    await c.close().catch(() => {});
  }
}

async function getToken() {
  const now = Date.now();
  if (tokenState && tokenState.expiration - now > 5 * 60 * 1000) return tokenState.token;
  tokenState = await fetchTokenFromTab();
  if (tokenState.expiration - now < 60 * 1000) {
    throw new Error(`Tradovate session token expired ${new Date(tokenState.expiration).toISOString()} — the web tab must be alive to renew it`);
  }
  return tokenState.token;
}

// ── REST helpers (401 refresh once, p-ticket throttle retry once) ────────────
async function api(path, body, _retried = false) {
  const token = await getToken();
  const opts = { headers: { Authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(HOST + path, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (res.status === 401 && !_retried) {
    tokenState = null;
    return api(path, body, true);
  }
  if (json && json['p-ticket'] && !_retried) {
    const waitS = Math.min(+(json['p-time'] || 5), 30);
    console.log(`[tvo] throttled, waiting ${waitS}s`);
    await new Promise(r => setTimeout(r, waitS * 1000));
    return api(path, body, true);
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

// ── Account / read side ───────────────────────────────────────────────────────
let acctCache = null;
export async function getAccount() {
  if (acctCache) return acctCache;
  const list = await api('/account/list');
  const a = list.find(x => x.active && x.name.startsWith(ACCT_PREFIX)) || list.find(x => x.active);
  if (!a) throw new Error('No active Tradovate account for this session');
  acctCache = a;
  return a;
}

export async function getEquity() {
  const a = await getAccount();
  const cash = await api('/cashBalance/getcashbalancesnapshot', { accountId: a.id });
  // totalCashValue includes realized; netLiq includes open P/L
  return { equity: cash.netLiq ?? cash.totalCashValue, balance: cash.totalCashValue, raw: cash };
}

export async function getRiskStatus() {
  const a = await getAccount();
  const [autoLiq] = await api('/userAccountAutoLiq/list');
  const rs = (await api('/accountRiskStatus/list')).find(x => x.id === a.id) || {};
  return {
    trailingMaxDrawdown: autoLiq?.trailingMaxDrawdown,
    mode: autoLiq?.trailingMaxDrawdownMode,
    floorLocksAt: autoLiq?.trailingMaxDrawdownLimit,   // 25100 = start+$100 lock
    peakNetLiq: rs.maxNetLiq,
  };
}

export async function getPositions() {
  const a = await getAccount();
  const pos = (await api('/position/list')).filter(p => p.accountId === a.id && p.netPos !== 0);
  for (const p of pos) {
    try { p.contractName = (await api(`/contract/item?id=${p.contractId}`)).name; } catch { p.contractName = String(p.contractId); }
  }
  return pos;
}

export async function getWorkingOrders() {
  const a = await getAccount();
  const orders = await api('/order/list');
  return orders.filter(o => o.accountId === a.id && ['Working', 'Suspended'].includes(o.ordStatus));
}

export async function validateContracts() {
  const out = {};
  for (const [sym, c] of Object.entries(CONTRACTS)) {
    const found = await api(`/contract/find?name=${c.name}`);
    if (!found?.id) throw new Error(`Contract ${c.name} (${sym}) does not resolve — front-month roll needed in CONTRACTS map`);
    out[sym] = { ...c, contractId: found.id };
  }
  return out;
}

// ── Sizing: whole contracts from a dollar risk budget ────────────────────────
export function sizeContracts({ symbol, entry, slPrice, riskUsd = +(process.env.TVO_RISK_USD || 100) }) {
  const c = CONTRACTS[symbol];
  if (!c) throw new Error(`No contract mapping for ${symbol}`);
  const perContract = Math.abs(entry - slPrice) * c.pointValue;
  if (perContract <= 0) throw new Error('Zero SL distance');
  const units = Math.min(Math.max(1, Math.floor(riskUsd / perContract)), MAX_CONTRACTS);
  return { units, perContract: +perContract.toFixed(2), riskUsd: +(units * perContract).toFixed(2) };
}

// ── Safety gate ───────────────────────────────────────────────────────────────
function roundToTick(price, tick) { return Math.round(price / tick) * tick; }

const contractIdCache = {};
async function contractIdFor(symbol) {
  const c = CONTRACTS[symbol];
  if (!contractIdCache[c.name]) {
    const found = await api(`/contract/find?name=${c.name}`);
    if (!found?.id) throw new Error(`Contract ${c.name} not found — roll needed`);
    contractIdCache[c.name] = found.id;
  }
  return contractIdCache[c.name];
}

export function assertOrderSafety({ symbol, direction, units, entry, slPrice, tpPrice }) {
  const c = CONTRACTS[symbol];
  if (!c) throw new Error(`No contract mapping for ${symbol}`);
  if (!slPrice || !tpPrice) throw new Error('NEVER-NAKED: SL and TP are both required');
  if (!Number.isInteger(units) || units < 1) throw new Error(`units must be a whole contract count, got ${units}`);
  if (units > MAX_CONTRACTS) throw new Error(`units ${units} > cap ${MAX_CONTRACTS}`);
  const day = new Date().getUTCDay();
  if (day === 6 || day === 0) throw new Error('Weekend — CME closed / no entries');
  if (new Date().getUTCHours() >= ENTRY_CUTOFF_UTC) throw new Error(`Past entry cutoff ${ENTRY_CUTOFF_UTC}:00 UTC (flat by 4:59pm ET is forced)`);
  const slDist = Math.abs(entry - slPrice);
  if (slDist < c.tick * 2) throw new Error(`SL distance ${slDist} too tight (< 2 ticks)`);
  const riskUsd = slDist * c.pointValue * units;
  if (riskUsd > MAX_RISK_USD) throw new Error(`Risk $${riskUsd.toFixed(0)} > cap $${MAX_RISK_USD} (1 contract SL too wide — skip this signal)`);
  const dirOk = direction === 'long' ? (slPrice < entry && tpPrice > entry) : (slPrice > entry && tpPrice < entry);
  if (!dirOk) throw new Error('SL/TP on wrong side of entry for direction');
  return { riskUsd };
}

// ── Order placement ───────────────────────────────────────────────────────────
// Market entry → poll for the futures fill price → OCO bracket at fill ± the
// signal's distances → verify both bracket legs are working.
export async function placeOrder({ symbol, direction, units, entry, tpPrice, slPrice }) {
  const { riskUsd } = assertOrderSafety({ symbol, direction, units, entry, slPrice, tpPrice });
  const a = await getAccount();
  const c = CONTRACTS[symbol];
  const cid = await contractIdFor(symbol);
  const slDist = Math.abs(entry - slPrice);
  const tpDist = Math.abs(entry - tpPrice);
  const action = direction === 'long' ? 'Buy' : 'Sell';
  const opp = direction === 'long' ? 'Sell' : 'Buy';

  // Anti-stack: never add to an existing position in this contract
  const existing = (await api('/position/list')).find(p => p.accountId === a.id && p.contractId === cid && p.netPos !== 0);
  if (existing) throw new Error(`Anti-stack: already ${existing.netPos} in ${c.name}`);

  // Drawdown-headroom guard: estimate the trailing floor from the intraday
  // peak (conservative — the real floor ratchets on EOD balances only, so the
  // estimate is never BELOW the true floor) and refuse entries that could put
  // the account within reach of it. Default $300 ≈ two max-loss trades spare.
  const MIN_HEADROOM = +(process.env.TVO_MIN_HEADROOM || 300);
  const eq = await getEquity();
  const rs = await getRiskStatus();
  const floorEst = Math.min((rs.peakNetLiq ?? eq.equity) - (rs.trailingMaxDrawdown ?? 1000), rs.floorLocksAt ?? Infinity);
  const headroom = eq.equity - floorEst;
  if (headroom - riskUsd < MIN_HEADROOM) {
    throw new Error(`DD headroom too low: equity ${eq.equity} vs floor≈${floorEst} leaves $${headroom.toFixed(0)}; trade risks $${riskUsd.toFixed(0)}, need $${MIN_HEADROOM} spare`);
  }

  console.log(`[tvo] entry ${action} ${units}x ${c.name} (slDist=${slDist.toFixed(2)} tpDist=${tpDist.toFixed(2)} risk=$${riskUsd.toFixed(0)})`);
  const res = await api('/order/placeorder', {
    accountSpec: a.name, accountId: a.id, action, symbol: c.name,
    orderQty: units, orderType: 'Market', isAutomated: true,
  });
  if (res.failureReason || res.failureText) {
    throw new Error(`placeorder rejected: ${res.failureReason || ''} ${res.failureText || ''}`);
  }

  // Poll for the fill (fast — the naked window must stay short)
  let fillPrice = null;
  for (let i = 0; i < 20 && fillPrice == null; i++) {
    await new Promise(r => setTimeout(r, 500));
    const pos = (await api('/position/list')).find(p => p.accountId === a.id && p.contractId === cid && p.netPos !== 0);
    if (pos) fillPrice = pos.netPrice;
  }
  if (fillPrice == null) {
    try { await api('/order/cancelorder', { orderId: res.orderId, isAutomated: true }); } catch {}
    throw new Error('Market entry not filled within 10s — order cancelled');
  }

  // OCO bracket at futures fill ± distances (basis-free)
  const sl = roundToTick(direction === 'long' ? fillPrice - slDist : fillPrice + slDist, c.tick);
  const tp = roundToTick(direction === 'long' ? fillPrice + tpDist : fillPrice - tpDist, c.tick);
  let oco;
  try {
    oco = await api('/order/placeoco', {
      accountSpec: a.name, accountId: a.id, action: opp, symbol: c.name,
      orderQty: units, orderType: 'Limit', price: tp, isAutomated: true,
      other: { action: opp, orderType: 'Stop', stopPrice: sl },
    });
    if (oco.failureReason || oco.failureText) throw new Error(`${oco.failureReason || ''} ${oco.failureText || ''}`);
  } catch (e) {
    console.error(`[tvo] EMERGENCY: filled @${fillPrice} but OCO bracket failed (${e.message}) — liquidating`);
    await liquidateContract(cid);
    throw new Error(`Bracket placement failed — position liquidated (never-naked): ${e.message}`);
  }

  // Verify both legs are actually working (up to ~10s)
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const working = (await getWorkingOrders()).filter(o => o.action === opp && o.contractId === cid);
    if (working.length >= 2) {
      console.log(`[tvo] VERIFIED: ${action} ${units}x ${c.name} @${fillPrice}, SL ${sl} / TP ${tp} both working`);
      return { ok: true, orderId: res.orderId, fillPrice, sl, tp, riskUsd };
    }
  }
  console.error('[tvo] EMERGENCY: bracket legs not verified working — liquidating');
  await liquidateContract(cid);
  await cancelAllWorking();
  throw new Error('Bracket verification failed — position liquidated (never-naked)');
}

async function liquidateContract(contractId) {
  const a = await getAccount();
  return api('/order/liquidateposition', { accountId: a.id, contractId, admin: false, isAutomated: true });
}

export async function cancelAllWorking() {
  const working = await getWorkingOrders();
  for (const o of working) {
    try { await api('/order/cancelorder', { orderId: o.id, isAutomated: true }); } catch (e) { console.error(`[tvo] cancel ${o.id}: ${e.message}`); }
  }
  return working.length;
}

export async function closeAllPositions() {
  const pos = await getPositions();
  for (const p of pos) {
    console.log(`[tvo] liquidating ${p.contractName} netPos=${p.netPos}`);
    await liquidateContract(p.contractId);
  }
  const cancelled = await cancelAllWorking();
  return { closed: pos.length, cancelled };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--test-token')) {
  const t = await fetchTokenFromTab();
  console.log(JSON.stringify({ tokenLen: t.token.length, expires: new Date(t.expiration).toISOString(), userId: t.userId }));
  process.exit(0);
}
if (argv.includes('--status')) {
  const a = await getAccount();
  const eq = await getEquity();
  const risk = await getRiskStatus();
  const pos = await getPositions();
  const working = await getWorkingOrders();
  const contracts = await validateContracts();
  console.log(JSON.stringify({
    account: { id: a.id, name: a.name, active: a.active },
    equity: eq.equity, balance: eq.balance,
    risk,
    positions: pos.map(p => ({ c: p.contractName, netPos: p.netPos, price: p.netPrice })),
    workingOrders: working.map(o => ({ id: o.id, action: o.action, status: o.ordStatus })),
    contracts: Object.fromEntries(Object.entries(contracts).map(([k, v]) => [k, v.name + '#' + v.contractId])),
  }, null, 1));
  process.exit(0);
}
if (argv.includes('--flatten')) {
  console.log(JSON.stringify(await closeAllPositions()));
  process.exit(0);
}
