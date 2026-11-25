import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphqlExecutorService } from './graphql-executor.service';
import { MessagingRepository } from '../persistence/messaging.repository';

test('a fixed GraphQL mutation returns the repository result', async () => {
  let seenActor: string | undefined;
  let seenRequestId: string | undefined;
  const repository = {
    sendMessage: async (actorId: string, _token: string, conversationId: string, clientMessageId: string, content: string, requestId: string) => {
      seenActor = actorId;
      seenRequestId = requestId;
      return { id: 'message-1', conversationId, senderId: actorId, clientMessageId, content, createdAt: '2026-11-23T12:00:00Z' };
    },
  } as MessagingRepository;
  const executor = new GraphqlExecutorService(repository);
  const result = await executor.execute({
    version: 1, audience: 'messaging-service', requestId: 'a248c773-1cb0-4dad-b109-dfe48a094c00',
    issuedAt: 1, expiresAt: 2, actorId: 'a248c773-1cb0-4dad-b109-dfe48a094c00',
    userJwt: 'token', operation: 'sendMessage', variables: {
      conversationId: '98547ca7-98a5-4fdd-a9b8-84ea7986644b',
      clientMessageId: '07d97fe4-1927-4df6-9ffd-032ff821f67f', content: 'hello',
    },
  });
  assert.equal(seenActor, 'a248c773-1cb0-4dad-b109-dfe48a094c00');
  assert.equal(seenRequestId, 'a248c773-1cb0-4dad-b109-dfe48a094c00');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    id: 'message-1', conversationId: '98547ca7-98a5-4fdd-a9b8-84ea7986644b',
    senderId: seenActor, clientMessageId: '07d97fe4-1927-4df6-9ffd-032ff821f67f',
    content: 'hello', createdAt: '2026-11-23T12:00:00Z',
  });
});

test('opening the current doctor uses only the authenticated actor ID', async () => {
  const actorId = 'a248c773-1cb0-4dad-b109-dfe48a094c00';
  let seenActor: string | undefined;
  const repository = {
    openCurrentDoctor: async (id: string) => {
      seenActor = id;
      return { id: '98547ca7-98a5-4fdd-a9b8-84ea7986644b', userLow: actorId,
        userHigh: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt: '2026-11-23T12:00:00Z' };
    },
  } as MessagingRepository;
  const result = await new GraphqlExecutorService(repository).execute({
    version: 1, audience: 'messaging-service', requestId: '07d97fe4-1927-4df6-9ffd-032ff821f67f',
    issuedAt: 1, expiresAt: 2, actorId, userJwt: 'token',
    operation: 'openCurrentDoctor', variables: {},
  });
  assert.equal(seenActor, actorId);
  assert.equal((result as { id: string }).id, '98547ca7-98a5-4fdd-a9b8-84ea7986644b');
});

test('care contacts are resolved for the authenticated actor', async () => {
  const actorId = 'a248c773-1cb0-4dad-b109-dfe48a094c00';
  const repository = {
    listCareContacts: async (id: string) => {
      assert.equal(id, actorId);
      return { role: 'doctor', contacts: [{ userId: '98547ca7-98a5-4fdd-a9b8-84ea7986644b', fullName: 'Demo Patient' }] };
    },
  } as MessagingRepository;
  const result = await new GraphqlExecutorService(repository).execute({
    version: 1, audience: 'messaging-service', requestId: '07d97fe4-1927-4df6-9ffd-032ff821f67f',
    issuedAt: 1, expiresAt: 2, actorId, userJwt: 'token',
    operation: 'careContacts', variables: {},
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    role: 'doctor', contacts: [{ userId: '98547ca7-98a5-4fdd-a9b8-84ea7986644b', fullName: 'Demo Patient' }],
  });
});
