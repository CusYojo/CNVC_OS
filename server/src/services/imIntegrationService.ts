import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  agentConversationRepository,
  identityRepositories,
  imIntegrationRepository,
} from '../repositories/index.js'
import type { AuditRecord, ImBotRecord, ImLeadRecord } from '../repositories/index.js'
import {
  decryptIntegrationCredential,
  encryptIntegrationCredential,
} from '../security/integrationCredentialCrypto.js'
import { redactSensitiveText } from '../security/redactSecrets.js'
import { listConfigurationRevisions, rollbackConfigurationRevision } from './adminConfigurationRevisionService.js'

export const IM_ADMIN_ROLES = ['系统管理员', '运营管理员'] as const
export const IM_PLATFORMS = ['dingtalk', 'feishu', 'wechat'] as const
export type ImPlatform = typeof IM_PLATFORMS[number]
export type ImActor = { userId: string; userName: string; role: string; department?: string; ip?: string }
export const IM_CONFIGURATION_REVISION_TYPES = ['im_bot', 'im_binding', 'im_lead_push_rule'] as const
export type ImConfigurationRevisionType = typeof IM_CONFIGURATION_REVISION_TYPES[number]

function serviceError(message: string, code: string, status: number) {
  return Object.assign(new Error(message), { code, status })
}

export function assertImAdmin(actor: ImActor) {
  if (!(IM_ADMIN_ROLES as readonly string[]).includes(actor.role)) {
    throw serviceError('仅系统管理员或运营管理员可管理 IM 机器人', 'ROLE_FORBIDDEN', 403)
  }
}

function safeError(error: unknown) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 500)
}

function stableHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function botView(row: ImBotRecord) {
  const { credentialCiphertext: _ciphertext, credentialFingerprint: _fingerprint, ...safe } = row
  return { ...safe, hasCredential: Boolean(row.credentialCiphertext), credentialMasked: row.credentialHint }
}

function auditRecord(
  actor: ImActor,
  action: string,
  target: string,
  result: 'success' | 'failed' | 'denied' = 'success',
): AuditRecord {
  return {
    userId: actor.userId,
    userName: actor.userName,
    module: 'IM机器人',
    action,
    target: target.slice(0, 8_000),
    ip: actor.ip,
    result,
  }
}

function allowedWebhookHosts(platform: ImPlatform) {
  const builtIn: Record<ImPlatform, string[]> = {
    dingtalk: ['oapi.dingtalk.com', 'api.dingtalk.com'],
    feishu: ['open.feishu.cn'],
    wechat: ['qyapi.weixin.qq.com'],
  }
  return new Set([
    ...builtIn[platform],
    ...(process.env.IM_WEBHOOK_ALLOWED_HOSTS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
  ])
}

export function validateImCredentials(platform: ImPlatform, credentials: Record<string, string>): Record<string, string> {
  if (platform === 'wechat' && credentials.transport?.trim() === 'ilink') {
    const botToken = credentials.botToken?.trim()
    const accountId = credentials.accountId?.trim()
    const inboundSecret = credentials.inboundSecret?.trim()
    if (!botToken || botToken.length < 16 || !accountId || !inboundSecret || inboundSecret.length < 16) {
      throw serviceError('微信扫码凭据不完整', 'IM_WEIXIN_CREDENTIAL_INVALID', 400)
    }
    let baseUrl: URL
    try { baseUrl = new URL(credentials.baseUrl?.trim() || 'https://ilinkai.weixin.qq.com') } catch {
      throw serviceError('微信服务地址无效', 'IM_WEIXIN_BASE_URL_INVALID', 400)
    }
    const host = baseUrl.hostname.toLowerCase()
    if (baseUrl.protocol !== 'https:' || (host !== 'weixin.qq.com' && !host.endsWith('.weixin.qq.com'))) {
      throw serviceError('微信服务地址不在允许列表', 'IM_WEIXIN_BASE_URL_FORBIDDEN', 403)
    }
    return {
      transport: 'ilink', botToken, accountId, inboundSecret,
      baseUrl: baseUrl.origin,
    }
  }
  const webhookUrl = credentials.webhookUrl?.trim()
  const inboundSecret = credentials.inboundSecret?.trim()
  if (!webhookUrl || !inboundSecret || inboundSecret.length < 16) {
    throw serviceError('机器人凭据必须包含 webhookUrl 和至少 16 位 inboundSecret', 'IM_CREDENTIAL_INVALID', 400)
  }
  if (webhookUrl === 'mock://success' || webhookUrl === 'mock://failure') {
    if (process.env.NODE_ENV === 'production' && process.env.IM_SAFE_MOCK_ENABLED !== 'true') {
      throw serviceError('生产环境禁止使用 Mock webhook', 'IM_WEBHOOK_FORBIDDEN', 403)
    }
    return { ...credentials, webhookUrl, inboundSecret }
  }
  let parsed: URL
  try { parsed = new URL(webhookUrl) } catch { throw serviceError('Webhook URL 无效', 'IM_WEBHOOK_INVALID', 400) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw serviceError('Webhook 必须使用不含内嵌凭据或片段的 HTTPS URL', 'IM_WEBHOOK_INVALID', 400)
  }
  if (!allowedWebhookHosts(platform).has(parsed.hostname.toLowerCase())) {
    throw serviceError('Webhook 主机不在允许列表', 'IM_WEBHOOK_HOST_FORBIDDEN', 403)
  }
  return { ...credentials, webhookUrl: parsed.toString(), inboundSecret }
}

export async function listImSettings(actor: ImActor) {
  assertImAdmin(actor)
  const data = await imIntegrationRepository.listSettingsData()
  const userOptions = data.users.map((user) => ({
      id: user.id,
      name: user.name,
      role: user.role,
      department: user.department,
      status: user.status,
    })).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  const conversationOptions = data.conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      userId: conversation.userId,
      projectId: conversation.projectId,
      status: conversation.status,
      externalSessionId: conversation.externalSessionId,
    }))
  return {
    bots: data.bots.map(botView), bindings: data.bindings, outbox: data.outbox, deliveryLogs: data.logs,
    users: userOptions, projects: data.projects,
    conversations: conversationOptions.map(({ externalSessionId, ...conversation }) => ({
      ...conversation, runtimeReady: Boolean(externalSessionId),
    })),
  }
}

