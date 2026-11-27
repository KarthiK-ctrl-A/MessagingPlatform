import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSession } from '../persistence/database-session';
import { OutboxRelay } from './outbox-relay.service';
import type { EventPublisher } from './event-publisher';

const publisher: EventPublisher = { publish: async () => undefined, flush: async () => undefined };

test('wake-ups during a drain collapse into a single follow-up pass', async () => {
  let passes = 0;
  let release!: () => void;
  const db = { query: async () => ({ rows: [{ pending: true }] }), transaction: async () => {
    passes++;
    if (passes === 1) await new Promise<void>((resolve) => { release = resolve; });
    return 0;
  } } as unknown as DatabaseSession;
  const relay = new OutboxRelay(db, publisher, () => { throw new Error('not used'); });
  (relay as unknown as { running: boolean }).running = true;
  relay.wake();
  for (let i = 0; i < 10; i++) relay.wake();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(passes, 2);
  await relay.onModuleDestroy();
});

test('the relay stays off until the outbox migration is installed', async () => {
  let listened = false;
  const db = { query: async () => ({ rows: [{ installed: false }] }) } as unknown as DatabaseSession;
  const relay = new OutboxRelay(db, publisher, () => { listened = true; throw new Error('should not listen'); });
  await relay.onApplicationBootstrap();
  assert.equal(listened, false);
  relay.wake(); // no-op while disabled
});
