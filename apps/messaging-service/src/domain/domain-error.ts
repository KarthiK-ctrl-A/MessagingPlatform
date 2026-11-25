import type { ResponseEnvelope } from '@messaging/contracts';

export type ErrorCode = Extract<ResponseEnvelope, { ok: false }>['error']['code'];

export class DomainError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
  }
}
