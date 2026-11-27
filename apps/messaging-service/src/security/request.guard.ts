import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { NatsContext, RpcException } from '@nestjs/microservices';
import { GUARD_REJECTION, requestSchema, SUBJECTS, type RequestEnvelope } from '@messaging/contracts';
import { assertFresh, requiredEnv, SupabaseJwtVerifier, verifyPacket } from '@messaging/security';
import { ReplayStore } from '../persistence/replay.store';

@Injectable()
export class VerifiedRequests {
  private readonly values = new WeakMap<object, RequestEnvelope>();

  set(packet: object, value: RequestEnvelope): void { this.values.set(packet, value); }
  get(packet: object): RequestEnvelope {
    const value = this.values.get(packet);
    if (!value) throw new RpcException({ code: GUARD_REJECTION.invalidService, message: 'Request was not verified' });
    return value;
  }
}

type RejectionReason = 'invalid_packet' | 'invalid_signature_or_schema' | 'expired' | 'subject_mismatch'
  | 'invalid_user_token' | 'actor_mismatch';

class Rejection extends Error {
  constructor(readonly reason: RejectionReason, readonly userFacing: boolean) { super(reason); }
}

@Injectable()
export class SignedRequestGuard implements CanActivate {
  private readonly logger = new Logger(SignedRequestGuard.name);
  constructor(private readonly jwt: SupabaseJwtVerifier, private readonly requests: VerifiedRequests,
    private readonly replay: ReplayStore) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const started = performance.now();
    const rpc = context.switchToRpc();
    let subject = 'unknown';
    let request: RequestEnvelope;
    try {
      subject = rpc.getContext<NatsContext>().getSubject();
      this.logger.log(`service=messaging-service stage=nats.received subject=${subject}`);
      request = await this.verify(rpc.getData<unknown>(), subject);
    } catch (error) {
      const rejection = error instanceof Rejection ? error : new Rejection('invalid_packet', false);
      this.logger.warn(`service=messaging-service stage=nats.reject subject=${subject} reason=${rejection.reason} durationMs=${Math.round(performance.now() - started)}`);
      throw rejection.userFacing
        ? new RpcException({ code: GUARD_REJECTION.invalidUser, message: 'Invalid user session' })
        : new RpcException({ code: GUARD_REJECTION.invalidService, message: 'Invalid service request' });
    }

    let claimed: boolean;
    try {
      claimed = await this.replay.claim(request.requestId, request.expiresAt);
    } catch {
      this.logger.error(`service=messaging-service stage=replay.reject requestId=${request.requestId} operation=${request.operation} reason=database_unavailable`);
      throw new RpcException({ code: GUARD_REJECTION.unavailable, message: 'Request replay check unavailable' });
    }
    if (!claimed) {
      this.logger.warn(`service=messaging-service stage=replay.reject requestId=${request.requestId} operation=${request.operation} reason=duplicate`);
      throw new RpcException({ code: GUARD_REJECTION.replayed, message: 'Replayed request' });
    }

    this.requests.set(rpc.getData<object>(), request);
    this.logger.log(`service=messaging-service stage=nats.verified requestId=${request.requestId} operation=${request.operation} durationMs=${Math.round(performance.now() - started)}`);
    return true;
  }

  private async verify(packet: unknown, subject: string): Promise<RequestEnvelope> {
    if (!packet || typeof packet !== 'object') throw new Rejection('invalid_packet', false);
    let request: RequestEnvelope;
    try {
      request = requestSchema.parse(verifyPacket(packet, requiredEnv('A_PUBLIC_KEY')));
    } catch { throw new Rejection('invalid_signature_or_schema', false); }
    try { assertFresh(request.issuedAt, request.expiresAt); }
    catch { throw new Rejection('expired', false); }
    if (subject !== SUBJECTS[request.operation]) throw new Rejection('subject_mismatch', false);
    let userId: string;
    // The gateway verified this token moments ago, so a failure here is almost
    // always expiry in transit: report it as a user-session problem (HTTP 401).
    try { userId = await this.jwt.verify(request.userJwt); }
    catch { throw new Rejection('invalid_user_token', true); }
    if (userId !== request.actorId) throw new Rejection('actor_mismatch', false);
    return request;
  }
}
