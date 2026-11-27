import { createHash, randomUUID } from 'node:crypto';
import { BadGatewayException, GatewayTimeoutException, HttpException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, Subscription, timeout } from 'rxjs';
import { GUARD_REJECTION, requestSchema, responseSchema, SUBJECTS, type Operation, type RequestEnvelope, type SignedPacket } from '@messaging/contracts';
import { assertFresh, requiredEnv, signPacket, verifyPacket } from '@messaging/security';
import type { Actor } from '../../security/auth.guard';

@Injectable()
export class NatsGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NatsGatewayService.name);
  private statusSubscription?: Subscription;
  private status = 'pending';
  constructor(@Inject('MESSAGING_CLIENT') private readonly client: ClientProxy) {}

  onModuleInit(): void {
    this.statusSubscription = this.client.status.subscribe((status) => {
      this.status = String(status);
      this.logger.log(`service=api-gateway stage=nats.connection status=${status}`);
    });
    // Connect eagerly so the first user request does not pay the TLS/auth handshake;
    // a failure here is retried by the client on the next request.
    this.client.connect().catch(() => {
      this.logger.warn('service=api-gateway stage=nats.connection status=initial_connect_failed');
    });
  }

  /** Latest broker connection status reported by the NestJS NATS client. */
  connectionStatus(): string { return this.status; }

  onModuleDestroy(): void { this.statusSubscription?.unsubscribe(); }

  async execute(operation: Operation, variables: Record<string, unknown>, actor: Actor): Promise<unknown> {
    const now = Date.now();
    const started = performance.now();
    const envelope = requestSchema.parse({
      version: 1, audience: 'messaging-service', requestId: actor.requestId ?? randomUUID(), issuedAt: now, expiresAt: now + 15000,
      operation, variables, actorId: actor.id, userJwt: actor.accessToken,
    }) as RequestEnvelope;
    const packet = signPacket(envelope, requiredEnv('A_PRIVATE_KEY'));
    const requestHash = createHash('sha256').update(packet.payload).digest('base64url');
    const context = `service=api-gateway requestId=${envelope.requestId} operation=${operation} subject=${SUBJECTS[operation]}`;
    this.logger.log(`${context} stage=nats.publish`);
    let signedReply: SignedPacket;
    try {
      signedReply = await firstValueFrom(
        this.client.send<SignedPacket, SignedPacket>(SUBJECTS[operation], packet).pipe(timeout(6000)),
      );
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'none';
      this.logger.warn(`${context} stage=nats.transport_error errorType=${error instanceof Error ? error.name : typeof error} code=${code} durationMs=${Math.round(performance.now() - started)}`);
      throw transportError(error, code);
    }
    let reply;
    try {
      reply = responseSchema.parse(verifyPacket(signedReply, requiredEnv('B_PUBLIC_KEY')));
      if (reply.requestId !== envelope.requestId) throw new Error('Reply correlation mismatch');
      if (reply.requestHash !== requestHash) throw new Error('Reply request hash mismatch');
      assertFresh(reply.issuedAt, reply.expiresAt);
    } catch {
      this.logger.warn(`${context} stage=nats.invalid_reply durationMs=${Math.round(performance.now() - started)}`);
      throw new BadGatewayException('Invalid messaging service reply');
    }
    if (!reply.ok) {
      this.logger.warn(`${context} stage=nats.reply status=error code=${reply.error.code} durationMs=${Math.round(performance.now() - started)}`);
      const status = { UNAUTHENTICATED: 401, FORBIDDEN: 403, VALIDATION: 400, CONFLICT: 409, NOT_FOUND: 404, UNAVAILABLE: 503 }[reply.error.code];
      throw new HttpException(reply.error.message, status);
    }
    this.logger.log(`${context} stage=nats.reply status=ok durationMs=${Math.round(performance.now() - started)}`);
    return reply.data;
  }
}

/**
 * Maps a transport-level failure (no signed reply) to an HTTP error. These replies
 * come from B's guard before verification and are not signed, so only the
 * user-session code is surfaced as 401; everything else is a gateway-side fault.
 */
export function transportError(error: unknown, code: string): HttpException {
  if (error instanceof Error && error.name === 'TimeoutError') return new GatewayTimeoutException('Messaging service timed out');
  if (code === GUARD_REJECTION.invalidUser) return new UnauthorizedException('Session is no longer valid');
  if (code === GUARD_REJECTION.invalidService || code === GUARD_REJECTION.replayed) {
    return new BadGatewayException('Messaging service rejected request');
  }
  return new ServiceUnavailableException('Messaging service unavailable');
}
