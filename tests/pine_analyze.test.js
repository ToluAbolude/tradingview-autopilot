/**
 * Offline tests for the production Pine static analyzer.
 * Run: node --test tests/pine_analyze.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyze as analyzeSource } from '../src/core/pine.js';

function analyze(source) {
  const result = analyzeSource({ source });
  assert.equal(result.success, true);
  assert.equal(result.issue_count, result.diagnostics.length);
  return result.diagnostics;
}

describe('pine_analyze — static analysis', () => {
  it('clean v6 script — no issues', () => {
    const diags = analyze(`//@version=6
indicator("Test", overlay=true)
a = array.from(1, 2, 3)
val = array.get(a, 1)
plot(close)`);
    assert.equal(diags.length, 0);
  });

  it('array.get out of bounds', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(1, 2, 3)
val = array.get(a, 5)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'error');
    assert.ok(diags[0].message.includes('out of bounds'));
    assert.ok(diags[0].message.includes('index 5'));
    assert.ok(diags[0].message.includes('size is 3'));
  });

  it('array.get negative index', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(1, 2)
val = array.get(a, -1)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'error');
  });

  it('array.set out of bounds', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.new_float(3)
array.set(a, 10, 99.0)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'error');
    assert.ok(diags[0].message.includes('array.set'));
  });

  it('array.get valid index — no issue', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(10, 20, 30, 40, 50)
val = array.get(a, 4)`);
    assert.equal(diags.length, 0);
  });

  it('.first() on empty array', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.new_float(0)
x = a.first()`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'warning');
    assert.ok(diags[0].message.includes('empty array'));
  });

  it('.last() on empty array', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.new_float(0)
x = a.last()`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'warning');
  });

  it('.first() on non-empty array — no issue', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(1, 2, 3)
x = a.first()`);
    assert.equal(diags.length, 0);
  });

  it('strategy.entry without strategy() declaration', () => {
    const diags = analyze(`//@version=6
indicator("Test")
strategy.entry("Long", strategy.long)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'error');
    assert.ok(diags[0].message.includes('no strategy() declaration'));
  });

  it('strategy.entry WITH strategy() — no issue', () => {
    const diags = analyze(`//@version=6
strategy("Test", overlay=true)
if close > open
    strategy.entry("Long", strategy.long)`);
    assert.equal(diags.length, 0);
  });

  it('old version v3 warning', () => {
    const diags = analyze(`//@version=3
study("Test")
plot(close)`);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].severity, 'info');
    assert.ok(diags[0].message.includes('v3'));
    assert.ok(diags[0].message.includes('upgrading'));
  });

  it('v5 — no version warning', () => {
    const diags = analyze(`//@version=5
indicator("Test")
plot(close)`);
    assert.equal(diags.length, 0);
  });

  it('multiple issues at once', () => {
    const diags = analyze(`//@version=6
indicator("Test")
a = array.from(1, 2)
b = array.new_float(0)
x = array.get(a, 5)
y = b.first()
strategy.entry("Long", strategy.long)`);
    assert.ok(diags.length >= 3, `Expected >= 3 issues, got ${diags.length}`);
    const errors = diags.filter(d => d.severity === 'error');
    const warnings = diags.filter(d => d.severity === 'warning');
    assert.ok(errors.length >= 2, 'Should have OOB error + strategy error');
    assert.ok(warnings.length >= 1, 'Should have empty array warning');
  });
});
