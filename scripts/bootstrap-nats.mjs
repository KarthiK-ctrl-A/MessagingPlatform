import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAccount, encodeOperator, encodeUser, fmtCreds } from '@nats-io/jwt';
import { createAccount, createOperator, createUser } from '@nats-io/nkeys';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve(repo, 'secrets/nats');
await mkdir(output, { recursive: true });
if ((await readdir(output)).length !== 0) {
  throw new Error(`Refusing to replace existing NATS identities in ${output}. Back them up and rotate deliberately.`);
}

const operator = createOperator();
const account = createAccount();
const system = createAccount();
const gateway = createUser();
const worker = createUser();
const requestSubjects = [
  'messaging.v1.query.care-contacts',
  'messaging.v1.command.create-conversation',
  'messaging.v1.command.open-current-doctor',
  'messaging.v1.query.conversations',
  'messaging.v1.command.send',
  'messaging.v1.query.history',
  'messaging.v1.query.auth-probe',
];
const accountLimits = {
  imports: -1, exports: -1, wildcards: true, conn: -1, leaf: -1,
  data: -1, payload: 65536, subs: -1, disallow_bearer: true,
};
const operatorJwt = await encodeOperator('MESSAGING', operator, { system_account: system.getPublicKey() });
const accountJwt = await encodeAccount('MESSAGING', account,
  { disallow_bearer: true, limits: accountLimits }, { signer: operator });
const systemJwt = await encodeAccount('SYSTEM', system,
  { limits: accountLimits }, { signer: operator });
const gatewayJwt = await encodeUser('gateway', gateway, account, {
  pub: { allow: requestSubjects },
  sub: { allow: ['_INBOX.gateway.>'] },
  payload: 65536,
});
const workerJwt = await encodeUser('worker', worker, account, {
  sub: { allow: requestSubjects },
  resp: { max: 1, ttl: 10_000_000_000 },
  payload: 65536,
});

const serverConfig = `# Local JWT/NKey broker. Add TLS and private connectivity before cross-network deployment.\n` +
  `server_name: messaging-local\nlisten: 0.0.0.0:4222\nmax_payload: 65536\n` +
  `operator: ${operatorJwt}\nsystem_account: ${system.getPublicKey()}\nresolver: MEMORY\n` +
  `resolver_preload {\n  ${account.getPublicKey()}: ${accountJwt}\n  ${system.getPublicKey()}: ${systemJwt}\n}\n`;

for (const [name, content] of [
  ['server.conf', serverConfig],
  ['gateway.creds', fmtCreds(gatewayJwt, gateway)],
  ['worker.creds', fmtCreds(workerJwt, worker)],
  ['operator.seed', operator.getSeed()],
  ['account.seed', account.getSeed()],
  ['system.seed', system.getSeed()],
]) {
  await writeFile(join(output, name), content, { flag: 'wx', mode: 0o600 });
}
console.log(`Generated NATS operator/account/user credentials in ${output}`);
console.log('Only mount each service\'s own .creds file; protect the operator, account, and system seeds separately.');
