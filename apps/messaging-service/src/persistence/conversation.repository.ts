import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DomainError } from '../domain/domain-error';
import { DatabaseSession } from './database-session';
import { ConversationRow, conversation } from './row-mappers';

@Injectable()
export class ConversationRepository {
  constructor(private readonly db: DatabaseSession) {}

  async createConversation(actorId: string, _token: string, otherUserId: string, requestId?: string) {
    if (actorId === otherUserId) throw new DomainError('VALIDATION', 'A second user is required');
    return this.db.asActor(actorId, 'createConversation', requestId, (client) => this.createConversationFor(client, otherUserId));
  }

  async openCurrentDoctor(actorId: string, requestId?: string) {
    return this.db.asActor(actorId, 'openCurrentDoctor', requestId, async (client) => {
      const assigned = await client.query<{ doctor_id: string }>(
        'SELECT doctor_id FROM public.patients WHERE user_id=$1 LIMIT 1', [actorId],
      );
      const doctorId = assigned.rows[0]?.doctor_id;
      if (!doctorId) throw new DomainError('NOT_FOUND', 'No assigned doctor found');
      return this.createConversationFor(client, doctorId);
    });
  }

  private async createConversationFor(client: PoolClient, otherUserId: string) {
    let id: string;
    try {
      const created = await client.query<{ create_direct_conversation: string }>(
        'SELECT public.create_direct_conversation($1) AS create_direct_conversation', [otherUserId],
      );
      id = created.rows[0].create_direct_conversation;
    } catch (error) {
      if (error instanceof Error && /Recipient is not the current doctor or patient|Invalid conversation users/.test(error.message)) {
        throw new DomainError('VALIDATION', 'Invalid recipient');
      }
      throw error;
    }
    const found = await client.query<ConversationRow>(
      'SELECT id,user_low,user_high,created_at FROM public.conversations WHERE id=$1', [id],
    );
    if (!found.rows[0]) throw new DomainError('UNAVAILABLE', 'Conversation unavailable');
    return conversation(found.rows[0]);
  }

  async listConversations(actorId: string, limit: number, requestId?: string) {
    return this.db.asActor(actorId, 'listConversations', requestId, async (client) => {
      const result = await client.query<ConversationRow>(
        'SELECT id,user_low,user_high,created_at FROM public.conversations ORDER BY created_at DESC,id DESC LIMIT $1',
        [limit],
      );
      return result.rows.map(conversation);
    });
  }

}
