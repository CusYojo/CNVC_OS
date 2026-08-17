import { randomUUID } from 'node:crypto'
import { agentConversationRepository, aiConfigurationRepository, identityRepositories } from '../repositories/index.js'
import type { AuditRecord, BuiltinCapabilitySeed } from '../repositories/index.js'
import { AI_MODEL_PROFILE_KEYS, type AiModelProfileKey } from './aiModelSettingsService.js'
import { AI_BUSINESS_SKILLS, AI_PPT_WORKFLOW_SKILLS, loadAiSkill } from './aiSkillService.js'
import { requireAccessibleProject } from './projectAccessService.js'
import { redactSensitiveText } from '../security/redactSecrets.js'
import { resolveExtensionFeatureFlags } from '../config/extensionFeatureFlags.js'
import { listConfigurationRevisions, rollbackConfigurationRevision } from './adminConfigurationRevisionService.js'

export const AI_CAPABILITY_KINDS = ['skill', 'agent', 'mcp', 'plugin'] as const
export const AI_CAPABILITY_SCOPE_TYPES = ['global', 'department', 'project'] as const
export type AiCapabilityKind = typeof AI_CAPABILITY_KINDS[number]
export type AiCapabilityScopeType = typeof AI_CAPABILITY_SCOPE_TYPES[number]
export type AiCapabilityActor = {
  userId: string; userName: string; role: string; department: string; ip?: string
}
export const AI_CAPABILITY_REVISION_TYPES = ['capability', 'capability_binding'] as const
export type AiCapabilityRevisionType = typeof AI_CAPABILITY_REVISION_TYPES[number]

export type AgentRuntimePolicy = {
  profileKey: AiModelProfileKey
  modelRouteKey: AiModelProfileKey
  timeoutMs: number
  maxTurns: number
  maxBudgetUsd: number
  budgetMode: 'server-cap'
  toolNames: string[]
}

export type RuntimeCapability = {
  id: string
  kind: string
  capabilityKey: string
  config: Record<string, unknown>
  toolNames: string[]
}

const INVESTMENT_TOOL_NAMES = [
  'search_project_docs', 'get_project_summary', 'list_project_files', 'read_project_file',
  'create_ai_task', 'get_ai_task_status', 'collect_public_intel',
] as const

export const AGENT_POLICY_LIMITS = {
  timeoutMs: { min: 30_000, max: 3_600_000 },
  maxTurns: { min: 1, max: 50 },
  maxBudgetUsd: { min: 0.01, max: 100 },
} as const

const AGENT_POLICY_DEFAULTS: Record<AiModelProfileKey, Omit<AgentRuntimePolicy, 'profileKey' | 'modelRouteKey' | 'budgetMode' | 'toolNames'>> = {
  'interactive-assistant': { timeoutMs: 900_000, maxTurns: 12, maxBudgetUsd: 5 },
  'lead-subject': { timeoutMs: 300_000, maxTurns: 2, maxBudgetUsd: 2 },
  'lead-research': { timeoutMs: 360_000, maxTurns: 2, maxBudgetUsd: 2 },
  'lead-screening': { timeoutMs: 360_000, maxTurns: 2, maxBudgetUsd: 2 },
  'lead-enrichment': { timeoutMs: 360_000, maxTurns: 2, maxBudgetUsd: 2 },
  'lead-scoring': { timeoutMs: 600_000, maxTurns: 2, maxBudgetUsd: 4 },
  'ai-document': { timeoutMs: 600_000, maxTurns: 12, maxBudgetUsd: 10 },
}

type CatalogItem = {
  kind: AiCapabilityKind; capabilityKey: string; name: string; description: string;
  packageVersion: string; config: Record<string, unknown>; toolNames: string[]; dependencyNames: string[]
}