export async function listImConfigurationRevisions(
  resourceType: ImConfigurationRevisionType,
  resourceId: string,
  actor: ImActor,
) {
  assertImAdmin(actor)
  return listConfigurationRevisions({ domain: 'im', resourceType, resourceId })
}

export async function rollbackImConfigurationRevision(input: {
  resourceType: ImConfigurationRevisionType
  resourceId: string
  revisionId: string
  expectedVersion: number
  confirmImpact?: boolean
}, actor: ImActor) {
  assertImAdmin(actor)
  return rollbackConfigurationRevision({
    domain: 'im', resourceType: input.resourceType, resourceId: input.resourceId,
    revisionId: input.revisionId, expectedVersion: input.expectedVersion,
    confirmImpact: input.confirmImpact, module: 'IM机器人', action: '回滚 IM 配置',
  }, actor)
}

const LEAD_TEMPLATE_FIELDS = new Set(['name', 'companyName', 'industry', 'status', 'score', 'projectName'])

function validateLeadMessageTemplate(value: string) {
  const template = value.trim()
  if (!template || template.length > 4_000) {
    throw serviceError('推送模板必须为 1—4000 个字符', 'IM_PUSH_TEMPLATE_INVALID', 400)
  }
  for (const match of template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) {
    if (!LEAD_TEMPLATE_FIELDS.has(match[1])) {
      throw serviceError(`推送模板字段不受支持：${match[1]}`, 'IM_PUSH_TEMPLATE_FIELD_INVALID', 400)
    }
  }
  return template
}

async function requireEnabledPushTarget(botId: string, bindingId: string) {
  const target = await imIntegrationRepository.findEnabledPushTarget(botId, bindingId)
  if (!target) {
    throw serviceError('只能选择已授权且启用的机器人绑定', 'IM_PUSH_TARGET_FORBIDDEN', 409)
  }
  return target
}

export async function listLeadPushSettings(actor: ImActor) {
  assertImAdmin(actor)
  const data = await imIntegrationRepository.listLeadPushSettingsData()
  return { targets: data.targets, rules: data.rules, projects: data.projects }
}

