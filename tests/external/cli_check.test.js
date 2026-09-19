/**
 * Opt-in CLI tests that POST Pine source to TradingView's compile API.
 * Run: npm run test:external
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCli as run } from '../helpers/cli.js';

describe('CLI — pine check (server compile)', () => {
  it('compiles valid Pine Script', () => {
    const source = '//@version=6\nindicator("test")\nplot(close)';
    const { stdout, exitCode } = run(['pine', 'check'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.success, true);
    assert.equal(result.compiled, true);
  });

  it('returns errors for invalid Pine Script', () => {
    const source = '//@version=6\nindicator("test")\nplot(nonexistent_var)';
    const { stdout, exitCode } = run(['pine', 'check'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.compiled, false);
    assert.ok(result.error_count > 0);
  });
});
