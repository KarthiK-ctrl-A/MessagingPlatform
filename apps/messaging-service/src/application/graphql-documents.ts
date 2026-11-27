import type { RequestEnvelope } from '@messaging/contracts';

export const documents: Record<RequestEnvelope['operation'], string> = {
  careContacts: `query { careContacts { role contacts { userId fullName } } }`,
  openCurrentDoctor: `mutation {
    openCurrentDoctor { id userLow userHigh createdAt }
  }`,
  createConversation: `mutation($otherUserId: ID!) {
    createConversation(otherUserId: $otherUserId) { id userLow userHigh createdAt }
  }`,
  listConversations: `query($limit: Int!) {
    conversations(limit: $limit) { id userLow userHigh createdAt }
  }`,
  sendMessage: `mutation($conversationId: ID!, $clientMessageId: ID!, $content: String!) {
    sendMessage(conversationId: $conversationId, clientMessageId: $clientMessageId, content: $content) {
      id conversationId senderId clientMessageId content createdAt
    }
  }`,
  listMessages: `query($conversationId: ID!, $limit: Int!, $before: String, $after: String) {
    messages(conversationId: $conversationId, limit: $limit, before: $before, after: $after) {
      items { id conversationId senderId clientMessageId content createdAt }
      nextCursor
      latestCursor
    }
  }`,
};