export async function createLeadPushRule(input: {
  name: string
  botId: string
  bindingId: string
  leadStatus?: string | null
  projectId?: string | null
  minScore?: number | null
  messageTemplate: string
  enabled?: boolean
}, actor: ImActor) {
  assertImAdmin(actor)
  const target = await requireEnabledPushTarget(input.botId, input.bindingId)
  if (target.binding.projectId && target.binding.projectId !== input.projectId) {
    throw serviceError('规则项目必须与机器人绑定项目一致', 'IM_PUSH_PROJECT_MISMATCH', 400)
  }
  if (input.projectId && !(await identityRepositories.permissions.findProjectById(input.projectId))) {
    throw serviceError('推送项目不存在', 'IM_PUSH_PROJECT_INVALID', 400)
  }
  const id = randomUUID()
  const result = await imIntegrationRepository.createLeadPushRuleWithAudit({
      id, name: input.name.trim(), botId: input.botId, bindingId: input.bindingId,
      leadStatus: input.leadStatus?.trim() || null, projectId: input.projectId || null,
      minScore: input.minScore ?? null, messageTemplate: validateLeadMessageTemplate(input.messageTemplate),
      enabled: input.enabled ?? true, createdBy: actor.userId, updatedBy: actor.userId,
    }, auditRecord(actor, '新增线索推送规则', `${id}:${input.botId}:${input.bindingId}`))
  if (result.status === 'target_forbidden') throw serviceError('只能选择已授权且启用的机器人绑定', 'IM_PUSH_TARGET_FORBIDDEN', 409)
  if (result.status === 'project_mismatch') throw serviceError('规则项目必须与机器人绑定项目一致', 'IM_PUSH_PROJECT_MISMATCH', 400)
  if (result.status === 'project_invalid') throw serviceError('推送项目不存在', 'IM_PUSH_PROJECT_INVALID', 400)
  if (!('record' in result)) throw serviceError('线索推送规则创建失败', 'IM_PUSH_RULE_INVALID', 400)
  return result.record
}

export async function updateLeadPushRule(ruleId: string, input: {
  expectedVersion: number
  name?: string
  leadStatus?: string | null
  projectId?: string | null
  minScore?: number | null
  messageTemplate?: string
  enabled?: boolean
}, actor: ImActor) {
  assertImAdmin(actor)
  const existing = await imIntegrationRepository.findLeadPushRule(ruleId)
  if (!existing) throw serviceError('线索推送规则不存在', 'IM_PUSH_RULE_NOT_FOUND', 404)
  const target = await requireEnabledPushTarget(existing.botId, existing.bindingId)
  const projectId = input.projectId === undefined ? existing.projectId : input.projectId
  if (target.binding.projectId && target.binding.projectId !== projectId) {
    throw serviceError('规则项目必须与机器人绑定项目一致', 'IM_PUSH_PROJECT_MISMATCH', 400)
  }
  if (projectId && !(await identityRepositories.permissions.findProjectById(projectId))) {
    throw serviceError('推送项目不存在', 'IM_PUSH_PROJECT_INVALID', 400)
  }
  const result = await imIntegrationRepository.updateLeadPushRuleWithAudit({
    ruleId,
    expectedVersion: input.expectedVersion,
    patch: {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.leadStatus === undefined ? {} : { leadStatus: input.leadStatus?.trim() || null }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId || null }),
      ...(input.minScore === undefined ? {} : { minScore: input.minScore }),
      ...(input.messageTemplate === undefined ? {} : { messageTemplate: validateLeadMessageTemplate(input.messageTemplate) }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      updatedBy: actor.userId,
    },
    updatedAt: new Date(),
    audit: auditRecord(actor, '修改线索推送规则', ruleId),
  })
  if (result.status === 'not_found') throw serviceError('线索推送规则不存在', 'IM_PUSH_RULE_NOT_FOUND', 404)
  if (result.status === 'conflict') throw serviceError('规则已被其他管理员修改', 'IM_PUSH_RULE_VERSION_CONFLICT', 409)
  if (result.status === 'target_forbidden') throw serviceError('只能选择已授权且启用的机器人绑定', 'IM_PUSH_TARGET_FORBIDDEN', 409)
  if (result.status === 'project_mismatch') throw serviceError('规则项目必须与机器人绑定项目一致', 'IM_PUSH_PROJECT_MISMATCH', 400)
  if (result.status === 'project_invalid') throw serviceError('推送项目不存在', 'IM_PUSH_PROJECT_INVALID', 400)
  if (!('record' in result)) throw serviceError('线索推送规则更新失败', 'IM_PUSH_RULE_INVALID', 400)
  return result.record
}

