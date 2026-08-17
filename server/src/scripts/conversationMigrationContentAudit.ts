import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

const outputDirectory = path.resolve('.runtime/migration-evidence/conversation-content-reconciliation')
const strictProduction = process.argv.includes('--strict-production')

function table(base: string) {
  return quoteMysqlIdentifier(mysqlTableName(base))
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]))
  return value
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path.resolve(file), 'utf8')) as Record<string, unknown> }
  catch { return null }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function number(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function main() {
  const [integrityRows] = await pool.query<RowDataPacket[]>(`
    SELECT
      (SELECT COUNT(*) FROM ${table('chat_conversations')} c LEFT JOIN ${table('agent_conversations')} a ON a.id=c.id WHERE a.id IS NULL) chatWithoutAgent,
      (SELECT COUNT(*) FROM ${table('agent_conversations')} a LEFT JOIN ${table('chat_conversations')} c ON c.id=a.id WHERE c.id IS NULL) agentWithoutChat,
      (SELECT COUNT(*) FROM ${table('chat_conversations')} c JOIN ${table('agent_conversations')} a ON a.id=c.id
        WHERE NOT (c.user_id <=> a.user_id) OR NOT (c.project_id <=> a.project_id)
          OR BINARY c.title<>BINARY a.title OR BINARY c.scope<>BINARY a.scope
          OR NOT (c.agent_id <=> a.external_session_id OR (c.agent_id IS NULL AND CHAR_LENGTH(a.external_session_id)>64))) incoherentConversationPairs,
      (SELECT COUNT(*) FROM (
        SELECT conversation_id FROM ${table('agent_messages')}
        GROUP BY conversation_id HAVING MIN(sequence)<>0 OR MAX(sequence)<>COUNT(*)-1 OR COUNT(DISTINCT sequence)<>COUNT(*)
      ) sequence_gaps) messageSequenceViolations,
      (SELECT COUNT(*) FROM (
        SELECT message_id FROM ${table('agent_message_parts')}
        GROUP BY message_id HAVING MIN(part_index)<>0 OR MAX(part_index)<>COUNT(*)-1 OR COUNT(DISTINCT part_index)<>COUNT(*)
      ) part_gaps) partSequenceViolations,
      (SELECT COUNT(*) FROM ${table('agent_messages')} WHERE role NOT IN ('user','assistant','system','tool')) invalidMessageRoles,
      (SELECT COUNT(*) FROM ${table('agent_messages')} WHERE status NOT IN ('complete','running','interrupted','error')) invalidMessageStatuses,
      (SELECT COUNT(*) FROM ${table('agent_message_parts')} WHERE type NOT IN ('text','reasoning','dynamic-tool','attachment','tool_call','tool_result')) invalidPartTypes,
      (SELECT COUNT(*) FROM ${table('agent_conversations')} WHERE legacy_source IS NOT NULL AND legacy_source<>'chat_index' AND status='streaming') activeMigratedConversations,
      (SELECT COUNT(*) FROM ${table('agent_messages')} m JOIN ${table('agent_conversations')} a ON a.id=m.conversation_id
        WHERE a.legacy_source IS NOT NULL AND a.legacy_source<>'chat_index' AND m.status='running') activeMigratedMessages,
      (SELECT COUNT(*) FROM (
        SELECT conversation_id,external_message_id FROM ${table('agent_messages')}
        WHERE external_message_id IS NOT NULL GROUP BY conversation_id,external_message_id HAVING COUNT(*)>1
      ) duplicate_external) duplicateExternalMessageKeys,
      (SELECT COUNT(*) FROM ${table('ai_tasks')} t LEFT JOIN ${table('agent_conversations')} a ON a.id=t.conversation_id
        WHERE t.conversation_id IS NOT NULL AND a.id IS NULL) taskConversationBindingViolations,
      (SELECT COALESCE(SUM(JSON_LENGTH(messages)),0) FROM ${table('chat_conversations')}) legacyJsonMessages
  `)
  const integrity = Object.fromEntries(Object.entries(integrityRows[0] || {}).map(([key, value]) => [key, number(value)]))

  const [countRows] = await pool.query<RowDataPacket[]>(`
    SELECT
      (SELECT COUNT(*) FROM ${table('chat_conversations')}) chatConversations,
      (SELECT COUNT(*) FROM ${table('agent_conversations')}) agentConversations,
      (SELECT COUNT(*) FROM ${table('agent_messages')}) messages,
      (SELECT COUNT(*) FROM ${table('agent_message_parts')}) parts,
      (SELECT COUNT(*) FROM ${table('agent_conversation_source_mappings')}) conversationSourceMappings,
      (SELECT COUNT(*) FROM ${table('agent_message_source_mappings')}) messageSourceMappings,
      (SELECT COUNT(*) FROM (SELECT conversation_id FROM ${table('agent_conversation_source_mappings')}
        GROUP BY conversation_id HAVING COUNT(DISTINCT source_system)>1) cross_source_conversations) crossSourceMergedConversations,
      (SELECT COUNT(*) FROM (SELECT message_id FROM ${table('agent_message_source_mappings')}
        GROUP BY message_id HAVING COUNT(DISTINCT source_system)>1) cross_source_messages) crossSourceMergedMessages
  `)
  const counts = Object.fromEntries(Object.entries(countRows[0] || {}).map(([key, value]) => [key, number(value)]))

  const [messages, parts] = await Promise.all([
    pool.query<RowDataPacket[]>(`SELECT conversation_id,external_message_id,role,sequence,content,tool_name,tool_input,tool_output,thinking,status,
      UNIX_TIMESTAMP(created_at)*1000 created_at_ms FROM ${table('agent_messages')} ORDER BY conversation_id,sequence,id`).then(([rows]) => rows),
    pool.query<RowDataPacket[]>(`SELECT message_id,part_index,type,content,payload
      FROM ${table('agent_message_parts')} ORDER BY message_id,part_index,id`).then(([rows]) => rows),
  ])
  const targetContentSha256 = sha256(JSON.stringify(canonical({ messages, parts })))

  const [productionInventory, jwReport, flueHarness, dumpReconciliation] = await Promise.all([
    readJson('.runtime/migration-evidence/production-source-inventory/candidate.json'),
    readJson('.runtime/migration-evidence/jw-sqlite-migration/report.json'),
    readJson('.runtime/migration-evidence/flue-content-verification/report.json'),
    readJson('.runtime/migration-evidence/mysql-reconciliation/report.json'),
  ])
  const flueDirectory = path.resolve('.runtime/migration-evidence/flue-sources')
  const flueReports = await Promise.all((await readdir(flueDirectory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
    .map((entry) => readJson(path.join(flueDirectory, entry.name))))
  const validFlueReports = flueReports.filter((report): report is Record<string, unknown> => Boolean(report))

  const jwCounts = object(jwReport?.sourceCounts)
  const flueSelectedMessages = validFlueReports.reduce((total, report) =>
    total + number(object(report.selectedCounts).messages), 0)
  const authorizedSourceMessages = number(integrity.legacyJsonMessages)
    + number(jwCounts.approvedMessages) + flueSelectedMessages
  const targetViolations = Object.entries(integrity)
    .filter(([key, value]) => key !== 'legacyJsonMessages' && number(value) > 0)
    .map(([key]) => key)
  const harnessRequired = [
    'sourceTargetContentChecksumsEqual', 'contentChecksumStableAcrossRepeatedApply',
    'messageSequenceVerified', 'visibleTextVerified', 'messagePartOrderAndTypesVerified',
    'chatIndexVisibleVerified', 'chatAgentPairCoherent', 'generatedChildChatIndexVerified',
    'attachmentReferenceAndDigestVerified', 'toolInputOutputVerified', 'interruptedStateVerified',
  ]
  const flueHarnessReady = Boolean(flueHarness?.ok)
    && harnessRequired.every((key) => flueHarness?.[key] === true)
    && flueHarness?.evidenceContainsBusinessContent === false
  const jwDispositionReady = jwReport?.ok === true && jwReport?.applied === true
    && number(jwCounts.unreviewedConversations) === 0 && number(jwCounts.orphanMessages) === 0
  const flueDispositionReady = validFlueReports.length > 0 && validFlueReports.every((report) =>
    report.ok === true && report.applied === true && number(object(report.issueCounts).errors) === 0)
  const dumpReadiness = object(dumpReconciliation?.readiness)
  const dumpConversationReady = dumpReadiness.dumpPostgresReconciliationReady === true
    && dumpReadiness.legacyConversationScopeNormalizationReady === true
  const productionInventoryReady = productionInventory?.environment === 'production'
    && productionInventory?.approved === true
    && typeof productionInventory?.approvedBy === 'string'
    && productionInventory.approvedBy.trim().length > 0
  const targetIntegrityReady = targetViolations.length === 0
  const currentAuthorizedEvidenceReady = targetIntegrityReady && flueHarnessReady
    && jwDispositionReady && flueDispositionReady && dumpConversationReady
  const productionContentReconciliationReady = currentAuthorizedEvidenceReady && productionInventoryReady

  const report = {
    schemaVersion: '1.0', generatedAt: new Date().toISOString(), mode: strictProduction ? 'strict-production' : 'audit',
    ok: targetIntegrityReady,
    readiness: {
      targetIntegrityReady, flueHarnessReady, jwDispositionReady, flueDispositionReady,
      dumpConversationReady, currentAuthorizedEvidenceReady, productionInventoryReady,
      productionContentReconciliationReady,
    },
    counts,
    sourceCoverage: {
      authorizedSourceMessages,
      postgresDumpLegacyJsonMessages: number(integrity.legacyJsonMessages),
      jwApprovedMessages: number(jwCounts.approvedMessages),
      jwRejectedMessages: number(jwCounts.rejectedMessages),
      flueSelectedMessages,
      flueCandidateReports: validFlueReports.length,
    },
    integrity,
    targetViolations,
    targetContentSha256,
    safeguards: {
      reportContainsMessageBody: false,
      reportContainsConversationOrMessageId: false,
      reportContainsSourcePath: false,
      databaseWrites: 0,
    },
  }
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  const target = path.join(outputDirectory, 'report.json')
  const temporary = `${target}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  const summary = [
    '# 会话迁移内容级对账', '',
    `- 目标会话索引/正文：${counts.chatConversations}/${counts.agentConversations}`,
    `- 消息/Part：${counts.messages}/${counts.parts}`,
    `- 当前授权源业务消息：${authorizedSourceMessages}`,
    `- 目标内部完整性：${targetIntegrityReady ? '通过' : '失败'}`,
    `- 当前本地证据：${currentAuthorizedEvidenceReady ? '通过' : '失败'}`,
    `- 生产内容级对账：${productionContentReconciliationReady ? '通过' : '未通过'}`,
    '',
    '报告仅保存计数、布尔结论和聚合 SHA-256，不保存消息正文、会话/消息 ID、用户或源路径。', '',
  ].join('\n')
  await writeFile(path.join(outputDirectory, 'summary.md'), summary, { mode: 0o600 })
  console.log(JSON.stringify({
    ok: targetIntegrityReady && (!strictProduction || productionContentReconciliationReady),
    targetIntegrityReady, currentAuthorizedEvidenceReady, productionContentReconciliationReady,
    counts, authorizedSourceMessages, targetViolations, databaseWrites: 0,
  }))
  if (!targetIntegrityReady) process.exitCode = 3
  else if (strictProduction && !productionContentReconciliationReady) process.exitCode = 2
}

await main().finally(async () => pool.end())
