import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'
import { hashPassword } from '../services/authService.js'

const execFileAsync = promisify(execFile)
const tempDir = await mkdtemp(path.join(tmpdir(), 'sbl-flue-migration-'))
const sourcePath = path.join(tempDir, 'flue-smoke.db')
const userId = randomUUID()
const conversationId = randomUUID()
const suffix = randomUUID()
const instanceId = `flue-smoke-${suffix}`
const canonicalConversationId = `conv_${suffix}`
const generatedCanonicalConversationId = `child_${suffix}`
const now = new Date().toISOString()
const attachmentBytes = Buffer.from('flue-migration-smoke-attachment')
const attachmentId = `attachment-${suffix}`
const attachmentDigest = createHash('sha256').update(attachmentBytes).digest('hex')
const evidenceDir = path.resolve('.runtime/migration-evidence/flue-content-verification')

function table(base: string): string {
  return quoteMysqlIdentifier(mysqlTableName(base))
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  const parsed = JSON.parse(value) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

async function writeEvidence(report: Record<string, unknown>): Promise<void> {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const target = path.resolve(evidenceDir, 'report.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  await chmod(target, 0o600)
}

async function cleanupTransientSourceEvidence(): Promise<void> {
  const directory = path.resolve('.runtime/migration-evidence/flue-sources')
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
    const file = path.resolve(directory, entry.name)
    const report = JSON.parse(await readFile(file, 'utf8')) as { source?: unknown; sourceSha256?: unknown }
    if (typeof report.source !== 'string' || report.sourceSha256 !== entry.name.slice(0, -5)) continue
    if (!/^sbl-flue-migration-[A-Za-z0-9_-]+$/.test(path.basename(path.dirname(report.source)))) continue
    await unlink(file)
  }
}

function record(id: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id,
    type,
    conversationId: canonicalConversationId,
    harness: 'default',
    session: 'default',
    timestamp: now,
    ...extra,
  }
}

const records = [
  record(`record-create-${suffix}`, 'conversation_created', { kind: 'root', affinityKey: `aff-${suffix}`, createdAt: now }),
  record(`record-user-${suffix}`, 'user_message', { messageId: `user-${suffix}`, parentId: null, content: [
    { type: 'text', text: '迁移冒烟问题' },
    { type: 'attachment', attachment: { id: attachmentId, mimeType: 'text/plain', size: attachmentBytes.length, digest: attachmentDigest, filename: 'smoke.txt' } },
  ] }),
  record(`record-assistant-start-${suffix}`, 'assistant_message_started', { messageId: `assistant-${suffix}`, parentId: `user-${suffix}`, modelInfo: { provider: 'smoke', model: 'smoke-model' } }),
  record(`record-reasoning-start-${suffix}`, 'assistant_reasoning_started', { messageId: `assistant-${suffix}`, blockId: `reasoning-${suffix}`, blockIndex: 0 }),
  record(`record-reasoning-delta-${suffix}`, 'assistant_reasoning_delta', { messageId: `assistant-${suffix}`, blockId: `reasoning-${suffix}`, sequence: 0, delta: '分析' }),
  record(`record-reasoning-complete-${suffix}`, 'assistant_reasoning_completed', { messageId: `assistant-${suffix}`, blockId: `reasoning-${suffix}`, deltaCount: 1 }),
  record(`record-text-start-${suffix}`, 'assistant_text_started', { messageId: `assistant-${suffix}`, blockId: `text-${suffix}`, blockIndex: 1 }),
  record(`record-text-delta-${suffix}`, 'assistant_text_delta', { messageId: `assistant-${suffix}`, blockId: `text-${suffix}`, sequence: 0, delta: '完成' }),
  record(`record-text-complete-${suffix}`, 'assistant_text_completed', { messageId: `assistant-${suffix}`, blockId: `text-${suffix}`, deltaCount: 1 }),
  record(`record-tool-${suffix}`, 'assistant_tool_call', { messageId: `assistant-${suffix}`, blockId: `tool-${suffix}`, blockIndex: 2, toolCallId: `call-${suffix}`, name: 'lookup', arguments: { id: 1 } }),
  record(`record-assistant-complete-${suffix}`, 'assistant_message_completed', { messageId: `assistant-${suffix}`, stopReason: 'toolUse', usage: { input: 1, output: 1, totalTokens: 2 } }),
  record(`record-outcome-${suffix}`, 'tool_outcome', { assistantMessageId: `assistant-${suffix}`, toolCallId: `call-${suffix}`, toolName: 'lookup', isError: false, content: [{ type: 'text', text: '工具结果' }], output: { ok: true } }),
  record(`record-tool-commit-${suffix}`, 'tool_results_committed', { assistantMessageId: `assistant-${suffix}`, parentId: `assistant-${suffix}`, outcomeIds: [`record-outcome-${suffix}`] }),
  record(`record-settled-${suffix}`, 'submission_settled', { submissionId: `submission-${suffix}`, outcome: 'completed', result: { ok: true } }),
  record(`record-interrupted-start-${suffix}`, 'assistant_message_started', { messageId: `interrupted-${suffix}`, parentId: `assistant-${suffix}`, modelInfo: { provider: 'smoke', model: 'smoke-model' } }),
  record(`record-interrupted-text-start-${suffix}`, 'assistant_text_started', { messageId: `interrupted-${suffix}`, blockId: `interrupted-text-${suffix}`, blockIndex: 0 }),
  record(`record-interrupted-text-delta-${suffix}`, 'assistant_text_delta', { messageId: `interrupted-${suffix}`, blockId: `interrupted-text-${suffix}`, sequence: 0, delta: '未完成' }),
  record(`record-child-create-${suffix}`, 'conversation_created', {
    conversationId: generatedCanonicalConversationId,
    kind: 'task', parentConversationId: canonicalConversationId, createdAt: now,
  }),
  record(`record-child-user-${suffix}`, 'user_message', {
    conversationId: generatedCanonicalConversationId,
    messageId: `child-user-${suffix}`, parentId: null,
    content: [{ type: 'text', text: '新生成历史子会话' }],
  }),
]