export async function deleteLeadPushRule(ruleId: string, actor: ImActor) {
  assertImAdmin(actor)
  const deleted = await imIntegrationRepository.deleteLeadPushRuleWithAudit(ruleId, auditRecord(actor, '删除线索推送规则', ruleId))
  if (!deleted) throw serviceError('线索推送规则不存在', 'IM_PUSH_RULE_NOT_FOUND', 404)
  return { ok: true }
}

function renderLeadPushMessage(template: string, lead: ImLeadRecord, projectName: string) {
  const fields: Record<string, string> = {
    name: lead.name, companyName: lead.companyName || '待核验', industry: lead.industry || '待核验',
    status: lead.poolStatus, score: String(lead.score), projectName: projectName || '未关联项目',
  }
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_all, key: string) => fields[key] || '').slice(0, 4_000)
}

export async function dispatchLeadPushRule(input: {
  ruleId: string
  leadId: string
  idempotencyKey: string
}, actor: ImActor) {
  assertImAdmin(actor)
  const row = await imIntegrationRepository.findLeadPushDispatch(input.ruleId, input.leadId)
  if (!row || !row.rule.enabled) throw serviceError('线索推送规则不存在或未启用', 'IM_PUSH_RULE_DISABLED', 409)
  await requireEnabledPushTarget(row.rule.botId, row.rule.bindingId)
  if (row.rule.leadStatus && row.rule.leadStatus !== row.lead.poolStatus) {
    throw serviceError('线索状态不匹配推送规则', 'IM_PUSH_RULE_NOT_MATCHED', 409)
  }
  if (row.rule.projectId && row.rule.projectId !== row.lead.convertedProjectId) {
    throw serviceError('线索项目不匹配推送规则', 'IM_PUSH_RULE_NOT_MATCHED', 409)
  }
  if (row.rule.minScore !== null && row.lead.score < row.rule.minScore) {
    throw serviceError('线索评分不匹配推送规则', 'IM_PUSH_RULE_NOT_MATCHED', 409)
  }
  return await enqueueImMessage({
    botId: row.rule.botId, bindingId: row.rule.bindingId,
    idempotencyKey: `lead-rule:${stableHash(input).slice(0, 64)}`,
    message: renderLeadPushMessage(row.rule.messageTemplate, row.lead, row.projectName || ''),
  }, actor)
}

export async function createImBot(input: {
  platform: ImPlatform
  name: string
  credentials: Record<string, string>
  config?: Record<string, unknown>
  enabled?: boolean
}, actor: ImActor) {
  assertImAdmin(actor)
  const id = randomUUID()
  const credentials = validateImCredentials(input.platform, input.credentials)
  const encrypted = encryptIntegrationCredential(credentials, id)
  const created = await imIntegrationRepository.createBotWithAudit({
      id,
      platform: input.platform,
      name: input.name.trim(),
      credentialCiphertext: encrypted.ciphertext,
      credentialHint: encrypted.hint,
      credentialFingerprint: encrypted.fingerprint,
      config: input.config || {},
      enabled: input.enabled ?? false,
      connectionStatus: 'disconnected',
      createdBy: actor.userId,
      updatedBy: actor.userId,
    }, auditRecord(actor, '新增机器人', `${id}:${input.platform}:${input.name.trim()}`))
  return botView(created)
}

export async function createWeixinBotFromLogin(input: {
  accountId: string
  accountUserId?: string | null
  botToken: string
  baseUrl: string
}, actor: ImActor) {
  assertImAdmin(actor)
  const credentials = {
    transport: 'ilink',
    accountId: input.accountId,
    botToken: input.botToken,
    baseUrl: input.baseUrl,
    inboundSecret: createHash('sha256').update(`${randomUUID()}:${input.accountId}`).digest('hex'),
  }
  const accountConfig = {
    transport: 'ilink',
    accountId: input.accountId,
    accountUserId: input.accountUserId || null,
    authorizedAt: new Date().toISOString(),
  }
  const data = await imIntegrationRepository.listSettingsData()
  const existing = data.bots.find((bot) => bot.platform === 'wechat' && (
    String(bot.config.accountId || '') === input.accountId
    || Boolean(input.accountUserId && String(bot.config.accountUserId || '') === input.accountUserId)
  ))
  const created = existing
    ? await updateImBot(existing.id, {
        expectedVersion: existing.version,
        credentials,
        config: { ...existing.config, ...accountConfig },
        enabled: true,
      }, actor)
    : await createImBot({
        platform: 'wechat',
        name: `微信机器人 ${input.accountId.replace(/@.*$/, '').slice(-12)}`,
        credentials,
        config: accountConfig,
        enabled: true,
      }, actor)
  await imIntegrationRepository.recordBotTestWithAudit({
    botId: created.id,
    ok: true,
    error: null,
    testedAt: new Date(),
    audit: auditRecord(actor, '微信扫码授权', `${created.id}:${input.accountId}`),
  })
  const connected = await imIntegrationRepository.findBot(created.id)
  return connected ? botView(connected) : created
}

