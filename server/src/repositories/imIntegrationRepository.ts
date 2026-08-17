import type { AuditRecord, SafeUserRecord } from './identityRepository.js'
import type { OptimisticResult } from './aiConfigurationRepository.js'
import type { AgentConversationRecord } from './agentConversationRepository.js'

export type ImBotRecord = {
  id: string; platform: string; name: string; credentialCiphertext: string; credentialHint: string
  credentialFingerprint: string; config: Record<string, unknown>; enabled: boolean
  connectionStatus: string; lastConnectedAt: Date | null; lastError: string | null; version: number
  createdBy: string | null; updatedBy: string | null; createdAt: Date; updatedAt: Date
}
export type ImBindingRecord = {
  id: string; botId: string; externalConversationId: string; userId: string; projectId: string | null
  conversationId: string | null; department: string | null; enabled: boolean; version: number
  createdBy: string | null; updatedBy: string | null; createdAt: Date; updatedAt: Date
}
export type ImOutboxRecord = {
  id: string; botId: string; bindingId: string; createdBy: string | null; idempotencyKey: string
  payloadHash: string; payload: Record<string, unknown>; status: string; attempts: number
  nextAttemptAt: Date; leaseOwner: string | null; leaseExpiresAt: Date | null; lastError: string | null
  sentAt: Date | null; createdAt: Date; updatedAt: Date
}
export type ImDeliveryLogRecord = {
  id: string; outboxId: string; attempt: number; status: string; externalMessageId: string | null
  httpStatus: number | null; durationMs: number; error: string | null; createdAt: Date
}
export type ImInboundRecord = {
  id: string; botId: string; bindingId: string | null; externalMessageId: string
  externalConversationId: string; externalUserId: string | null; contentHash: string
  payload: Record<string, unknown>; status: string; rejectionReason: string | null; receivedAt: Date
}
export type ImLeadPushRuleRecord = {
  id: string; name: string; botId: string; bindingId: string; leadStatus: string | null
  projectId: string | null; minScore: number | null; messageTemplate: string; enabled: boolean
  version: number; createdBy: string | null; updatedBy: string | null; createdAt: Date; updatedAt: Date
}
export type ImLeadRecord = {
  id: string; name: string; companyName: string | null; industry: string | null
  poolStatus: string; score: number; convertedProjectId: string | null
}
export type ClaimedImOutbox = {
  id: string; botId: string; payload: Record<string, unknown>; attempts: number; leaseOwner: string
}
export type OperationalAlertOutboxState = {
  id: string; status: string; createdAt: Date; state: 'active' | 'recovered'
  fingerprint: string; alertCodes: string[]
}