const sqlite = new DatabaseSync(sourcePath)
sqlite.exec(`
  CREATE TABLE flue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE flue_conversation_streams (
    path TEXT PRIMARY KEY, identity_json TEXT NOT NULL, next_offset INTEGER NOT NULL DEFAULT 0,
    producer_id TEXT, producer_epoch INTEGER NOT NULL DEFAULT 0,
    next_producer_sequence INTEGER NOT NULL DEFAULT 0, incarnation TEXT NOT NULL
  );
  CREATE TABLE flue_conversation_stream_batches (
    path TEXT NOT NULL, seq INTEGER NOT NULL, producer_id TEXT NOT NULL,
    producer_epoch INTEGER NOT NULL, producer_sequence INTEGER NOT NULL,
    data TEXT NOT NULL, submission_id TEXT, attempt_id TEXT,
    PRIMARY KEY (path, seq), UNIQUE (path, producer_id, producer_epoch, producer_sequence)
  );
  CREATE TABLE flue_attachments (
    stream_path TEXT NOT NULL, attachment_id TEXT NOT NULL, mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL, digest TEXT NOT NULL, conversation_id TEXT NOT NULL,
    chunk_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (stream_path, attachment_id)
  );
  CREATE TABLE flue_attachment_chunks (
    stream_path TEXT NOT NULL, attachment_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
    bytes BLOB NOT NULL, PRIMARY KEY (stream_path, attachment_id, chunk_index)
  );
`)
sqlite.prepare('INSERT INTO flue_meta (key,value) VALUES (?,?)').run('schema_version', '4')
const streamPath = `agents/assistant/${instanceId}`
sqlite.prepare(`
  INSERT INTO flue_conversation_streams
    (path,identity_json,next_offset,producer_id,producer_epoch,next_producer_sequence,incarnation)
  VALUES (?,?,?,?,?,?,?)
`).run(streamPath, JSON.stringify({ agentName: 'assistant', instanceId }), records.length, `producer-${suffix}`, 1, records.length, `incarnation-${suffix}`)
const insertBatch = sqlite.prepare(`
  INSERT INTO flue_conversation_stream_batches
    (path,seq,producer_id,producer_epoch,producer_sequence,data) VALUES (?,?,?,?,?,?)
`)
records.forEach((item, index) => insertBatch.run(streamPath, index, `producer-${suffix}`, 1, index, JSON.stringify([item])))
sqlite.prepare(`
  INSERT INTO flue_attachments
    (stream_path,attachment_id,mime_type,byte_size,digest,conversation_id,chunk_count,created_at)
  VALUES (?,?,?,?,?,?,?,?)
`).run(streamPath, attachmentId, 'text/plain', attachmentBytes.length, attachmentDigest, canonicalConversationId, 1, Date.now())
sqlite.prepare(`
  INSERT INTO flue_attachment_chunks (stream_path,attachment_id,chunk_index,bytes) VALUES (?,?,?,?)
`).run(streamPath, attachmentId, 0, attachmentBytes)
sqlite.close()
const sourceLocator = realpathSync(sourcePath)

