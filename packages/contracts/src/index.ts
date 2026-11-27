import { z } from 'zod';

export const SUBJECTS = {
  careContacts: 'messaging.v1.query.care-contacts',
  createConversation: 'messaging.v1.command.create-conversation',
  openCurrentDoctor: 'messaging.v1.command.open-current-doctor',
  listConversations: 'messaging.v1.query.conversations',
  sendMessage: 'messaging.v1.command.send',
  listMessages: 'messaging.v1.query.history',
} as const;

/** Every request subject; the single source for NATS permissions and handlers. */
export const REQUEST_SUBJECTS: readonly string[] = Object.values(SUBJECTS);

/**
 * Codes B's request guard returns before a request is verified (these replies
 * are not signed because no trusted request exists yet). Only `UNAUTHENTICATED`
 * is attributable to the end user; the others indicate a service-side fault.
 */
export const GUARD_REJECTION = {
  invalidUser: 'UNAUTHENTICATED',
  invalidService: 'INVALID_SERVICE_REQUEST',
  replayed: 'REPLAYED_REQUEST',
  unavailable: 'UNAVAILABLE',
} as const;

export const uuid = z.uuid();

const baseRequest = z.object({
  version: z.literal(1),
  audience: z.literal('messaging-service'),
  requestId: uuid,
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  actorId: uuid,
  userJwt: z.string().min(20),
});

export const requestSchema = z.discriminatedUnion('operation', [
  baseRequest.extend({
    operation: z.literal('careContacts'),
    variables: z.object({}).strict(),
  }).strict(),
  baseRequest.extend({
    operation: z.literal('openCurrentDoctor'),
    variables: z.object({}).strict(),
  }).strict(),
  baseRequest.extend({
    operation: z.literal('createConversation'),
    variables: z.object({ otherUserId: uuid }).strict(),
  }).strict(),
  baseRequest.extend({
    operation: z.literal('listConversations'),
    variables: z.object({ limit: z.number().int().min(1).max(50) }).strict(),
  }).strict(),
  baseRequest.extend({
    operation: z.literal('sendMessage'),
    variables: z.object({
      conversationId: uuid,
      clientMessageId: uuid,
      content: z.string().trim().min(1).max(2000),
    }).strict(),
  }).strict(),
  baseRequest.extend({
    operation: z.literal('listMessages'),
    variables: z.object({
      conversationId: uuid,
      limit: z.number().int().min(1).max(50),
      before: z.string().max(256).optional(),
    }).strict(),
  }).strict(),
]);

export type RequestEnvelope = z.infer<typeof requestSchema>;
export type Operation = RequestEnvelope['operation'];

export const signedPacketSchema = z.object({
  payload: z.string().min(1).max(65536),
  signature: z.string().min(40).max(256),
}).strict();
export type SignedPacket = z.infer<typeof signedPacketSchema>;

export const responseSchema = z.discriminatedUnion('ok', [
  z.object({ audience: z.literal('api-gateway'), requestId: uuid, requestHash: z.string().length(43), issuedAt: z.number().int(), expiresAt: z.number().int(), ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({ audience: z.literal('api-gateway'), requestId: uuid, requestHash: z.string().length(43), issuedAt: z.number().int(), expiresAt: z.number().int(), ok: z.literal(false), error: z.object({
    code: z.enum(['UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION', 'CONFLICT', 'NOT_FOUND', 'UNAVAILABLE']),
    message: z.string(),
  }).strict() }).strict(),
]);
export type ResponseEnvelope = z.infer<typeof responseSchema>;

const cursorSchema = z.object({ createdAt: z.iso.datetime({ offset: true }), id: uuid }).strict();
export type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(value: string): Cursor {
  if (value.length > 256) throw new Error('Invalid cursor');
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new Error('Invalid cursor');
  }
}