export async function updateImBot(botId: string, input: {
  expectedVersion: number
  name?: string
  credentials?: Record<string, string>
  config?: Record<string, unknown>
  enabled?: boolean
  confirmDisableImpact?: boolean
}, actor: ImActor) {
  assertImAdmin(actor)
  const existing = await imIntegrationRepository.findBot(botId)
  if (!existing) throw serviceError('IM 机器人不存在', 'IM_BOT_NOT_FOUND', 404)
    const credentialPatch = input.credentials === undefined ? {} : (() => {
      const credentials = validateImCredentials(existing.platform as ImPlatform, input.credentials!)
      const encrypted = encryptIntegrationCredential(credentials, botId)
      return {
        credentialCiphertext: encrypted.ciphertext,
        credentialHint: encrypted.hint,
        credentialFingerprint: encrypted.fingerprint,
        connectionStatus: 'disconnected',
        lastConnectedAt: null,
        lastError: null,
      }
    })()
  const result = await imIntegrationRepository.updateBotWithAudit({
    botId,
    expectedVersion: input.expectedVersion,
    patch: {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.config === undefined ? {} : { config: input.config }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.enabled === false ? {
        connectionStatus: 'disconnected', lastConnectedAt: null, lastError: null,
      } : {}),
      ...credentialPatch,
      updatedBy: actor.userId,
    },
    confirmDisableImpact: Boolean(input.confirmDisableImpact),
    updatedAt: new Date(),
    audit: auditRecord(actor, input.credentials ? '替换机器人凭据' : '修改机器人', botId),
  })
  if (result.status === 'not_found') throw serviceError('IM 机器人不存在', 'IM_BOT_NOT_FOUND', 404)
  if (result.status === 'disable_confirmation_required') {
    throw serviceError('机器人仍有启用绑定或未完成任务，需确认影响后再停用', 'IM_DISABLE_CONFIRMATION_REQUIRED', 409)
  }
  if (result.status === 'conflict') throw serviceError('机器人已被其他管理员修改，请刷新后重试', 'IM_VERSION_CONFLICT', 409)
  return botView(result.record)
}

function deliveryBody(platform: ImPlatform, message: string) {
  if (platform === 'feishu') return { msg_type: 'text', content: { text: message } }
  return { msgtype: 'text', text: { content: message } }
}

async function deliverWebhook(
  bot: ImBotRecord,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const credentials = decryptIntegrationCredential(bot.credentialCiphertext, bot.id)
  if (bot.platform === 'wechat' && credentials.transport === 'ilink') {
    throw serviceError('微信扫码账号需先捕获接收目标后发送消息', 'IM_WEIXIN_TARGET_REQUIRED', 409)
  }
  const webhookUrl = credentials.webhookUrl
  const message = String(payload.message || '').trim()
  if (!message) throw serviceError('发送内容为空', 'IM_MESSAGE_EMPTY', 400)
  const started = Date.now()
  if (webhookUrl === 'mock://success') {
    return { ok: true, status: 200, durationMs: Date.now() - started, externalMessageId: `mock-${randomUUID()}` }
  }
  if (webhookUrl === 'mock://failure') {
    return { ok: false, status: 503, durationMs: Date.now() - started, error: 'mock delivery failed' }
  }
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deliveryBody(bot.platform as ImPlatform, message)),
    signal: signal || AbortSignal.timeout(15_000),
    redirect: 'error',
  })
  return {
    ok: response.ok,
    status: response.status,
    durationMs: Date.now() - started,
    error: response.ok ? undefined : `HTTP ${response.status}`,
    externalMessageId: response.headers.get('x-request-id') || undefined,
  }
}

