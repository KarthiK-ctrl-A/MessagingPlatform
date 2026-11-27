import { Injectable, Logger } from '@nestjs/common';
import { buildSchema, execute, parse, validate, type DocumentNode, type GraphQLSchema } from 'graphql';
import type { Operation, RequestEnvelope } from '@messaging/contracts';
import { DomainError } from '../domain/domain-error';
import { CareContactRepository } from '../persistence/care-contact.repository';
import { ConversationRepository } from '../persistence/conversation.repository';
import { MessageRepository } from '../persistence/message.repository';
import { schemaText } from './graphql-schema';
import { documents } from './graphql-documents';

interface GraphContext { actorId: string; requestId: string }

/** The GraphQL root field each fixed operation document selects. */
const resultField: Record<Operation, string> = {
  careContacts: 'careContacts', createConversation: 'createConversation', openCurrentDoctor: 'openCurrentDoctor',
  listConversations: 'conversations', sendMessage: 'sendMessage', listMessages: 'messages',
};

@Injectable()
export class GraphqlExecutorService {
  private readonly logger = new Logger(GraphqlExecutorService.name);
  private readonly schema: GraphQLSchema = buildSchema(schemaText);
  // Documents are server-owned and fixed: parse and validate them once at startup,
  // so a broken document fails the deployment instead of a user request.
  private readonly parsed: Record<Operation, DocumentNode>;
  private readonly root;

  constructor(conversations: ConversationRepository, contacts: CareContactRepository, messages: MessageRepository) {
    this.parsed = Object.fromEntries(Object.entries(documents).map(([operation, source]) => {
      const document = parse(source);
      const errors = validate(this.schema, document);
      if (errors.length) throw new Error(`Invalid GraphQL document for ${operation}: ${errors[0].message}`);
      return [operation, document];
    })) as Record<Operation, DocumentNode>;
    this.root = {
      careContacts: (_args: unknown, ctx: GraphContext) => contacts.listCareContacts(ctx.actorId, ctx.requestId),
      openCurrentDoctor: (_args: unknown, ctx: GraphContext) => conversations.openCurrentDoctor(ctx.actorId, ctx.requestId),
      createConversation: ({ otherUserId }: { otherUserId: string }, ctx: GraphContext) =>
        conversations.createConversation(ctx.actorId, otherUserId, ctx.requestId),
      conversations: ({ limit }: { limit: number }, ctx: GraphContext) =>
        conversations.listConversations(ctx.actorId, limit, ctx.requestId),
      sendMessage: ({ conversationId, clientMessageId, content }: { conversationId: string; clientMessageId: string; content: string }, ctx: GraphContext) =>
        messages.sendMessage(ctx.actorId, conversationId, clientMessageId, content, ctx.requestId),
      messages: ({ conversationId, limit, before }: { conversationId: string; limit: number; before?: string }, ctx: GraphContext) =>
        messages.listMessages(ctx.actorId, conversationId, limit, before, ctx.requestId),
    };
  }

  async execute(request: RequestEnvelope): Promise<unknown> {
    const started = performance.now();
    const context = `service=messaging-service requestId=${request.requestId} operation=${request.operation}`;
    this.logger.log(`${context} stage=graphql.start`);
    try {
      const result = await execute({
        schema: this.schema,
        document: this.parsed[request.operation],
        rootValue: this.root,
        contextValue: { actorId: request.actorId, requestId: request.requestId } satisfies GraphContext,
        variableValues: request.variables,
      });
      if (result.errors?.length) {
        const original = result.errors[0].originalError;
        if (original instanceof DomainError) throw original;
        throw new DomainError('UNAVAILABLE', 'Messaging operation failed');
      }
      this.logger.log(`${context} stage=graphql.done status=ok durationMs=${Math.round(performance.now() - started)}`);
      return result.data?.[resultField[request.operation]];
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'UNAVAILABLE';
      this.logger.warn(`${context} stage=graphql.done status=error code=${code} durationMs=${Math.round(performance.now() - started)}`);
      throw error;
    }
  }
}
