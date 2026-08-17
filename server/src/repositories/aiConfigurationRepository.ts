import type { AuditRecord } from './identityRepository.js'

export type AiModelProviderRecord = {
  id: string
  name: string
  protocol: string
  baseUrl: string
  credentialCiphertext: string | null
  credentialHint: string | null
  credentialFingerprint: string | null
  timeoutMs: number
  enabled: boolean
  version: number
  lastTestStatus: string | null
  lastTestError: string | null
  lastTestLatencyMs: number | null
  lastTestTraceId: string | null
  lastTestAt: Date | null
  createdBy: string | null
  updatedBy: string | null
  createdAt: Date
  updatedAt: Date
}

export type AiModelRecord = {
  id: string
  providerId: string
  modelKey: string
  displayName: string
  contextWindow: number | null
  capabilityTags: string[]
  allowedRoles: string[]
  enabled: boolean
  isDefault: boolean
  version: number
  createdBy: string | null
  updatedBy: string | null
  createdAt: Date
  updatedAt: Date
}

export type AiModelRouteRecord = {
  profileKey: string
  modelId: string
  fallbackModelId: string | null
  enabled: boolean
  version: number
  updatedBy: string | null
  createdAt: Date
  updatedAt: Date
}

export type AiCapabilityRecord = {
  id: string
  kind: string
  capabilityKey: string
  name: string
  description: string | null
  source: string
  packageVersion: string
  config: Record<string, unknown>
  toolNames: string[]
  dependencyNames: string[]
  allowedRoles: string[]
  enabled: boolean
  version: number
  lastTestStatus: string | null
  lastTestError: string | null
  lastTestLatencyMs: number | null
  lastTestTraceId: string | null
  lastTestAt: Date | null
  createdBy: string | null
  updatedBy: string | null
  createdAt: Date
  updatedAt: Date
}

export type AiCapabilityBindingRecord = {
  id: string
  capabilityId: string
  scopeType: string
  scopeKey: string
  department: string | null
  projectId: string | null
  enabled: boolean
  version: number
  createdBy: string | null
  updatedBy: string | null
  createdAt: Date
  updatedAt: Date
}

export type BuiltinCapabilitySeed = {
  capabilityId: string
  globalBindingId: string
  kind: string
  capabilityKey: string
  name: string
  description: string
  packageVersion: string
  config: Record<string, unknown>
  toolNames: string[]
  dependencyNames: string[]
  expectedVersion?: number
}

export type OptimisticResult<T> =
  | { status: 'ok'; record: T }
  | { status: 'not_found' }
  | { status: 'conflict' }

