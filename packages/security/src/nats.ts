import { readFileSync } from 'node:fs';
import { connect, credsAuthenticator, type NatsConnection } from '@nats-io/transport-node';
import { requiredEnv } from './env';

export interface NatsTlsOptions { caFile: string; certFile?: string; keyFile?: string }

/**
 * TLS settings for the NATS connection. When NATS_TLS_CA_FILE is set the client
 * verifies the broker certificate against that CA (and presents a client
 * certificate if NATS_TLS_CERT_FILE/NATS_TLS_KEY_FILE are set). Production
 * refuses to start without TLS because envelopes carry message content and
 * user access tokens.
 */
export function natsTlsOptions(env: NodeJS.ProcessEnv = process.env): NatsTlsOptions | undefined {
  const caFile = env.NATS_TLS_CA_FILE;
  if (!caFile) {
    if (env.NODE_ENV === 'production' || env.NATS_REQUIRE_TLS === 'true') {
      throw new Error('NATS_TLS_CA_FILE is required when NODE_ENV=production or NATS_REQUIRE_TLS=true');
    }
    return undefined;
  }
  if (Boolean(env.NATS_TLS_CERT_FILE) !== Boolean(env.NATS_TLS_KEY_FILE)) {
    throw new Error('Set both NATS_TLS_CERT_FILE and NATS_TLS_KEY_FILE, or neither');
  }
  return {
    caFile,
    ...(env.NATS_TLS_CERT_FILE ? { certFile: env.NATS_TLS_CERT_FILE, keyFile: env.NATS_TLS_KEY_FILE } : {}),
  };
}

/** Shared NATS connection options for a service identified by its `.creds` file variable. */
export function natsConnectionOptions(credentialsVariable: string) {
  const tls = natsTlsOptions();
  return {
    servers: [process.env.NATS_URL ?? 'nats://127.0.0.1:4222'],
    authenticator: credsAuthenticator(readFileSync(requiredEnv(credentialsVariable))),
    ...(tls ? { tls } : {}),
  };
}

/**
 * A plain NATS connection (outside the NestJS transport) for publishing or
 * subscribing to live events. Reconnects indefinitely; callers drain it on shutdown.
 */
export function connectNats(credentialsVariable: string, name: string): Promise<NatsConnection> {
  return connect({ ...natsConnectionOptions(credentialsVariable), name, maxReconnectAttempts: -1, reconnectTimeWait: 1000 });
}
