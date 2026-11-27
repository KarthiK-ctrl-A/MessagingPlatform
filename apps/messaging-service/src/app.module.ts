import { Module } from '@nestjs/common';
import { ObserveModule } from './observe';
import { DatabaseSession } from './persistence/database-session';
import { ConversationRepository } from './persistence/conversation.repository';
import { CareContactRepository } from './persistence/care-contact.repository';
import { MessageRepository } from './persistence/message.repository';
import { SupabaseJwtVerifier } from '@messaging/security';
import { GraphqlExecutorService } from './application/graphql-executor.service';
import { MessagingRepository } from './persistence/messaging.repository';
import { NatsController } from './transport/nats/nats.controller';
import { SignedRequestGuard, VerifiedRequests } from './security/request.guard';

@Module({
  imports: [ObserveModule.forRoot({
    appKey: process.env.OBSERVE_B_APP_KEY,
    appSecret: process.env.OBSERVE_B_APP_SECRET,
    enabled: Boolean(process.env.OBSERVE_B_APP_KEY && process.env.OBSERVE_B_APP_SECRET),
    serviceId: 'messaging-service',
    forwardLogs: true,
  })],
  controllers: [NatsController],
  providers: [
    { provide: SupabaseJwtVerifier, useFactory: () => new SupabaseJwtVerifier(required('SUPABASE_URL')) },
    VerifiedRequests, SignedRequestGuard, DatabaseSession, ConversationRepository, CareContactRepository, MessageRepository, MessagingRepository, GraphqlExecutorService,
  ],
})
export class AppModule {}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