await cleanupTransientSourceEvidence()
await ensureSchema()
const passwordHash = await hashPassword(`${randomUUID()}-Aa1!`)
const connection = await pool.getConnection()
let generatedConversationId: string | null = null
try {
  await connection.execute(`
    INSERT INTO ${table('users')} (id,email,name,role,department,password_hash,status,created_at)
    VALUES (?,?,?,?,?,?,?,NOW(3))
  `, [userId, `flue-migration-smoke-${suffix}@example.invalid`, 'Flue迁移冒烟', '系统管理员', '测试', passwordHash, '启用'])
  // Seed only the normalized agent half. This represents an orphaned legacy
  // target and proves the importer restores the user-visible chat index.
  await connection.execute(`
    INSERT INTO ${table('agent_conversations')}
      (id,user_id,project_id,title,scope,status,runtime,external_session_id,legacy_source,legacy_conversation_id,model_id,metadata,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [conversationId, userId, null, 'Flue迁移冒烟', 'global', 'closed', 'legacy-index', instanceId,
    'legacy_postgres', conversationId, null, JSON.stringify({}), new Date(now), new Date(now)])
  await connection.execute(`
    INSERT INTO ${table('agent_messages')}
      (id,conversation_id,external_message_id,role,sequence,content,tool_name,tool_input,tool_output,thinking,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `, [randomUUID(), conversationId, `legacy-user-${suffix}`, 'user', 0, '迁移冒烟问题', null, null, null, null, 'complete', new Date(now)])

  async function runImporter(): Promise<Record<string, unknown>> {
    const result = await execFileAsync(process.execPath, [
      '--env-file-if-exists=.env',
      '--import', 'tsx',
      'server/src/scripts/migrateFlueSqliteToMySql.ts',
      '--source', sourcePath,
      '--apply',
    ], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 })
    const line = result.stdout.trim().split('\n').at(-1)
    if (!line) throw new Error('Flue importer returned no report')
    return JSON.parse(line) as Record<string, unknown>
  }

  const first = await runImporter()
  const second = await runImporter()
  if (first.ok !== true || second.ok !== true) throw new Error('Flue importer did not report success')
  if (typeof first.sourceChecksum !== 'string' || first.sourceChecksum !== first.targetChecksum
    || typeof second.sourceChecksum !== 'string' || second.sourceChecksum !== second.targetChecksum
    || first.sourceChecksum !== second.sourceChecksum) {
    throw new Error('Flue source/target content checksum is missing, mismatched or unstable')
  }

  const [generatedMappings] = await connection.query<RowDataPacket[]>(`
    SELECT conversation_id AS conversationId
    FROM ${table('agent_conversation_source_mappings')}
    WHERE source_system='flue' AND source_conversation_id=?
  `, [`${instanceId}/${generatedCanonicalConversationId}`])
  if (generatedMappings.length !== 1) throw new Error('generated Flue child conversation mapping is missing or duplicated')
  generatedConversationId = String(generatedMappings[0].conversationId)

  const [counts] = await connection.query<RowDataPacket[]>(`
    SELECT
      (SELECT COUNT(*) FROM ${table('chat_conversations')} WHERE id=?) AS chatIndexes,
      (SELECT COUNT(*) FROM ${table('agent_conversations')} WHERE id=?) AS conversations,
      (SELECT COUNT(*) FROM ${table('agent_messages')} WHERE conversation_id=?) AS messages,
      (SELECT COUNT(*) FROM ${table('agent_message_parts')} p JOIN ${table('agent_messages')} m ON m.id=p.message_id WHERE m.conversation_id=?) AS parts,
      (SELECT COUNT(*) FROM ${table('agent_conversation_source_mappings')} WHERE conversation_id=?) AS conversationMappings,
      (SELECT COUNT(*) FROM ${table('agent_message_source_mappings')} sm JOIN ${table('agent_messages')} m ON m.id=sm.message_id WHERE m.conversation_id=?) AS messageMappings,
      (SELECT COUNT(*) FROM ${table('chat_conversations')} WHERE id=?) AS generatedChatIndexes,
      (SELECT COUNT(*) FROM ${table('agent_conversations')} WHERE id=?) AS generatedConversations,
      (SELECT COUNT(*) FROM ${table('agent_messages')} WHERE conversation_id=?) AS generatedMessages,
      (SELECT COUNT(*) FROM ${table('agent_message_parts')} p JOIN ${table('agent_messages')} m ON m.id=p.message_id WHERE m.conversation_id=?) AS generatedParts,
      (SELECT COUNT(*) FROM ${table('migration_runs')} WHERE source_locator=? AND status='succeeded') AS migrationRuns
  `, [conversationId, conversationId, conversationId, conversationId, conversationId, conversationId,
    generatedConversationId, generatedConversationId, generatedConversationId, generatedConversationId, sourceLocator])
  const actual = Object.fromEntries(Object.entries(counts[0]).map(([key, value]) => [key, Number(value)]))
  const expected = {
    chatIndexes: 1, conversations: 1, messages: 3, parts: 7,
    conversationMappings: 1, messageMappings: 3,
    generatedChatIndexes: 1, generatedConversations: 1, generatedMessages: 1, generatedParts: 1,
    migrationRuns: 2,
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Flue idempotency counts differ: ${JSON.stringify({ expected, actual })}`)

  const [pairRows] = await connection.query<RowDataPacket[]>(`
    SELECT c.id,JSON_LENGTH(c.messages) legacyMessages
    FROM ${table('chat_conversations')} c
    JOIN ${table('agent_conversations')} a ON a.id=c.id
    WHERE c.id=? AND c.user_id=a.user_id AND c.project_id <=> a.project_id
      AND BINARY c.title=BINARY a.title AND BINARY c.scope=BINARY a.scope
      AND (c.agent_id <=> a.external_session_id
        OR (c.agent_id IS NULL AND CHAR_LENGTH(a.external_session_id)>64))
  `, [conversationId])
  if (pairRows.length !== 1 || Number(pairRows[0].legacyMessages) !== 0) {
    throw new Error('Flue migrated conversation is not visible through a coherent chat/agent pair')
  }
  const [generatedPairRows] = await connection.query<RowDataPacket[]>(`
    SELECT c.id
    FROM ${table('chat_conversations')} c
    JOIN ${table('agent_conversations')} a ON a.id=c.id
    WHERE c.id=? AND c.user_id=a.user_id AND c.project_id <=> a.project_id
      AND BINARY c.title=BINARY a.title AND BINARY c.scope=BINARY a.scope
      AND (c.agent_id <=> a.external_session_id
        OR (c.agent_id IS NULL AND CHAR_LENGTH(a.external_session_id)>64))
  `, [generatedConversationId])
  if (generatedPairRows.length !== 1) throw new Error('newly generated Flue child is not a coherent visible chat/agent pair')

  const [messageRows] = await connection.query<RowDataPacket[]>(`
    SELECT id,role,sequence,content,thinking,tool_name AS toolName,tool_input AS toolInput,tool_output AS toolOutput,status
    FROM ${table('agent_messages')} WHERE conversation_id=? ORDER BY sequence
  `, [conversationId])
  if (messageRows.length !== 3
    || messageRows[0]?.sequence !== 0 || messageRows[0]?.role !== 'user' || messageRows[0]?.content !== '迁移冒烟问题'
    || messageRows[1]?.sequence !== 1 || messageRows[1]?.role !== 'assistant' || messageRows[1]?.status !== 'complete'
    || messageRows[1]?.content !== '完成' || messageRows[1]?.thinking !== '分析' || messageRows[1]?.toolName !== 'lookup'
    || jsonObject(messageRows[1]?.toolInput).id !== 1 || jsonObject(messageRows[1]?.toolOutput).ok !== true
    || messageRows[2]?.sequence !== 2 || messageRows[2]?.role !== 'assistant'
    || messageRows[2]?.status !== 'interrupted' || messageRows[2]?.content !== '未完成') {
    throw new Error('Flue assistant content/tool/reasoning projection differs from the canonical fixture')
  }
  const [partRows] = await connection.query<RowDataPacket[]>(`
    SELECT m.sequence,p.part_index AS partIndex,p.type,p.content,p.payload
    FROM ${table('agent_message_parts')} p
    JOIN ${table('agent_messages')} m ON m.id=p.message_id
    WHERE m.conversation_id=? ORDER BY m.sequence,p.part_index
  `, [conversationId])
  const partTypes = partRows.map((row) => `${Number(row.sequence)}:${Number(row.partIndex)}:${String(row.type)}`)
  const expectedPartTypes = [
    '0:0:text', '0:1:attachment',
    '1:0:reasoning', '1:1:text', '1:2:tool_call', '1:3:tool_result',
    '2:0:text',
  ]
  if (JSON.stringify(partTypes) !== JSON.stringify(expectedPartTypes)) {
    throw new Error(`Flue message Part order/type differs: ${JSON.stringify(partTypes)}`)
  }
  const attachmentPayload = jsonObject(partRows[1]?.payload)
  const toolCallPayload = jsonObject(partRows[4]?.payload)
  const toolResultPayload = jsonObject(partRows[5]?.payload)
  if (attachmentPayload.id !== attachmentId || attachmentPayload.digest !== attachmentDigest
    || Number(attachmentPayload.size) !== attachmentBytes.length
    || toolCallPayload.name !== 'lookup' || jsonObject(toolCallPayload.arguments).id !== 1
    || toolResultPayload.toolName !== 'lookup' || toolResultPayload.isError !== false
    || jsonObject(toolResultPayload.output).ok !== true) {
    throw new Error('Flue attachment or tool Part payload differs from the canonical fixture')
  }
  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ok: true,
    idempotentRuns: 2,
    counts: actual,
    sourceTargetContentChecksumsEqual: true,
    contentChecksumStableAcrossRepeatedApply: true,
    messageSequenceVerified: true,
    visibleTextVerified: true,
    messagePartOrderAndTypesVerified: true,
    chatIndexVisibleVerified: true,
    chatAgentPairCoherent: true,
    generatedChildChatIndexVerified: true,
    partTypeCounts: { text: 3, attachment: 1, reasoning: 1, toolCall: 1, toolResult: 1 },
    exactDuplicateMerged: true,
    attachmentReferenceAndDigestVerified: true,
    toolInputOutputVerified: true,
    interruptedStateVerified: true,
    evidenceContainsBusinessContent: false,
  }
  await writeEvidence(report)
  console.log(JSON.stringify(report))
} finally {
  await connection.execute(`DELETE FROM ${table('migration_runs')} WHERE source_locator=?`, [sourceLocator]).catch(() => undefined)
  // Generic mappings intentionally have no FK because they span heterogeneous source tables.
  // Remove them before the specialized conversation/message rows cascade so repeated smoke
  // runs cannot leave target-less migration mappings behind.
  const cleanupConversationIds = generatedConversationId ? [conversationId, generatedConversationId] : [conversationId]
  await connection.execute(`
    DELETE m FROM ${table('migration_entity_mappings')} m
    WHERE m.source_system='flue' AND (
      (m.source_table='flue_conversation_streams' AND m.target_id IN (${cleanupConversationIds.map(() => '?').join(',')}))
      OR (m.source_table='flue_conversation_stream_batches' AND m.target_id IN (
        SELECT id FROM ${table('agent_messages')} WHERE conversation_id IN (${cleanupConversationIds.map(() => '?').join(',')})
      ))
    )
  `, [...cleanupConversationIds, ...cleanupConversationIds]).catch(() => undefined)
  if (generatedConversationId) {
    await connection.execute(`DELETE FROM ${table('agent_conversations')} WHERE id=?`, [generatedConversationId]).catch(() => undefined)
    await connection.execute(`DELETE FROM ${table('chat_conversations')} WHERE id=?`, [generatedConversationId]).catch(() => undefined)
  }
  await connection.execute(`DELETE FROM ${table('agent_conversations')} WHERE id=?`, [conversationId]).catch(() => undefined)
  await connection.execute(`DELETE FROM ${table('chat_conversations')} WHERE id=?`, [conversationId]).catch(() => undefined)
  await connection.execute(`DELETE FROM ${table('users')} WHERE id=?`, [userId]).catch(() => undefined)
  connection.release()
  await pool.end()
  await rm(tempDir, { recursive: true, force: true })
  await cleanupTransientSourceEvidence()
}
