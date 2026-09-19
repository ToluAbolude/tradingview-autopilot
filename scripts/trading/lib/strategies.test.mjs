// Tests for the strategy registry and the exposure policy — run: node --test scripts/trading/lib/
import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestErrors, loadStrategies, bracket, gateOn, readManifests } from './strategies.mjs';
import { exposurePolicy, exposureVerdict, DEFAULT_EXPOSURE } from './exposure.mjs';

const good = {
  id: 'demo_orb', enabled: true, mode: 'paper', account: '2131377', logic: { module: 'orb' },
  instruments: ['NAS100'], timeframe: '15', target: { r: 2 }, risk: { per_trade_pct: 0.1 },
};

test('a well-formed manifest has no errors', () => {
  assert.deepEqual(manifestErrors(good, 'demo_orb'), []);
});

test('manifest mistakes are caught before anything trades', () => {
  const errs = change => manifestErrors({ ...good, ...change }, 'demo_orb').join(' | ');
  assert.match(errs({ timeframe: '60m' }), /timeframe/);
  assert.match(errs({ timeframe: 60 }), /timeframe/);
  assert.match(errs({ instruments: [] }), /instruments/);
  assert.match(errs({ instruments: ['eurusd'] }), /instruments/);
  assert.match(errs({ risk: { per_trade_pct: 5 } }), /per_trade_pct/);
  assert.match(errs({ target: {} }), /target\.r/);
  assert.match(errs({ mode: 'yolo' }), /mode/);
  assert.match(errs({ account: 2131377 }), /account/);
  assert.match(errs({ riskk: 1 }), /unknown field "riskk"/);
  assert.match(errs({ logic: { module: 'orb', file: 'logic.mjs' } }), /exactly one/);
  assert.match(errs({ logic: { file: '../../broker_ctrader.mjs' } }), /logic\.file/);
  assert.match(manifestErrors(good, 'other_folder').join(), /folder name/);
});

test('gate opt-outs and bracket settings are validated', () => {
  const errs = change => manifestErrors({ ...good, ...change }, 'demo_orb').join(' | ');
  assert.deepEqual(manifestErrors({ ...good, gates: { plan: false, fib_veto: false, daily_eod: false },
    target: { r: 4, own: false }, risk: { per_trade_pct: 0.5, stop_mult: 1.5 } }, 'demo_orb'), []);
  assert.match(errs({ gates: { stop_floor: false } }), /not a gate/);      // safety gates are never optional
  assert.match(errs({ gates: { plan: 'no' } }), /true or false/);
  assert.match(errs({ risk: { per_trade_pct: 0.1, stop_mult: 0.5 } }), /stop_mult/);
  assert.match(errs({ target: { r: 2, own: 'yes' } }), /target\.own/);
  assert.equal(gateOn(good, 'plan'), true);                                 // on unless opted out
  assert.equal(gateOn({ gates: { plan: false } }, 'plan'), false);
});

test('bracket reproduces the backtest: stop x stop_mult, target r x the NEW risk', () => {
  const sig = { dir: 'long', entry: 100, sl: 98, tp: 105 };
  const m = (target, stop_mult) => ({ target, risk: { per_trade_pct: 0.1, stop_mult } });
  assert.deepEqual(bracket(sig, m({ r: 2 }, 1)), { sl: 98, tp: 105, risk: 2 });              // own target by default
  assert.deepEqual(bracket(sig, m({ r: 2, own: false }, 1.5)), { sl: 97, tp: 106, risk: 3 }); // 2R of the WIDER stop
  assert.deepEqual(bracket(sig, m({ r: 4, own: false }, 1.5)), { sl: 97, tp: 112, risk: 3 }); // the gold pick's shape
  assert.deepEqual(bracket({ ...sig, tp: 99 }, m({ r: 2 })), { sl: 98, tp: 104, risk: 2 });  // own target on the wrong side
  assert.deepEqual(bracket({ dir: 'short', entry: 100, sl: 102 }, m({ r: 3 })), { sl: 102, tp: 94, risk: 2 });
});

test('every manifest in scripts/trading/strategies loads', async () => {
  const { strategies, errors } = await loadStrategies();
  assert.deepEqual(errors, []);
  assert.ok(strategies.length > 0);
  const ids = strategies.map(s => s.manifest.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(readManifests().size, strategies.length);   // the settings-only reader agrees
});

test('default exposure is the old rule: one position per symbol, account-wide', () => {
  const policy = exposurePolicy({}, '2131377');
  assert.deepEqual(policy, DEFAULT_EXPOSURE);
  assert.equal(exposureVerdict({ positions: [], dir: 'long', label: 'a', policy }).ok, true);
  assert.equal(exposureVerdict({ positions: [{ direction: 'long', label: '' }], dir: 'long', label: 'a', policy }).ok, false);
});

test('a raised cap lets a second strategy share the symbol, but not the same one twice', () => {
  const policy = exposurePolicy({ exposure: { 2131377: { maxPositionsPerSymbol: 3 } } }, '2131377');
  const open = [{ direction: 'long', label: 'a' }];
  assert.equal(exposureVerdict({ positions: open, dir: 'long', label: 'b', policy }).ok, true);
  assert.match(exposureVerdict({ positions: open, dir: 'long', label: 'a', policy }).reason, /already holds/);
  assert.match(exposureVerdict({ positions: open, dir: 'short', label: 'b', policy }).reason, /opposite/);
  const hedged = exposurePolicy({ exposure: { default: { maxPositionsPerSymbol: 3, allowOppositeDirections: true } } }, '2118552');
  assert.equal(exposureVerdict({ positions: open, dir: 'short', label: 'b', policy: hedged }).ok, true);
});

test('bad exposure values fall back to the safe default', () => {
  const p = exposurePolicy({ exposure: { default: { maxPositionsPerSymbol: '5', allowOppositeDirections: 'yes' } } }, 'x');
  assert.equal(p.maxPositionsPerSymbol, 1);
  assert.equal(p.allowOppositeDirections, false);
});
