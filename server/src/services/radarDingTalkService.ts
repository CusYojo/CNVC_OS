import { createHmac } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { auditLogs, radarDingTalkSettings } from '../db/schema.js'
import {
  decryptIntegrationCredential,
  encryptIntegrationCredential,
} from '../security/integrationCredentialCrypto.js'

const SETTINGS_ID = 'default'
const CREDENTIAL_CONTEXT = 'radar-dingtalk:default'
const ALLOWED_HOSTS = new Set(['oapi.dingtalk.com', 'api.dingtalk.com'])

type Actor = { userId: string; userName: string; ip?: string }
type Credentials = { webhookUrl: string; signingSecret: string }

function serviceError(message: string, code: string, status: number) {
  return Object.assign(new Error(message), { code, status })
}

function safeDingTalkError(message: unknown): string {
  return String(message || '钉钉返回未知错误')
    .replace(/https?:\/\/[^\s]+/gi, '[WEBHOOK_REDACTED]')
    .replace(/access_token=[^&\s]+/gi, 'access_token=[REDACTED]')
    .slice(0, 500)
}

export function validateRadarDingTalkWebhook(webhookUrl: string): string {
  let parsed: URL
  try { parsed = new URL(webhookUrl.trim()) } catch {
    throw serviceError('Webhook URL 格式无效', 'RADAR_DINGTALK_WEBHOOK_INVALID', 400)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw serviceError('Webhook 必须是不含内嵌账号或片段的 HTTPS URL', 'RADAR_DINGTALK_WEBHOOK_INVALID', 400)
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.pathname !== '/robot/send') {
    throw serviceError('Webhook 必须使用钉钉自定义机器人地址', 'RADAR_DINGTALK_WEBHOOK_FORBIDDEN', 400)
  }
  if (!parsed.searchParams.get('access_token')) {
    throw serviceError('Webhook 缺少 access_token', 'RADAR_DINGTALK_ACCESS_TOKEN_MISSING', 400)
  }
  parsed.searchParams.delete('timestamp')
  parsed.searchParams.delete('sign')
  return parsed.toString()
}

export function createDingTalkSignedWebhookUrl(webhookUrl: string, signingSecret: string, timestamp: number): string {
  const parsed = new URL(webhookUrl)
  const stringToSign = `${timestamp}\n${signingSecret}`
  const sign = createHmac('sha256', signingSecret).update(stringToSign).digest('base64')
  parsed.searchParams.set('timestamp', String(timestamp))
  parsed.searchParams.set('sign', sign)
  return parsed.toString()
}

export async function sendDingTalkWebhook(
  credentials: Credentials,
  message: string,
  options: { fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)
  try {
    const signedUrl = createDingTalkSignedWebhookUrl(
      credentials.webhookUrl,
      credentials.signingSecret,
      (options.now ?? Date.now)(),
    )
    let response: Response
    try {
      response = await fetchImpl(signedUrl, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: message.slice(0, 4_000) },
          at: { isAtAll: false },
        }),
        signal: controller.signal,
      })
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError'
      throw serviceError(
        timedOut ? '钉钉 Webhook 请求超时' : '钉钉 Webhook 请求失败',
        timedOut ? 'RADAR_DINGTALK_TIMEOUT' : 'RADAR_DINGTALK_REQUEST_FAILED',
        502,
      )
    }
    const raw = await response.text()
    let payload: { errcode?: number | string; errmsg?: string } = {}
    try { payload = raw ? JSON.parse(raw) as typeof payload : {} } catch {}
    if (!response.ok || Number(payload.errcode ?? -1) !== 0) {
      throw serviceError(
        `钉钉机器人发送失败：${safeDingTalkError(payload.errmsg || `HTTP ${response.status}`)}`,
        'RADAR_DINGTALK_DELIVERY_FAILED',
        502,
      )
    }
    return { ok: true as const, durationMs: Date.now() - startedAt }
  } finally {
    clearTimeout(timeout)
  }
}

