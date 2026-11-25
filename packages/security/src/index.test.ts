import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { assertFresh, signPacket, verifyPacket } from './index';

test('signed packets reject tampering and wrong keys', () => {
  const pair = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const otherKey = other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const packet = signPacket({ operation: 'sendMessage', content: 'hello' }, privateKey);
  assert.deepEqual(verifyPacket(packet, publicKey), { operation: 'sendMessage', content: 'hello' });
  assert.throws(() => verifyPacket(packet, otherKey), /Invalid service signature/);
  assert.throws(() => verifyPacket({ ...packet, payload: Buffer.from('{}').toString('base64url') }, publicKey));
});

test('freshness rejects expired and overly long windows', () => {
  const now = Date.now();
  assert.doesNotThrow(() => assertFresh(now, now + 15000, now));
  assert.throws(() => assertFresh(now - 20000, now - 1, now));
  assert.throws(() => assertFresh(now, now + 60000, now));
});
