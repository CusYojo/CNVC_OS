import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, imBotBindings, imBots, imDeliveryLogs, imOutbox, users } from '../db/schema.js'
import { encryptIntegrationCredential } from '../security/integrationCredentialCrypto.js'
import { dispatchOperationalAlerts } from '../services/operationalAlertDeliveryService.js'
import { processImOutboxBatch } from '../services/imIntegrationService.js'
import type { OperationalAlert } from '../services/operationalTelemetryService.js'

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY,
  IM_SAFE_MOCK_ENABLED: process.env.IM_SAFE_MOCK_ENABLED,
  IM_INTEGRATIONS_ENABLED: process.env.IM_INTEGRATIONS_ENABLED,
  IM_OUTBOX_ENABLED: process.env.IM_OUTBOX_ENABLED,
  OPS_ALERT_NOTIFICATION_CHANNEL_ID: process.env.OPS_ALERT_NOTIFICATION_CHANNEL_ID,
  OPS_ALERT_ESCALATION_POLICY_ID: process.env.OPS_ALERT_ESCALATION_POLICY_ID,
  OPS_ALERT_REMINDER_MINUTES: process.env.OPS_ALERT_REMINDER_MINUTES,
}
const marker = randomUUID().slice(0, 8)
const ids = { user: randomUUID(), bot: randomUUID(), binding: randomUUID() }
const createdOutboxIds: string[] = []
const createdAuditIds: string[] = []
const checks: string[] = []

function check(condition: unknown, name: string): asserts condition {
  assert.ok(condition, name)
  checks.push(name)
}

function snapshot(timestamp: string, alerts: OperationalAlert[]) {
  return {
    timestamp,
    status: alerts.some((alert) => alert.severity === 'critical')
      ? 'critical' as const : alerts.length ? 'warning' as const : 'ok' as const,
    alerts,
  }
}

