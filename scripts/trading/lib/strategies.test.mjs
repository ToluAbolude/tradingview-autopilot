// Tests for the strategy registry and the exposure policy — run: node --test scripts/trading/lib/
import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestErrors, loadStrategies } from './strategies.mjs';
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

test('every manifest in scripts/trading/strategies loads', async () => {
  const { strategies, errors } = await loadStrategies();
  assert.deepEqual(errors, []);
  assert.ok(strategies.length > 0);
  const ids = strategies.map(s => s.manifest.id);
  assert.equal(new Set(ids).size, ids.length);
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
