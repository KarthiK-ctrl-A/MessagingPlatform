import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { signedPacketSchema, type SignedPacket } from '@messaging/contracts';

export function signPacket(value: unknown, privateKeyBase64: string): SignedPacket {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const key = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' });
  const signature = sign(null, Buffer.from(payload), key).toString('base64url');
  return { payload, signature };
}

export function verifyPacket(packet: unknown, publicKeyBase64: string): unknown {
  const parsed = signedPacketSchema.parse(packet);
  const key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
  const valid = verify(null, Buffer.from(parsed.payload), key, Buffer.from(parsed.signature, 'base64url'));
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
