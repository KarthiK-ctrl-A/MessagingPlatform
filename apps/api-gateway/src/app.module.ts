import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { credsAuthenticator } from '@nats-io/transport-node';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { SupabaseJwtVerifier } from '@messaging/security';
import { AuthGuard } from './security/auth.guard';
import { ObserveModule } from './observe';
import { ConversationsController } from './transport/http/conversations.controller';
import { NatsGatewayService } from './transport/nats/nats-gateway.service';
import { PublicConfigController } from './transport/http/public-config.controller';

@Module({
  imports: [ObserveModule.forRoot({
    appKey: process.env.OBSERVE_APP_KEY,
    appSecret: process.env.OBSERVE_APP_SECRET,
    serviceId: 'api-gateway',
    forwardLogs: true,
    http: { capture: false },
  }), ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]), ClientsModule.register([{
    name: 'MESSAGING_CLIENT', transport: Transport.NATS,
    options: { servers: [process.env.NATS_URL ?? 'nats://127.0.0.1:4222'],
      authenticator: credsAuthenticator(readFileSync(required('NATS_A_CREDENTIALS_FILE'))),
      inboxPrefix: '_INBOX.gateway',
    },
  }])],
  controllers: [ConversationsController, PublicConfigController],
  providers: [
    { provide: SupabaseJwtVerifier, useFactory: () => new SupabaseJwtVerifier(required('SUPABASE_URL')) },
    AuthGuard,
    NatsGatewayService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
