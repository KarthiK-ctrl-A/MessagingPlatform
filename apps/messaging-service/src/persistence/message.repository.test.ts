import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSession } from './database-session';
import { MessageRepository } from './message.repository';
import { MessageRow } from './row-mappers';

test('history uses one read and preserves the page cursor', async () => {
  const actorId = '19e83fb4-b894-4681-8fdc-8cf4c4a0ec64';
  const conversationId = '545190c1-ea59-4e0e-a222-53e3850af6c6';
  const rows: MessageRow[] = [1, 2, 3].map((n) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    conversation_id: conversationId, sender_id: actorId,
    client_message_id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
    content: `message ${n}`, created_at: new Date(`2026-11-27T00:00:0${4 - n}.000Z`),
  }));
  let calls = 0;
  const db = {
    readMessagePage: async (actor: string, conversation: string, count: number) => {
      calls++;
      assert.equal(actor, actorId);
      assert.equal(conversation, conversationId);
      assert.equal(count, 3);
      return rows;
    },
    asActor: async () => { throw new Error('unexpected transaction fallback'); },
  } as unknown as DatabaseSession;
  const result = await new MessageRepository(db).listMessages(actorId, conversationId, 2);
  assert.equal(calls, 1);
  assert.deepEqual(result.items.map((item) => item.content), ['message 1', 'message 2']);
  assert.ok(result.nextCursor);
});

test('a missing conversation retains the API not-found error', async () => {
  const db = ({ readMessagePage: async () => { throw Object.assign(new Error(), { code: 'P0002' }); } }) as unknown as DatabaseSession;
  await assert.rejects(
    new MessageRepository(db).listMessages('actor', 'conversation', 2),
    { code: 'NOT_FOUND' },
  );
});
