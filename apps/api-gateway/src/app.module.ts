import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { natsConnectionOptions, requiredEnv, SupabaseJwtVerifier } from '@messaging/security';
import { AuthGuard } from './security/auth.guard';
import { ipTracker, sessionTracker } from './security/throttle-trackers';
import { ObserveModule } from './observe';
import { ConversationsController } from './transport/http/conversations.controller';
import { EventsController } from './transport/http/events.controller';
import { HealthController } from './transport/http/health.controller';
import { EventHub } from './transport/events/event-hub.service';
import { NatsGatewayService } from './transport/nats/nats-gateway.service';
import { PublicConfigController } from './transport/http/public-config.controller';

const perMinute = (variable: string, fallback: number) => Number(process.env[variable] ?? fallback);

@Module({
  imports: [ObserveModule.forRoot({
    appKey: process.env.OBSERVE_APP_KEY,
    appSecret: process.env.OBSERVE_APP_SECRET,
    enabled: Boolean(process.env.OBSERVE_APP_KEY && process.env.OBSERVE_APP_SECRET),
    serviceId: 'api-gateway',
    forwardLogs: true,
    http: { capture: false },
  }), ThrottlerModule.forRoot([
    // Each signed-in session (browser tab) gets its own budget; a shared clinic
    // NAT address is only bounded by the much larger per-IP flood limit.
    { name: 'session', ttl: 60000, limit: perMinute('THROTTLE_SESSION_PER_MINUTE', 120), getTracker: sessionTracker },
    { name: 'ip', ttl: 60000, limit: perMinute('THROTTLE_IP_PER_MINUTE', 1200), getTracker: ipTracker },
  ]), ClientsModule.registerAsync([{
    // Resolved during bootstrap so configuration errors reach main()'s handler.
    name: 'MESSAGING_CLIENT',
    useFactory: () => ({
      transport: Transport.NATS,
      options: { ...natsConnectionOptions('NATS_A_CREDENTIALS_FILE'), inboxPrefix: '_INBOX.gateway' },
    }),
  }])],
  controllers: [ConversationsController, PublicConfigController, HealthController, EventsController],
  providers: [
    { provide: SupabaseJwtVerifier, useFactory: () => new SupabaseJwtVerifier(requiredEnv('SUPABASE_URL')) },
    AuthGuard,
    NatsGatewayService,
    EventHub,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
