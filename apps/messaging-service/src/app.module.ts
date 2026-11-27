import { Module } from '@nestjs/common';
import { requiredEnv, SupabaseJwtVerifier } from '@messaging/security';
import { ObserveModule } from './observe';
import { createPool, DatabaseSession, PG_POOL } from './persistence/database-session';
import { ConversationRepository } from './persistence/conversation.repository';
import { CareContactRepository } from './persistence/care-contact.repository';
import { MessageRepository } from './persistence/message.repository';
import { ReplayStore } from './persistence/replay.store';
import { GraphqlExecutorService } from './application/graphql-executor.service';
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
    { provide: SupabaseJwtVerifier, useFactory: () => new SupabaseJwtVerifier(requiredEnv('SUPABASE_URL')) },
    { provide: PG_POOL, useFactory: createPool },
    VerifiedRequests, SignedRequestGuard, DatabaseSession, ReplayStore,
    ConversationRepository, CareContactRepository, MessageRepository, GraphqlExecutorService,
  ],
})
export class AppModule {}