export interface ImIntegrationRepository {
  listSettingsData(): Promise<{
    bots: ImBotRecord[]; bindings: ImBindingRecord[]; outbox: ImOutboxRecord[]
    logs: ImDeliveryLogRecord[]; users: SafeUserRecord[]; projects: Array<{ id: string; name: string }>
    conversations: AgentConversationRecord[]
  }>
  listLeadPushSettingsData(): Promise<{
    targets: Array<{ botId: string; botName: string; platform: string; bindingId: string; externalConversationId: string; userId: string; projectId: string | null; department: string | null }>
    rules: ImLeadPushRuleRecord[]; projects: Array<{ id: string; name: string }>
  }>
  findEnabledPushTarget(botId: string, bindingId: string): Promise<{ bot: ImBotRecord; binding: ImBindingRecord } | null>
  findLatestOperationalAlert(bindingId: string): Promise<OperationalAlertOutboxState | null>
  enqueueOperationalAlert(input: {
    id: string; bindingId: string; idempotencyKey: string; payloadHash: string
    payload: Record<string, unknown>; audit: AuditRecord
  }): Promise<
    { status: 'created' | 'existing'; record: ImOutboxRecord }
    | { status: 'binding_disabled' | 'idempotency_conflict' }
  >
  enqueueSystemNotification(input: {
    id: string; bindingId: string; idempotencyKey: string; payloadHash: string
    payload: Record<string, unknown>; audit: AuditRecord
  }): Promise<
    { status: 'created' | 'existing'; record: ImOutboxRecord }
    | { status: 'binding_disabled' | 'idempotency_conflict' }
  >
  createLeadPushRuleWithAudit(record: Omit<ImLeadPushRuleRecord, 'version' | 'createdAt' | 'updatedAt'>, audit: AuditRecord): Promise<
    { status: 'ok'; record: ImLeadPushRuleRecord }
    | { status: 'target_forbidden' | 'project_mismatch' | 'project_invalid' }
  >
  findLeadPushRule(ruleId: string): Promise<ImLeadPushRuleRecord | null>
  updateLeadPushRuleWithAudit(input: { ruleId: string; expectedVersion: number; patch: Partial<Pick<ImLeadPushRuleRecord, 'name' | 'leadStatus' | 'projectId' | 'minScore' | 'messageTemplate' | 'enabled' | 'updatedBy'>>; updatedAt: Date; audit: AuditRecord }): Promise<
    OptimisticResult<ImLeadPushRuleRecord>
    | { status: 'target_forbidden' | 'project_mismatch' | 'project_invalid' }
  >
  deleteLeadPushRuleWithAudit(ruleId: string, audit: AuditRecord): Promise<boolean>
  findLeadPushDispatch(ruleId: string, leadId: string): Promise<{ rule: ImLeadPushRuleRecord; lead: ImLeadRecord; projectName: string | null } | null>
  createBotWithAudit(record: Omit<ImBotRecord, 'version' | 'lastConnectedAt' | 'lastError' | 'createdAt' | 'updatedAt'>, audit: AuditRecord): Promise<ImBotRecord>
  findBot(botId: string): Promise<ImBotRecord | null>
  updateBotWithAudit(input: { botId: string; expectedVersion: number; patch: Partial<Pick<ImBotRecord, 'name' | 'credentialCiphertext' | 'credentialHint' | 'credentialFingerprint' | 'config' | 'enabled' | 'connectionStatus' | 'lastConnectedAt' | 'lastError' | 'updatedBy'>>; confirmDisableImpact: boolean; updatedAt: Date; audit: AuditRecord }): Promise<OptimisticResult<ImBotRecord> | { status: 'disable_confirmation_required' }>
  recordBotTestWithAudit(input: { botId: string; ok: boolean; error: string | null; testedAt: Date; audit: AuditRecord }): Promise<boolean>
  createBindingWithAudit(input: { record: Omit<ImBindingRecord, 'version' | 'createdAt' | 'updatedAt' | 'department'> & { department?: string | null }; audit: AuditRecord }): Promise<{ status: 'ok'; record: ImBindingRecord } | { status: 'bot_not_found' | 'user_invalid' | 'project_invalid' | 'conversation_invalid' }>
  updateBindingWithAudit(input: { bindingId: string; expectedVersion: number; patch: Partial<Pick<ImBindingRecord, 'externalConversationId' | 'enabled' | 'updatedBy'>>; updatedAt: Date; audit: AuditRecord }): Promise<OptimisticResult<ImBindingRecord>>
  deleteBindingWithAudit(bindingId: string, audit: AuditRecord): Promise<'ok' | 'not_found' | 'has_push_rule' | 'has_history'>
  enqueueMessageWithAudit(input: { id: string; botId: string; bindingId: string; actorUserId: string; actorIsAdmin: boolean; idempotencyKey: string; payloadHash: string; payload: Record<string, unknown>; successAudit: AuditRecord; deniedAudit: AuditRecord }): Promise<{ status: 'created' | 'existing'; record: ImOutboxRecord } | { status: 'binding_disabled' | 'forbidden' | 'idempotency_conflict' }>
  claimOutboxBatch(input: { owner: string; limit: number; leaseExpiresAt: Date }): Promise<ClaimedImOutbox[]>
  deferClaimForDisabledBot(input: { outboxId: string; owner: string; nextAttemptAt: Date; updatedAt: Date }): Promise<void>
  findLatestDeliveryAt(botId: string): Promise<Date | null>
  deferClaimForRateLimit(input: { outboxId: string; owner: string; nextAttemptAt: Date }): Promise<void>
  completeDelivery(input: { outboxId: string; owner: string; attempt: number; ok: boolean; terminal: boolean; externalMessageId?: string; httpStatus: number; durationMs: number; error: string | null; nextAttemptAt: Date; completedAt: Date }): Promise<boolean>
  findEnabledInboundBinding(botId: string, externalConversationId: string): Promise<ImBindingRecord | null>
  findInboundMessage(botId: string, externalMessageId: string): Promise<ImInboundRecord | null>
  createInboundMessage(record: Omit<ImInboundRecord, 'receivedAt'>): Promise<'created' | 'duplicate'>
  updateInboundStatus(id: string, status: string, rejectionReason?: string | null): Promise<void>
  findInboundMessageById(id: string): Promise<ImInboundRecord | null>
}
