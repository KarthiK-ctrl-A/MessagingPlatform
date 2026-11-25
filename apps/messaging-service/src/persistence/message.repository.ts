import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { decodeCursor, encodeCursor } from '@messaging/contracts';
import { DomainError } from '../domain/domain-error';
import { DatabaseSession } from './database-session';
import { MessageRow, message } from './row-mappers';

@Injectable()
export class MessageRepository {
  constructor(private readonly db: DatabaseSession) {}

  private async assertMember(client: PoolClient, conversationId: string): Promise<void> {
    const found = await client.query('SELECT id FROM public.conversations WHERE id=$1', [conversationId]);
    if (!found.rows[0]) throw new DomainError('NOT_FOUND', 'Conversation not found');
  }

  async sendMessage(actorId: string, _token: string, conversationId: string, clientMessageId: string, content: string, requestId?: string) {
    return this.db.asActor(actorId, 'sendMessage', requestId, async (client) => {
      await this.assertMember(client, conversationId);
      const inserted = await client.query<MessageRow>(
        `INSERT INTO public.messages (conversation_id,sender_id,client_message_id,content)
         VALUES ($1,$2,$3,$4) ON CONFLICT (sender_id,client_message_id) DO NOTHING
         RETURNING id,conversation_id,sender_id,client_message_id,content,created_at`,
        [conversationId, actorId, clientMessageId, content],
      );
      if (inserted.rows[0]) return message(inserted.rows[0]);
      const existing = await client.query<MessageRow>(
        `SELECT id,conversation_id,sender_id,client_message_id,content,created_at
         FROM public.messages WHERE sender_id=$1 AND client_message_id=$2`,
        [actorId, clientMessageId],
      );
      const row = existing.rows[0];
      if (!row) throw new DomainError('UNAVAILABLE', 'Unable to send message');
      if (row.conversation_id !== conversationId || row.content !== content) {
        throw new DomainError('CONFLICT', 'Message ID was already used with different content');
      }
      return message(row);
    });
  }

  async listMessages(actorId: string, conversationId: string, limit: number, before?: string, requestId?: string) {
    let cursor: ReturnType<typeof decodeCursor> | undefined;
    if (before) {
      try { cursor = decodeCursor(before); }
      catch { throw new DomainError('VALIDATION', 'Invalid cursor'); }
    }
    return this.db.asActor(actorId, 'listMessages', requestId, async (client) => {
      await this.assertMember(client, conversationId);
      const result = await client.query<MessageRow>(
        `SELECT id,conversation_id,sender_id,client_message_id,content,created_at
         FROM public.messages
         WHERE conversation_id=$1
           AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
         ORDER BY created_at DESC,id DESC LIMIT $4`,
        [conversationId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      const page = result.rows.slice(0, limit);
      const last = page.at(-1);
      return { items: page.map(message), nextCursor: result.rows.length > limit && last
        ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id }) : null };
    });
  }
}
