import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { signedPacketSchema, type SignedPacket } from '@messaging/contracts';

import { requiredEnv } from './env';

export { requiredEnv } from './env';
export { natsConnectionOptions, natsTlsOptions, type NatsTlsOptions } from './nats';

/** Fails fast at startup if a required signing or verification key is missing or malformed. */
export function assertServiceKeys(privateKeyVariable: string, publicKeyVariable: string): void {
  parsePrivateKey(requiredEnv(privateKeyVariable));
  parsePublicKey(requiredEnv(publicKeyVariable));
}

// Parsing DER keys is comparatively expensive; cache by the encoded key so a
// rotated environment value still takes effect.
const privateKeys = new Map<string, KeyObject>();
const publicKeys = new Map<string, KeyObject>();

export function parsePrivateKey(privateKeyBase64: string): KeyObject {
  let key = privateKeys.get(privateKeyBase64);
  if (!key) {
    key = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Service signing key must be Ed25519');
    privateKeys.set(privateKeyBase64, key);
  }
  return key;
}

export function parsePublicKey(publicKeyBase64: string): KeyObject {
  let key = publicKeys.get(publicKeyBase64);
  if (!key) {
    key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Service verification key must be Ed25519');
    publicKeys.set(publicKeyBase64, key);
  }
  return key;
}

export function signPacket(value: unknown, privateKeyBase64: string): SignedPacket {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = sign(null, Buffer.from(payload), parsePrivateKey(privateKeyBase64)).toString('base64url');
  return { payload, signature };
}

export function verifyPacket(packet: unknown, publicKeyBase64: string): unknown {
  const parsed = signedPacketSchema.parse(packet);
  const valid = verify(null, Buffer.from(parsed.payload), parsePublicKey(publicKeyBase64),
    Buffer.from(parsed.signature, 'base64url'));
  if (!valid) throw new Error('Invalid service signature');
  return JSON.parse(Buffer.from(parsed.payload, 'base64url').toString('utf8')) as unknown;
}

export function assertFresh(issuedAt: number, expiresAt: number, now = Date.now()): void {
  if (issuedAt > now + 5000 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > 30000) {
    throw new Error('Expired or invalid request time');
  }
}

export class SupabaseJwtVerifier {
  private readonly jwks;
  private readonly issuer: string;

  constructor(supabaseUrl: string) {
    const base = supabaseUrl.replace(/\/$/, '');
    this.issuer = `${base}/auth/v1`;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  }

  async verify(token: string): Promise<string> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.issuer,
      audience: 'authenticated',
    });
    if (typeof payload.sub !== 'string') throw new Error('Missing user identity');
    return payload.sub;
  }
}