const uniqueSkills = new Map<string, CatalogItem>()
for (const item of [...AI_BUSINESS_SKILLS, ...AI_PPT_WORKFLOW_SKILLS]) {
  if (!uniqueSkills.has(item.name)) uniqueSkills.set(item.name, {
    kind: 'skill', capabilityKey: item.name, name: item.label,
    description: `代码包内批准的专业 Skill：${item.name}`,
    packageVersion: 'bundled', config: { runtime: 'controlled-ai-task' }, toolNames: [], dependencyNames: [],
  })
}

export const AI_CAPABILITY_CATALOG: readonly CatalogItem[] = [
  ...uniqueSkills.values(),
  ...AI_MODEL_PROFILE_KEYS.map((profileKey) => ({
    kind: 'agent' as const,
    capabilityKey: profileKey,
    name: profileKey,
    description: `受控 Agent Profile：${profileKey}`,
    packageVersion: 'v1',
    config: {
      profileKey, modelRouteKey: profileKey, ...AGENT_POLICY_DEFAULTS[profileKey], budgetMode: 'server-cap',
    },
    toolNames: profileKey === 'interactive-assistant' ? [...INVESTMENT_TOOL_NAMES] : [],
    dependencyNames: [],
  })),
  {
    kind: 'mcp', capabilityKey: 'investment', name: '投资业务工具',
    description: '由单体服务宿主、按用户/项目强制鉴权的固定 MCP 工具集。',
    packageVersion: '1.0.0', config: { transport: 'in-process', executable: 'host-only' },
    toolNames: [...INVESTMENT_TOOL_NAMES], dependencyNames: [],
  },
]

function agentCatalogItem(profileKey: string) {
  return AI_CAPABILITY_CATALOG.find((item) => item.kind === 'agent' && item.capabilityKey === profileKey)
}

function approvedCatalogItem(input: { kind: string; capabilityKey: string; source: string }) {
  if (input.source !== 'builtin') return undefined
  return AI_CAPABILITY_CATALOG.find((item) => (
    item.kind === input.kind && item.capabilityKey === input.capabilityKey
  ))
}

function boundedPolicyNumber(value: unknown, fallback: number, limits: { min: number; max: number }, integer = false) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const bounded = Math.max(limits.min, Math.min(limits.max, parsed))
  return integer ? Math.round(bounded) : bounded
}

export function normalizeAgentRuntimePolicy(input: {
  capabilityKey: string; config: Record<string, unknown>; toolNames: string[]
}): AgentRuntimePolicy {
  const catalog = agentCatalogItem(input.capabilityKey)
  if (!catalog || !(AI_MODEL_PROFILE_KEYS as readonly string[]).includes(input.capabilityKey)) {
    throw serviceError('Agent Profile 未在代码目录注册', 'AGENT_POLICY_NOT_APPROVED', 403)
  }
  const profileKey = input.capabilityKey as AiModelProfileKey
  const defaults = AGENT_POLICY_DEFAULTS[profileKey]
  const configuredRoute = typeof input.config.modelRouteKey === 'string' ? input.config.modelRouteKey : profileKey
  const modelRouteKey = (AI_MODEL_PROFILE_KEYS as readonly string[]).includes(configuredRoute)
    ? configuredRoute as AiModelProfileKey
    : profileKey
  const approvedTools = new Set(catalog.toolNames)
  return {
    profileKey,
    modelRouteKey,
    timeoutMs: boundedPolicyNumber(input.config.timeoutMs, defaults.timeoutMs, AGENT_POLICY_LIMITS.timeoutMs, true),
    maxTurns: boundedPolicyNumber(input.config.maxTurns, defaults.maxTurns, AGENT_POLICY_LIMITS.maxTurns, true),
    maxBudgetUsd: boundedPolicyNumber(input.config.maxBudgetUsd, defaults.maxBudgetUsd, AGENT_POLICY_LIMITS.maxBudgetUsd),
    budgetMode: 'server-cap',
    toolNames: [...new Set(input.toolNames)].filter((name) => approvedTools.has(name)),
  }
}

