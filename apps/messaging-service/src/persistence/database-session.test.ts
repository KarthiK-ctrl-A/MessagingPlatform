import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { DomainError } from '../domain/domain-error';
import { toDomainError } from './database-errors';
import { DatabaseSession } from './database-session';

function fakeClient(failOn: Set<string>) {
  const statements: string[] = [];
  let released: unknown = 'not released';
  const client = {
    query: async (text: string) => {
      statements.push(text.split(' ')[0]);
      if (failOn.has(text.split(' ')[0])) throw Object.assign(new Error(`${text} failed`), { code: '08006' });
      return { rows: [] };
    },
    release: (error?: unknown) => { released = error; },
  } as unknown as PoolClient;
  return { client, statements, released: () => released };
}

function sessionWith(client: PoolClient) {
  const pool = Object.assign(new EventEmitter(), { connect: async () => client }) as unknown as Pool;
  return { session: new DatabaseSession(pool), pool };
}

test('a successful action commits and returns the client to the pool', async () => {
  const fake = fakeClient(new Set());
  const result = await sessionWith(fake.client).session.asActor('actor', 'op', 'req', async () => 42);
  assert.equal(result, 42);
  assert.deepEqual(fake.statements, ['BEGIN', 'SELECT', 'COMMIT']);
  assert.equal(fake.released(), undefined);
});

test('a broken connection is destroyed instead of being returned to the pool', async () => {
  const fake = fakeClient(new Set(['ROLLBACK']));
  await assert.rejects(
    sessionWith(fake.client).session.asActor('actor', 'op', 'req', async () => { throw new Error('action failed'); }),
    /action failed/, // the original error is preserved, not the rollback error
  );
  assert.ok(fake.released() instanceof Error);
});

test('a SQL authorization failure surfaces as a typed domain error', async () => {
  const fake = fakeClient(new Set());
  await assert.rejects(
    sessionWith(fake.client).session.asActor('actor', 'op', 'req', async () => {
      throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
    }),
    { code: 'FORBIDDEN' },
  );
  assert.equal(fake.released(), undefined);
});

test('an idle client error is handled instead of crashing the process', () => {
  const { pool } = sessionWith(fakeClient(new Set()).client);
  assert.ok((pool as unknown as EventEmitter).listenerCount('error') > 0);
  assert.doesNotThrow(() => (pool as unknown as EventEmitter).emit('error', new Error('terminating connection')));
});

test('database errors map by SQLSTATE, with a fallback for pre-migration messages', () => {
  const error = (code: string, message = '') => Object.assign(new Error(message), { code });
  assert.deepEqual(pick(toDomainError(error('MP400', 'Invalid recipient'))), ['VALIDATION', 'Invalid recipient']);
  assert.deepEqual(pick(toDomainError(error('MP403', 'Sender is not a conversation participant'))), ['FORBIDDEN', 'Sender is not a conversation participant']);
  assert.deepEqual(pick(toDomainError(error('P0002'))), ['NOT_FOUND', 'Conversation not found']);
  assert.deepEqual(pick(toDomainError(error('P0001', 'Current doctor assignment required'))), ['FORBIDDEN', 'Not permitted for this conversation']);
  assert.deepEqual(pick(toDomainError(error('P0001', 'Recipient is not the current doctor or patient'))), ['VALIDATION', 'Invalid recipient']);
  assert.equal(toDomainError(error('08006', 'connection failure')), undefined);
  assert.equal(toDomainError(new Error('no code')), undefined);
});

function pick(error: DomainError | undefined) { return error ? [error.code, error.message] : undefined; }