export async function testImBotConnection(botId: string, actor: ImActor) {
  assertImAdmin(actor)
  const bot = await imIntegrationRepository.findBot(botId)
  if (!bot) throw serviceError('IM 机器人不存在', 'IM_BOT_NOT_FOUND', 404)
  const storedCredentials = decryptIntegrationCredential(bot.credentialCiphertext, bot.id)
  if (bot.platform === 'wechat' && storedCredentials.transport === 'ilink') {
    const ok = Boolean(storedCredentials.botToken && storedCredentials.accountId)
    await imIntegrationRepository.recordBotTestWithAudit({
      botId, ok, error: ok ? null : '微信扫码凭据不完整', testedAt: new Date(),
      audit: auditRecord(actor, '检查微信扫码授权', `${botId}:${ok ? 'succeeded' : 'failed'}`),
    })
    return { ok, status: ok ? 200 : 409, latencyMs: 0, error: ok ? null : '微信扫码凭据不完整' }
  }
  let result: Awaited<ReturnType<typeof deliverWebhook>>
  try {
    result = await deliverWebhook(bot, { message: '投资中台 IM 机器人连接测试' })
  } catch (error) {
    result = { ok: false, status: 0, durationMs: 0, error: safeError(error) }
  }
  await imIntegrationRepository.recordBotTestWithAudit({
    botId, ok: result.ok, error: result.ok ? null : safeError(result.error), testedAt: new Date(),
    audit: auditRecord(actor, '测试机器人连接', `${botId}:${result.ok ? 'succeeded' : 'failed'}`),
  })
  return { ok: result.ok, status: result.status, latencyMs: result.durationMs, error: result.error || null }
}

export async function createImBinding(input: {
  botId: string
  externalConversationId: string
  userId: string
  projectId?: string | null
  conversationId?: string | null
  department?: string | null
  enabled?: boolean
}, actor: ImActor) {
  assertImAdmin(actor)
  const id = randomUUID()
  const result = await imIntegrationRepository.createBindingWithAudit({
    record: {
      id,
      botId: input.botId,
      externalConversationId: input.externalConversationId.trim(),
      userId: input.userId,
      projectId: input.projectId ?? null,
      conversationId: input.conversationId ?? null,
      department: input.department?.trim() || null,
      enabled: input.enabled ?? true,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    },
    audit: auditRecord(actor, '新增机器人绑定', `${id}:${input.botId}:${input.userId}`),
  })
  if (result.status === 'bot_not_found') throw serviceError('IM 机器人不存在', 'IM_BOT_NOT_FOUND', 404)
  if (result.status === 'user_invalid') throw serviceError('绑定用户不存在或已禁用', 'IM_BINDING_USER_INVALID', 400)
  if (result.status === 'project_invalid') throw serviceError('绑定项目不存在', 'IM_BINDING_PROJECT_INVALID', 400)
  if (result.status === 'conversation_invalid') throw serviceError('Agent 会话与绑定用户/项目不一致', 'IM_BINDING_CONVERSATION_INVALID', 400)
  if (!('record' in result)) throw serviceError('机器人绑定创建失败', 'IM_BINDING_INVALID', 400)
  return result.record
}

