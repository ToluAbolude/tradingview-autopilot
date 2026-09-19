/**
 * Offline CLI tests for help, routing, analysis, and exit codes.
 * Run: npm run test:cli
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runCli as run } from './helpers/cli.js';

describe('CLI — help and routing', () => {
  it('--help shows command list', () => {
    const { stdout, exitCode } = run(['--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
    assert.ok(stdout.includes('status'));
    assert.ok(stdout.includes('pine'));
    assert.ok(stdout.includes('quote'));
  });

  it('-h is same as --help', () => {
    const { stdout, exitCode } = run(['-h']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
  });

  it('no args shows help', () => {
    const { stdout, exitCode } = run([]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
  });

  it('unknown command exits 1', () => {
    const { exitCode, stderr } = run(['nonexistent']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown command'));
  });

  it('pine --help shows subcommands', () => {
    const { stdout, exitCode } = run(['pine', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('get'));
    assert.ok(stdout.includes('set'));
    assert.ok(stdout.includes('compile'));
    assert.ok(stdout.includes('analyze'));
    assert.ok(stdout.includes('check'));
  });

  it('ohlcv --help shows options', () => {
    const { stdout, exitCode } = run(['ohlcv', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('--count'));
    assert.ok(stdout.includes('--summary'));
  });
});

describe('CLI — pine analyze (offline)', () => {
  it('analyzes clean v6 script', () => {
    const source = '//@version=6\nindicator("test")\nplot(close)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.success, true);
    assert.equal(result.issue_count, 0);
  });

  it('detects array out of bounds', () => {
    const source = '//@version=6\nindicator("test")\narr = array.from(1, 2, 3)\nval = array.get(arr, 5)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.issue_count, 1);
    assert.ok(result.diagnostics[0].message.includes('out of bounds'));
  });

  it('detects strategy.entry without strategy()', () => {
    const source = '//@version=6\nindicator("test")\nstrategy.entry("long", strategy.long)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.ok(result.diagnostics.some(d => d.message.includes('strategy()')));
  });

  it('errors without input', () => {
    // When stdin is a TTY (no pipe), analyze should error
    const { exitCode, stderr } = run(['pine', 'analyze']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('No source provided'));
  });

  it('reads --file flag', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tv-cli-test-'));
    const tmpFile = join(tempDir, 'script.pine');
    writeFileSync(tmpFile, '//@version=6\nindicator("test")\nplot(close)');
    try {
      const { stdout, exitCode } = run(['pine', 'analyze', '--file', tmpFile]);
      assert.equal(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.equal(result.success, true);
    } finally {
      unlinkSync(tmpFile);
      rmdirSync(tempDir);
    }
  });
});