function policyConfig(policy: AgentRuntimePolicy): Record<string, unknown> {
  return {
    profileKey: policy.profileKey,
    modelRouteKey: policy.modelRouteKey,
    timeoutMs: policy.timeoutMs,
    maxTurns: policy.maxTurns,
    maxBudgetUsd: policy.maxBudgetUsd,
    budgetMode: policy.budgetMode,
  }
}

export async function ensureBuiltinCapabilityCatalog() {
  await aiConfigurationRepository.ensureBuiltinCapabilities(AI_CAPABILITY_CATALOG.map((item) => ({
    ...item,
    capabilityId: randomUUID(),
    globalBindingId: randomUUID(),
  })))
  return { capabilities: AI_CAPABILITY_CATALOG.length }
}

function serviceError(message: string, code: string, status: number) {
  return Object.assign(new Error(message), { message, code, status })
}

export function assertAiCapabilityAdmin(actor: AiCapabilityActor) {
  if (!['系统管理员', 'AI平台管理员', 'AI 平台管理员'].includes(actor.role)) {
    throw serviceError('仅系统管理员或 AI 平台管理员可管理能力', 'ROLE_FORBIDDEN', 403)
  }
}

function auditRecord(actor: AiCapabilityActor, action: string, target: string): AuditRecord {
  return {
    userId: actor.userId, userName: actor.userName, module: '能力管理', action, target, ip: actor.ip,
  }
}

export async function syncBuiltinCapabilities(actor: AiCapabilityActor) {
  assertAiCapabilityAdmin(actor)
  const current = await aiConfigurationRepository.listCapabilitySettings()
  const existingByKey = new Map(current.capabilities.map((item) => [`${item.kind}:${item.capabilityKey}`, item]))
  const items: BuiltinCapabilitySeed[] = AI_CAPABILITY_CATALOG.map((item) => {
    const existing = existingByKey.get(`${item.kind}:${item.capabilityKey}`)
    const preservedAgentPolicy = item.kind === 'agent' && existing
      ? normalizeAgentRuntimePolicy({
        capabilityKey: item.capabilityKey,
        config: existing.config,
        toolNames: existing.toolNames,
      })
      : null
    return {
      ...item,
      capabilityId: existing?.id ?? randomUUID(),
      globalBindingId: randomUUID(),
      config: preservedAgentPolicy ? policyConfig(preservedAgentPolicy) : item.config,
      toolNames: preservedAgentPolicy?.toolNames ?? item.toolNames,
      expectedVersion: existing?.version,
    }
  })
  const result = await aiConfigurationRepository.syncBuiltinCapabilitiesWithAudit({
    items,
    actorUserId: actor.userId,
    audit: auditRecord(actor, '同步内置能力目录', `${AI_CAPABILITY_CATALOG.length} capabilities`),
    updatedAt: new Date(),
  })
  if (result === 'conflict') {
    throw serviceError('能力目录已被其他管理员修改，请刷新后重试', 'CAPABILITY_VERSION_CONFLICT', 409)
  }
  return listCapabilitySettings(actor)
}

export async function listCapabilitySettings(actor: AiCapabilityActor) {
  assertAiCapabilityAdmin(actor)
  const { capabilities, bindings, projects: projectRows } = await aiConfigurationRepository.listCapabilitySettings()
  const capabilityViews = capabilities.map((capability) => {
    const pluginApproved = capability.kind !== 'plugin' || Boolean(approvedCatalogItem(capability))
    return {
      ...capability,
      configuredEnabled: capability.enabled,
      enabled: pluginApproved && capability.enabled,
      installed: pluginApproved,
      runtimeAvailable: pluginApproved && capability.enabled,
      approvalStatus: pluginApproved ? 'approved' as const : 'not_approved' as const,
    }
  })
  const pluginRecords = capabilityViews.filter((capability) => capability.kind === 'plugin')
  return {
    capabilities: capabilityViews,
    bindings,
    projects: projectRows,
    kinds: AI_CAPABILITY_KINDS,
    scopeTypes: AI_CAPABILITY_SCOPE_TYPES,
    pluginInventory: {
      records: pluginRecords.length,
      approved: pluginRecords.filter((plugin) => plugin.approvalStatus === 'approved').length,
      installed: pluginRecords.filter((plugin) => plugin.installed).length,
      runtimeEnabled: pluginRecords.filter((plugin) => plugin.runtimeAvailable).length,
      dynamicInstallEnabled: false,
    },
    agentPolicyOptions: {
      modelRouteKeys: AI_MODEL_PROFILE_KEYS,
      limits: AGENT_POLICY_LIMITS,
      approvedToolNamesByCapability: Object.fromEntries(AI_CAPABILITY_CATALOG
        .filter((item) => item.kind === 'agent')
        .map((item) => [item.capabilityKey, item.toolNames])),
    },
  }
}

