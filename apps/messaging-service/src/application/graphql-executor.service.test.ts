import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphqlExecutorService } from './graphql-executor.service';
import { DomainError } from '../domain/domain-error';
import type { CareContactRepository } from '../persistence/care-contact.repository';
import type { ConversationRepository } from '../persistence/conversation.repository';
import type { MessageRepository } from '../persistence/message.repository';

const actorId = 'a248c773-1cb0-4dad-b109-dfe48a094c00';
const requestId = '07d97fe4-1927-4df6-9ffd-032ff821f67f';
const base = { version: 1, audience: 'messaging-service', requestId, issuedAt: 1, expiresAt: 2, actorId, userJwt: 'token' } as const;

function executor(parts: { conversations?: object; contacts?: object; messages?: object }) {
  return new GraphqlExecutorService(
    (parts.conversations ?? {}) as ConversationRepository,
    (parts.contacts ?? {}) as CareContactRepository,
    (parts.messages ?? {}) as MessageRepository,
  );
}

test('a fixed GraphQL mutation returns the repository result', async () => {
  let seen: unknown[] = [];
  const messages = {
    sendMessage: async (...args: unknown[]) => {
      seen = args;
      const [actor, conversationId, clientMessageId, content] = args as string[];
      return { id: 'message-1', conversationId, senderId: actor, clientMessageId, content, createdAt: '2026-11-23T12:00:00Z' };
    },
  };
  const result = await executor({ messages }).execute({
    ...base, operation: 'sendMessage', variables: {
      conversationId: '98547ca7-98a5-4fdd-a9b8-84ea7986644b',
      clientMessageId: '07d97fe4-1927-4df6-9ffd-032ff821f67f', content: 'hello',
    },
  });
  // The user token is not passed to persistence: only the verified actor ID is.
  assert.deepEqual(seen, [actorId, '98547ca7-98a5-4fdd-a9b8-84ea7986644b', '07d97fe4-1927-4df6-9ffd-032ff821f67f', 'hello', requestId]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    id: 'message-1', conversationId: '98547ca7-98a5-4fdd-a9b8-84ea7986644b',
    senderId: actorId, clientMessageId: '07d97fe4-1927-4df6-9ffd-032ff821f67f',
    content: 'hello', createdAt: '2026-11-23T12:00:00Z',
  });
});

test('opening the current doctor uses only the authenticated actor ID', async () => {
  let seenActor: string | undefined;
  const conversations = {
    openCurrentDoctor: async (id: string) => {
      seenActor = id;
      return { id: '98547ca7-98a5-4fdd-a9b8-84ea7986644b', userLow: actorId,
        userHigh: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt: '2026-11-23T12:00:00Z' };
    },
  };
  const result = await executor({ conversations }).execute({ ...base, operation: 'openCurrentDoctor', variables: {} });
  assert.equal(seenActor, actorId);
  assert.equal((result as { id: string }).id, '98547ca7-98a5-4fdd-a9b8-84ea7986644b');
});

test('care contacts are resolved for the authenticated actor', async () => {
  const contacts = {
    listCareContacts: async (id: string) => {
      assert.equal(id, actorId);
      return { role: 'doctor', contacts: [{ userId: '98547ca7-98a5-4fdd-a9b8-84ea7986644b', fullName: 'Demo Patient' }] };
    },
  };
  const result = await executor({ contacts }).execute({ ...base, operation: 'careContacts', variables: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    role: 'doctor', contacts: [{ userId: '98547ca7-98a5-4fdd-a9b8-84ea7986644b', fullName: 'Demo Patient' }],
  });
});

test('domain errors propagate and unknown resolver errors become UNAVAILABLE', async () => {
  const forbidden = executor({ conversations: { listConversations: async () => { throw new DomainError('FORBIDDEN', 'No'); } } });
  await assert.rejects(forbidden.execute({ ...base, operation: 'listConversations', variables: { limit: 5 } }), { code: 'FORBIDDEN' });
  const crashed = executor({ conversations: { listConversations: async () => { throw new Error('socket hang up'); } } });
  await assert.rejects(crashed.execute({ ...base, operation: 'listConversations', variables: { limit: 5 } }),
    { code: 'UNAVAILABLE', message: 'Messaging operation failed' });
});