export async function updateImBinding(bindingId: string, input: {
  expectedVersion: number
  externalConversationId?: string
  enabled?: boolean
}, actor: ImActor) {
  assertImAdmin(actor)
  const result = await imIntegrationRepository.updateBindingWithAudit({
    bindingId,
    expectedVersion: input.expectedVersion,
    patch: {
      ...(input.externalConversationId === undefined ? {} : { externalConversationId: input.externalConversationId.trim() }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      updatedBy: actor.userId,
    },
    updatedAt: new Date(),
    audit: auditRecord(actor, '修改机器人绑定', bindingId),
  })
  if (result.status !== 'ok') throw serviceError('绑定不存在或已被修改', 'IM_BINDING_VERSION_CONFLICT', 409)
  return result.record
}

export async function deleteImBinding(bindingId: string, actor: ImActor) {
  assertImAdmin(actor)
  const result = await imIntegrationRepository.deleteBindingWithAudit(bindingId, auditRecord(actor, '删除机器人绑定', bindingId))
  if (result === 'has_push_rule') throw serviceError('绑定仍被线索推送规则引用，请先删除规则', 'IM_BINDING_HAS_PUSH_RULE', 409)
  if (result === 'has_history') throw serviceError('绑定已有投递历史，请停用以保留审计链', 'IM_BINDING_HAS_HISTORY', 409)
  if (result === 'not_found') throw serviceError('机器人绑定不存在', 'IM_BINDING_NOT_FOUND', 404)
  return { ok: true }
}

export async function enqueueImMessage(input: {
  botId: string
  bindingId: string
  idempotencyKey: string
  message: string
}, actor: ImActor) {
  const payload = { message: input.message.trim() }
  if (!payload.message || payload.message.length > 4_000) {
    throw serviceError('发送内容必须为 1—4000 个字符', 'IM_MESSAGE_INVALID', 400)
  }
  const payloadHash = stableHash(payload)
  const id = randomUUID()
  const result = await imIntegrationRepository.enqueueMessageWithAudit({
    id, botId: input.botId, bindingId: input.bindingId, actorUserId: actor.userId,
    actorIsAdmin: (IM_ADMIN_ROLES as readonly string[]).includes(actor.role),
    idempotencyKey: input.idempotencyKey, payloadHash, payload,
    successAudit: auditRecord(actor, '创建发送任务', `${id}:${input.botId}:${input.bindingId}`),
    deniedAudit: auditRecord(actor, '发送机器人消息', input.bindingId, 'denied'),
  })
  if (result.status === 'binding_disabled') throw serviceError('机器人或绑定未启用', 'IM_BINDING_DISABLED', 409)
  if (result.status === 'forbidden') throw serviceError('无权使用该机器人绑定', 'IM_BINDING_FORBIDDEN', 403)
  if (result.status === 'idempotency_conflict') throw serviceError('幂等键已用于不同发送内容', 'IM_IDEMPOTENCY_CONFLICT', 409)
  if (!('record' in result)) throw serviceError('发送任务创建失败', 'IM_OUTBOX_INVALID', 409)
  return result.record
}

export async function processImOutboxBatch(input: {
  owner?: string
  limit?: number
  maxAttempts?: number
  signal?: AbortSignal
} = {}) {
  const owner = input.owner || `im-outbox:${process.pid}:${randomUUID().slice(0, 8)}`
  const limit = Math.min(50, Math.max(1, input.limit || 10))
  const maxAttempts = Math.min(20, Math.max(1, input.maxAttempts || 5))
  const claimed = await imIntegrationRepository.claimOutboxBatch({
    owner, limit, leaseExpiresAt: new Date(Date.now() + 60_000),
  })

  let sent = 0
  let failed = 0
  let deadLetter = 0
  let rateLimited = 0
  for (const claim of claimed) {
    if (input.signal?.aborted) break
    const bot = await imIntegrationRepository.findBot(claim.botId)
    if (!bot || !bot.enabled) {
      await imIntegrationRepository.deferClaimForDisabledBot({
        outboxId: claim.id, owner, nextAttemptAt: new Date(Date.now() + 60_000), updatedAt: new Date(),
      })
      failed += 1
      continue
    }
    const attempt = Number(claim.attempts) + 1
    const rawRateLimit = Number((bot.config as Record<string, unknown>).rateLimitPerMinute ?? 20)
    const rateLimitPerMinute = Number.isFinite(rawRateLimit)
      ? Math.min(120, Math.max(1, Math.floor(rawRateLimit))) : 20
    const minIntervalMs = Math.ceil(60_000 / rateLimitPerMinute)
    const deliveredAt = await imIntegrationRepository.findLatestDeliveryAt(bot.id)
    if (deliveredAt && Date.now() - new Date(deliveredAt).getTime() < minIntervalMs) {
      const nextAttemptAt = new Date(new Date(deliveredAt).getTime() + minIntervalMs)
      await imIntegrationRepository.deferClaimForRateLimit({ outboxId: claim.id, owner, nextAttemptAt })
      rateLimited += 1
      continue
    }
    let delivery: Awaited<ReturnType<typeof deliverWebhook>>
    try {
      delivery = await deliverWebhook(bot, claim.payload, input.signal)
    } catch (error) {
      delivery = { ok: false, status: 0, durationMs: 0, error: safeError(error) }
    }
    const terminal = !delivery.ok && attempt >= maxAttempts
    const nextAttemptAt = new Date(Date.now() + Math.min(30 * 60_000, 1_000 * (2 ** Math.max(0, attempt - 1))))
    await imIntegrationRepository.completeDelivery({
      outboxId: claim.id, owner, attempt, ok: delivery.ok, terminal,
      externalMessageId: delivery.externalMessageId, httpStatus: delivery.status,
      durationMs: delivery.durationMs, error: delivery.ok ? null : safeError(delivery.error),
      nextAttemptAt, completedAt: new Date(),
    })
    if (delivery.ok) sent += 1
    else if (terminal) deadLetter += 1
    else failed += 1
  }
  return { claimed: claimed.length, sent, failed, deadLetter, rateLimited }
}

function secretMatches(expected: string, provided: string) {
  const left = createHash('sha256').update(expected).digest()
  const right = createHash('sha256').update(provided).digest()
  return timingSafeEqual(left, right)
}

export async function routeImInboundMessage(input: {
  botId: string
  inboundSecret: string
  externalMessageId: string
  externalConversationId: string
  externalUserId?: string
  message: string
  payload?: Record<string, unknown>
}, dispatch: (route: {
  userId: string
  conversationId: string
  agentId: string
  userRole: string
  message: string
}) => Promise<unknown>) {
  const bot = await imIntegrationRepository.findBot(input.botId)
  if (!bot || !bot.enabled) throw serviceError('机器人不存在或未启用', 'IM_BOT_DISABLED', 404)
  const credentials = decryptIntegrationCredential(bot.credentialCiphertext, bot.id)
  if (!credentials.inboundSecret || !secretMatches(credentials.inboundSecret, input.inboundSecret)) {
    throw serviceError('入站签名无效', 'IM_INBOUND_UNAUTHORIZED', 401)
  }
  const binding = await imIntegrationRepository.findEnabledInboundBinding(input.botId, input.externalConversationId)
  const contentHash = stableHash({ message: input.message, payload: input.payload || {} })
  const existing = await imIntegrationRepository.findInboundMessage(input.botId, input.externalMessageId)
  if (existing) return { ...existing, duplicate: true }
  const conversation = binding?.conversationId
    ? await agentConversationRepository.findAgentById(binding.conversationId)
    : null
  const boundUser = binding ? await identityRepositories.users.findById(binding.userId) : null
  if (!binding || !conversation || !boundUser || boundUser.status !== '启用'
    || conversation.userId !== binding.userId
    || (binding.projectId && conversation.projectId !== binding.projectId)
    || !conversation.externalSessionId) {
    const id = randomUUID()
    const inserted = await imIntegrationRepository.createInboundMessage({
      id,
      botId: input.botId,
      bindingId: null,
      externalMessageId: input.externalMessageId,
      externalConversationId: input.externalConversationId,
      externalUserId: input.externalUserId ?? null,
      contentHash,
      payload: input.payload || {},
      status: 'rejected',
      rejectionReason: 'binding_not_authorized',
    })
    if (inserted === 'duplicate') {
      const raced = await imIntegrationRepository.findInboundMessage(input.botId, input.externalMessageId)
      if (raced) return { ...raced, duplicate: true }
    }
    throw serviceError('外部会话未绑定授权用户、项目和 Agent', 'IM_INBOUND_ROUTE_FORBIDDEN', 403)
  }
  const id = randomUUID()
  const inserted = await imIntegrationRepository.createInboundMessage({
      id,
      botId: input.botId,
      bindingId: binding.id,
      externalMessageId: input.externalMessageId,
      externalConversationId: input.externalConversationId,
      externalUserId: input.externalUserId ?? null,
      contentHash,
      payload: input.payload || {},
      status: 'accepted',
      rejectionReason: null,
    })
  if (inserted === 'duplicate') {
    const raced = await imIntegrationRepository.findInboundMessage(input.botId, input.externalMessageId)
    if (raced) return { ...raced, duplicate: true }
    throw serviceError('入站消息幂等冲突', 'IM_INBOUND_CONFLICT', 409)
  }
  try {
    await dispatch({
      userId: binding.userId,
      conversationId: conversation.id,
      agentId: conversation.externalSessionId,
      userRole: boundUser.role,
      message: input.message,
    })
    await imIntegrationRepository.updateInboundStatus(id, 'dispatched')
  } catch (error) {
    await imIntegrationRepository.updateInboundStatus(id, 'failed', safeError(error).slice(0, 64))
    throw error
  }
  const created = await imIntegrationRepository.findInboundMessageById(id)
  return { ...created, duplicate: false }
}
