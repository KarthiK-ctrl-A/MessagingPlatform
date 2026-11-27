import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { assertFresh, assertServiceKeys, natsTlsOptions, signPacket, verifyPacket } from './index';

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

test('service keys are validated at startup', () => {
  const pair = generateKeyPairSync('ed25519');
  process.env.TEST_PRIVATE_KEY = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  process.env.TEST_PUBLIC_KEY = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.doesNotThrow(() => assertServiceKeys('TEST_PRIVATE_KEY', 'TEST_PUBLIC_KEY'));
  delete process.env.TEST_PUBLIC_KEY;
  assert.throws(() => assertServiceKeys('TEST_PRIVATE_KEY', 'TEST_PUBLIC_KEY'), /TEST_PUBLIC_KEY is required/);
  process.env.TEST_PUBLIC_KEY = 'bm90LWEta2V5';
  assert.throws(() => assertServiceKeys('TEST_PRIVATE_KEY', 'TEST_PUBLIC_KEY'));
});

test('NATS TLS is optional locally and mandatory in production', () => {
  assert.equal(natsTlsOptions({}), undefined);
  assert.throws(() => natsTlsOptions({ NODE_ENV: 'production' }), /NATS_TLS_CA_FILE is required/);
  assert.deepEqual(natsTlsOptions({ NATS_TLS_CA_FILE: 'ca.pem' }), { caFile: 'ca.pem' });
  assert.deepEqual(natsTlsOptions({ NATS_TLS_CA_FILE: 'ca.pem', NATS_TLS_CERT_FILE: 'c.pem', NATS_TLS_KEY_FILE: 'k.pem' }),
    { caFile: 'ca.pem', certFile: 'c.pem', keyFile: 'k.pem' });
  assert.throws(() => natsTlsOptions({ NATS_TLS_CA_FILE: 'ca.pem', NATS_TLS_CERT_FILE: 'c.pem' }), /both/);
});
