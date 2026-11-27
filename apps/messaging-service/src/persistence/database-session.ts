import { readFileSync } from 'node:fs';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, type ClientConfig, type PoolClient, type QueryResultRow } from 'pg';
import { requiredEnv } from '@messaging/security';
import { dbCode, toDomainError } from './database-errors';
import type { MessageRow } from './row-mappers';
import { preciseTimestampTypes } from './timestamps';

export const PG_POOL = Symbol('PG_POOL');
export const RUNTIME_ROLE = 'messaging_b_runtime';

/** Connection settings shared by the pool and the relay's LISTEN connection. TLS is mandatory outside local development. */
export function databaseConfig(): ClientConfig {
  const sslMode = process.env.DATABASE_SSL_MODE ?? 'verify-full';
  if (sslMode !== 'verify-full' && sslMode !== 'disable') throw new Error('DATABASE_SSL_MODE must be verify-full or disable');
  if (sslMode === 'disable' && process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_SSL_MODE=disable is not allowed in production');
  }
  return {
    connectionString: requiredEnv('DATABASE_URL'),
    ssl: sslMode === 'disable' ? false : { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT_PATH
      ? { ca: readFileSync(process.env.DATABASE_CA_CERT_PATH, 'utf8') } : {}) },
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    types: preciseTimestampTypes,
  };
}

/** Builds the worker's pool. */
export function createPool(): Pool {
  return new Pool({ ...databaseConfig(), max: Number(process.env.DATABASE_POOL_MAX ?? 10), idleTimeoutMillis: 30000 });
}

/**
 * Runs `action` in one transaction. A failed ROLLBACK means the connection is
 * unusable; that error is reported to `onBrokenConnection` so the caller can
 * destroy the client instead of returning it to the pool.
 */
export async function runInTransaction<T>(client: PoolClient, action: (client: PoolClient) => Promise<T>,
  onBrokenConnection: (error: Error) => void): Promise<T> {
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackError) { onBrokenConnection(rollbackError instanceof Error ? rollbackError : new Error('Rollback failed')); }
    throw error;
  }
}

/** Like runInTransaction, with a transaction-local actor identity for RLS. */
export function runAsActor<T>(client: PoolClient, actorId: string,
  action: (client: PoolClient) => Promise<T>, onBrokenConnection: (error: Error) => void): Promise<T> {
  return runInTransaction(client, async (tx) => {
    // A transaction-scoped identity cannot bleed into a later pooled request.
    await tx.query("SELECT set_config('app.user_id', $1, true)", [actorId]);
    return action(tx);
  }, onBrokenConnection);
}