export interface AiConfigurationRepository {
  listModelSettings(): Promise<{
    providers: AiModelProviderRecord[]
    models: AiModelRecord[]
    routes: AiModelRouteRecord[]
  }>
  createProviderWithAudit(input: Omit<AiModelProviderRecord,
    'version' | 'lastTestStatus' | 'lastTestError' | 'lastTestLatencyMs' | 'lastTestTraceId'
    | 'lastTestAt' | 'createdAt' | 'updatedAt'>, audit: AuditRecord): Promise<AiModelProviderRecord>
  updateProviderWithAudit(input: {
    providerId: string
    expectedVersion: number
    patch: Partial<Pick<AiModelProviderRecord,
      'name' | 'protocol' | 'baseUrl' | 'credentialCiphertext' | 'credentialHint'
      | 'credentialFingerprint' | 'timeoutMs' | 'enabled' | 'updatedBy'>>
    audit: AuditRecord
    updatedAt: Date
  }): Promise<OptimisticResult<AiModelProviderRecord>>
  createModelWithAudit(input: {
    record: Omit<AiModelRecord, 'version' | 'createdAt' | 'updatedAt'>
    audit: AuditRecord
    updatedAt: Date
  }): Promise<{ status: 'ok'; record: AiModelRecord } | { status: 'provider_not_found' }>
  updateModelWithAudit(input: {
    modelId: string
    expectedVersion: number
    patch: Partial<Pick<AiModelRecord,
      'providerId' | 'modelKey' | 'displayName' | 'contextWindow' | 'capabilityTags'
      | 'allowedRoles' | 'enabled' | 'isDefault' | 'updatedBy'>>
    audit: AuditRecord
    updatedAt: Date
  }): Promise<OptimisticResult<AiModelRecord> | { status: 'provider_not_found' }>
  upsertRouteWithAudit(input: {
    profileKey: string
    modelId: string
    fallbackModelId: string | null
    enabled: boolean
    expectedVersion?: number
    updatedBy: string
    createAudit: AuditRecord
    updateAudit: AuditRecord
    updatedAt: Date
  }): Promise<OptimisticResult<AiModelRouteRecord> | { status: 'model_not_found' }>
  listEnabledModelsWithProviders(): Promise<Array<{
    model: AiModelRecord
    provider: AiModelProviderRecord
  }>>
  findModelWithProvider(modelId: string): Promise<{
    model: AiModelRecord
    provider: AiModelProviderRecord
  } | null>
  findEnabledRoute(profileKey: string): Promise<AiModelRouteRecord | null>
  findDefaultEnabledModelId(): Promise<string | null>
  findEnabledModelIdsByKey(modelKey: string, limit?: number): Promise<string[]>
  findProvider(providerId: string): Promise<AiModelProviderRecord | null>
  recordProviderTestWithAudit(input: {
    providerId: string
    ok: boolean
    error: string | null
    latencyMs: number
    traceId: string
    testedAt: Date
    audit: AuditRecord
  }): Promise<void>
  ensureBuiltinCapabilities(items: BuiltinCapabilitySeed[]): Promise<void>
  syncBuiltinCapabilitiesWithAudit(input: {
    items: BuiltinCapabilitySeed[]
    actorUserId: string
    audit: AuditRecord
    updatedAt: Date
  }): Promise<'ok' | 'conflict'>
  listCapabilitySettings(): Promise<{
    capabilities: AiCapabilityRecord[]
    bindings: AiCapabilityBindingRecord[]
    projects: Array<{ id: string; name: string }>
  }>
  findCapability(capabilityId: string): Promise<AiCapabilityRecord | null>
  findBuiltinCapability(kind: string, capabilityKey: string): Promise<AiCapabilityRecord | null>
  updateCapabilityWithAudit(input: {
    capabilityId: string
    expectedVersion: number
    patch: Partial<Pick<AiCapabilityRecord,
      'name' | 'description' | 'config' | 'toolNames' | 'allowedRoles' | 'enabled' | 'updatedBy'>>
    audit: AuditRecord
    updatedAt: Date
  }): Promise<OptimisticResult<AiCapabilityRecord>>
  deleteCapabilityWithAudit(input: {
    capabilityId: string
    expectedVersion: number
    audit: AuditRecord
  }): Promise<'ok' | 'not_found' | 'conflict'>
  createCapabilityBindingWithAudit(input: {
    record: Omit<AiCapabilityBindingRecord, 'version' | 'createdAt' | 'updatedAt'>
    audit: AuditRecord
  }): Promise<AiCapabilityBindingRecord>
  updateCapabilityBindingWithAudit(input: {
    bindingId: string
    expectedVersion: number
    enabled: boolean
    updatedBy: string
    updatedAt: Date
    audit: AuditRecord
  }): Promise<OptimisticResult<AiCapabilityBindingRecord>>
  recordCapabilityTestWithAudit(input: {
    capabilityId: string
    status: string
    error: string | null
    latencyMs: number
    traceId: string
    actorUserId: string
    testedAt: Date
    audit: AuditRecord
  }): Promise<boolean>
  listEnabledCapabilitiesAndBindings(): Promise<{
    capabilities: AiCapabilityRecord[]
    bindings: AiCapabilityBindingRecord[]
  }>
  listConversationCapabilityIds(conversationId: string, userId: string): Promise<string[]>
  replaceConversationCapabilities(input: {
    conversationId: string
    userId: string
    capabilityIds: string[]
  }): Promise<void>
}
