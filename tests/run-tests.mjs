/**
 * Select test files explicitly so npm test stays offline on every platform.
 * Avoid shell glob expansion, which differs between Unix and Windows.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const external = args.includes('--external');
const nodeArgs = args.filter(arg => arg !== '--external');
const directories = external
  ? ['tests/external']
  : ['tests', 'scripts/trading/lib', 'scripts/trading/institutional'];

const files = directories.flatMap(directory =>
  readdirSync(join(root, directory), { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.test\.(?:mjs|js)$/.test(entry.name)
      && entry.name !== 'e2e.test.js')
    .map(entry => join(directory, entry.name)),
).sort();

if (files.length === 0) throw new Error('No test files found');
console.log(`Running ${external ? 'external API' : 'offline'} tests (${files.length} files).`);
const result = spawnSync(process.execPath, ['--test', ...nodeArgs, ...files], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
