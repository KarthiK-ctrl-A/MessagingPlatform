import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCursor, encodeCursor, requestSchema } from './index';

test('cursor round trips and rejects invalid input', () => {
  const value = { createdAt: '2026-11-23T12:00:00Z', id: 'a248c773-1cb0-4dad-b109-dfe48a094c00' };
  assert.deepEqual(decodeCursor(encodeCursor(value)), value);
  assert.throws(() => decodeCursor('%%%'), /Invalid cursor/);
});

test('request contract rejects unknown fields', () => {
  const result = requestSchema.safeParse({
    version: 1, requestId: 'a248c773-1cb0-4dad-b109-dfe48a094c00',
    issuedAt: 1, expiresAt: 2, actorId: 'a248c773-1cb0-4dad-b109-dfe48a094c00',
    userJwt: 'x'.repeat(20), operation: 'listConversations', variables: { limit: 10, injected: true },
  });
  assert.equal(result.success, false);
});
