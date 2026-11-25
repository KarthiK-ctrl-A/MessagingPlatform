import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { NatsContext, RpcException } from '@nestjs/microservices';
import { requestSchema, SUBJECTS, type RequestEnvelope } from '@messaging/contracts';
import { assertFresh, SupabaseJwtVerifier, verifyPacket } from '@messaging/security';
import { MessagingRepository } from '../persistence/messaging.repository';

@Injectable()
export class VerifiedRequests {
  private readonly values = new WeakMap<object, RequestEnvelope>();

  set(packet: object, value: RequestEnvelope): void { this.values.set(packet, value); }
  get(packet: object): RequestEnvelope {
    const value = this.values.get(packet);
    if (!value) throw new RpcException({ code: 'UNAUTHENTICATED', message: 'Request was not verified' });
    return value;
  }
}

@Injectable()
export class SignedRequestGuard implements CanActivate {
  private readonly logger = new Logger(SignedRequestGuard.name);
  constructor(private readonly jwt: SupabaseJwtVerifier, private readonly requests: VerifiedRequests,
    private readonly repository: MessagingRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    let request: RequestEnvelope;
    let subject = 'unknown';
    const started = performance.now();
    try {
      const nats = context.switchToRpc().getContext<NatsContext>();
      subject = nats.getSubject();
      this.logger.log(`service=messaging-service stage=nats.received subject=${subject}`);
      const packet = context.switchToRpc().getData<unknown>();
      if (!packet || typeof packet !== 'object') throw new Error('Invalid packet');
      request = requestSchema.parse(verifyPacket(packet, required('A_PUBLIC_KEY')));
      assertFresh(request.issuedAt, request.expiresAt);
      if (subject !== SUBJECTS[request.operation]) throw new Error('Operation subject mismatch');
      const userId = await this.jwt.verify(request.userJwt);
      if (userId !== request.actorId) throw new Error('Actor mismatch');
    } catch (error) {
      this.logger.warn(`service=messaging-service stage=nats.reject subject=${subject} reason=invalid_service_or_user durationMs=${Math.round(performance.now() - started)}`);
      throw new RpcException({ code: 'UNAUTHENTICATED', message: 'Invalid service or user request' });
    }
    try {
      if (!await this.repository.claimRequest(request.requestId, request.expiresAt)) {
        this.logger.warn(`service=messaging-service stage=replay.reject requestId=${request.requestId} operation=${request.operation} reason=duplicate`);
        throw new RpcException({ code: 'UNAUTHENTICATED', message: 'Replayed request' });
      }
    } catch (error) {
      if (error instanceof RpcException) throw error;
      this.logger.error(`service=messaging-service stage=replay.reject requestId=${request.requestId} operation=${request.operation} reason=database_unavailable`);
      throw new RpcException({ code: 'UNAVAILABLE', message: 'Request replay check unavailable' });
    }
    const packet = context.switchToRpc().getData<object>();
    this.requests.set(packet, request);
    this.logger.log(`service=messaging-service stage=nats.verified requestId=${request.requestId} operation=${request.operation} durationMs=${Math.round(performance.now() - started)}`);
    return true;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