export async function listCapabilityConfigurationRevisions(
  resourceType: AiCapabilityRevisionType,
  resourceId: string,
  actor: AiCapabilityActor,
) {
  assertAiCapabilityAdmin(actor)
  return listConfigurationRevisions({ domain: 'capability', resourceType, resourceId })
}

export async function rollbackCapabilityConfigurationRevision(input: {
  resourceType: AiCapabilityRevisionType
  resourceId: string
  revisionId: string
  expectedVersion: number
}, actor: AiCapabilityActor) {
  assertAiCapabilityAdmin(actor)
  return rollbackConfigurationRevision({
    domain: 'capability', resourceType: input.resourceType, resourceId: input.resourceId,
    revisionId: input.revisionId, expectedVersion: input.expectedVersion,
    module: '能力管理', action: '回滚能力配置',
  }, actor)
}

export async function updateCapability(capabilityId: string, input: {
  expectedVersion: number; name?: string; description?: string | null;
  allowedRoles?: string[]; enabled?: boolean
}, actor: AiCapabilityActor) {
  assertAiCapabilityAdmin(actor)
  const existing = await aiConfigurationRepository.findCapability(capabilityId)
  if (!existing) throw serviceError('能力不存在', 'CAPABILITY_NOT_FOUND', 404)
  if (
    existing.kind === 'plugin'
    && !approvedCatalogItem(existing)
    && input.enabled !== false
  ) {
    throw serviceError('Plugin 未进入代码批准目录，只允许保持停用', 'PLUGIN_NOT_APPROVED', 403)
  }
  const result = await aiConfigurationRepository.updateCapabilityWithAudit({
    capabilityId,
    expectedVersion: input.expectedVersion,
    patch: {
    ...(input.name === undefined ? {} : { name: input.name.trim() }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.allowedRoles === undefined ? {} : { allowedRoles: [...new Set(input.allowedRoles)] }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      updatedBy: actor.userId,
    },
    updatedAt: new Date(),
    audit: auditRecord(actor, '修改能力', capabilityId),
  })
  if (result.status !== 'ok') throw serviceError('能力不存在或已被其他管理员修改', 'CAPABILITY_VERSION_CONFLICT', 409)
  return result.record
}

export async function deleteSkill(capabilityId: string, expectedVersion: number, actor: AiCapabilityActor) {
  assertAiCapabilityAdmin(actor)
  const existing = await aiConfigurationRepository.findCapability(capabilityId)
  if (!existing) throw serviceError('Skill 不存在', 'CAPABILITY_NOT_FOUND', 404)
  if (existing.kind !== 'skill') {
    throw serviceError('只能通过此操作删除 Skill', 'CAPABILITY_KIND_INVALID', 400)
  }
  const result = await aiConfigurationRepository.deleteCapabilityWithAudit({
    capabilityId,
    expectedVersion,
    audit: auditRecord(actor, '删除 Skill', `${existing.name} (${existing.capabilityKey})`),
  })
  if (result === 'not_found') throw serviceError('Skill 不存在', 'CAPABILITY_NOT_FOUND', 404)
  if (result === 'conflict') {
    throw serviceError('Skill 已被其他管理员修改，请刷新后重试', 'CAPABILITY_VERSION_CONFLICT', 409)
  }
  return { deleted: true, id: capabilityId }
}

export async function updateAgentCapabilityPolicy(capabilityId: string, input: {
  expectedVersion: number
  modelRouteKey: AiModelProfileKey
  timeoutMs: number
  maxTurns: number
  maxBudgetUsd: number
  toolNames: string[]
  allowedRoles: string[]
}, actor: AiCapabilityActor) {
  assertAiCapabilityAdmin(actor)
  const existing = await aiConfigurationRepository.findCapability(capabilityId)
  if (!existing) throw serviceError('Agent 能力不存在', 'CAPABILITY_NOT_FOUND', 404)
  const catalog = agentCatalogItem(existing.capabilityKey)
  if (existing.kind !== 'agent' || existing.source !== 'builtin' || !catalog) {
    throw serviceError('仅可配置代码包内批准的 Agent Profile', 'AGENT_POLICY_NOT_APPROVED', 403)
  }
  const approvedTools = new Set(catalog.toolNames)
  const selectedTools = [...new Set(input.toolNames)]
  if (selectedTools.some((name) => !approvedTools.has(name))) {
    throw serviceError('Agent 工具包含未批准项', 'AGENT_TOOL_NOT_APPROVED', 400)
  }
  const policy = normalizeAgentRuntimePolicy({
    capabilityKey: existing.capabilityKey,
    config: {
      modelRouteKey: input.modelRouteKey,
      timeoutMs: input.timeoutMs,
      maxTurns: input.maxTurns,
      maxBudgetUsd: input.maxBudgetUsd,
    },
    toolNames: selectedTools,
  })
  const result = await aiConfigurationRepository.updateCapabilityWithAudit({
    capabilityId,
    expectedVersion: input.expectedVersion,
    patch: {
      config: policyConfig(policy),
      toolNames: policy.toolNames,
      allowedRoles: [...new Set(input.allowedRoles)],
      updatedBy: actor.userId,
    },
    updatedAt: new Date(),
    audit: auditRecord(actor, '修改 Agent 运行策略', capabilityId),
  })
  if (result.status !== 'ok') {
    throw serviceError('Agent 策略已被其他管理员修改，请刷新后重试', 'CAPABILITY_VERSION_CONFLICT', 409)
  }
  return result.record
}

export async function resolveAgentRuntimePolicy(profileKey: AiModelProfileKey): Promise<AgentRuntimePolicy> {
  const catalog = agentCatalogItem(profileKey)
  if (!catalog) throw serviceError('Agent Profile 未在代码目录注册', 'AGENT_POLICY_NOT_APPROVED', 403)
  if (!resolveExtensionFeatureFlags().aiCapabilitiesEnabled) {
    return normalizeAgentRuntimePolicy({
      capabilityKey: profileKey,
      config: catalog.config,
      toolNames: catalog.toolNames,
    })
  }
  const capability = await aiConfigurationRepository.findBuiltinCapability('agent', profileKey)
  if (capability && !capability.enabled) {
    throw serviceError('Agent Profile 已停用', 'AGENT_CAPABILITY_FORBIDDEN', 403)
  }
  return normalizeAgentRuntimePolicy({
    capabilityKey: profileKey,
    config: capability?.config || catalog.config,
    toolNames: capability?.toolNames || catalog.toolNames,
  })
}

function normalizeBinding(input: { scopeType: AiCapabilityScopeType; department?: string | null; projectId?: string | null }) {
  if (input.scopeType === 'global') return { scopeKey: '*', department: null, projectId: null }
  if (input.scopeType === 'department') {
    const department = input.department?.trim()
    if (!department) throw serviceError('部门作用域必须指定部门', 'CAPABILITY_SCOPE_INVALID', 400)
    return { scopeKey: department, department, projectId: null }
  }
  if (!input.projectId) throw serviceError('项目作用域必须指定项目', 'CAPABILITY_SCOPE_INVALID', 400)
  return { scopeKey: input.projectId, department: null, projectId: input.projectId }
}

export async function createCapabilityBinding(input: {
  capabilityId: string; scopeType: AiCapabilityScopeType; department?: string | null; projectId?: string | null; enabled?: boolean
}, actor: AiCapabilityActor) {
  assertAiCapabilityAdmin(actor)
  const scope = normalizeBinding(input)
  const capability = await aiConfigurationRepository.findCapability(input.capabilityId)
  if (!capability) throw serviceError('能力不存在', 'CAPABILITY_NOT_FOUND', 404)
  if (capability.kind === 'plugin' && !approvedCatalogItem(capability)) {
    throw serviceError('Plugin 未进入代码批准目录，不能创建运行授权', 'PLUGIN_NOT_APPROVED', 403)
  }
  if (scope.projectId) {
    const project = await identityRepositories.permissions.findProjectById(scope.projectId)
    if (!project) throw serviceError('项目不存在', 'PROJECT_NOT_FOUND', 404)
  }
  const id = randomUUID()
  return aiConfigurationRepository.createCapabilityBindingWithAudit({
    record: {
      id, capabilityId: input.capabilityId, scopeType: input.scopeType, ...scope,
      enabled: input.enabled ?? true, createdBy: actor.userId, updatedBy: actor.userId,
    },
    audit: auditRecord(actor, '新增能力授权', `${input.capabilityId}:${input.scopeType}:${scope.scopeKey}`),
  })
}

export async function updateCapabilityBinding(bindingId: string, input: { expectedVersion: number; enabled: boolean }, actor: AiCapabilityActor) {
  assertAiCapabilityAdmin(actor)
  const result = await aiConfigurationRepository.updateCapabilityBindingWithAudit({
    bindingId,
    expectedVersion: input.expectedVersion,
    enabled: input.enabled,
    updatedBy: actor.userId,
    updatedAt: new Date(),
    audit: auditRecord(actor, input.enabled ? '启用能力授权' : '停用能力授权', bindingId),
  })
  if (result.status !== 'ok') throw serviceError('授权不存在或已被其他管理员修改', 'CAPABILITY_BINDING_VERSION_CONFLICT', 409)
  return result.record
}

export async function testCapability(capabilityId: string, actor: AiCapabilityActor) {
  assertAiCapabilityAdmin(actor)
  const capability = await aiConfigurationRepository.findCapability(capabilityId)
  if (!capability) throw serviceError('能力不存在', 'CAPABILITY_NOT_FOUND', 404)
  const traceId = randomUUID()
  const started = Date.now()
  let status = 'succeeded'
  let error: string | null = null
  try {
    const approved = AI_CAPABILITY_CATALOG.some((item) => item.kind === capability.kind && item.capabilityKey === capability.capabilityKey)
    if (!approved || capability.source !== 'builtin') throw serviceError('仅可测试代码包内批准能力', 'CAPABILITY_NOT_APPROVED', 403)
    if (capability.kind === 'skill') await loadAiSkill(capability.capabilityKey)
    if (capability.kind === 'agent' && !(AI_MODEL_PROFILE_KEYS as readonly string[]).includes(capability.capabilityKey)) throw new Error('Agent Profile 未注册')
    if (capability.kind === 'mcp' && capability.capabilityKey !== 'investment') throw new Error('MCP Server 未注册')
    if (capability.kind === 'plugin') throw new Error('生产运行时未批准任何 Plugin')
  } catch (cause) {
    status = 'failed'
    error = redactSensitiveText(cause instanceof Error ? cause.message : String(cause)).slice(0, 1000)
  }
  const latencyMs = Date.now() - started
  const testedAt = new Date()
  await aiConfigurationRepository.recordCapabilityTestWithAudit({
    capabilityId,
    status,
    error,
    latencyMs,
    traceId,
    actorUserId: actor.userId,
    testedAt,
    audit: auditRecord(actor, '测试能力', `${capabilityId}:${status}:${traceId}`),
  })
  return { ok: status === 'succeeded', status, error, latencyMs, traceId }
}

export async function listAvailableCapabilities(actor: AiCapabilityActor, projectId?: string | null) {
  if (projectId) await requireAccessibleProject(actor.userId, projectId)
  const { capabilities, bindings } = await aiConfigurationRepository.listEnabledCapabilitiesAndBindings()
  const bound = new Set(bindings.filter((binding) => (
    binding.scopeType === 'global'
    || (binding.scopeType === 'department' && binding.department === actor.department)
    || (binding.scopeType === 'project' && Boolean(projectId) && binding.projectId === projectId)
  )).map((binding) => binding.capabilityId))
  return capabilities.filter((capability) => {
    const roles = Array.isArray(capability.allowedRoles) ? capability.allowedRoles : []
    const pluginApproved = capability.kind !== 'plugin' || Boolean(approvedCatalogItem(capability))
    return pluginApproved && bound.has(capability.id) && (!roles.length || roles.includes(actor.role))
  })
}

async function ownedConversation(actor: AiCapabilityActor, conversationId: string) {
  const conversation = await agentConversationRepository.findOwnedAgentById(actor.userId, conversationId)
  if (!conversation) throw serviceError('会话不存在或无权访问', 'CONVERSATION_FORBIDDEN', 403)
  if (conversation.projectId) await requireAccessibleProject(actor.userId, conversation.projectId)
  return conversation
}

export async function getConversationCapabilities(actor: AiCapabilityActor, conversationId: string) {
  const conversation = await ownedConversation(actor, conversationId)
  const available = await listAvailableCapabilities(actor, conversation.projectId)
  const selected = await aiConfigurationRepository.listConversationCapabilityIds(conversationId, actor.userId)
  const selectedSet = new Set(selected)
  return { available, selectedIds: available.filter((item) => selectedSet.has(item.id)).map((item) => item.id) }
}

export async function setConversationCapabilities(actor: AiCapabilityActor, conversationId: string, capabilityIds: string[]) {
  const conversation = await ownedConversation(actor, conversationId)
  const available = await listAvailableCapabilities(actor, conversation.projectId)
  const allowedIds = new Set(available.map((item) => item.id))
  const selectedIds = [...new Set(capabilityIds)]
  if (selectedIds.some((id) => !allowedIds.has(id))) {
    throw serviceError('选择包含未授权、已停用或不属于当前作用域的能力', 'CAPABILITY_FORBIDDEN', 403)
  }
  await aiConfigurationRepository.replaceConversationCapabilities({
    conversationId,
    userId: actor.userId,
    capabilityIds: selectedIds,
  })
  return { available, selectedIds }
}

export async function resolveSelectedRuntimeCapabilities(
  actor: AiCapabilityActor,
  conversationId: string,
): Promise<RuntimeCapability[]> {
  if (!resolveExtensionFeatureFlags().aiCapabilitiesEnabled) {
    const interactive = agentCatalogItem('interactive-assistant')!
    // 关闭能力扩展时保留无项目工具的最小互动 Agent，使核心对话可用但不能
    // 继承数据库中的扩展授权、MCP 或专业 Skill。
    return [{
      id: 'builtin:agent:interactive-assistant',
      kind: interactive.kind,
      capabilityKey: interactive.capabilityKey,
      config: interactive.config,
      toolNames: [],
    }]
  }
  const { available, selectedIds } = await getConversationCapabilities(actor, conversationId)
  // 迁移前创建的会话没有选择记录，按“全部已授权能力”兼容；一旦保存过选择，
  // Runtime 只加载选择项。空选择在当前 UI 中不提交，避免语义歧义。
  const selected = selectedIds.length
    ? available.filter((item) => selectedIds.includes(item.id))
    : available
  // 数据库选择只能收窄代码白名单，不能注册新执行器或扩展 SDK 工具。
  return selected.filter((item) => AI_CAPABILITY_CATALOG.some((approved) => (
    approved.kind === item.kind && approved.capabilityKey === item.capabilityKey
  )))
}
