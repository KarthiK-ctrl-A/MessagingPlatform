import { Injectable, Logger } from '@nestjs/common';
import { buildSchema, graphql, type GraphQLSchema } from 'graphql';
import type { RequestEnvelope } from '@messaging/contracts';
import { DomainError } from '../domain/domain-error';
import { MessagingRepository } from '../persistence/messaging.repository';

import { schemaText } from './graphql-schema';
import { documents } from './graphql-documents';

interface GraphContext { actorId: string; userJwt: string; requestId: string }

@Injectable()
export class GraphqlExecutorService {
  private readonly logger = new Logger(GraphqlExecutorService.name);
  private readonly schema: GraphQLSchema = buildSchema(schemaText);

  constructor(private readonly repository: MessagingRepository) {}

  async execute(request: RequestEnvelope): Promise<unknown> {
    const started = performance.now();
    const context = `service=messaging-service requestId=${request.requestId} operation=${request.operation}`;
    this.logger.log(`${context} stage=graphql.start`);
    try {
      const root = {
        careContacts: (_args: unknown, context: GraphContext) =>
          this.repository.listCareContacts(context.actorId, context.requestId),
        openCurrentDoctor: (_args: unknown, context: GraphContext) =>
          this.repository.openCurrentDoctor(context.actorId, context.requestId),
        createConversation: ({ otherUserId }: { otherUserId: string }, context: GraphContext) =>
          this.repository.createConversation(context.actorId, context.userJwt, otherUserId, context.requestId),
        conversations: ({ limit }: { limit: number }, context: GraphContext) =>
          this.repository.listConversations(context.actorId, limit, context.requestId),
        sendMessage: ({ conversationId, clientMessageId, content }: { conversationId: string; clientMessageId: string; content: string }, context: GraphContext) =>
          this.repository.sendMessage(context.actorId, context.userJwt, conversationId, clientMessageId, content, context.requestId),
        messages: ({ conversationId, limit, before }: { conversationId: string; limit: number; before?: string }, context: GraphContext) =>
          this.repository.listMessages(context.actorId, conversationId, limit, before, context.requestId),
      };
      const result = await graphql({
        schema: this.schema,
        source: documents[request.operation],
        rootValue: root,
        contextValue: { actorId: request.actorId, userJwt: request.userJwt, requestId: request.requestId } satisfies GraphContext,
        variableValues: request.variables,
      });
      if (result.errors?.length) {
        const original = result.errors[0].originalError;
        if (original instanceof DomainError) throw original;
        throw new DomainError('UNAVAILABLE', 'Messaging operation failed');
      }
      const data = result.data?.[{
        careContacts: 'careContacts', createConversation: 'createConversation', openCurrentDoctor: 'openCurrentDoctor', listConversations: 'conversations',
        sendMessage: 'sendMessage', listMessages: 'messages',
      }[request.operation]];
      this.logger.log(`${context} stage=graphql.done status=ok durationMs=${Math.round(performance.now() - started)}`);
      return data;
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'UNAVAILABLE';
      this.logger.warn(`${context} stage=graphql.done status=error code=${code} durationMs=${Math.round(performance.now() - started)}`);
      throw error;
    }
  }
}
