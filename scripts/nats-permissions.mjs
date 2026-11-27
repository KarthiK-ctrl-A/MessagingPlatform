import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// NATS user permissions for each service identity. Subjects come from
// @messaging/contracts so broker permissions cannot drift from the handlers.
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const contractsPath = resolve(repo, 'packages/contracts/dist/index.js');
if (!existsSync(contractsPath)) throw new Error('Run `npm run build` first: NATS permissions are generated from @messaging/contracts');
const { REQUEST_SUBJECTS, EVENT_SUBJECT_WILDCARD } = createRequire(import.meta.url)(contractsPath);
if (!Array.isArray(REQUEST_SUBJECTS) || typeof EVENT_SUBJECT_WILDCARD !== 'string') {
  throw new Error('packages/contracts/dist is out of date: run `npm run build` first');
}

/** `auth-probe` is used only by scripts/verify-nats-auth.mjs. */
export const requestSubjects = [...REQUEST_SUBJECTS, 'messaging.v1.query.auth-probe'];
export const MAX_PAYLOAD = 65536;

export const userPermissions = {
  // Gateway: send requests, read its own reply inbox, receive live events.
  gateway: {
    pub: { allow: requestSubjects },
    sub: { allow: ['_INBOX.gateway.>', EVENT_SUBJECT_WILDCARD] },
    payload: MAX_PAYLOAD,
  },
  // Worker: receive requests, reply once per request, publish live events only.
  worker: {
    pub: { allow: [EVENT_SUBJECT_WILDCARD] },
    sub: { allow: requestSubjects },
    resp: { max: 1, ttl: 10_000_000_000 },
    payload: MAX_PAYLOAD,
  },
};
