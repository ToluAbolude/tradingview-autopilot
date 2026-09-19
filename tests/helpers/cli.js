import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../src/cli/index.js', import.meta.url));

export function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  }
}