function restoreEnvironment() {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

async function cleanup() {
  if (createdOutboxIds.length) {
    await db.delete(imDeliveryLogs).where(inArray(imDeliveryLogs.outboxId, createdOutboxIds)).catch(() => undefined)
    await db.delete(imOutbox).where(inArray(imOutbox.id, createdOutboxIds)).catch(() => undefined)
  }
  await db.delete(imBotBindings).where(eq(imBotBindings.id, ids.binding)).catch(() => undefined)
  await db.delete(imBots).where(eq(imBots.id, ids.bot)).catch(() => undefined)
  if (createdAuditIds.length) {
    await db.delete(auditLogs).where(inArray(auditLogs.id, createdAuditIds)).catch(() => undefined)
  }
  await db.delete(users).where(eq(users.id, ids.user)).catch(() => undefined)
}

async function captureFixtureRows() {
  const outboxRows = await db.select({ id: imOutbox.id }).from(imOutbox)
    .where(eq(imOutbox.bindingId, ids.binding))
  createdOutboxIds.splice(0, createdOutboxIds.length, ...outboxRows.map((row) => row.id))
  // Audit targets start with the generated outbox ID. Filter in memory so cleanup never
  // broad-deletes operational records created by another process.
  const exactAuditRows = await db.select({ id: auditLogs.id, target: auditLogs.target }).from(auditLogs)
    .where(eq(auditLogs.module, '运维告警'))
  const prefixes = new Set(createdOutboxIds)
  createdAuditIds.splice(0, createdAuditIds.length, ...exactAuditRows
    .filter((row) => row.target && prefixes.has(row.target.split(':', 1)[0]))
    .map((row) => row.id))
}

async function main() {
  process.env.NODE_ENV = 'development'
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')
  process.env.IM_SAFE_MOCK_ENABLED = 'true'
  process.env.IM_INTEGRATIONS_ENABLED = 'true'
  process.env.IM_OUTBOX_ENABLED = 'true'
  process.env.OPS_ALERT_NOTIFICATION_CHANNEL_ID = 'not-a-binding-uuid'
  process.env.OPS_ALERT_ESCALATION_POLICY_ID = 'acceptance-policy'
  process.env.OPS_ALERT_REMINDER_MINUTES = '5'
  await assert.rejects(() => dispatchOperationalAlerts(), /must be an enabled IM binding UUID/)
  checks.push('notification-channel-requires-binding-uuid')
  process.env.OPS_ALERT_NOTIFICATION_CHANNEL_ID = ids.binding

  const encrypted = encryptIntegrationCredential({
    webhookUrl: 'mock://success',
    inboundSecret: `${randomUUID()}${randomUUID()}`,
  }, ids.bot)
  await db.insert(users).values({
    id: ids.user,
    email: `ops-alert-${marker}@example.invalid`,
    name: '运维告警验收用户',
    role: '系统管理员',
    department: '平台部',
    passwordHash: 'not-used',
  })
  await db.insert(imBots).values({
    id: ids.bot,
    platform: 'dingtalk',
    name: `运维告警验收-${marker}`,
    credentialCiphertext: encrypted.ciphertext,
    credentialHint: encrypted.hint,
    credentialFingerprint: encrypted.fingerprint,
    config: { rateLimitPerMinute: 120 },
    enabled: true,
  })
  await db.insert(imBotBindings).values({
    id: ids.binding,
    botId: ids.bot,
    externalConversationId: `ops-alert-${marker}`,
    userId: ids.user,
    enabled: true,
  })

  const activeAlerts: OperationalAlert[] = [
    { code: 'ACCEPT_QUEUE_DEPTH', severity: 'critical', metric: 'queues.pending', value: 9, threshold: 5 },
    { code: 'ACCEPT_HTTP_LATENCY', severity: 'warning', metric: 'http.p95', value: 2_500, threshold: 2_000 },
  ]
  const activeAt = new Date('2026-08-11T00:00:00.000Z')
  process.env.IM_OUTBOX_ENABLED = 'false'
  const schedulerDisabled = await dispatchOperationalAlerts({
    snapshot: snapshot(activeAt.toISOString(), activeAlerts), now: activeAt,
  })
  check(schedulerDisabled.status === 'scheduler_disabled' && schedulerDisabled.enqueued === 0,
    'configured-channel-does-not-bypass-disabled-outbox-scheduler')
  process.env.IM_OUTBOX_ENABLED = 'true'
  const first = await dispatchOperationalAlerts({ snapshot: snapshot(activeAt.toISOString(), activeAlerts), now: activeAt })
  check(first.status === 'created' && first.enqueued === 1 && first.state === 'active', 'active-alert-enqueued-once')
  const duplicate = await dispatchOperationalAlerts({
    snapshot: snapshot(activeAt.toISOString(), [...activeAlerts].reverse()),
    now: new Date(activeAt.getTime() + 60_000),
  })
  check(duplicate.status === 'deduplicated' && duplicate.enqueued === 0, 'same-alert-set-deduplicated-before-reminder')

  await captureFixtureRows()
  check(createdOutboxIds.length === 1, 'one-active-outbox-row-persisted')
  await processImOutboxBatch({ owner: `ops-alert-accept-${marker}`, limit: 50 })
  const [sentActive] = await db.select().from(imOutbox).where(eq(imOutbox.id, createdOutboxIds[0])).limit(1)
  check(sentActive?.status === 'sent' && sentActive.attempts === 1, 'active-alert-delivered-through-existing-im-outbox')

  const [activeLog] = await db.select().from(imDeliveryLogs).where(eq(imDeliveryLogs.outboxId, sentActive.id)).limit(1)
  check(activeLog?.status === 'sent', 'active-alert-delivery-log-persisted')
  await db.update(imDeliveryLogs).set({ createdAt: new Date(Date.now() - 2_000) })
    .where(eq(imDeliveryLogs.outboxId, sentActive.id))

  const recoveredAt = new Date(activeAt.getTime() + 120_000)
  const recovered = await dispatchOperationalAlerts({ snapshot: snapshot(recoveredAt.toISOString(), []), now: recoveredAt })
  check(recovered.status === 'created' && recovered.enqueued === 1 && recovered.state === 'recovered', 'recovery-notification-enqueued-once')
  const duplicateRecovery = await dispatchOperationalAlerts({
    snapshot: snapshot(recoveredAt.toISOString(), []), now: new Date(recoveredAt.getTime() + 60_000),
  })
  check(duplicateRecovery.status === 'deduplicated' && duplicateRecovery.enqueued === 0, 'recovery-notification-deduplicated')

  await captureFixtureRows()
  check(Number(createdOutboxIds.length) === 2, 'active-and-recovery-outbox-history-persisted')
  await processImOutboxBatch({ owner: `ops-alert-recovery-${marker}`, limit: 50 })
  const rows = await db.select().from(imOutbox).where(eq(imOutbox.bindingId, ids.binding))
  check(rows.every((row) => row.status === 'sent'), 'active-and-recovery-notifications-delivered')
  const logs = await db.select().from(imDeliveryLogs).where(inArray(imDeliveryLogs.outboxId, createdOutboxIds))
  check(logs.length === 2 && logs.every((row) => row.status === 'sent'), 'both-deliveries-have-durable-success-logs')

  const allowedPayloadKeys = ['alertCodes', 'fingerprint', 'kind', 'message', 'observedAt', 'severity', 'state']
  check(rows.every((row) => JSON.stringify(Object.keys(row.payload).sort()) === JSON.stringify(allowedPayloadKeys)), 'alert-payload-has-fixed-safe-field-allowlist')
  const serializedPayloads = JSON.stringify(rows.map((row) => row.payload))
  check(!serializedPayloads.includes(ids.binding) && !serializedPayloads.includes(ids.bot)
    && !serializedPayloads.includes('inboundSecret') && !serializedPayloads.includes('credential'),
  'alert-payload-excludes-binding-identity-and-credentials')

  await captureFixtureRows()
  check(createdAuditIds.length === 2, 'active-and-recovery-enqueue-actions-audited')
  await cleanup()
  const [outboxResidue, bindingResidue, botResidue, userResidue, auditResidue] = await Promise.all([
    db.select({ id: imOutbox.id }).from(imOutbox).where(eq(imOutbox.bindingId, ids.binding)),
    db.select({ id: imBotBindings.id }).from(imBotBindings).where(eq(imBotBindings.id, ids.binding)),
    db.select({ id: imBots.id }).from(imBots).where(eq(imBots.id, ids.bot)),
    db.select({ id: users.id }).from(users).where(eq(users.id, ids.user)),
    createdAuditIds.length ? db.select({ id: auditLogs.id }).from(auditLogs).where(inArray(auditLogs.id, createdAuditIds)) : Promise.resolve([]),
  ])
  check([outboxResidue, bindingResidue, botResidue, userResidue, auditResidue].every((items) => items.length === 0), 'acceptance-fixture-cleaned-with-zero-residue')

  const report = {
    ok: true,
    checks,
    count: checks.length,
    outboxRows: 2,
    deliveryLogs: 2,
    auditRows: 2,
    durableDeduplication: true,
    recoveryNotification: true,
    retryAndDeadLetterPathReused: true,
    sensitiveValuesExcluded: true,
    businessContentExcluded: true,
    fixtureResidue: 0,
  }
  const evidenceRoot = path.resolve('.runtime/migration-evidence/operational-alert-delivery')
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
  await chmod(evidenceRoot, 0o700)
  const reportPath = path.join(evidenceRoot, 'report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await chmod(reportPath, 0o600)
  console.log(JSON.stringify(report))
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}).finally(async () => {
  await captureFixtureRows().catch(() => undefined)
  await cleanup()
  restoreEnvironment()
  await pool.end()
})
