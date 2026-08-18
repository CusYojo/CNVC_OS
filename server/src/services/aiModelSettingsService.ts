import { randomUUID } from 'node:crypto'
import type { AiModelProviderRecord } from '../repositories/aiConfigurationRepository.js'
import { aiConfigurationRepository } from '../repositories/index.js'
import { decryptModelCredential, encryptModelCredential } from '../security/modelCredentialCrypto.js'
import { redactSensitiveText } from '../security/redactSecrets.js'
import { listConfigurationRevisions, rollbackConfigurationRevision } from './adminConfigurationRevisionService.js'

export const AI_MODEL_ADMIN_ROLES = ['系统管理员', 'AI平台管理员', 'AI 平台管理员'] as const
export const AI_MODEL_PROFILE_KEYS = [
  'interactive-assistant',
  'lead-subject',
  'lead-research',
  'lead-screening',
  'lead-enrichment',
  'lead-scoring',
  'ai-document',
] as const

export type AiModelProfileKey = typeof AI_MODEL_PROFILE_KEYS[number]
export type AiModelActor = { userId: string; userName: string; role: string; ip?: string }
export const AI_MODEL_REVISION_TYPES = ['provider', 'model', 'route'] as const
export type AiModelRevisionType = typeof AI_MODEL_REVISION_TYPES[number]

function serviceError(message: string, code: string, status: number) {
  return Object.assign(new Error(message), { code, status })
}

export function assertAiModelAdmin(actor: AiModelActor): void {
  if (!(AI_MODEL_ADMIN_ROLES as readonly string[]).includes(actor.role)) {
    throw serviceError('仅系统管理员或 AI 平台管理员可管理模型', 'ROLE_FORBIDDEN', 403)
  }
}

export function normalizeModelProviderUrl(value: string): string {
  let parsed: URL
  try { parsed = new URL(value.trim()) } catch { throw serviceError('模型 Base URL 无效', 'MODEL_BASE_URL_INVALID', 400) }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw serviceError('模型 Base URL 必须是不含凭据、查询或片段的 HTTP(S) 地址', 'MODEL_BASE_URL_INVALID', 400)
  }
  if (parsed.protocol === 'http:' && process.env.NODE_ENV === 'production' && process.env.MODEL_PROVIDER_ALLOW_HTTP !== 'true') {
    throw serviceError('生产模型 Base URL 必须使用 HTTPS', 'MODEL_BASE_URL_INSECURE', 400)
  }
  const allowedHosts = (process.env.MODEL_PROVIDER_ALLOWED_HOSTS || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
  if (allowedHosts.length && !allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw serviceError('模型 Provider 主机不在允许列表', 'MODEL_PROVIDER_HOST_FORBIDDEN', 403)
  }
  return parsed.toString().replace(/\/$/, '')
}

function providerView(row: AiModelProviderRecord) {
  const { credentialCiphertext: _ciphertext, credentialFingerprint: _fingerprint, ...safe } = row
  return {
    ...safe,
    hasCredential: Boolean(row.credentialCiphertext),
    credentialMasked: row.credentialHint || null,
  }
}

function auditRecord(actor: AiModelActor, action: string, target: string) {
  return {
    userId: actor.userId,
    userName: actor.userName,
    module: '模型设置',
    action,
    target,
    ip: actor.ip,
  }
}

export async function listModelSettings(actor: AiModelActor) {
  assertAiModelAdmin(actor)
  const { providers, models, routes } = await aiConfigurationRepository.listModelSettings()
  return { providers: providers.map(providerView), models, routes, profileKeys: AI_MODEL_PROFILE_KEYS }
}

export async function listModelConfigurationRevisions(
  resourceType: AiModelRevisionType,
  resourceId: string,
  actor: AiModelActor,
) {
  assertAiModelAdmin(actor)
  return listConfigurationRevisions({ domain: 'model', resourceType, resourceId })
}

