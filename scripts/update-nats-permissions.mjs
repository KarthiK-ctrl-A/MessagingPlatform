import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeUser, fmtCreds } from '@nats-io/jwt';
import { fromSeed } from '@nats-io/nkeys';
import { userPermissions } from './nats-permissions.mjs';

// Re-issues the gateway and worker user JWTs with the current permissions,
// keeping their existing NKeys and account. The broker config is unchanged
// (it trusts the account, not individual users), so only the two services
// need a restart to pick up the new .creds files.
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = resolve(repo, process.env.NATS_SECRETS_DIR ?? 'secrets/nats');
const account = fromSeed(new TextEncoder().encode((await readFile(join(directory, 'account.seed'), 'utf8')).trim()));

for (const name of ['gateway', 'worker']) {
  const path = join(directory, `${name}.creds`);
  const creds = await readFile(path, 'utf8');
  const seed = /-----BEGIN USER NKEY SEED-----\s+(\S+)\s+------END USER NKEY SEED------/.exec(creds)?.[1];
  if (!seed) throw new Error(`Cannot read the user seed in ${path}`);
  const user = fromSeed(new TextEncoder().encode(seed));
  const jwt = await encodeUser(name, user, account, userPermissions[name]);
  // Rewrite in place (same file) so Docker single-file bind mounts see the change.
  await writeFile(path, fmtCreds(jwt, user), { mode: 0o600 });
  console.log(`Updated ${name}.creds permissions`);
}
console.log('Recreate the services to load the new credentials, e.g. `docker compose up -d --force-recreate api-gateway messaging-service`.');
