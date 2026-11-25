import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dist = resolve(process.cwd(), 'dist');
const tests = [];
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (entry.isFile() && entry.name.endsWith('.test.js')) tests.push(path);
  }
}
scan(dist);
if (tests.length === 0) {
  console.log('No compiled tests in this workspace');
  process.exit(0);
}
const result = spawnSync(process.execPath, ['--test', ...tests.sort()], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
