import { readFileSync } from 'node:fs';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import type { MessageRow } from './row-mappers';

@Injectable()
export class DatabaseSession implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(DatabaseSession.name);
  private cleanupTimer?: NodeJS.Timeout;
  private fastHistoryAvailable = false;
  private readonly pool = new Pool({
    connectionString: required('DATABASE_URL'),
    ssl: { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT_PATH
      ? { ca: readFileSync(process.env.DATABASE_CA_CERT_PATH, 'utf8') } : {}) },
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
  });

  async onModuleInit(): Promise<void> {
    const result = await this.pool.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT current_user AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    const role = result.rows[0];
    if (!role || role.role_name !== 'messaging_b_runtime' || role.rolsuper || role.rolbypassrls) {
      throw new Error('Messaging service requires the non-superuser messaging_b_runtime database role');
    }
    const history = await this.pool.query<{ available: boolean }>(
      `SELECT pg_catalog.to_regprocedure(
        'internal.read_message_page(uuid,uuid,integer,timestamp with time zone,uuid)'
      ) IS NOT NULL AS available`,
    );
    this.fastHistoryAvailable = history.rows[0]?.available === true;
    this.logger.log('service=messaging-service stage=db.ready role=messaging_b_runtime');
    this.logger.log(`service=messaging-service stage=db.history_fast_path enabled=${this.fastHistoryAvailable}`);
    this.cleanupExpiredRequests();
    this.cleanupTimer = setInterval(() => this.cleanupExpiredRequests(), 60 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  private cleanupExpiredRequests(): void {
    void this.pool.query("DELETE FROM internal.request_nonces WHERE expires_at < now() - interval '1 minute'")
      .catch(() => { /* A failed cleanup never bypasses the uniqueness check. */ });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.pool.end();
  }

  async claimRequest(requestId: string, expiresAt: number): Promise<boolean> {
    const started = performance.now();
    try {
      const inserted = await this.pool.query(
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

  // A single server-side function call keeps actor identity transaction-local and
  // avoids a separate network round trip for each part of the history read.
  async readMessagePage(actorId: string, conversationId: string, pageSize: number,
    beforeCreatedAt: string | null, beforeId: string | null, requestId?: string): Promise<MessageRow[] | null> {
    if (!this.fastHistoryAvailable) return null;
    const started = performance.now();
    const context = `service=messaging-service requestId=${requestId ?? 'unknown'} operation=listMessages`;
    this.logger.log(`${context} stage=db.start`);
    try {
      const result = await this.pool.query<MessageRow>(
        'SELECT * FROM internal.read_message_page($1::uuid,$2::uuid,$3::integer,$4::timestamptz,$5::uuid)',
        [actorId, conversationId, pageSize, beforeCreatedAt, beforeId],
      );
      this.logger.log(`${context} stage=db.done status=ok path=single_statement durationMs=${Math.round(performance.now() - started)}`);
      return result.rows;
    } catch (error) {
      this.logger.warn(`${context} stage=db.done status=error path=single_statement code=${dbCode(error)} durationMs=${Math.round(performance.now() - started)}`);
      throw error;
    }
  }

  async asActor<T>(actorId: string, operation: string, requestId: string | undefined,
    action: (client: PoolClient) => Promise<T>): Promise<T> {
    const started = performance.now();
    const context = `service=messaging-service requestId=${requestId ?? 'unknown'} operation=${operation}`;
    this.logger.log(`${context} stage=db.start`);
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      this.logger.warn(`${context} stage=db.done status=error code=${dbCode(error)} durationMs=${Math.round(performance.now() - started)}`);
      throw error;
    }
    try {
      await client.query('BEGIN');
      // A transaction-scoped identity cannot bleed into a later pooled request.
      await client.query("SELECT set_config('app.user_id', $1, true)", [actorId]);
      const result = await action(client);
      await client.query('COMMIT');
      this.logger.log(`${context} stage=db.done status=ok durationMs=${Math.round(performance.now() - started)}`);
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      this.logger.warn(`${context} stage=db.done status=error code=${dbCode(error)} durationMs=${Math.round(performance.now() - started)}`);
      throw error;
    } finally {
      client.release();
    }
  }

}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function dbCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? code : 'unknown';
}