@Injectable()
export class DatabaseSession implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(DatabaseSession.name);
  private fastHistoryAvailable = false;
  private fastHistoryAfterAvailable = false;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    // Without a listener, an idle client dropped by the server (pooler restart,
    // network blip) emits an unhandled 'error' event and terminates the process.
    this.pool.on('error', (error) => {
      this.logger.error(`service=messaging-service stage=db.idle_client_error code=${dbCode(error)}`);
    });
  }

  async onModuleInit(): Promise<void> {
    const result = await this.pool.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT current_user AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    const role = result.rows[0];
    if (!role || role.role_name !== RUNTIME_ROLE || role.rolsuper || role.rolbypassrls) {
      throw new Error(`Messaging service requires the non-superuser ${RUNTIME_ROLE} database role`);
    }
    const history = await this.pool.query<{ before: boolean; after: boolean }>(
      `SELECT pg_catalog.to_regprocedure(
          'internal.read_message_page(uuid,uuid,integer,timestamp with time zone,uuid)') IS NOT NULL AS before,
        pg_catalog.to_regprocedure(
          'internal.read_messages_after(uuid,uuid,integer,timestamp with time zone,uuid)') IS NOT NULL AS after`,
    );
    this.fastHistoryAvailable = history.rows[0]?.before === true;
    this.fastHistoryAfterAvailable = history.rows[0]?.after === true;
    this.logger.log(`service=messaging-service stage=db.ready role=${RUNTIME_ROLE}`);
    this.logger.log(`service=messaging-service stage=db.history_fast_path enabled=${this.fastHistoryAvailable} after=${this.fastHistoryAfterAvailable}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /** A single statement outside any actor context (replay claims, maintenance). */
  query<R extends QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<R>(text, values);
  }

  // A single server-side function call keeps actor identity transaction-local and
  // avoids a separate network round trip for each part of the history read.
  /** Older-than-cursor page (newest first), or null when the SQL function is not installed. */
  readMessagePage(actorId: string, conversationId: string, pageSize: number,
    beforeCreatedAt: string | null, beforeId: string | null, requestId?: string): Promise<MessageRow[] | null> {
    if (!this.fastHistoryAvailable) return Promise.resolve(null);
    return this.historyStatement('internal.read_message_page', [actorId, conversationId, pageSize, beforeCreatedAt, beforeId], requestId);
  }

  /** Newer-than-cursor page (oldest first), or null when the SQL function is not installed. */
  readMessagesAfter(actorId: string, conversationId: string, pageSize: number,
    afterCreatedAt: string, afterId: string, requestId?: string): Promise<MessageRow[] | null> {
    if (!this.fastHistoryAfterAvailable) return Promise.resolve(null);
    return this.historyStatement('internal.read_messages_after', [actorId, conversationId, pageSize, afterCreatedAt, afterId], requestId);
  }

  private async historyStatement(fn: 'internal.read_message_page' | 'internal.read_messages_after',
    values: unknown[], requestId?: string): Promise<MessageRow[]> {
    const started = performance.now();
    const context = `service=messaging-service requestId=${requestId ?? 'unknown'} operation=listMessages`;
    this.logger.log(`${context} stage=db.start`);
    try {
      const result = await this.pool.query<MessageRow>(
        `SELECT * FROM ${fn}($1::uuid,$2::uuid,$3::integer,$4::timestamptz,$5::uuid)`, values,
      );
      this.logger.log(`${context} stage=db.done status=ok path=single_statement durationMs=${Math.round(performance.now() - started)}`);
      return result.rows;
    } catch (error) {
      const mapped = toDomainError(error);
      this.logger.warn(`${context} stage=db.done status=error path=single_statement code=${mapped?.code ?? dbCode(error)} sqlstate=${dbCode(error)} durationMs=${Math.round(performance.now() - started)}`);
      throw mapped ?? error;
    }
  }

  /** Runs `action` in a transaction with the actor identity that RLS policies read. */
  asActor<T>(actorId: string, operation: string, requestId: string | undefined,
    action: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.withClient(operation, requestId, (client, onBroken) => runAsActor(client, actorId, action, onBroken));
  }

  /** Runs `action` in a transaction without an actor (system work such as the outbox relay). */
  transaction<T>(operation: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.withClient(operation, undefined, (client, onBroken) => runInTransaction(client, action, onBroken));
  }

  private async withClient<T>(operation: string, requestId: string | undefined,
    run: (client: PoolClient, onBroken: (error: Error) => void) => Promise<T>): Promise<T> {
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
    let broken: Error | undefined;
    try {
      const result = await run(client, (error) => { broken = error; });
      this.logger.log(`${context} stage=db.done status=ok durationMs=${Math.round(performance.now() - started)}`);
      return result;
    } catch (error) {
      const mapped = toDomainError(error);
      this.logger.warn(`${context} stage=db.done status=error code=${mapped?.code ?? dbCode(error)} sqlstate=${dbCode(error)} durationMs=${Math.round(performance.now() - started)}`);
      throw mapped ?? error;
    } finally {
      // Passing an error destroys the connection rather than returning it to the pool.
      client.release(broken);
    }
  }
}
