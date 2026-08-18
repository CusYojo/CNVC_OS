import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { ResultSetHeader } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

const receiptsTable = quoteMysqlIdentifier(mysqlTableName('radar_webhook_receipts'))

type WebhookSecurityError = Error & { status?: number; code?: string }

function securityError(status: number, code: string, message: string): WebhookSecurityError {
  return Object.assign(new Error(message), { status, code })
}

function boundedIntegerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name] || fallback)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

function normalizedSignature(value: string): string {
  const normalized = value.trim().replace(/^sha256=/i, '').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw securityError(401, 'RADAR_WEBHOOK_SIGNATURE_INVALID', '雷达推送签名格式无效')
  }
  return normalized
}

function signedInstant(value: string): Date {
  const trimmed = value.trim()
  const numeric = Number(trimmed)
  const parsed = /^\d{10,13}$/.test(trimmed)
    ? new Date(trimmed.length === 10 ? numeric * 1_000 : numeric)
    : new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    throw securityError(401, 'RADAR_WEBHOOK_TIMESTAMP_INVALID', '雷达推送时间戳无效')
  }
  return parsed
}

export function computeRadarWebhookSignature(secret: string, timestamp: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest('hex')
}

export function verifyRadarWebhookSignature(input: {
  secret: string
  timestamp: string
  signature: string
  rawBody: Buffer
  now?: Date
}) {
  if (!input.secret.trim()) {
    throw securityError(503, 'RADAR_WEBHOOK_SECRET_MISSING', '雷达推送凭据未配置')
  }
  if (!input.timestamp.trim() || !input.signature.trim()) {
    throw securityError(401, 'RADAR_WEBHOOK_SIGNATURE_REQUIRED', '雷达推送必须提供时间戳和 HMAC 签名')
  }
  const signedAt = signedInstant(input.timestamp)
  const now = input.now ?? new Date()
  const maxSkewSeconds = boundedIntegerEnv('RADAR_WECHAT_PUSH_MAX_SKEW_SECONDS', 300, 60, 3_600)
  if (Math.abs(now.getTime() - signedAt.getTime()) > maxSkewSeconds * 1_000) {
    throw securityError(401, 'RADAR_WEBHOOK_TIMESTAMP_EXPIRED', '雷达推送时间戳已过期')
  }
  const actual = Buffer.from(normalizedSignature(input.signature), 'hex')
  const expected = Buffer.from(computeRadarWebhookSignature(input.secret, input.timestamp, input.rawBody), 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw securityError(401, 'RADAR_WEBHOOK_SIGNATURE_INVALID', '雷达推送签名无效')
  }
  const receiptHash = createHash('sha256')
    .update(input.timestamp).update(':').update(actual).digest('hex')
  return {
    signedAt,
    receiptHash,
    expiresAt: new Date(now.getTime() + maxSkewSeconds * 1_000),
  }
}

export async function claimRadarWebhookReceipt(input: {
  receiptHash: string
  signedAt: Date
  expiresAt: Date
}): Promise<void> {
  await pool.query(`DELETE FROM ${receiptsTable} WHERE expires_at < NOW(3) LIMIT 1000`)
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT IGNORE INTO ${receiptsTable} (receipt_hash,signed_at,expires_at,received_at)
     VALUES (?,?,?,NOW(3))`,
    [input.receiptHash, input.signedAt, input.expiresAt],
  )
  if (result.affectedRows !== 1) {
    throw securityError(409, 'RADAR_WEBHOOK_REPLAY', '雷达推送请求已处理，拒绝重复播放')
  }
}

export async function releaseRadarWebhookReceipt(receiptHash: string): Promise<void> {
  await pool.query(`DELETE FROM ${receiptsTable} WHERE receipt_hash=?`, [receiptHash])
}