function safeView(row?: typeof radarDingTalkSettings.$inferSelect) {
  if (!row) {
    return {
      id: SETTINGS_ID, configured: false, credentialMasked: null, enabled: false,
      notifySuccess: true, version: 0, lastTestStatus: null, lastTestError: null,
      lastTestLatencyMs: null, lastTestAt: null, lastDeliveryStatus: null,
      lastDeliveryError: null, lastDeliveryAt: null, updatedAt: null,
    }
  }
  return {
    id: row.id,
    configured: Boolean(row.credentialCiphertext),
    credentialMasked: row.credentialHint,
    enabled: row.enabled,
    notifySuccess: row.notifySuccess,
    version: row.version,
    lastTestStatus: row.lastTestStatus,
    lastTestError: row.lastTestError,
    lastTestLatencyMs: row.lastTestLatencyMs,
    lastTestAt: row.lastTestAt,
    lastDeliveryStatus: row.lastDeliveryStatus,
    lastDeliveryError: row.lastDeliveryError,
    lastDeliveryAt: row.lastDeliveryAt,
    updatedAt: row.updatedAt,
  }
}

export async function getRadarDingTalkSettings() {
  const [row] = await db.select().from(radarDingTalkSettings)
    .where(eq(radarDingTalkSettings.id, SETTINGS_ID)).limit(1)
  return safeView(row)
}

export async function saveRadarDingTalkSettings(input: {
  expectedVersion: number
  webhookUrl?: string
  signingSecret?: string
  enabled: boolean
  notifySuccess: boolean
}, actor: Actor) {
  const hasCredentialInput = Boolean(input.webhookUrl?.trim() || input.signingSecret?.trim())
  if (hasCredentialInput && (!input.webhookUrl?.trim() || !input.signingSecret?.trim())) {
    throw serviceError('Webhook URL 和加签密钥必须同时填写', 'RADAR_DINGTALK_CREDENTIAL_INCOMPLETE', 400)
  }
  const encrypted = hasCredentialInput
    ? encryptIntegrationCredential({
        webhookUrl: validateRadarDingTalkWebhook(input.webhookUrl!),
        signingSecret: input.signingSecret!.trim(),
      }, CREDENTIAL_CONTEXT)
    : null
  const now = new Date()
  return await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(radarDingTalkSettings)
      .where(eq(radarDingTalkSettings.id, SETTINGS_ID)).limit(1).for('update')
    if (!existing) {
      if (input.expectedVersion !== 0) throw serviceError('配置已变更，请刷新后重试', 'VERSION_CONFLICT', 409)
      if (!encrypted) throw serviceError('首次保存必须填写 Webhook URL 和加签密钥', 'RADAR_DINGTALK_CREDENTIAL_REQUIRED', 400)
      await tx.insert(radarDingTalkSettings).values({
        id: SETTINGS_ID,
        credentialCiphertext: encrypted.ciphertext,
        credentialHint: encrypted.hint,
        credentialFingerprint: encrypted.fingerprint,
        enabled: input.enabled,
        notifySuccess: input.notifySuccess,
        createdBy: actor.userId,
        updatedBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
    } else {
      if (existing.version !== input.expectedVersion) {
        throw serviceError('配置已被其他管理员修改，请刷新后重试', 'VERSION_CONFLICT', 409)
      }
      if (input.enabled && !existing.credentialCiphertext && !encrypted) {
        throw serviceError('启用前必须配置 Webhook 与加签密钥', 'RADAR_DINGTALK_CREDENTIAL_REQUIRED', 400)
      }
      const [result] = await tx.update(radarDingTalkSettings).set({
        ...(encrypted ? {
          credentialCiphertext: encrypted.ciphertext,
          credentialHint: encrypted.hint,
          credentialFingerprint: encrypted.fingerprint,
          lastTestStatus: null,
          lastTestError: null,
          lastTestLatencyMs: null,
          lastTestAt: null,
        } : {}),
        enabled: input.enabled,
        notifySuccess: input.notifySuccess,
        updatedBy: actor.userId,
        updatedAt: now,
        version: sql`${radarDingTalkSettings.version} + 1`,
      }).where(and(
        eq(radarDingTalkSettings.id, SETTINGS_ID),
        eq(radarDingTalkSettings.version, input.expectedVersion),
      ))
      if (result.affectedRows !== 1) throw serviceError('配置已变更，请刷新后重试', 'VERSION_CONFLICT', 409)
    }
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      userName: actor.userName.slice(0, 64),
      module: 'Radar钉钉告警',
      action: existing ? '更新告警配置' : '创建告警配置',
      target: `radar-dingtalk:${SETTINGS_ID};credentials=${encrypted ? 'replaced' : 'unchanged'};enabled=${input.enabled}`,
      ip: actor.ip?.slice(0, 45),
      result: 'success',
    })
    const [saved] = await tx.select().from(radarDingTalkSettings)
      .where(eq(radarDingTalkSettings.id, SETTINGS_ID)).limit(1)
    return safeView(saved)
  })
}

