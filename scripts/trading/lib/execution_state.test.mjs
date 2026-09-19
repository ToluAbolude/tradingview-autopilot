import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireExecutorLock, readExecutionState, attemptSignalOnce } from './execution_state.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'executor-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a separate process cannot acquire an executor lock held by this process', t => {
  const file = join(fixture(t), 'executor.lock');
  const release = acquireExecutorLock(file);
  const code = `import { acquireExecutorLock } from ${JSON.stringify(new URL('./execution_state.mjs', import.meta.url).href)};
    try { acquireExecutorLock(process.argv[1]); process.exitCode = 1; }
    catch (e) { if (!e.message.includes('EXECUTOR_LOCKED')) throw e; }`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code, file]);
  release();
  acquireExecutorLock(file)();
  assert.equal(existsSync(file), false);
});

test('corrupt/stale locks are not silently stolen and release checks ownership', t => {
  const file = join(fixture(t), 'executor.lock');
  const release = acquireExecutorLock(file);
  writeFileSync(file, 'different owner');
  release();
  assert.equal(readFileSync(file, 'utf8'), 'different owner');
  assert.throws(() => acquireExecutorLock(file), /EXECUTOR_LOCKED/);
});

test('attempt is durable before broker call and survives an ambiguous fill failure', async t => {
  const file = join(fixture(t), 'state.json');
  const ledger = readExecutionState(file);
  let calls = 0;
  await assert.rejects(attemptSignalOnce(file, ledger, 'signal@timestamp', 1234, async () => {
    calls++;
    assert.equal(readExecutionState(file)['signal@timestamp'], 1234);
    throw new Error('response lost after fill');
  }), /response lost/);
  const restarted = readExecutionState(file);
  assert.equal(await attemptSignalOnce(file, restarted, 'signal@timestamp', 1235, async () => { calls++; }), false);
  assert.equal(calls, 1);
});

test('persistence failure prevents execution, and a corrupt ledger blocks recovery', async t => {
  const dir = fixture(t);
  let called = false;
  await assert.rejects(attemptSignalOnce(join(dir, 'missing', 'state.json'), {}, 'signal', 1234, async () => { called = true; }));
  assert.equal(called, false);
  const file = join(dir, 'state.json');
  for (const content of ['{broken', 'null', '[]', '{"signal":"not a timestamp"}']) {
    writeFileSync(file, content);
    assert.throws(() => readExecutionState(file));
  }
});
