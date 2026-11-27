import { createHash } from 'node:crypto';
import { Controller, Logger, UseGuards } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { SUBJECTS, type ResponseEnvelope, type SignedPacket } from '@messaging/contracts';
import { requiredEnv, signPacket } from '@messaging/security';
import { DomainError } from '../../domain/domain-error';
import { GraphqlExecutorService } from '../../application/graphql-executor.service';
import { SignedRequestGuard, VerifiedRequests } from '../../security/request.guard';

@Controller()
@UseGuards(SignedRequestGuard)
export class NatsController {
  private readonly logger = new Logger(NatsController.name);
  constructor(private readonly verified: VerifiedRequests, private readonly graphql: GraphqlExecutorService) {}
  @MessagePattern(SUBJECTS.createConversation)
  create(@Payload() packet: SignedPacket) { return this.handle(packet); }
  @MessagePattern(SUBJECTS.openCurrentDoctor)
  openCurrentDoctor(@Payload() packet: SignedPacket) { return this.handle(packet); }
  @MessagePattern(SUBJECTS.careContacts)
  careContacts(@Payload() packet: SignedPacket) { return this.handle(packet); }
  @MessagePattern(SUBJECTS.listConversations)
  conversations(@Payload() packet: SignedPacket) { return this.handle(packet); }
  @MessagePattern(SUBJECTS.sendMessage)
  send(@Payload() packet: SignedPacket) { return this.handle(packet); }
  @MessagePattern(SUBJECTS.listMessages)
  history(@Payload() packet: SignedPacket) { return this.handle(packet); }
  private async handle(packet: SignedPacket): Promise<SignedPacket> {
    const request = this.verified.get(packet);
    const started = performance.now();
    const context = `service=messaging-service requestId=${request.requestId} operation=${request.operation}`;
    this.logger.log(`${context} stage=handler.start`);
    const issuedAt = Date.now();
    const replyBase = { audience: 'api-gateway' as const, requestId: request.requestId,
      requestHash: createHash('sha256').update(packet.payload).digest('base64url'),
      issuedAt, expiresAt: issuedAt + 15000 };
    let response: ResponseEnvelope;
    try {
      response = { ...replyBase, ok: true, data: await this.graphql.execute(request) };
      this.logger.log(`${context} stage=handler.done status=ok durationMs=${Math.round(performance.now() - started)}`);
    } catch (error) {
      const known = error instanceof DomainError ? error : new DomainError('UNAVAILABLE', 'Messaging operation failed');
      response = { ...replyBase, ok: false, error: { code: known.code, message: known.message } };
      this.logger.warn(`${context} stage=handler.done status=error code=${known.code} durationMs=${Math.round(performance.now() - started)}`);
    }
    return signPacket(response, requiredEnv('B_PRIVATE_KEY'));
  }
}
