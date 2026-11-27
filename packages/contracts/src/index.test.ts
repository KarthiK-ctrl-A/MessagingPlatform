import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCursor, encodeCursor, messageCreatedEventSchema, requestSchema } from './index';

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

test('history requests accept either a before or an after cursor, not both', () => {
  const base = { version: 1, audience: 'messaging-service', requestId: 'a248c773-1cb0-4dad-b109-dfe48a094c00',
    issuedAt: 1, expiresAt: 2, actorId: 'a248c773-1cb0-4dad-b109-dfe48a094c00', userJwt: 'x'.repeat(20), operation: 'listMessages' };
  const conversationId = '98547ca7-98a5-4fdd-a9b8-84ea7986644b';
  assert.equal(requestSchema.safeParse({ ...base, variables: { conversationId, limit: 5, after: 'c' } }).success, true);
  assert.equal(requestSchema.safeParse({ ...base, variables: { conversationId, limit: 5, before: 'c', after: 'c' } }).success, false);
});

test('live events cannot carry message content', () => {
  const id = 'a248c773-1cb0-4dad-b109-dfe48a094c00';
  const event = { audience: 'api-gateway', type: 'message.created', eventId: id, messageId: id, conversationId: id,
    participants: [id, id], occurredAt: '2026-11-27T21:39:30.022123Z', issuedAt: 1, expiresAt: 2 };
  assert.equal(messageCreatedEventSchema.safeParse(event).success, true);
  assert.equal(messageCreatedEventSchema.safeParse({ ...event, content: 'hello' }).success, false);
});
