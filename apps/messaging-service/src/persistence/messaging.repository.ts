import { Injectable } from '@nestjs/common';
import { DatabaseSession } from './database-session';
import { ConversationRepository } from './conversation.repository';
import { CareContactRepository } from './care-contact.repository';
import { MessageRepository } from './message.repository';

@Injectable()
export class MessagingRepository {
  constructor(
    private readonly db: DatabaseSession,
    private readonly conversations: ConversationRepository,
    private readonly contacts: CareContactRepository,
    private readonly messages: MessageRepository,
  ) {}

  claimRequest(requestId: string, expiresAt: number) { return this.db.claimRequest(requestId, expiresAt); }
  createConversation(actorId: string, token: string, otherUserId: string, requestId?: string) { return this.conversations.createConversation(actorId, token, otherUserId, requestId); }
  openCurrentDoctor(actorId: string, requestId?: string) { return this.conversations.openCurrentDoctor(actorId, requestId); }
  listCareContacts(actorId: string, requestId?: string) { return this.contacts.listCareContacts(actorId, requestId); }
  listConversations(actorId: string, limit: number, requestId?: string) { return this.conversations.listConversations(actorId, limit, requestId); }
  sendMessage(actorId: string, token: string, conversationId: string, clientMessageId: string, content: string, requestId?: string) { return this.messages.sendMessage(actorId, token, conversationId, clientMessageId, content, requestId); }
  listMessages(actorId: string, conversationId: string, limit: number, before?: string, requestId?: string) { return this.messages.listMessages(actorId, conversationId, limit, before, requestId); }
}