function credentialsFromRow(row: typeof radarDingTalkSettings.$inferSelect): Credentials {
  if (!row.credentialCiphertext) {
    throw serviceError('尚未配置钉钉 Webhook', 'RADAR_DINGTALK_NOT_CONFIGURED', 409)
  }
  const value = decryptIntegrationCredential(row.credentialCiphertext, CREDENTIAL_CONTEXT)
  if (!value.signingSecret?.trim()) {
    throw serviceError('钉钉加签密钥缺失，请由管理员重新写入', 'RADAR_DINGTALK_SECRET_MISSING', 409)
  }
  return {
    webhookUrl: validateRadarDingTalkWebhook(value.webhookUrl || ''),
    signingSecret: value.signingSecret.trim(),
  }
}

async function updateDeliveryState(status: 'succeeded' | 'failed', error: string | null, at: Date) {
  await db.update(radarDingTalkSettings).set({
    lastDeliveryStatus: status,
    lastDeliveryError: error,
    lastDeliveryAt: at,
  }).where(eq(radarDingTalkSettings.id, SETTINGS_ID))
}

export async function sendRadarDingTalkAlert(input: { message: string; status: 'succeeded' | 'partial' | 'failed' }) {
  const [row] = await db.select().from(radarDingTalkSettings)
    .where(eq(radarDingTalkSettings.id, SETTINGS_ID)).limit(1)
  if (!row?.credentialCiphertext || !row.enabled) return { configured: Boolean(row?.credentialCiphertext), enabled: Boolean(row?.enabled), sent: false }
  if (input.status === 'succeeded' && !row.notifySuccess) return { configured: true, enabled: true, sent: false }
  const at = new Date()
  try {
    const result = await sendDingTalkWebhook(credentialsFromRow(row), input.message)
    await updateDeliveryState('succeeded', null, at)
    return { configured: true, enabled: true, sent: true, durationMs: result.durationMs }
  } catch (error) {
    const safeError = safeDingTalkError(error instanceof Error ? error.message : error)
    await updateDeliveryState('failed', safeError, at).catch(() => undefined)
    throw error
  }
}

export async function testRadarDingTalkSettings(actor: Actor) {
  const [row] = await db.select().from(radarDingTalkSettings)
    .where(eq(radarDingTalkSettings.id, SETTINGS_ID)).limit(1)
  if (!row) throw serviceError('尚未保存钉钉 Webhook 配置', 'RADAR_DINGTALK_NOT_CONFIGURED', 409)
  const at = new Date()
  try {
    const result = await sendDingTalkWebhook(
      credentialsFromRow(row),
      '[数据源监控] Radar 钉钉告警连接测试成功',
    )
    await db.transaction(async (tx) => {
      await tx.update(radarDingTalkSettings).set({
        lastTestStatus: 'succeeded', lastTestError: null, lastTestLatencyMs: result.durationMs, lastTestAt: at,
      }).where(eq(radarDingTalkSettings.id, SETTINGS_ID))
      await tx.insert(auditLogs).values({
        userId: actor.userId, userName: actor.userName.slice(0, 64), module: 'Radar钉钉告警',
        action: '测试告警连接', target: `radar-dingtalk:${SETTINGS_ID};status=succeeded`,
        ip: actor.ip?.slice(0, 45), result: 'success',
      })
    })
    return { ok: true, latencyMs: result.durationMs, testedAt: at }
  } catch (error) {
    const safeError = safeDingTalkError(error instanceof Error ? error.message : error)
    await db.transaction(async (tx) => {
      await tx.update(radarDingTalkSettings).set({
        lastTestStatus: 'failed', lastTestError: safeError, lastTestLatencyMs: null, lastTestAt: at,
      }).where(eq(radarDingTalkSettings.id, SETTINGS_ID))
      await tx.insert(auditLogs).values({
        userId: actor.userId, userName: actor.userName.slice(0, 64), module: 'Radar钉钉告警',
        action: '测试告警连接', target: `radar-dingtalk:${SETTINGS_ID};status=failed`,
        ip: actor.ip?.slice(0, 45), result: 'failed',
      })
    }).catch(() => undefined)
    throw error
  }
}
