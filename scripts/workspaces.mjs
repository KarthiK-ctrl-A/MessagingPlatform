import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const task = process.argv[2];
if (task !== 'build' && task !== 'test') throw new Error('Usage: node scripts/workspaces.mjs build|test');
const root = process.cwd();
const workspaces = new Map();
for (const group of ['packages', 'apps']) {
  for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, group, entry.name, 'package.json');
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (workspaces.has(data.name)) throw new Error(`Duplicate workspace ${data.name}`);
      workspaces.set(data.name, data);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}
const visited = new Set();
const active = new Set();
const ordered = [];
function visit(name) {
  if (visited.has(name)) return;
  if (active.has(name)) throw new Error(`Workspace dependency cycle at ${name}`);
  active.add(name);
  const workspace = workspaces.get(name);
  for (const dependency of Object.keys({ ...workspace.dependencies, ...workspace.devDependencies }).sort()) {
    if (workspaces.has(dependency)) visit(dependency);
  }
  active.delete(name);
  visited.add(name);
  ordered.push(workspace);
}
for (const name of [...workspaces.keys()].sort()) visit(name);
for (const workspace of ordered) {
  if (!workspace.scripts?.[task]) continue;
  console.log(`\n[${task}] ${workspace.name}`);
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this script through npm so npm_execpath is available');
  const result = spawnSync(process.execPath, [npmCli, 'run', task, '--workspace', workspace.name], {
    cwd: root, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
