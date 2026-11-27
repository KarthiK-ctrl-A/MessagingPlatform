import { toIsoMicros } from './timestamps';

export interface ConversationRow { id: string; user_low: string; user_high: string; created_at: Date | string }
export interface MessageRow { id: string; conversation_id: string; sender_id: string; client_message_id: string; content: string; created_at: Date | string }

export function conversation(row: ConversationRow) {
  return { id: row.id, userLow: row.user_low, userHigh: row.user_high, createdAt: toIsoMicros(row.created_at) };
}
export function message(row: MessageRow) {
  return { id: row.id, conversationId: row.conversation_id, senderId: row.sender_id,
    clientMessageId: row.client_message_id, content: row.content, createdAt: toIsoMicros(row.created_at) };
}
