export type ChatConversationRecord = {
  id: string
  userId: string | null
  title: string
  scope: string
  projectId: string | null
  projectName: string | null
  agentId: string | null
  messages: unknown[]
  createdAt: Date
  updatedAt: Date
}

export type AgentConversationRecord = {
  id: string
  userId: string
  projectId: string | null
  title: string
  scope: string
  status: string
  runtime: string
  externalSessionId: string | null
  legacySource: string | null
  legacyConversationId: string | null
  modelId: string | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export type AgentMessageRecord = {
  id: string
  conversationId: string
  externalMessageId: string | null
  role: string
  sequence: number
  content: string | null
  toolName: string | null
  toolInput: unknown
  toolOutput: unknown
  thinking: string | null
  status: string
  createdAt: Date
}

export type AgentMessagePartRecord = {
  id: string
  messageId: string
  partIndex: number
  type: string
  content: string | null
  payload: unknown
  createdAt: Date
}

export type SaveAgentMessageInput = {
  conversationId: string
  externalMessageId: string
  role: string
  content?: string | null
  thinking?: string | null
  toolName?: string | null
  toolInput?: unknown
  toolOutput?: unknown
  status?: string
  preserveTerminalStatus?: boolean
  parts?: Array<{ type: string; content?: string | null; payload?: unknown }>
}

export type CreateConversationPairInput = {
  id: string
  userId: string
  title: string
  scope: string
  projectId: string | null
  projectName: string | null
  externalSessionId: string
  modelId: string | null
}

export type InterruptedAgentRecovery = {
  conversations: number
  messages: number
  parts: number
}

export interface AgentConversationRepository {
  listChatsForUser(userId: string, limit?: number): Promise<ChatConversationRecord[]>
  findChatByIdForUser(userId: string, conversationId: string): Promise<ChatConversationRecord | null>
  findChatByAgentForUser(userId: string, agentId: string): Promise<ChatConversationRecord | null>
  findAgentById(conversationId: string): Promise<AgentConversationRecord | null>
  findOwnedAgentById(userId: string, conversationId: string): Promise<AgentConversationRecord | null>
  findAgentModels(conversationIds: string[]): Promise<Array<{ id: string; modelId: string | null }>>
  listRecentAgents(limit?: number): Promise<AgentConversationRecord[]>
  ensureAgentFromChat(chat: ChatConversationRecord): Promise<AgentConversationRecord>
  createConversationPair(input: CreateConversationPairInput): Promise<ChatConversationRecord>
  renameConversationPair(userId: string, conversationId: string, title: string): Promise<ChatConversationRecord | null>
  appendChatMessages(userId: string, conversationId: string, messages: unknown[], title?: string): Promise<ChatConversationRecord | null>
  deleteConversationPair(userId: string, conversationId: string): Promise<boolean>
  findMessageByExternalId(conversationId: string, externalMessageId: string): Promise<AgentMessageRecord | null>
  saveMessage(input: SaveAgentMessageInput): Promise<AgentMessageRecord>
  listMessagesWithParts(conversationId: string): Promise<Array<{
    message: AgentMessageRecord
    parts: AgentMessagePartRecord[]
  }>>
  mergeConversationState(
    conversationId: string,
    status: string,
    metadataPatch?: Record<string, unknown>,
  ): Promise<AgentConversationRecord | null>
  updateModelForOwner(input: {
    conversationId: string
    userId: string
    modelId: string | null
    metadataPatch: Record<string, unknown>
    updatedAt: Date
  }): Promise<boolean>
  interruptRunningTools(input: {
    conversationId: string
    reason: string
    interruptedAt: Date
    partErrorText: string
  }): Promise<number>
  recoverStreamingSessions(input: {
    interruptedAt: Date
    partErrorText: string
    metadataFor: (conversation: AgentConversationRecord) => Record<string, unknown>
  }): Promise<InterruptedAgentRecovery>
}
