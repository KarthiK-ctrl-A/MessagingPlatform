import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { ClientProxy } from '@nestjs/microservices';
import { of } from 'rxjs';
import { signPacket, verifyPacket } from '@messaging/security';
import { NatsGatewayService } from './nats-gateway.service';

test('A signs its request and accepts only B signed reply with matching request ID', async () => {
  const a = generateKeyPairSync('ed25519');
  const b = generateKeyPairSync('ed25519');
  process.env.A_PRIVATE_KEY = a.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  process.env.B_PUBLIC_KEY = b.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const aPublic = a.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const bPrivate = b.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const client = {
    send: (_subject: string, packet: unknown) => {
      const request = verifyPacket(packet, aPublic) as { requestId: string; operation: string };
      assert.equal(request.operation, 'listConversations');
      assert.equal(request.requestId, '98547ca7-98a5-4fdd-a9b8-84ea7986644b');
      const now = Date.now();
      const requestHash = createHash('sha256').update((packet as { payload: string }).payload).digest('base64url');
      return of(signPacket({ audience: 'api-gateway', requestId: request.requestId, requestHash, issuedAt: now, expiresAt: now + 15000, ok: true, data: [] }, bPrivate));
    },
  } as ClientProxy;
  const gateway = new NatsGatewayService(client);
  const result = await gateway.execute('listConversations', { limit: 5 }, {
    id: 'a248c773-1cb0-4dad-b109-dfe48a094c00', accessToken: 'x'.repeat(20),
    requestId: '98547ca7-98a5-4fdd-a9b8-84ea7986644b',
  });
  assert.deepEqual(result, []);

  const wrongReply = { send: (_subject: string, packet: unknown) => {
    const request = verifyPacket(packet, aPublic) as { requestId: string };
    const now = Date.now();
    return of(signPacket({ audience: 'api-gateway', requestId: request.requestId, requestHash: '0'.repeat(43),
      issuedAt: now, expiresAt: now + 15000, ok: true, data: [] }, bPrivate));
  } } as ClientProxy;
  await assert.rejects(new NatsGatewayService(wrongReply).execute('listConversations', { limit: 5 }, {
    id: 'a248c773-1cb0-4dad-b109-dfe48a094c00', accessToken: 'x'.repeat(20),
  }), /Invalid messaging service reply/);
});
