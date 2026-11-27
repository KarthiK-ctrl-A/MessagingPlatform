import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, credsAuthenticator } from '@nats-io/transport-node';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const server = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
// When the broker has TLS enabled, verify it against the configured CA.
const tls = process.env.NATS_TLS_CA_FILE ? { tls: { caFile: process.env.NATS_TLS_CA_FILE } } : {};
const options = async (name) => ({
  servers: server,
  ...tls,
  authenticator: credsAuthenticator(await readFile(resolve(root, `secrets/nats/${name}.creds`))),
  ...(name === 'gateway' ? { inboxPrefix: '_INBOX.gateway' } : {}),
  timeout: 2000,
  maxReconnectAttempts: 0,
});

const worker = await connect(await options('worker'));
let gateway;
try {
  gateway = await connect(await options('gateway'));
  const subject = 'messaging.v1.query.auth-probe';
  const subscription = worker.subscribe(subject, { queue: 'messaging-workers' });
  try {
    await worker.flush();
    const response = (async () => {
      for await (const message of subscription) {
        message.respond(new TextEncoder().encode('ok'));
        return;
      }
    })();
    const reply = await gateway.request(subject, new TextEncoder().encode('probe'), { timeout: 3000 });
    if (new TextDecoder().decode(reply.data) !== 'ok') throw new Error('Unexpected NATS reply');
    await response;
  } finally {
    subscription.unsubscribe();
  }
  for (const credentials of [{}, { user: 'gateway', pass: 'local-gateway-only' }]) {
    let rejected = false;
    try {
      const connection = await connect({ servers: server, ...tls, ...credentials, timeout: 1000, maxReconnectAttempts: 0 });
      await connection.close();
    } catch { rejected = true; }
    if (!rejected) throw new Error('Broker accepted an unauthenticated or legacy-password connection');
  }
  console.log('NATS JWT/NKey request-reply passed; anonymous and legacy-password connections rejected.');
} finally {
  await gateway?.drain();
  await worker.drain();
}
