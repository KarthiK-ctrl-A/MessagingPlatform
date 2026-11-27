import { DomainError } from '../domain/domain-error';

/**
 * Application SQLSTATEs raised by this project's SQL functions and triggers
 * (see supabase/migrations/20261128_error_codes.sql). Their messages are
 * authored in this repository and are safe to return to clients.
 */
const APPLICATION_CODES: Record<string, DomainError['code']> = {
  MP400: 'VALIDATION',
  MP403: 'FORBIDDEN',
  MP404: 'NOT_FOUND',
};

/** Standard PostgreSQL SQLSTATEs that carry a client-meaningful outcome. */
const STANDARD_CODES: Record<string, [DomainError['code'], string]> = {
  '42501': ['FORBIDDEN', 'Not permitted for this conversation'], // RLS / privilege violation
  P0002: ['NOT_FOUND', 'Conversation not found'],
  '22023': ['VALIDATION', 'Invalid request'],
  '23505': ['CONFLICT', 'Request conflicts with existing data'],
};

/** Messages raised before the SQLSTATE migration was applied (default P0001). */
const LEGACY_MESSAGES: [RegExp, DomainError['code'], string][] = [
  [/Recipient is not the current doctor or patient|Invalid conversation users/, 'VALIDATION', 'Invalid recipient'],
  [/Current doctor assignment required|Sender is not a conversation participant/, 'FORBIDDEN', 'Not permitted for this conversation'],
  [/Conversation unavailable/, 'NOT_FOUND', 'Conversation not found'],
  [/Conversation identifiers do not match|Patient and doctor are required/, 'VALIDATION', 'Invalid request'],
];

export function dbCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? code : 'unknown';
}

/** Converts a known database failure into a typed domain error; returns undefined otherwise. */
export function toDomainError(error: unknown): DomainError | undefined {
  if (error instanceof DomainError) return error;
  const code = dbCode(error);
  const message = error instanceof Error ? error.message : '';
  const application = APPLICATION_CODES[code];
  if (application) return new DomainError(application, message || 'Request rejected');
  const standard = STANDARD_CODES[code];
  if (standard) return new DomainError(standard[0], standard[1]);
  if (code === 'P0001') {
    const legacy = LEGACY_MESSAGES.find(([pattern]) => pattern.test(message));
    if (legacy) return new DomainError(legacy[1], legacy[2]);
  }
  return undefined;
}
