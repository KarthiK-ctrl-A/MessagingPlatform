import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { ExecutionContext } from '@nestjs/common';
import { SupabaseJwtVerifier, signPacket } from '@messaging/security';
import { MessagingRepository } from '../persistence/messaging.repository';
import { SignedRequestGuard, VerifiedRequests } from './request.guard';

test('B accepts a signed request on its intended NATS subject and rejects a wrong subject', async () => {
  const pair = generateKeyPairSync('ed25519');
  process.env.A_PUBLIC_KEY = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const actorId = 'a248c773-1cb0-4dad-b109-dfe48a094c00';
  const now = Date.now();
  const packet = signPacket({
    version: 1, audience: 'messaging-service', requestId: '98547ca7-98a5-4fdd-a9b8-84ea7986644b',
    issuedAt: now, expiresAt: now + 10000, actorId, userJwt: 'x'.repeat(20),
    operation: 'listConversations', variables: { limit: 5 },
  }, privateKey);
  const requests = new VerifiedRequests();
  const jwt = { verify: async () => actorId } as unknown as SupabaseJwtVerifier;
  const claimed = new Set<string>();
  const repository = { claimRequest: async (id: string) => {
    if (claimed.has(id)) return false;
    claimed.add(id);
    return true;
  } } as unknown as MessagingRepository;
  const guard = new SignedRequestGuard(jwt, requests, repository);
  const context = (subject: string) => ({ switchToRpc: () => ({
    getData: () => packet, getContext: () => ({ getSubject: () => subject }),
  }) }) as ExecutionContext;
  assert.equal(await guard.canActivate(context('messaging.v1.query.conversations')), true);
  assert.equal(requests.get(packet).actorId, actorId);
  await assert.rejects(guard.canActivate(context('messaging.v1.command.send')));
  await assert.rejects(guard.canActivate(context('messaging.v1.query.conversations')));
});
