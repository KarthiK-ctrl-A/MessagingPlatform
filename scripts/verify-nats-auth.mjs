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
  // Live events: the worker may publish them and the gateway may receive them.
  const eventSubject = 'messaging.v1.event.message-created';
  const events = gateway.subscribe(eventSubject, { max: 1 });
  await gateway.flush();
  worker.publish(eventSubject, new TextEncoder().encode('event-probe'));
  await worker.flush();
  const received = await Promise.race([
    (async () => { for await (const message of events) return new TextDecoder().decode(message.data); })(),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000)),
  ]);
  if (received !== 'event-probe') {
    throw new Error('Live events are not permitted: run `npm run nats:update-permissions` and restart the services');
  }
  // The worker must not be able to impersonate the gateway by publishing requests.
  const ownRequests = worker.subscribe('messaging.v1.query.conversations', { max: 1 });
  await worker.flush();
  worker.publish('messaging.v1.query.conversations', new TextEncoder().encode('forged'));
  await worker.flush().catch(() => undefined);
  const forged = await Promise.race([
    (async () => { for await (const _ of ownRequests) return 'delivered'; })(),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 1000)),
  ]);
  ownRequests.unsubscribe();
  if (forged !== 'blocked') throw new Error('Worker identity can publish request subjects; permissions are too broad');

  for (const credentials of [{}, { user: 'gateway', pass: 'local-gateway-only' }]) {
    let rejected = false;
    try {
      const connection = await connect({ servers: server, ...tls, ...credentials, timeout: 1000, maxReconnectAttempts: 0 });
      await connection.close();
    } catch { rejected = true; }
    if (!rejected) throw new Error('Broker accepted an unauthenticated or legacy-password connection');
  }
  console.log('NATS JWT/NKey request-reply and live events passed; worker request forgery, anonymous and legacy-password connections rejected.');
} finally {
  await gateway?.drain();
  await worker.drain();
}
