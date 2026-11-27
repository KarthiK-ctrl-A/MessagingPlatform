import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { dbCode } from './database-errors';
import { DatabaseSession } from './database-session';

/** One-time request-ID claims shared by every worker replica. */
@Injectable()
export class ReplayStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReplayStore.name);
  private cleanupTimer?: NodeJS.Timeout;

  constructor(private readonly db: DatabaseSession) {}

  onModuleInit(): void {
    this.cleanupExpired();
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async claim(requestId: string, expiresAt: number): Promise<boolean> {
    const started = performance.now();
    try {
      const inserted = await this.db.query(
        `INSERT INTO internal.request_nonces (request_id, expires_at)
         VALUES ($1, $2) ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
        [requestId, new Date(expiresAt)],
      );
      const accepted = inserted.rowCount === 1;
      this.logger.log(`service=messaging-service stage=db.replay_claim requestId=${requestId} accepted=${accepted} durationMs=${Math.round(performance.now() - started)}`);
      return accepted;
    } catch (error) {
      this.logger.warn(`service=messaging-service stage=db.replay_claim requestId=${requestId} status=error code=${dbCode(error)} durationMs=${Math.round(performance.now() - started)}`);
      throw error;
    }
  }

  private cleanupExpired(): void {
    // The retention margin (5 minutes) comfortably exceeds the accepted clock skew,
    // so a nonce is never removed while its request could still pass freshness checks.
    void this.db.query("DELETE FROM internal.request_nonces WHERE expires_at < now() - interval '5 minutes'")
      .catch((error: unknown) => {
        this.logger.warn(`service=messaging-service stage=db.replay_cleanup status=error code=${dbCode(error)}`);
      });
  }
}
