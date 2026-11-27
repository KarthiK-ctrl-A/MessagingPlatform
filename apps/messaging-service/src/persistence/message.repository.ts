import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { decodeCursor, encodeCursor, type Cursor } from '@messaging/contracts';
import { DomainError } from '../domain/domain-error';
import { toDomainError } from './database-errors';
import { DatabaseSession } from './database-session';
import { MessageRow, message } from './row-mappers';
import { toIsoMicros } from './timestamps';

@Injectable()
export class MessageRepository {
  constructor(private readonly db: DatabaseSession) {}

  private async assertMember(client: PoolClient, conversationId: string): Promise<void> {
    const found = await client.query('SELECT id FROM public.conversations WHERE id=$1', [conversationId]);
    if (!found.rows[0]) throw new DomainError('NOT_FOUND', 'Conversation not found');
  }

  async sendMessage(actorId: string, conversationId: string, clientMessageId: string, content: string, requestId?: string) {
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

  /**
   * One page of history. Without cursors: the newest messages. With `before`:
   * older messages (scrolling back). With `after`: messages newer than the
   * cursor, used to fill gaps after a live event or a reconnect. Items are
   * always newest first; `latestCursor` marks the newest item returned.
   */
  async listMessages(actorId: string, conversationId: string, limit: number,
    cursors: { before?: string; after?: string } = {}, requestId?: string) {
    if (cursors.before && cursors.after) throw new DomainError('VALIDATION', 'Use either before or after');
    const before = cursors.before ? this.cursor(cursors.before) : undefined;
    const after = cursors.after ? this.cursor(cursors.after) : undefined;
    if (after) return this.listAfter(actorId, conversationId, limit, after, requestId);

    let rows: MessageRow[] | null;
    try {
      rows = await this.db.readMessagePage(actorId, conversationId, limit + 1,
        before?.createdAt ?? null, before?.id ?? null, requestId);
    } catch (error) {
      throw toDomainError(error) ?? error;
    }
    if (rows !== null) return this.page(rows, limit);
    return this.db.asActor(actorId, 'listMessages', requestId, async (client) => {
      await this.assertMember(client, conversationId);
      const result = await client.query<MessageRow>(
        `SELECT id,conversation_id,sender_id,client_message_id,content,created_at
         FROM public.messages
         WHERE conversation_id=$1
           AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
         ORDER BY created_at DESC,id DESC LIMIT $4`,
        [conversationId, before?.createdAt ?? null, before?.id ?? null, limit + 1],
      );
      return this.page(result.rows, limit);
    });
  }

  private async listAfter(actorId: string, conversationId: string, limit: number, after: Cursor, requestId?: string) {
    let rows: MessageRow[] | null;
    try {
      rows = await this.db.readMessagesAfter(actorId, conversationId, limit, after.createdAt, after.id, requestId);
    } catch (error) {
      throw toDomainError(error) ?? error;
    }
    rows ??= await this.db.asActor(actorId, 'listMessages', requestId, async (client) => {
      await this.assertMember(client, conversationId);
      const result = await client.query<MessageRow>(
        `SELECT id,conversation_id,sender_id,client_message_id,content,created_at
         FROM public.messages
         WHERE conversation_id=$1 AND (created_at,id)>($2::timestamptz,$3::uuid)
         ORDER BY created_at ASC,id ASC LIMIT $4`,
        [conversationId, after.createdAt, after.id, limit],
      );
      return result.rows;
    });
    // Oldest-first from the database; respond newest-first like every other page.
    const items = [...rows].reverse();
    return { items: items.map(message), nextCursor: null, latestCursor: items[0] ? cursorOf(items[0]) : null };
  }

  private cursor(value: string): Cursor {
    try { return decodeCursor(value); }
    catch { throw new DomainError('VALIDATION', 'Invalid cursor'); }
  }

  private page(rows: MessageRow[], limit: number) {
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(message),
      nextCursor: rows.length > limit && last ? cursorOf(last) : null,
      latestCursor: page[0] ? cursorOf(page[0]) : null,
    };
  }
}

function cursorOf(row: MessageRow): string {
  return encodeCursor({ createdAt: toIsoMicros(row.created_at), id: row.id });
}
