import assert from 'node:assert/strict';
import test from 'node:test';
import { ipTracker, sessionTracker } from './throttle-trackers';
import { trustProxySetting } from '../transport/http/trust-proxy';

test('sessions behind one clinic IP get separate throttle buckets', () => {
  const a = sessionTracker({ ip: '10.0.0.1', headers: { authorization: 'Bearer token-for-user-a' } });
  const b = sessionTracker({ ip: '10.0.0.1', headers: { authorization: 'Bearer token-for-user-b' } });
  assert.notEqual(a, b);
  assert.match(a, /^session:/);
  assert.ok(!a.includes('token-for-user-a'), 'the raw token is never used as a storage key');
});

test('requests without a bearer token fall back to the client IP', () => {
  assert.equal(sessionTracker({ ip: '203.0.113.9', headers: {} }), 'ip:203.0.113.9');
  assert.equal(ipTracker({ ip: '203.0.113.9' }), 'ip:203.0.113.9');
});

test('TRUST_PROXY accepts hop counts, booleans, and address lists', () => {
  assert.equal(trustProxySetting(undefined), false);
  assert.equal(trustProxySetting('false'), false);
  assert.equal(trustProxySetting('true'), true);
  assert.equal(trustProxySetting('1'), 1);
  assert.equal(trustProxySetting('loopback, 10.0.0.0/8'), 'loopback, 10.0.0.0/8');
});
