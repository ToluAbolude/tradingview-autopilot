import { openSync, closeSync, writeFileSync, readFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Single-host lock. Never steal a lock: a crashed holder needs operator reconciliation. */
export function acquireExecutorLock(file) {
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() });
  let fd;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`EXECUTOR_LOCKED: ${file} exists; verify its owner and reconcile broker orders before removing a stale lock`);
    }
    throw error;
  }
  try {
    writeFileSync(fd, owner);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  // If writing failed, retain the lock so another process cannot trade with
  // uncertain state. Normal exit only releases the exact token we acquired.
  return () => {
    try {
      if (readFileSync(file, 'utf8') === owner) unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}

/** Atomic replacement while holding the executor lock. No partially written ledger. */
export function writeExecutionState(file, ledger) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(ledger));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function readExecutionState(file) {
  let ledger;
  try { ledger = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)
      || Object.values(ledger).some(ts => !Number.isFinite(ts) || ts <= 0)) {
    throw new Error('EXECUTOR_STATE_INVALID: reconcile the attempt ledger before placing orders');
  }
  return ledger;
}

/** Persist BEFORE the callback: an ambiguous fill or process crash cannot re-arm this signal. */
export async function attemptSignalOnce(file, ledger, key, now, attempt) {
  if (Object.hasOwn(ledger, key)) return false;
  const next = { ...ledger, [key]: now };
  writeExecutionState(file, next);
  Object.assign(ledger, next);
  await attempt();
  return true;
}
