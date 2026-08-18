import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  ingestRadarWechatChatPush,
  listRadarWechatChatGroups,
  listRadarWechatChatMessages,
} from '../services/radarWechatChatService.js'
import {
  claimRadarWebhookReceipt,
  computeRadarWebhookSignature,
  verifyRadarWebhookSignature,
} from '../services/radarWebhookSecurityService.js'
import { ensureSchema } from '../db/migrate.js'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

assertIsolatedMysqlAcceptanceDatabase('radarWechatChatAcceptance')

const marker = `accept-${randomUUID()}`
const date = '2099-12-31'
const messagesTable = quoteMysqlIdentifier(mysqlTableName('radar_wechat_chat_messages'))
const candidatesTable = quoteMysqlIdentifier(mysqlTableName('radar_candidates'))
const rawTable = quoteMysqlIdentifier(mysqlTableName('radar_raw_events'))
const receiptsTable = quoteMysqlIdentifier(mysqlTableName('radar_webhook_receipts'))
const receiptHashes = new Set<string>()

async function cleanup() {
  await pool.query(`DELETE FROM ${rawTable} WHERE source='wechat_chat' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.merchant_no'))=?`, [marker])
  await pool.query(`DELETE FROM ${candidatesTable} WHERE source='wechat_chat' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.merchant_no'))=?`, [marker])
  await pool.query(`DELETE FROM ${messagesTable} WHERE merchant_no=?`, [marker])
  if (receiptHashes.size) {
    await pool.query(`DELETE FROM ${receiptsTable} WHERE receipt_hash IN (${[...receiptHashes].map(() => '?').join(',')})`, [...receiptHashes])
  }
}

try {
  await ensureSchema()
  await cleanup()
  const payload = {
    merchant_no: marker,
    pushed_at: `${date} 10:00:00`,
    messages: [{
      msg_key: 'acceptance-message', group_name: '迁移验收群', group_serial_no: marker,
      sender_name: '验收机器人', message_time: `${date} 10:00:00`,
      msg_content_decoded: '推荐一个人工智能项目，正在进行 Pre-A 轮融资，已有客户订单。', msg_type: 1,
    }],
  }
  const first = await ingestRadarWechatChatPush(payload)
  const duplicate = await ingestRadarWechatChatPush(payload)
  assert.equal(first.received, 1)
  assert.equal(first.stored, 1)
  assert.equal(first.groups, 1)
  assert.equal(first.candidates, 1)
  assert.equal(duplicate.stored, 0)
  const messages = await listRadarWechatChatMessages({ date, groupSerialNo: marker, limit: 10 })
  assert.equal(messages.total, 1)
  const groups = await listRadarWechatChatGroups(date)
  const group = groups.groups.find((item) => item.group_serial_no === marker)
  assert.equal(group?.message_count, 1)
  assert.equal(group?.candidate_count, 1)
  const [candidateRows] = await pool.query<Array<RowDataPacket & { total: number }>>(
    `SELECT COUNT(*) AS total FROM ${candidatesTable} WHERE source='wechat_chat' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.merchant_no'))=?`, [marker],
  )
  assert.equal(Number(candidateRows[0]?.total), 1)
  const secret = randomBytes(32).toString('hex')
  const timestamp = String(Math.floor(Date.now() / 1_000))
  const rawBody = Buffer.from(JSON.stringify(payload))
  const signature = computeRadarWebhookSignature(secret, timestamp, rawBody)
  const verified = verifyRadarWebhookSignature({ secret, timestamp, signature: `sha256=${signature}`, rawBody })
  receiptHashes.add(verified.receiptHash)
  await claimRadarWebhookReceipt(verified)
  await assert.rejects(
    claimRadarWebhookReceipt(verified),
    (error: Error & { code?: string }) => error.code === 'RADAR_WEBHOOK_REPLAY',
  )
  assert.throws(
    () => verifyRadarWebhookSignature({ secret, timestamp, signature, rawBody: Buffer.from(`${rawBody.toString()} `) }),
    (error: Error & { code?: string }) => error.code === 'RADAR_WEBHOOK_SIGNATURE_INVALID',
  )
  const expiredTimestamp = String(Math.floor(Date.now() / 1_000) - 3_601)
  assert.throws(
    () => verifyRadarWebhookSignature({
      secret, timestamp: expiredTimestamp,
      signature: computeRadarWebhookSignature(secret, expiredTimestamp, rawBody), rawBody,
    }),
    (error: Error & { code?: string }) => error.code === 'RADAR_WEBHOOK_TIMESTAMP_EXPIRED',
  )
  console.log(JSON.stringify({
    ok: true, idempotent: true, hmacVerified: true, replayRejected: true,
    expiredSignatureRejected: true, messages: messages.total, candidates: 1,
  }))
} finally {
  await cleanup()
  await pool.end()
}