export async function rollbackModelConfigurationRevision(input: {
  resourceType: AiModelRevisionType
  resourceId: string
  revisionId: string
  expectedVersion: number
}, actor: AiModelActor) {
  assertAiModelAdmin(actor)
  return rollbackConfigurationRevision({
    domain: 'model', resourceType: input.resourceType, resourceId: input.resourceId,
    revisionId: input.revisionId, expectedVersion: input.expectedVersion,
    module: '模型设置', action: '回滚模型配置',
  }, actor)
}

export async function createModelProvider(input: {
  name: string; protocol: string; baseUrl: string; apiKey: string; timeoutMs: number; enabled: boolean
}, actor: AiModelActor) {
  assertAiModelAdmin(actor)
  const id = randomUUID()
  const encrypted = encryptModelCredential(input.apiKey, id)
  const baseUrl = normalizeModelProviderUrl(input.baseUrl)
  const created = await aiConfigurationRepository.createProviderWithAudit({
      id,
      name: input.name.trim(),
      protocol: input.protocol,
      baseUrl,
      credentialCiphertext: encrypted.ciphertext,
      credentialHint: encrypted.hint,
      credentialFingerprint: encrypted.fingerprint,
      timeoutMs: input.timeoutMs,
      enabled: input.enabled,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    }, auditRecord(actor, '新增 Provider', `${id}:${input.name.trim()}`))
  return providerView(created)
}

export async function updateModelProvider(providerId: string, input: {
  expectedVersion: number; name?: string; protocol?: string; baseUrl?: string;
  apiKey?: string; timeoutMs?: number; enabled?: boolean
}, actor: AiModelActor) {
  assertAiModelAdmin(actor)
  const credential = input.apiKey === undefined ? {} : (() => {
      const encrypted = encryptModelCredential(input.apiKey!, providerId)
      return {
        credentialCiphertext: encrypted.ciphertext,
        credentialHint: encrypted.hint,
        credentialFingerprint: encrypted.fingerprint,
      }
    })()
  const result = await aiConfigurationRepository.updateProviderWithAudit({
    providerId,
    expectedVersion: input.expectedVersion,
    patch: {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
      ...(input.baseUrl === undefined ? {} : { baseUrl: normalizeModelProviderUrl(input.baseUrl) }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...credential,
      updatedBy: actor.userId,
    },
    audit: auditRecord(actor, input.apiKey === undefined ? '修改 Provider' : '替换 Provider 凭据', providerId),
    updatedAt: new Date(),
  })
  if (result.status === 'not_found') throw serviceError('模型 Provider 不存在', 'MODEL_PROVIDER_NOT_FOUND', 404)
  if (result.status === 'conflict') throw serviceError('Provider 已被其他管理员修改，请刷新后重试', 'MODEL_VERSION_CONFLICT', 409)
  return providerView(result.record)
}

export async function deleteModelProvider(providerId: string, expectedVersion: number, actor: AiModelActor) {
  assertAiModelAdmin(actor)
  const result = await aiConfigurationRepository.deleteProviderWithAudit({
    providerId, expectedVersion,
    audit: auditRecord(actor, '删除 Provider', providerId),
  })
  if (result === 'not_found') throw serviceError('模型 Provider 不存在', 'MODEL_PROVIDER_NOT_FOUND', 404)
  if (result === 'conflict') throw serviceError('Provider 已被其他管理员修改，请刷新后重试', 'MODEL_VERSION_CONFLICT', 409)
  if (result === 'has_models') throw serviceError('请先删除该 Provider 下的所有模型', 'MODEL_PROVIDER_HAS_MODELS', 409)
  return { deleted: true }
}

export async function createAiModel(input: {
  providerId: string; modelKey: string; displayName: string; contextWindow?: number | null;
  capabilityTags: string[]; allowedRoles: string[]; enabled: boolean; isDefault: boolean
}, actor: AiModelActor) {
  assertAiModelAdmin(actor)
  const id = randomUUID()
  const result = await aiConfigurationRepository.createModelWithAudit({
    record: {
      id,
      providerId: input.providerId,
      modelKey: input.modelKey.trim(),
      displayName: input.displayName.trim(),
      contextWindow: input.contextWindow ?? null,
      capabilityTags: [...new Set(input.capabilityTags)],
      allowedRoles: [...new Set(input.allowedRoles)],
      enabled: input.enabled,
      isDefault: input.isDefault,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    },
    audit: auditRecord(actor, '新增模型', `${id}:${input.modelKey.trim()}`),
    updatedAt: new Date(),
  })
  if (result.status === 'provider_not_found') throw serviceError('模型 Provider 不存在', 'MODEL_PROVIDER_NOT_FOUND', 404)
  return result.record
}

export async function updateAiModel(modelId: string, input: {
  expectedVersion: number; providerId?: string; modelKey?: string; displayName?: string;
  contextWindow?: number | null; capabilityTags?: string[]; allowedRoles?: string[];
  enabled?: boolean; isDefault?: boolean
}, actor: AiModelActor) {
  assertAiModelAdmin(actor)
  const result = await aiConfigurationRepository.updateModelWithAudit({
    modelId,
    expectedVersion: input.expectedVersion,
    patch: {
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.modelKey === undefined ? {} : { modelKey: input.modelKey.trim() }),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName.trim() }),
      ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
      ...(input.capabilityTags === undefined ? {} : { capabilityTags: [...new Set(input.capabilityTags)] }),
      ...(input.allowedRoles === undefined ? {} : { allowedRoles: [...new Set(input.allowedRoles)] }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
      updatedBy: actor.userId,
    },
    audit: auditRecord(actor, '修改模型', modelId),
    updatedAt: new Date(),
  })
  if (result.status === 'not_found') throw serviceError('模型不存在', 'MODEL_NOT_FOUND', 404)
  if (result.status === 'provider_not_found') throw serviceError('模型 Provider 不存在', 'MODEL_PROVIDER_NOT_FOUND', 404)
  if (result.status === 'conflict') throw serviceError('模型已被其他管理员修改，请刷新后重试', 'MODEL_VERSION_CONFLICT', 409)
  return result.record
}

