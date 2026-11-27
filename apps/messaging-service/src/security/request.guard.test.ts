import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { ExecutionContext } from '@nestjs/common';
import { SupabaseJwtVerifier, signPacket } from '@messaging/security';
import type { ReplayStore } from '../persistence/replay.store';
import { SignedRequestGuard, VerifiedRequests } from './request.guard';

const actorId = 'a248c773-1cb0-4dad-b109-dfe48a094c00';
const pair = generateKeyPairSync('ed25519');
process.env.A_PUBLIC_KEY = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

function packetFor(requestId: string, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return signPacket({
    version: 1, audience: 'messaging-service', requestId,
    issuedAt: now, expiresAt: now + 10000, actorId, userJwt: 'x'.repeat(20),
    operation: 'listConversations', variables: { limit: 5 }, ...overrides,
  }, privateKey);
}

function contextFor(packet: object, subject: string) {
  return { switchToRpc: () => ({
    getData: () => packet, getContext: () => ({ getSubject: () => subject }),
  }) } as unknown as ExecutionContext;
}

function guardWith(options: { verify?: () => Promise<string>; claim?: (id: string) => Promise<boolean> } = {}) {
  const requests = new VerifiedRequests();
  const jwt = { verify: options.verify ?? (async () => actorId) } as unknown as SupabaseJwtVerifier;
  const claimed = new Set<string>();
  const replay = { claim: options.claim ?? (async (id: string) => {
    if (claimed.has(id)) return false;
    claimed.add(id);
    return true;
  }) } as unknown as ReplayStore;
  return { guard: new SignedRequestGuard(jwt, requests, replay), requests };
}

test('B accepts a signed request on its intended subject, then rejects a wrong subject and a replay', async () => {
  const packet = packetFor('98547ca7-98a5-4fdd-a9b8-84ea7986644b');
  const { guard, requests } = guardWith();
  assert.equal(await guard.canActivate(contextFor(packet, 'messaging.v1.query.conversations')), true);
  assert.equal(requests.get(packet).actorId, actorId);
  await assert.rejects(guard.canActivate(contextFor(packet, 'messaging.v1.command.send')),
    (error: { getError(): { code: string } }) => error.getError().code === 'INVALID_SERVICE_REQUEST');
  await assert.rejects(guard.canActivate(contextFor(packet, 'messaging.v1.query.conversations')),
    (error: { getError(): { code: string } }) => error.getError().code === 'REPLAYED_REQUEST');
});

test('an expired or invalid user token is reported as a user-session failure', async () => {
  const { guard } = guardWith({ verify: async () => { throw new Error('"exp" claim timestamp check failed'); } });
  await assert.rejects(guard.canActivate(contextFor(packetFor('0f6e2a4c-56e1-4a46-9d2a-2a4cbc5f3c11'), 'messaging.v1.query.conversations')),
    (error: { getError(): { code: string } }) => error.getError().code === 'UNAUTHENTICATED');
});

test('a token for a different user than the signed actor is a service fault', async () => {
  const { guard } = guardWith({ verify: async () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  await assert.rejects(guard.canActivate(contextFor(packetFor('2b0dfc0e-5d0b-4a4b-8b8e-6b1c1d9f9e01'), 'messaging.v1.query.conversations')),
    (error: { getError(): { code: string } }) => error.getError().code === 'INVALID_SERVICE_REQUEST');
});

test('a tampered packet and an unavailable replay store are rejected', async () => {
  const packet = packetFor('5f1c6c0e-1b7c-4d1f-9a55-0f6d0d7a1b22');
  const tampered = { ...packet, payload: Buffer.from('{"forged":true}').toString('base64url') };
  const { guard } = guardWith({ claim: async () => { throw new Error('connection refused'); } });
  await assert.rejects(guard.canActivate(contextFor(tampered, 'messaging.v1.query.conversations')),
    (error: { getError(): { code: string } }) => error.getError().code === 'INVALID_SERVICE_REQUEST');
  await assert.rejects(guard.canActivate(contextFor(packet, 'messaging.v1.query.conversations')),
    (error: { getError(): { code: string } }) => error.getError().code === 'UNAVAILABLE');
});
