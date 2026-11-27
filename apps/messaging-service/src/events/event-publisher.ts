import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { NatsConnection } from '@nats-io/transport-node';
import { connectNats } from '@messaging/security';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

/** Publishes already-signed event packets. */
export interface EventPublisher {
  publish(subject: string, packet: object): Promise<void>;
  /** Resolves once the broker has acknowledged everything published so far. */
  flush(): Promise<void>;
}

@Injectable()
export class NatsEventPublisher implements EventPublisher, OnModuleDestroy {
  private readonly logger = new Logger(NatsEventPublisher.name);
  private connection?: Promise<NatsConnection>;

  async publish(subject: string, packet: object): Promise<void> {
    const nc = await this.connect();
    nc.publish(subject, JSON.stringify(packet));
  }

  async flush(): Promise<void> {
    await (await this.connect()).flush();
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.connection) return;
    const nc = await this.connection.catch(() => undefined);
    await nc?.drain().catch(() => undefined);
  }

  private connect(): Promise<NatsConnection> {
    this.connection ??= connectNats('NATS_B_CREDENTIALS_FILE', 'messaging-service-events').then((nc) => {
      void this.watch(nc);
      return nc;
    }).catch((error: unknown) => {
      this.connection = undefined; // retry on the next publish
      throw error;
    });
    return this.connection;
  }

  private async watch(nc: NatsConnection): Promise<void> {
    for await (const status of nc.status()) {
      // A permissions violation means the worker's NATS identity predates live
      // events: run `npm run nats:update-permissions` (see README).
      if (status.type === 'error') this.logger.error(`service=messaging-service stage=events.nats_error error=${String(status.error)}`);
      else this.logger.log(`service=messaging-service stage=events.nats_status status=${status.type}`);
    }
  }
}