export async function deleteAiModel(modelId: string, expectedVersion: number, actor: AiModelActor) {
  assertAiModelAdmin(actor)
  const result = await aiConfigurationRepository.deleteModelWithAudit({
    modelId, expectedVersion,
    audit: auditRecord(actor, '删除模型', modelId),
  })
  if (result === 'not_found') throw serviceError('模型不存在', 'MODEL_NOT_FOUND', 404)
  if (result === 'conflict') throw serviceError('模型已被其他管理员修改，请刷新后重试', 'MODEL_VERSION_CONFLICT', 409)
  if (result === 'referenced') throw serviceError('模型仍被任务模型路由引用，请先调整主模型或备用模型路由', 'MODEL_REFERENCED_BY_ROUTE', 409)
  return { deleted: true }
}

export async function upsertAiModelRoute(input: {
  profileKey: AiModelProfileKey; modelId: string; fallbackModelId?: string | null;
  enabled: boolean; expectedVersion?: number
}, actor: AiModelActor) {
  assertAiModelAdmin(actor)
  if (input.fallbackModelId === input.modelId) throw serviceError('备用模型不能与主模型相同', 'MODEL_ROUTE_INVALID', 400)
  const result = await aiConfigurationRepository.upsertRouteWithAudit({
    profileKey: input.profileKey,
    modelId: input.modelId,
    fallbackModelId: input.fallbackModelId ?? null,
    enabled: input.enabled,
    expectedVersion: input.expectedVersion,
    updatedBy: actor.userId,
    createAudit: auditRecord(actor, '新增模型路由', input.profileKey),
    updateAudit: auditRecord(actor, '修改模型路由', input.profileKey),
    updatedAt: new Date(),
  })
  if (result.status === 'model_not_found') throw serviceError('模型路由引用了不存在的模型', 'MODEL_NOT_FOUND', 404)
  if (result.status === 'conflict') throw serviceError('模型路由已被其他管理员修改，请刷新后重试', 'MODEL_VERSION_CONFLICT', 409)
  if (result.status === 'not_found') throw serviceError('模型路由不存在', 'MODEL_NOT_FOUND', 404)
  return result.record
}

