export const schemaText = `
  type Conversation { id: ID!, userLow: ID!, userHigh: ID!, createdAt: String! }
  type Message { id: ID!, conversationId: ID!, senderId: ID!, clientMessageId: ID!, content: String!, createdAt: String! }
  type MessagePage { items: [Message!]!, nextCursor: String }
  type CareContact { userId: ID!, fullName: String! }
  type CareContacts { role: String!, contacts: [CareContact!]! }
  type Query {
    careContacts: CareContacts!
    conversations(limit: Int!): [Conversation!]!
    messages(conversationId: ID!, limit: Int!, before: String): MessagePage!
  }
  type Mutation {
    createConversation(otherUserId: ID!): Conversation!
    openCurrentDoctor: Conversation!
    sendMessage(conversationId: ID!, clientMessageId: ID!, content: String!): Message!
  }
`;

