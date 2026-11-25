import { existsSync, realpathSync, rmSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(fileURLToPath(new URL('../', import.meta.url)));
const cwd = realpathSync(process.cwd());
const within = (root, path) => {
  const remainder = relative(root, path);
  return remainder !== '' && !remainder.startsWith('..' + sep) && remainder !== '..' && !isAbsolute(remainder);
};
if (!within(resolve(repo, 'apps'), cwd) && !within(resolve(repo, 'packages'), cwd)) {
  throw new Error('Build must run inside an apps/* or packages/* workspace');
}
const dist = resolve(cwd, 'dist');
if (existsSync(dist)) {
  const resolvedDist = realpathSync(dist);
  if (!within(cwd, resolvedDist)) throw new Error('Refusing to clean dist outside workspace');
  rmSync(dist, { recursive: true, force: true });
}
const compiler = resolve(repo, 'node_modules', 'typescript', 'bin', 'tsc');
const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.json'], { cwd, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