export async function listAvailableModels(role: string) {
  const rows = await aiConfigurationRepository.listEnabledModelsWithProviders()
  return rows.flatMap(({ model, provider }) => {
    if (!provider.enabled || (model.allowedRoles.length && !model.allowedRoles.includes(role))) return []
    return [{
      id: model.id,
      modelKey: model.modelKey,
      displayName: model.displayName,
      capabilityTags: model.capabilityTags,
      contextWindow: model.contextWindow,
      isDefault: model.isDefault,
    }]
  })
}

async function runtimeCandidate(modelId: string | null | undefined, role?: string) {
  if (!modelId) return null
  const row = await aiConfigurationRepository.findModelWithProvider(modelId)
  if (!row?.model.enabled || !row.provider.enabled || !row.provider.credentialCiphertext) return null
  if (role && row.model.allowedRoles.length && !row.model.allowedRoles.includes(role)) return null
  return {
    modelId: row.model.id,
    model: row.model.modelKey,
    baseUrl: row.provider.baseUrl,
    apiKey: decryptModelCredential(row.provider.credentialCiphertext, row.provider.id),
    timeoutMs: row.provider.timeoutMs,
    providerId: row.provider.id,
  }
}

export async function resolveAiModelRoute(profileKey: AiModelProfileKey, role?: string) {
  const route = await aiConfigurationRepository.findEnabledRoute(profileKey)
  if (route) return await runtimeCandidate(route.modelId, role) || await runtimeCandidate(route.fallbackModelId, role)
  return await runtimeCandidate(await aiConfigurationRepository.findDefaultEnabledModelId(), role)
}

export async function resolveAiModelByKey(modelKey: string, role?: string) {
  const ids = await aiConfigurationRepository.findEnabledModelIdsByKey(modelKey, 2)
  if (ids.length !== 1) return null
  return await runtimeCandidate(ids[0], role)
}

export async function resolveAiModelById(modelId: string, role?: string) {
  return await runtimeCandidate(modelId, role)
}

export async function testModelProvider(providerId: string, actor: AiModelActor) {
  assertAiModelAdmin(actor)
  const provider = await aiConfigurationRepository.findProvider(providerId)
  if (!provider) throw serviceError('模型 Provider 不存在', 'MODEL_PROVIDER_NOT_FOUND', 404)
  if (!provider.credentialCiphertext) throw serviceError('Provider 尚未配置 API Key', 'MODEL_CREDENTIAL_MISSING', 409)
  const apiKey = decryptModelCredential(provider.credentialCiphertext, provider.id)
  const traceId = randomUUID()
  const started = Date.now()
  let ok = false
  let status = 0
  let safeError: string | null = null
  try {
    let response = await fetch(`${provider.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'X-Request-Id': traceId },
      signal: AbortSignal.timeout(provider.timeoutMs),
    })
    if ([404, 405].includes(response.status) && provider.protocol === 'openai-compatible') {
      response = await fetch(`${provider.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Request-Id': traceId,
        },
        // An intentionally incomplete request verifies route and authentication
        // without starting a billable generation on compatible gateways.
        body: '{}',
        signal: AbortSignal.timeout(provider.timeoutMs),
      })
    }
    status = response.status
    ok = response.ok || [400, 422].includes(response.status)
    if (!ok) safeError = `HTTP ${response.status}`
  } catch (error) {
    safeError = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 500)
  }
  const latencyMs = Date.now() - started
  await aiConfigurationRepository.recordProviderTestWithAudit({
    providerId,
    ok,
    error: safeError,
    latencyMs,
    traceId,
    testedAt: new Date(),
    audit: auditRecord(actor, '测试 Provider 连接', `${providerId}:${ok ? 'succeeded' : 'failed'}:${traceId}`),
  })
  return { ok, status, latencyMs, traceId, error: safeError }
}
