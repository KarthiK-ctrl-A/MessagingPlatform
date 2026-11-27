import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Client, type Notification } from 'pg';
import { EVENT_SUBJECTS, type MessageCreatedEvent } from '@messaging/contracts';
import { requiredEnv, signPacket } from '@messaging/security';
import { dbCode } from '../persistence/database-errors';
import { databaseConfig, DatabaseSession } from '../persistence/database-session';
import { toIsoMicros } from '../persistence/timestamps';
import { EVENT_PUBLISHER, type EventPublisher } from './event-publisher';

export const LISTEN_CLIENT_FACTORY = Symbol('LISTEN_CLIENT_FACTORY');
export type ListenClientFactory = () => Pick<Client, 'connect' | 'query' | 'end' | 'on'>;

const BATCH = 100;
const CHANNEL = 'messaging_outbox';
/** Signed events are valid for this long; the gateway rejects anything older. */
const EVENT_TTL_MS = 30_000;

interface OutboxRow {
  id: string; message_id: string; conversation_id: string;
  user_low: string; user_high: string; created_at: Date | string;
}

/**
 * Publishes committed message events from internal.message_outbox to NATS.
 *
 * Wake-ups come from PostgreSQL NOTIFY (sent on commit by the outbox trigger),
 * with a slow timer as a safety net for missed notifications. Rows are claimed
 * with FOR UPDATE SKIP LOCKED, so any number of worker replicas can run the
 * relay without publishing the same row concurrently. A crash after publishing
 * but before commit republishes the row later; consumers de-duplicate by eventId.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private running = false;
  private draining?: Promise<void>;
  private pendingWake = false;
  private listener?: ReturnType<ListenClientFactory>;
  private readonly timers: NodeJS.Timeout[] = [];
  private retryTimer?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseSession,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(LISTEN_CLIENT_FACTORY) private readonly listenClient: ListenClientFactory,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.OUTBOX_RELAY_ENABLED === 'false') {
      this.logger.log('service=messaging-service stage=outbox.disabled reason=configuration');
      return;
    }
    const installed = await this.db.query<{ installed: boolean }>(
      "SELECT pg_catalog.to_regclass('internal.message_outbox') IS NOT NULL AS installed");
    if (!installed.rows[0]?.installed) {
      this.logger.warn('service=messaging-service stage=outbox.disabled reason=migration_20261129_not_applied');
      return;
    }
    this.running = true;
    await this.listen();
    const safetyMs = Number(process.env.OUTBOX_SAFETY_POLL_MS ?? 10_000);
    this.timers.push(setInterval(() => this.wake(), safetyMs), setInterval(() => this.cleanup(), 60 * 60 * 1000));
    for (const timer of this.timers) timer.unref();
    this.logger.log('service=messaging-service stage=outbox.ready');
    this.wake();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.draining;
    await this.listener?.end().catch(() => undefined);
  }

  /** Requests a drain; concurrent wake-ups collapse into one follow-up pass. */
  wake(): void {
    if (!this.running) return;
    if (this.draining) { this.pendingWake = true; return; }
    this.draining = this.drainAll().finally(() => {
      this.draining = undefined;
      if (this.pendingWake) { this.pendingWake = false; this.wake(); }
    });
  }

  /** Publishes and marks one batch; returns the number of events published. */
  async drainOnce(): Promise<number> {
    return this.db.transaction('outbox.publish', async (client) => {
      const pending = await client.query<OutboxRow>(
        `SELECT id, message_id, conversation_id, user_low, user_high, created_at
         FROM internal.message_outbox
         WHERE published_at IS NULL
         ORDER BY created_at, id
         LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`);
      if (pending.rows.length === 0) return 0;
      const key = requiredEnv('B_PRIVATE_KEY');
      for (const row of pending.rows) {
        const issuedAt = Date.now();
        const event: MessageCreatedEvent = {
          audience: 'api-gateway', type: 'message.created', eventId: row.id,
          messageId: row.message_id, conversationId: row.conversation_id,
          participants: [row.user_low, row.user_high], occurredAt: toIsoMicros(row.created_at),
          issuedAt, expiresAt: issuedAt + EVENT_TTL_MS,
        };
        await this.publisher.publish(EVENT_SUBJECTS.messageCreated, signPacket(event, key));
      }
      // Only mark rows published once the broker has accepted them.
      await this.publisher.flush();
      await client.query('UPDATE internal.message_outbox SET published_at = now() WHERE id = ANY($1::uuid[])',
        [pending.rows.map((row) => row.id)]);
      this.logger.log(`service=messaging-service stage=outbox.published count=${pending.rows.length}`);
      return pending.rows.length;
    });
  }

  private async drainAll(): Promise<void> {
    try {
      // Cheap, log-free check so the safety timer costs one index probe when idle.
      const pending = await this.db.query<{ pending: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM internal.message_outbox WHERE published_at IS NULL) AS pending');
      if (!pending.rows[0]?.pending) return;
      while (this.running && await this.drainOnce() === BATCH) { /* keep draining full batches */ }
    } catch (error) {
      this.logger.warn(`service=messaging-service stage=outbox.publish status=error code=${dbCode(error)} error=${error instanceof Error ? error.name : 'unknown'}`);
      // Unpublished rows stay pending; retry soon rather than waiting for the safety timer.
      this.retryTimer = setTimeout(() => this.wake(), 2000);
      this.retryTimer.unref();
    }
  }

  private async listen(): Promise<void> {
    const client = this.listenClient();
    this.listener = client;
    client.on('notification', (message: Notification) => { if (message.channel === CHANNEL) this.wake(); });
    client.on('error', (error: Error) => {
      this.logger.warn(`service=messaging-service stage=outbox.listen status=error code=${dbCode(error)}`);
    });
    client.on('end', () => {
      if (!this.running) return;
      // The safety timer keeps events flowing (with more delay) until LISTEN is back.
      this.logger.warn('service=messaging-service stage=outbox.listen status=disconnected');
      const retry = setTimeout(() => { this.listen().catch(() => undefined); }, 5000);
      retry.unref();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.logger.log('service=messaging-service stage=outbox.listen status=connected');
      this.wake(); // catch up on anything committed while disconnected
    } catch (error) {
      this.logger.warn(`service=messaging-service stage=outbox.listen status=error code=${dbCode(error)}`);
      await client.end().catch(() => undefined);
    }
  }

  private cleanup(): void {
    void this.db.query("DELETE FROM internal.message_outbox WHERE published_at < now() - interval '1 day'")
      .catch((error: unknown) => this.logger.warn(`service=messaging-service stage=outbox.cleanup status=error code=${dbCode(error)}`));
  }
}

/** Default LISTEN connection: same settings as the pool, without a statement timeout. */
export function createListenClient(): Client {
  const { statement_timeout: _ignored, ...config } = databaseConfig();
  return new Client(config);
}
