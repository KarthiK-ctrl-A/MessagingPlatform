import { createHash } from 'node:crypto';

type TrackedRequest = { ip?: string; headers?: Record<string, string | string[] | undefined> };

/**
 * Per-client-IP bucket. Behind a reverse proxy, set TRUST_PROXY so `req.ip`
 * is the real client address rather than the proxy's.
 */
export function ipTracker(req: TrackedRequest): string {
  return `ip:${req.ip ?? 'unknown'}`;
}

/**
 * Per-session bucket keyed by a hash of the bearer token. The token is not
 * verified here (the AuthGuard does that), so the key must not be derived from
 * unverified claims such as `sub`: a forged token naming another user could
 * otherwise exhaust that user's bucket. Random forged tokens only spread across
 * new buckets and remain bounded by the per-IP limit.
 */
export function sessionTracker(req: TrackedRequest): string {
  const header = req.headers?.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  if (!match) return ipTracker(req);
  return `session:${createHash('sha256').update(match[1]).digest('base64url').slice(0, 32)}`;
}
