import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { NatsConnection, Subscription } from '@nats-io/transport-node';
import { EVENT_SUBJECTS, messageCreatedEventSchema, type MessageCreatedEvent } from '@messaging/contracts';
import { assertFresh, connectNats, requiredEnv, verifyPacket } from '@messaging/security';
import { EventRouter, type EventSink } from './event-router';

/**
 * Subscribes this gateway instance to live events from the messaging service
 * (every instance receives every event; it notifies only its own connections).
 */
@Injectable()
export class EventHub implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventHub.name);
  readonly router = new EventRouter({
    perUser: Number(process.env.EVENT_STREAMS_PER_USER ?? 5),
    total: Number(process.env.EVENT_STREAMS_MAX ?? 10_000),
    dedupeWindow: 10_000,
  });
  private connection?: NatsConnection;
  private subscription?: Subscription;
  private state = 'starting';
  private stopped = false;

  onModuleInit(): void {
    // Not awaited: the HTTP API must start, and keep running, even if live events
    // are unavailable. Clients then fall back to polling (see /v1/events).
    this.start().catch((error: unknown) => {
      this.state = 'failed';
      this.logger.error(`service=api-gateway stage=events.failed error=${error instanceof Error ? error.name : 'unknown'}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.router.closeAll();
    await this.connection?.drain().catch(() => undefined);
  }

  /** `connected` when live events can be delivered; anything else means clients should poll. */
  status(): string { return this.state; }

  register(userId: string, sink: EventSink): () => void { return this.router.register(userId, sink); }

  /** Verifies a raw NATS payload; returns the event, or undefined if it must be ignored. */
  parse(data: string): MessageCreatedEvent | undefined {
    try {
      const event = messageCreatedEventSchema.parse(verifyPacket(JSON.parse(data), requiredEnv('B_PUBLIC_KEY')));
      assertFresh(event.issuedAt, event.expiresAt);
      return event;
    } catch {
      this.logger.warn('service=api-gateway stage=events.reject reason=invalid_or_stale_event');
      return undefined;
    }
  }

  private async start(): Promise<void> {
    while (!this.connection && !this.stopped) {
      try {
        this.connection = await connectNats('NATS_A_CREDENTIALS_FILE', 'api-gateway-events');
      } catch {
        this.state = 'disconnected';
        this.logger.warn('service=api-gateway stage=events.connect status=retrying');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    if (!this.connection) return;
    void this.watch(this.connection);
    this.subscription = this.connection.subscribe(EVENT_SUBJECTS.messageCreated);
    this.state = 'connected';
    this.logger.log(`service=api-gateway stage=events.subscribed subject=${EVENT_SUBJECTS.messageCreated}`);
    try {
      for await (const message of this.subscription) {
        const event = this.parse(message.string());
        if (!event) continue;
        const delivered = this.router.deliver(event);
        this.logger.log(`service=api-gateway stage=events.deliver eventId=${event.eventId} streams=${delivered}`);
      }
    } catch (error) {
      // Typically a permissions violation: this identity was issued before live
      // events existed. REST keeps working; streams are closed so clients poll.
      const permission = error instanceof Error && error.name === 'PermissionViolationError';
      this.state = permission ? 'forbidden' : 'failed';
      this.router.closeAll();
      this.logger.error(permission
        ? 'service=api-gateway stage=events.forbidden action="run npm run build && npm run nats:update-permissions, then recreate api-gateway and messaging-service"'
        : `service=api-gateway stage=events.failed error=${error instanceof Error ? error.name : 'unknown'}`);
    }
  }

  private async watch(nc: NatsConnection): Promise<void> {
    for await (const status of nc.status()) {
      if (this.state === 'forbidden' || this.state === 'failed') continue;
      if (status.type === 'disconnect') {
        this.state = 'disconnected';
        // Events published while disconnected are lost for this instance; closing the
        // streams makes clients reconnect and fill the gap from the history cursor.
        this.router.closeAll();
      } else if (status.type === 'reconnect') this.state = 'connected';
      else if (status.type === 'error') {
        // A permissions violation means the gateway's NATS identity predates live
        // events: run `npm run nats:update-permissions` (see README).
        this.logger.error(`service=api-gateway stage=events.nats_error error=${String(status.error)}`);
      }
    }
  }
}
