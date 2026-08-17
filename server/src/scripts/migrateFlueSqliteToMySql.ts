import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'
import { isMigrationJsonError, migrationJsonIssue, parseMigrationJson } from './migrationJsonSafety.js'

type JsonObject = Record<string, unknown>
type Severity = 'error' | 'warning'
type MigrationIssue = {
  severity: Severity
  sourceTable?: string
  sourceKey?: string
  code: string
  message: string
  payload?: JsonObject
}
type SourceStream = {
  path: string
  instanceId: string
  agentName: string
  records: JsonObject[]
  conversations: SourceConversation[]
}
type SourceConversation = {
  canonicalId: string
  sourceConversationId: string
  kind: string
  parentCanonicalId?: string
  harness: string
  session: string
  createdAt: Date
  modelId: string | null
  status: 'closed' | 'interrupted'
  metadataEvents: JsonObject[]
  messages: SourceMessage[]
  targetId?: string
}
type SourceMessage = {
  sourceMessageId: string
  role: string
  sequence: number
  content: string | null
  toolName: string | null
  toolInput: unknown
  toolOutput: unknown
  thinking: string | null
  status: string
  createdAt: Date
  parts: SourcePart[]
  sourceChecksum: string
  targetId?: string
}
type SourcePart = {
  type: string
  content: string | null
  payload: unknown
}
type TargetConversation = {
  id: string
  userId: string
  projectId: string | null
  title: string
  scope: string
  externalSessionId: string | null
  legacySource: string | null
  legacyConversationId: string | null
  modelId: string | null
  metadata: JsonObject
  exists: boolean
}
type ConversationAccumulator = {
  source: SourceConversation
  messageDrafts: MessageDraft[]
  assistantDrafts: Map<string, AssistantDraft>
  toolOutcomes: Map<string, ToolOutcomeDraft[]>
}
type MessageDraft = Omit<SourceMessage, 'sequence' | 'sourceChecksum'> & { ordinal: number }
type AssistantBlock = {
  blockId: string
  blockIndex: number
  type: 'text' | 'reasoning' | 'tool_call'
  deltas: string[]
  completed: boolean
  payload: JsonObject
}
type AssistantDraft = {
  messageId: string
  ordinal: number
  createdAt: Date
  modelInfo: JsonObject
  blocks: Map<string, AssistantBlock>
  completion?: JsonObject
}
type ToolOutcomeDraft = {
  ordinal: number
  record: JsonObject
}

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    apply: { type: 'boolean', default: false },
    map: { type: 'string' },
    report: { type: 'string' },
    'exclude-source': { type: 'string' },
  },
  strict: true,
})

if (!values.source?.trim()) throw new Error('Usage: migrate:flue -- --source /absolute/path/flue.db [--map mapping.json] [--report report.json] [--apply]')
const requestedSource = path.resolve(values.source)
if (!existsSync(requestedSource) || !statSync(requestedSource).isFile()) throw new Error(`Flue source is not a regular file: ${requestedSource}`)
const sourcePath = realpathSync(requestedSource)
const apply = values.apply === true

const REQUIRED_TABLES = [
  'flue_meta',
  'flue_conversation_streams',
  'flue_conversation_stream_batches',
  'flue_attachments',
  'flue_attachment_chunks',
] as const
const KNOWN_TABLES = new Set([
  ...REQUIRED_TABLES,
  'flue_agent_attempt_markers',
  'flue_agent_dispatch_receipts',
  'flue_agent_submissions',
  'flue_event_stream_entries',
  'flue_event_stream_keys',
  'flue_event_streams',
  'flue_image_chunks',
  'flue_runs',
  'sqlite_sequence',
])
const SUPPORTED_RECORD_TYPES = new Set([
  'conversation_created',
  'user_message',
  'signal',
  'assistant_message_started',
  'assistant_text_started',
  'assistant_text_delta',
  'assistant_text_completed',
  'assistant_reasoning_started',
  'assistant_reasoning_delta',
  'assistant_reasoning_completed',
  'assistant_tool_call',
  'assistant_message_completed',
  'tool_outcome',
  'tool_results_committed',
  'compaction',
  'child_session_retained',
  'submission_settled',
])

function table(base: string): string {
  return quoteMysqlIdentifier(mysqlTableName(base))
}

function asObject(value: unknown): JsonObject | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function jsonValue(raw: unknown, label: string): unknown {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { throw new Error(`Invalid JSON in ${label}`) }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function canonical(value: unknown): unknown {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as JsonObject)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]))
  }
  if (typeof value === 'bigint') return value.toString()
  return value
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function deterministicUuid(key: string): string {
  const bytes = Buffer.from(createHash('sha256').update(key).digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function boundedSourceId(value: string): string {
  if (value.length <= 191) return value
  return `sha256:${checksum(value)}`
}

function parseTimestamp(value: unknown, issue: (input: MigrationIssue) => void, sourceKey: string): Date {
  const date = typeof value === 'string' || typeof value === 'number' ? new Date(value) : new Date(Number.NaN)
  if (!Number.isNaN(date.valueOf())) return date
  issue({
    severity: 'error',
    sourceTable: 'flue_conversation_stream_batches',
    sourceKey,
    code: 'INVALID_TIMESTAMP',
    message: 'Canonical Flue record has an invalid timestamp.',
  })
  return new Date(0)
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function textFromBlocks(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.map((block) => {
    const object = asObject(block)
    return object?.type === 'text' && typeof object.text === 'string' ? object.text : ''
  }).filter(Boolean).join('\n')
}

function attachmentRefs(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((block) => {
    const object = asObject(block)
    const attachment = object?.type === 'attachment' ? asObject(object.attachment) : null
    return attachment ? [attachment] : []
  })
}

function sourceMessageChecksum(message: Omit<SourceMessage, 'sourceChecksum' | 'targetId'>): string {
  return checksum({
    sourceMessageId: message.sourceMessageId,
    role: message.role,
    content: message.content,
    toolName: message.toolName,
    toolInput: message.toolInput,
    toolOutput: message.toolOutput,
    thinking: message.thinking,
    status: message.status,
    createdAt: message.createdAt,
    parts: message.parts,
  })
}

function conversationContentChecksum(conversation: SourceConversation): string {
  return checksum({
    sourceConversationId: conversation.sourceConversationId,
    canonicalId: conversation.canonicalId,
    messages: conversation.messages.map((message) => message.sourceChecksum),
    metadataEvents: conversation.metadataEvents,
  })
}

function readSourceDatabase(file: string, issues: MigrationIssue[]): {
  schemaVersion: string
  streams: SourceStream[]
  counts: Record<string, number>
} {
  const issue = (input: MigrationIssue) => issues.push(input)
  if (/aipin/i.test(file)) {
    issue({ severity: 'error', code: 'AIPIN_SOURCE_REJECTED', message: 'Source path contains Aipin identity and is outside the migration allowlist.' })
    return { schemaVersion: 'unknown', streams: [], counts: {} }
  }

  const sqlite = new DatabaseSync(file, { readOnly: true })
  try {
    sqlite.exec('PRAGMA query_only=ON')
    const integrity = sqlite.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') {
      issue({ severity: 'error', code: 'SQLITE_INTEGRITY_FAILED', message: 'SQLite integrity_check did not return ok.' })
    }
    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name)
    for (const name of tables) {
      if (/aipin/i.test(name)) issue({ severity: 'error', sourceTable: name, code: 'AIPIN_TABLE_REJECTED', message: 'Aipin table is explicitly excluded from migration.' })
      else if (!KNOWN_TABLES.has(name)) issue({ severity: 'warning', sourceTable: name, code: 'UNKNOWN_FLUE_TABLE', message: 'Unknown table is not read by the Flue conversation importer.' })
    }
    for (const required of REQUIRED_TABLES) {
      if (!tables.includes(required)) issue({ severity: 'error', sourceTable: required, code: 'REQUIRED_TABLE_MISSING', message: 'Required Flue canonical storage table is missing.' })
    }
    if (issues.some((item) => item.severity === 'error')) return { schemaVersion: 'unknown', streams: [], counts: {} }

    const versionRow = sqlite.prepare("SELECT value FROM flue_meta WHERE key='schema_version'").get() as { value?: unknown } | undefined
    const schemaVersion = String(versionRow?.value ?? '')
    if (schemaVersion !== '4') {
      issue({ severity: 'error', sourceTable: 'flue_meta', sourceKey: 'schema_version', code: 'UNSUPPORTED_FLUE_SCHEMA', message: `Flue schema version ${schemaVersion || 'missing'} is not supported by the validated importer.` })
    }

    const attachmentRows = sqlite.prepare('SELECT stream_path, attachment_id, mime_type, byte_size, digest, conversation_id, chunk_count FROM flue_attachments').all() as Array<Record<string, unknown>>
    const attachmentChunkRows = sqlite.prepare('SELECT stream_path, attachment_id, chunk_index, bytes FROM flue_attachment_chunks ORDER BY stream_path, attachment_id, chunk_index').all() as Array<Record<string, unknown>>
    const attachmentMap = new Map(attachmentRows.map((row) => [`${String(row.stream_path)}\u0000${String(row.attachment_id)}`, row]))
    const chunksByAttachment = new Map<string, Array<Record<string, unknown>>>()
    for (const chunk of attachmentChunkRows) {
      const key = `${String(chunk.stream_path)}\u0000${String(chunk.attachment_id)}`
      const list = chunksByAttachment.get(key) ?? []
      list.push(chunk)
      chunksByAttachment.set(key, list)
    }
    for (const [key, attachment] of attachmentMap) {
      const chunks = chunksByAttachment.get(key) ?? []
      const expectedChunks = Number(attachment.chunk_count)
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.bytes as Uint8Array)))
      if (chunks.length !== expectedChunks || chunks.some((chunk, index) => Number(chunk.chunk_index) !== index)) {
        issue({ severity: 'error', sourceTable: 'flue_attachment_chunks', sourceKey: key, code: 'ATTACHMENT_CHUNK_SEQUENCE', message: 'Attachment chunks are missing, duplicated or out of order.' })
      }
      if (bytes.length !== Number(attachment.byte_size) || createHash('sha256').update(bytes).digest('hex') !== String(attachment.digest)) {
        issue({ severity: 'error', sourceTable: 'flue_attachments', sourceKey: key, code: 'ATTACHMENT_INTEGRITY_FAILED', message: 'Attachment byte size or SHA-256 differs from its canonical reference.' })
      }
      issue({ severity: 'warning', sourceTable: 'flue_attachments', sourceKey: key, code: 'ATTACHMENT_ARCHIVE_REQUIRED', message: 'Attachment reference is preserved, but bytes must be copied by the file-asset migration before cutover.' })
    }
    for (const key of chunksByAttachment.keys()) {
      if (!attachmentMap.has(key)) issue({ severity: 'error', sourceTable: 'flue_attachment_chunks', sourceKey: key, code: 'ORPHAN_ATTACHMENT_CHUNK', message: 'Attachment chunk has no parent attachment row.' })
    }
    const streamRows = sqlite.prepare('SELECT path, identity_json, next_offset FROM flue_conversation_streams ORDER BY path').all() as Array<Record<string, unknown>>
    const batchRows = sqlite.prepare('SELECT path, seq, data FROM flue_conversation_stream_batches ORDER BY path, seq').all() as Array<Record<string, unknown>>
    const batchesByPath = new Map<string, Array<Record<string, unknown>>>()
    for (const batch of batchRows) {
      const streamPath = String(batch.path)
      const list = batchesByPath.get(streamPath) ?? []
      list.push(batch)
      batchesByPath.set(streamPath, list)
    }

    const streams: SourceStream[] = []
    let recordCount = 0
    for (const row of streamRows) {
      const streamPath = String(row.path)
      let identity: JsonObject | null
      try {
        identity = asObject(parseMigrationJson(row.identity_json, {
          sourceSystem: 'flue', table: 'flue_conversation_streams', column: 'identity_json', sourceKey: streamPath,
        }))
      } catch (error) {
        if (!isMigrationJsonError(error)) throw error
        issue(migrationJsonIssue(error))
        continue
      }
      const instanceId = stringValue(identity?.instanceId)
      const agentName = stringValue(identity?.agentName)
      if (!instanceId || !agentName || streamPath !== `agents/${agentName}/${instanceId}`) {
        issue({ severity: 'error', sourceTable: 'flue_conversation_streams', sourceKey: streamPath, code: 'STREAM_IDENTITY_MISMATCH', message: 'Stream path and identity_json do not describe the same agent instance.' })
        continue
      }
      const batches = batchesByPath.get(streamPath) ?? []
      const nextOffset = Number(row.next_offset)
      if (nextOffset !== batches.length || batches.some((batch, index) => Number(batch.seq) !== index)) {
        issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: streamPath, code: 'STREAM_SEQUENCE_GAP', message: 'Canonical batch sequence is not contiguous or does not match next_offset.', payload: { nextOffset, batches: batches.length } })
      }
      const records: JsonObject[] = []
      for (const batch of batches) {
        const sourceKey = `${streamPath}:${String(batch.seq)}`
        let parsed: unknown
        try {
          parsed = parseMigrationJson(batch.data, {
            sourceSystem: 'flue', table: 'flue_conversation_stream_batches', column: 'data', sourceKey,
          })
        } catch (error) {
          if (!isMigrationJsonError(error)) throw error
          issue(migrationJsonIssue(error))
          continue
        }
        if (!Array.isArray(parsed)) {
          issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey, code: 'BATCH_NOT_ARRAY', message: 'Canonical batch payload is not a JSON array.' })
          continue
        }
        for (const item of parsed) {
          const record = asObject(item)
          if (!record) {
            issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey, code: 'RECORD_NOT_OBJECT', message: 'Canonical batch contains a non-object record.' })
            continue
          }
          records.push(record)
        }
      }
      recordCount += records.length
      const projectedConversations = projectRecords(streamPath, records, attachmentMap, issue)
      for (const conversation of projectedConversations) {
        conversation.sourceConversationId = boundedSourceId(`${instanceId}/${conversation.canonicalId}`)
      }
      streams.push({
        path: streamPath,
        instanceId,
        agentName,
        records,
        conversations: projectedConversations,
      })
    }
    for (const batchPath of batchesByPath.keys()) {
      if (!streamRows.some((row) => String(row.path) === batchPath)) issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: batchPath, code: 'ORPHAN_STREAM_BATCH', message: 'Canonical batch has no stream metadata row.' })
    }
    const conversations = streams.flatMap((stream) => stream.conversations)
    return {
      schemaVersion,
      streams,
      counts: {
        streams: streams.length,
        batches: batchRows.length,
        records: recordCount,
        conversations: conversations.length,
        messages: conversations.reduce((sum, conversation) => sum + conversation.messages.length, 0),
        parts: conversations.reduce((sum, conversation) => sum + conversation.messages.reduce((inner, message) => inner + message.parts.length, 0), 0),
        attachments: attachmentRows.length,
        attachmentChunks: attachmentChunkRows.length,
      },
    }
  } finally {
    sqlite.close()
  }
}

function projectRecords(
  streamPath: string,
  records: JsonObject[],
  attachments: Map<string, Record<string, unknown>>,
  issue: (input: MigrationIssue) => void,
): SourceConversation[] {
  const conversations = new Map<string, ConversationAccumulator>()
  const seenRecordIds = new Map<string, string>()

  function accumulator(record: JsonObject, ordinal: number): ConversationAccumulator | null {
    const canonicalId = stringValue(record.conversationId)
    if (!canonicalId) {
      issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: `${streamPath}:${ordinal}`, code: 'CONVERSATION_ID_MISSING', message: 'Canonical record has no conversationId.' })
      return null
    }
    const found = conversations.get(canonicalId)
    if (!found) issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: `${streamPath}:${ordinal}`, code: 'CONVERSATION_NOT_INITIALIZED', message: 'Record appears before conversation_created.', payload: { canonicalId } })
    return found ?? null
  }

  function validateAttachments(content: unknown, sourceKey: string): void {
    for (const ref of attachmentRefs(content)) {
      const attachmentId = stringValue(ref.id)
      if (!attachmentId || !attachments.has(`${streamPath}\u0000${attachmentId}`)) {
        issue({ severity: 'error', sourceTable: 'flue_attachments', sourceKey, code: 'ATTACHMENT_MISSING', message: 'Canonical message references attachment bytes that are absent from the attachment store.' })
      }
    }
  }

  records.forEach((record, ordinal) => {
    const type = stringValue(record.type)
    const recordId = stringValue(record.id)
    const recordKey = `${streamPath}:${ordinal}`
    if (record.v !== 1 || !type || !recordId) {
      issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: recordKey, code: 'INVALID_RECORD_ENVELOPE', message: 'Canonical record must have v=1, id and type.' })
      return
    }
    const recordHash = checksum(record)
    const priorHash = seenRecordIds.get(recordId)
    if (priorHash && priorHash !== recordHash) {
      issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: recordId, code: 'RECORD_ID_CONFLICT', message: 'Canonical record id is reused with different content.' })
      return
    }
    if (priorHash) return
    seenRecordIds.set(recordId, recordHash)
    if (!SUPPORTED_RECORD_TYPES.has(type)) {
      issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: recordId, code: 'UNSUPPORTED_RECORD_TYPE', message: `Unsupported canonical record type: ${type}` })
      return
    }

    if (type === 'conversation_created') {
      const canonicalId = stringValue(record.conversationId)
      if (!canonicalId || conversations.has(canonicalId)) {
        issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: recordId, code: 'DUPLICATE_CONVERSATION_CREATE', message: 'conversation_created is missing an id or initializes the same conversation twice.' })
        return
      }
      const createdAt = parseTimestamp(record.createdAt ?? record.timestamp, issue, recordId)
      const source: SourceConversation = {
        canonicalId,
        sourceConversationId: '',
        kind: stringValue(record.kind) ?? 'root',
        parentCanonicalId: stringValue(record.parentConversationId) ?? undefined,
        harness: stringValue(record.harness) ?? 'default',
        session: stringValue(record.session) ?? 'default',
        createdAt,
        modelId: null,
        status: 'closed',
        metadataEvents: [{ type, recordId, raw: record }],
        messages: [],
      }
      conversations.set(canonicalId, { source, messageDrafts: [], assistantDrafts: new Map(), toolOutcomes: new Map() })
      return
    }

    const current = accumulator(record, ordinal)
    if (!current) return
    const timestamp = parseTimestamp(record.timestamp, issue, recordId)
    const messageId = stringValue(record.messageId)

    if (type === 'user_message' || type === 'signal') {
      if (!messageId) {
        issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: recordId, code: 'MESSAGE_ID_MISSING', message: `${type} has no messageId.` })
        return
      }
      const contentBlocks = type === 'user_message' ? record.content : [{ type: 'text', text: String(record.content ?? '') }]
      validateAttachments(contentBlocks, recordId)
      const parts: SourcePart[] = Array.isArray(contentBlocks) ? contentBlocks.map((block) => {
        const object = asObject(block) ?? {}
        if (object.type === 'text') return { type: 'text', content: String(object.text ?? ''), payload: null }
        return { type: 'attachment', content: null, payload: object.attachment ?? object }
      }) : []
      current.messageDrafts.push({
        sourceMessageId: messageId,
        role: type === 'signal' ? 'system' : 'user',
        content: textFromBlocks(contentBlocks) || null,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        thinking: null,
        status: 'complete',
        createdAt: timestamp,
        parts,
        ordinal,
      })
      return
    }

    if (type === 'assistant_message_started') {
      if (!messageId || current.assistantDrafts.has(messageId)) {
        issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: recordId, code: 'ASSISTANT_START_CONFLICT', message: 'Assistant message start is missing or duplicates messageId.' })
        return
      }
      const modelInfo = asObject(record.modelInfo) ?? {}
      current.source.modelId ??= stringValue(modelInfo.model)
      current.assistantDrafts.set(messageId, { messageId, ordinal, createdAt: timestamp, modelInfo, blocks: new Map() })
      return
    }

    if (type.startsWith('assistant_')) {
      if (!messageId) {
        issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: recordId, code: 'ASSISTANT_MESSAGE_ID_MISSING', message: `${type} has no messageId.` })
        return
      }
      const draft = current.assistantDrafts.get(messageId)
      if (!draft) {
        issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: recordId, code: 'ASSISTANT_NOT_STARTED', message: `${type} appears before assistant_message_started.` })
        return
      }
      if (type === 'assistant_message_completed') {
        draft.completion = record
        return
      }
      const blockId = stringValue(record.blockId)
      if (!blockId) {
        issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: recordId, code: 'BLOCK_ID_MISSING', message: `${type} has no blockId.` })
        return
      }
      if (type.endsWith('_started') || type === 'assistant_tool_call') {
        if (draft.blocks.has(blockId)) {
          issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: recordId, code: 'BLOCK_START_CONFLICT', message: 'Assistant block starts more than once.' })
          return
        }
        const blockType: AssistantBlock['type'] = type === 'assistant_tool_call' ? 'tool_call' : type.includes('reasoning') ? 'reasoning' : 'text'
        draft.blocks.set(blockId, {
          blockId,
          blockIndex: Number(record.blockIndex ?? draft.blocks.size),
          type: blockType,
          deltas: [],
          completed: blockType === 'tool_call',
          payload: blockType === 'tool_call' ? {
            toolCallId: record.toolCallId,
            name: record.name,
            arguments: record.arguments,
            thoughtSignature: record.thoughtSignature,
          } : {},
        })
        return
      }
      const block = draft.blocks.get(blockId)
      if (!block) {
        issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: recordId, code: 'BLOCK_NOT_STARTED', message: `${type} appears before its block start.` })
        return
      }
      if (type.endsWith('_delta')) {
        const sequence = Number(record.sequence)
        if (!Number.isInteger(sequence) || sequence !== block.deltas.length || typeof record.delta !== 'string') {
          issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: recordId, code: 'BLOCK_DELTA_SEQUENCE', message: 'Assistant block delta sequence is not contiguous.' })
          return
        }
        block.deltas.push(record.delta)
        return
      }
      if (type.endsWith('_completed')) {
        if (Number(record.deltaCount) !== block.deltas.length) issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: recordId, code: 'BLOCK_DELTA_COUNT', message: 'Assistant block deltaCount does not match observed deltas.' })
        block.completed = true
        block.payload = { ...block.payload, textSignature: record.textSignature, encrypted: record.encrypted, redacted: record.redacted }
        return
      }
    }

    if (type === 'tool_outcome') {
      const assistantMessageId = stringValue(record.assistantMessageId)
      if (!assistantMessageId) {
        issue({ severity: 'error', sourceTable: 'flue_conversation_stream_batches', sourceKey: recordId, code: 'TOOL_OUTCOME_MESSAGE_MISSING', message: 'tool_outcome has no assistantMessageId.' })
        return
      }
      validateAttachments(record.content, recordId)
      const list = current.toolOutcomes.get(assistantMessageId) ?? []
      list.push({ ordinal, record })
      current.toolOutcomes.set(assistantMessageId, list)
      return
    }

    current.source.metadataEvents.push({ type, recordId, raw: record })
  })

  for (const current of conversations.values()) {
    for (const draft of current.assistantDrafts.values()) {
      const blocks = [...draft.blocks.values()].sort((left, right) => left.blockIndex - right.blockIndex)
      const parts: SourcePart[] = blocks.map((block) => ({
        type: block.type,
        content: block.type === 'tool_call' ? null : block.deltas.join(''),
        payload: block.payload,
      }))
      const outcomes = (current.toolOutcomes.get(draft.messageId) ?? []).sort((left, right) => left.ordinal - right.ordinal)
      for (const outcome of outcomes) {
        parts.push({
          type: 'tool_result',
          content: textFromBlocks(outcome.record.content) || null,
          payload: {
            toolCallId: outcome.record.toolCallId,
            toolName: outcome.record.toolName,
            isError: outcome.record.isError,
            output: outcome.record.output,
            content: outcome.record.content,
          },
        })
      }
      const firstTool = blocks.find((block) => block.type === 'tool_call')
      const firstOutcome = outcomes[0]?.record
      const incompleteBlock = blocks.some((block) => !block.completed)
      const error = stringValue(draft.completion?.error)
      current.messageDrafts.push({
        sourceMessageId: draft.messageId,
        role: 'assistant',
        content: parts.filter((part) => part.type === 'text').map((part) => part.content).filter(Boolean).join('\n') || null,
        toolName: stringValue(firstTool?.payload.name),
        toolInput: firstTool?.payload.arguments ?? null,
        toolOutput: firstOutcome?.output ?? firstOutcome?.content ?? null,
        thinking: parts.filter((part) => part.type === 'reasoning').map((part) => part.content).filter(Boolean).join('\n') || null,
        status: error ? 'failed' : !draft.completion || incompleteBlock ? 'interrupted' : 'complete',
        createdAt: draft.createdAt,
        parts,
        ordinal: draft.ordinal,
      })
    }
    current.messageDrafts.sort((left, right) => left.ordinal - right.ordinal || left.sourceMessageId.localeCompare(right.sourceMessageId))
    current.source.messages = current.messageDrafts.map((draft, sequence) => {
      const message = { ...draft, sequence }
      const { ordinal: _ordinal, ...withoutOrdinal } = message
      return { ...withoutOrdinal, sourceChecksum: sourceMessageChecksum(withoutOrdinal) }
    })
    current.source.status = current.source.messages.some((message) => message.status === 'interrupted') ? 'interrupted' : 'closed'
  }
  return [...conversations.values()].map((current) => current.source)
}

async function readMappingFile(file: string | undefined): Promise<Map<string, string>> {
  if (!file) return new Map()
  const parsed = jsonValue(await readFile(path.resolve(file), 'utf8'), 'mapping file')
  const instances = asObject(asObject(parsed)?.instances)
  if (!instances) throw new Error('Mapping file must contain an object at instances')
  const result = new Map<string, string>()
  for (const [instanceId, targetId] of Object.entries(instances)) {
    if (typeof targetId !== 'string' || !targetId) throw new Error(`Invalid target conversation id for instance ${instanceId}`)
    result.set(instanceId, targetId)
  }
  return result
}

async function readSourceExclusion(
  file: string | undefined,
  sourceSha256: string,
  fullSourceChecksum: string,
  sourceCounts: Record<string, number>,
): Promise<{ disposition: string; reason: string } | null> {
  if (!file) return null
  const parsed = asObject(jsonValue(await readFile(path.resolve(file), 'utf8'), 'source exclusion file'))
  if (!parsed || parsed.schemaVersion !== '1.0'
    || parsed.disposition !== 'exclude-acceptance-fixture'
    || parsed.sourceSha256 !== sourceSha256
    || parsed.fullSourceChecksum !== fullSourceChecksum) {
    throw new Error('Source exclusion policy identity/checksum contract does not match the selected Flue source')
  }
  const expectedCounts = asObject(parsed.expectedCounts)
  if (!expectedCounts || Object.entries(sourceCounts).some(([key, count]) => Number(expectedCounts[key]) !== count)) {
    throw new Error('Source exclusion policy counts do not match the selected Flue source')
  }
  const reason = String(parsed.reason ?? '').trim()
  if (!reason) throw new Error('Source exclusion policy requires a non-empty reason')
  return { disposition: String(parsed.disposition), reason }
}

function parseMetadata(raw: unknown): JsonObject {
  const value = typeof raw === 'string' ? jsonValue(raw, 'MySQL metadata') : raw
  return asObject(value) ?? {}
}

async function loadTargets(connection: PoolConnection, explicit: Map<string, string>, issues: MigrationIssue[]): Promise<{
  byId: Map<string, TargetConversation>
  byInstance: Map<string, TargetConversation>
  sourceMappings: Map<string, string>
}> {
  const [agentRows] = await connection.query<RowDataPacket[]>(`
    SELECT id, user_id AS userId, project_id AS projectId, title, scope,
           external_session_id AS externalSessionId, legacy_source AS legacySource,
           legacy_conversation_id AS legacyConversationId, model_id AS modelId, metadata
    FROM ${table('agent_conversations')}
  `)
  const byId = new Map<string, TargetConversation>()
  const instanceCandidates = new Map<string, TargetConversation[]>()
  for (const row of agentRows) {
    const target: TargetConversation = {
      id: String(row.id), userId: String(row.userId), projectId: row.projectId == null ? null : String(row.projectId),
      title: String(row.title), scope: String(row.scope), externalSessionId: row.externalSessionId == null ? null : String(row.externalSessionId),
      legacySource: row.legacySource == null ? null : String(row.legacySource), legacyConversationId: row.legacyConversationId == null ? null : String(row.legacyConversationId),
      modelId: row.modelId == null ? null : String(row.modelId), metadata: parseMetadata(row.metadata), exists: true,
    }
    byId.set(target.id, target)
    if (target.externalSessionId) instanceCandidates.set(target.externalSessionId, [...(instanceCandidates.get(target.externalSessionId) ?? []), target])
  }

  const [chatRows] = await connection.query<RowDataPacket[]>(`
    SELECT id, user_id AS userId, project_id AS projectId, title, scope, agent_id AS agentId
    FROM ${table('chat_conversations')} WHERE agent_id IS NOT NULL
  `)
  for (const row of chatRows) {
    const id = String(row.id)
    const agentId = String(row.agentId)
    if (row.userId == null) {
      issues.push({ severity: 'error', sourceKey: id, code: 'CHAT_OWNER_MISSING', message: 'Legacy chat index has no stable MySQL user owner.' })
      continue
    }
    const target = byId.get(id) ?? {
      id, userId: String(row.userId), projectId: row.projectId == null ? null : String(row.projectId), title: String(row.title), scope: String(row.scope),
      externalSessionId: agentId, legacySource: 'legacy_postgres', legacyConversationId: id, modelId: null, metadata: {}, exists: false,
    }
    instanceCandidates.set(agentId, [...(instanceCandidates.get(agentId) ?? []), target])
    byId.set(id, target)
  }

  const byInstance = new Map<string, TargetConversation>()
  for (const [instanceId, candidates] of instanceCandidates) {
    const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()]
    if (unique.length === 1) byInstance.set(instanceId, unique[0])
    else issues.push({ severity: 'error', sourceKey: instanceId, code: 'AMBIGUOUS_INSTANCE_OWNER', message: 'More than one target conversation claims the same Flue instance.', payload: { targetIds: unique.map((item) => item.id) } })
  }
  for (const [instanceId, targetId] of explicit) {
    const target = byId.get(targetId)
    if (!target) issues.push({ severity: 'error', sourceKey: instanceId, code: 'MAPPING_TARGET_MISSING', message: 'Explicit mapping refers to a target conversation that does not exist.', payload: { targetId } })
    else if (byInstance.has(instanceId) && byInstance.get(instanceId)!.id !== targetId) issues.push({ severity: 'error', sourceKey: instanceId, code: 'MAPPING_CONFLICT', message: 'Explicit mapping conflicts with automatic agent_id mapping.' })
    else byInstance.set(instanceId, target)
  }

  const [mappingRows] = await connection.query<RowDataPacket[]>(`
    SELECT source_conversation_id AS sourceConversationId, conversation_id AS conversationId
    FROM ${table('agent_conversation_source_mappings')} WHERE source_system='flue'
  `)
  return { byId, byInstance, sourceMappings: new Map(mappingRows.map((row) => [String(row.sourceConversationId), String(row.conversationId)])) }
}

function assignTargets(
  streams: SourceStream[],
  targets: Awaited<ReturnType<typeof loadTargets>>,
  issues: MigrationIssue[],
): TargetConversation[] {
  const plannedTargets = new Map<string, TargetConversation>()
  for (const stream of streams) {
    const owner = targets.byInstance.get(stream.instanceId)
    if (!owner) {
      issues.push({ severity: 'error', sourceTable: 'flue_conversation_streams', sourceKey: stream.path, code: 'OWNER_MAPPING_MISSING', message: 'Flue instance has no matching PostgreSQL/MySQL conversation index. Provide an approved --map file; do not infer a user.' })
      continue
    }
    const roots = stream.conversations.filter((conversation) => conversation.kind === 'root')
    const primaryRoot = roots.find((conversation) => conversation.harness === 'default' && conversation.session === 'default') ?? roots[0]
    if (!primaryRoot) {
      issues.push({ severity: 'error', sourceKey: stream.path, code: 'ROOT_CONVERSATION_MISSING', message: 'Flue stream has no root conversation.' })
      continue
    }
    for (const conversation of stream.conversations) {
      const mappedId = targets.sourceMappings.get(conversation.sourceConversationId)
      const defaultTargetId = conversation === primaryRoot ? owner.id : deterministicUuid(`flue-conversation:${conversation.sourceConversationId}`)
      const targetId = mappedId ?? defaultTargetId
      if (mappedId && mappedId !== defaultTargetId) {
        issues.push({ severity: 'error', sourceKey: conversation.sourceConversationId, code: 'SOURCE_MAPPING_CONFLICT', message: 'Existing source mapping conflicts with the planned target conversation.' })
        continue
      }
      conversation.targetId = targetId
      const existing = targets.byId.get(targetId)
      if (existing && (existing.userId !== owner.userId || existing.projectId !== owner.projectId)) {
        issues.push({ severity: 'error', sourceKey: conversation.sourceConversationId, code: 'OWNER_SCOPE_CONFLICT', message: 'Mapped child conversation has different user or project ownership.' })
        continue
      }
      const conversationImportChecksum = conversationContentChecksum(conversation)
      plannedTargets.set(targetId, existing ?? {
        id: targetId,
        userId: owner.userId,
        projectId: owner.projectId,
        title: conversation === primaryRoot ? owner.title : `${owner.title} · ${conversation.kind === 'task' ? '子任务' : '子会话'}`,
        scope: owner.scope,
        externalSessionId: conversation === primaryRoot ? stream.instanceId : `${stream.instanceId}:${conversation.canonicalId}`.slice(0, 128),
        legacySource: 'legacy_flue',
        legacyConversationId: conversation.canonicalId.slice(0, 64),
        modelId: conversation.modelId,
        metadata: {},
        exists: false,
      })
      const target = plannedTargets.get(targetId)!
      target.modelId ??= conversation.modelId
      target.metadata = {
        ...target.metadata,
        flueImport: {
          sourceConversationId: conversation.sourceConversationId,
          sourceInstanceId: stream.instanceId,
          canonicalConversationId: conversation.canonicalId,
          kind: conversation.kind,
          parentCanonicalId: conversation.parentCanonicalId ?? null,
          harness: conversation.harness,
          session: conversation.session,
          checksum: conversationImportChecksum,
          metadataEvents: conversation.metadataEvents,
        },
      }
      for (const message of conversation.messages) message.targetId = deterministicUuid(`flue-message:${conversation.sourceConversationId}:${message.sourceMessageId}`)
    }
  }
  return [...plannedTargets.values()]
}

function importedContentChecksum(streams: SourceStream[]): string {
  return checksum(streams.flatMap((stream) => stream.conversations.map((conversation) => ({
    sourceConversationId: conversation.sourceConversationId,
    metadataChecksum: checksum(conversation.metadataEvents),
    messages: conversation.messages.map((message) => ({
      sourceMessageId: message.sourceMessageId,
      sourceChecksum: message.sourceChecksum,
      parts: message.parts,
    })),
  }))))
}

async function planMessageTargets(connection: PoolConnection, streams: SourceStream[], issues: MigrationIssue[]): Promise<void> {
  for (const conversation of streams.flatMap((stream) => stream.conversations).filter((item) => item.targetId)) {
    for (const message of conversation.messages) {
      const sourceMessageId = boundedSourceId(message.sourceMessageId)
      const [mappingRows] = await connection.query<RowDataPacket[]>(`
        SELECT message_id AS messageId FROM ${table('agent_message_source_mappings')}
        WHERE source_system='flue' AND source_conversation_id=? AND source_message_id=?
      `, [conversation.sourceConversationId, sourceMessageId])
      const [externalRows] = await connection.query<RowDataPacket[]>(`
        SELECT id FROM ${table('agent_messages')} WHERE conversation_id=? AND external_message_id=?
      `, [conversation.targetId, sourceMessageId])
      const [semanticRows] = await connection.query<RowDataPacket[]>(`
        SELECT id,tool_input AS toolInput,tool_output AS toolOutput
        FROM ${table('agent_messages')}
        WHERE conversation_id=? AND role=? AND content <=> ? AND thinking <=> ? AND tool_name <=> ? AND created_at=?
      `, [conversation.targetId, message.role, message.content, message.thinking, message.toolName, message.createdAt])
      const semanticIds = semanticRows.filter((row) => (
        checksum(row.toolInput == null ? null : jsonValue(row.toolInput, 'existing tool input')) === checksum(message.toolInput)
        && checksum(row.toolOutput == null ? null : jsonValue(row.toolOutput, 'existing tool output')) === checksum(message.toolOutput)
      )).map((row) => String(row.id))
      const candidates = new Set([
        ...mappingRows.map((row) => String(row.messageId)),
        ...externalRows.map((row) => String(row.id)),
        ...semanticIds,
      ])
      if (candidates.size > 1) {
        issues.push({
          severity: 'error',
          sourceTable: 'agent_messages',
          sourceKey: `${conversation.sourceConversationId}/${sourceMessageId}`,
          code: 'MESSAGE_DEDUP_CONFLICT',
          message: 'Source mapping, external id or exact semantic fingerprint resolve to different target messages.',
          payload: { targetIds: [...candidates] },
        })
        continue
      }
      message.targetId = [...candidates][0] ?? deterministicUuid(`flue-message:${conversation.sourceConversationId}:${message.sourceMessageId}`)
    }
  }
}

async function insertRun(connection: PoolConnection, input: {
  sourceSha256: string
  sourceCounts: Record<string, number>
  sourceChecksum: string
  status: string
  report: JsonObject
}): Promise<string> {
  const id = randomUUID()
  await connection.execute(`
    INSERT INTO ${table('migration_runs')}
      (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,source_checksum,report,started_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,NOW(3),IF(?='running',NULL,NOW(3)))
  `, [id, 'flue-sqlite-to-mysql', sourcePath, input.sourceSha256, 'apply', input.status,
    JSON.stringify(input.sourceCounts), JSON.stringify({}), input.sourceChecksum, JSON.stringify(input.report), input.status])
  return id
}

async function insertIssues(connection: PoolConnection, runId: string, issues: MigrationIssue[]): Promise<void> {
  for (const issue of issues) {
    await connection.execute(`
      INSERT INTO ${table('migration_issues')}
        (id,run_id,severity,source_system,source_table,source_key,code,message,payload,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,NOW(3))
    `, [randomUUID(), runId, issue.severity, 'flue', issue.sourceTable ?? null, issue.sourceKey?.slice(0, 255) ?? null,
      issue.code, issue.message, JSON.stringify(issue.payload ?? {})])
  }
}

async function applyProjection(
  connection: PoolConnection,
  streams: SourceStream[],
  targetConversations: TargetConversation[],
  runId: string,
): Promise<Record<string, number>> {
  await connection.beginTransaction()
  try {
    for (const target of targetConversations) {
      const sourceConversation = streams.flatMap((stream) => stream.conversations).find((conversation) => conversation.targetId === target.id)!
      const projectName = typeof target.metadata.projectName === 'string' ? target.metadata.projectName : null
      // The legacy chat index allows 64 characters while the normalized agent
      // session allows 128. Never truncate an external identity into a possibly
      // colliding value; the stable shared conversation UUID remains authoritative.
      const chatAgentId = target.externalSessionId && target.externalSessionId.length <= 64
        ? target.externalSessionId : null
      // chat_conversations is the user-visible list/index while agent_conversations
      // owns the normalized message stream. Restore both halves atomically so a
      // generated or orphaned historical agent is not migrated but invisible.
      await connection.execute(`
        INSERT INTO ${table('chat_conversations')}
          (id,user_id,title,scope,project_id,project_name,agent_id,messages,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,JSON_ARRAY(),?,?)
        ON DUPLICATE KEY UPDATE
          user_id=VALUES(user_id), project_id=VALUES(project_id), title=VALUES(title), scope=VALUES(scope),
          project_name=COALESCE(VALUES(project_name),project_name),
          agent_id=VALUES(agent_id), updated_at=VALUES(updated_at)
      `, [target.id, target.userId, target.title, target.scope, target.projectId, projectName,
        chatAgentId, sourceConversation.createdAt,
        sourceConversation.messages.at(-1)?.createdAt ?? sourceConversation.createdAt])
      await connection.execute(`
        INSERT INTO ${table('agent_conversations')}
          (id,user_id,project_id,title,scope,status,runtime,external_session_id,legacy_source,legacy_conversation_id,model_id,metadata,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
          user_id=VALUES(user_id), project_id=VALUES(project_id), title=VALUES(title), scope=VALUES(scope),
          status=VALUES(status), runtime=VALUES(runtime), external_session_id=VALUES(external_session_id),
          model_id=COALESCE(VALUES(model_id),model_id), metadata=VALUES(metadata), updated_at=VALUES(updated_at)
      `, [target.id, target.userId, target.projectId, target.title, target.scope, sourceConversation.status, 'legacy-import',
        target.externalSessionId, target.legacySource, target.legacyConversationId, target.modelId, JSON.stringify(target.metadata),
        sourceConversation.createdAt, sourceConversation.messages.at(-1)?.createdAt ?? sourceConversation.createdAt])
      await connection.execute(`
        INSERT INTO ${table('agent_conversation_source_mappings')}
          (id,conversation_id,source_system,source_conversation_id,source_instance_id,source_checksum,metadata,created_at)
        VALUES (?,?,?,?,?,?,?,NOW(3))
        ON DUPLICATE KEY UPDATE
          conversation_id=VALUES(conversation_id), source_instance_id=VALUES(source_instance_id),
          source_checksum=VALUES(source_checksum), metadata=VALUES(metadata)
      `, [deterministicUuid(`flue-conversation-map:${sourceConversation.sourceConversationId}`), target.id, 'flue',
        sourceConversation.sourceConversationId, String((target.metadata.flueImport as JsonObject).sourceInstanceId),
        String((target.metadata.flueImport as JsonObject).checksum), JSON.stringify(target.metadata.flueImport)])
      await connection.execute(`
        INSERT INTO ${table('migration_entity_mappings')}
          (id,run_id,source_system,source_table,source_id,target_table,target_id,mapping_kind,source_checksum,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,NOW(3))
        ON DUPLICATE KEY UPDATE
          run_id=VALUES(run_id),target_table=VALUES(target_table),target_id=VALUES(target_id),
          mapping_kind=VALUES(mapping_kind),source_checksum=VALUES(source_checksum)
      `, [deterministicUuid(`flue-entity-map:conversation:${sourceConversation.sourceConversationId}`), runId,
        'flue', 'flue_conversation_streams', boundedSourceId(sourceConversation.sourceConversationId),
        'agent_conversations', target.id, target.exists ? 'resolved' : 'generated',
        String((target.metadata.flueImport as JsonObject).checksum)])

      for (const message of sourceConversation.messages) {
        const [mappedRows] = await connection.query<RowDataPacket[]>(`
          SELECT message_id AS messageId FROM ${table('agent_message_source_mappings')}
          WHERE source_system='flue' AND source_conversation_id=? AND source_message_id=?
        `, [sourceConversation.sourceConversationId, boundedSourceId(message.sourceMessageId)])
        const [externalRows] = await connection.query<RowDataPacket[]>(`
          SELECT id FROM ${table('agent_messages')} WHERE conversation_id=? AND external_message_id=? LIMIT 2
        `, [target.id, boundedSourceId(message.sourceMessageId)])
        const mappedId = mappedRows[0]?.messageId == null ? null : String(mappedRows[0].messageId)
        const externalId = externalRows[0]?.id == null ? null : String(externalRows[0].id)
        if (mappedId && externalId && mappedId !== externalId) throw new Error(`Flue message mapping conflict for ${sourceConversation.sourceConversationId}`)
        if ((mappedId && mappedId !== message.targetId) || (externalId && externalId !== message.targetId)) {
          throw new Error(`Flue message target changed after preview for ${sourceConversation.sourceConversationId}`)
        }
        const messageId = mappedId ?? externalId ?? message.targetId!
        message.targetId = messageId
        await connection.execute(`
          INSERT INTO ${table('agent_messages')}
            (id,conversation_id,external_message_id,role,sequence,content,tool_name,tool_input,tool_output,thinking,status,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE
            role=VALUES(role), sequence=VALUES(sequence), content=VALUES(content), tool_name=VALUES(tool_name),
            tool_input=VALUES(tool_input), tool_output=VALUES(tool_output), thinking=VALUES(thinking),
            status=VALUES(status), created_at=VALUES(created_at)
        `, [messageId, target.id, boundedSourceId(message.sourceMessageId), message.role, message.sequence, message.content,
          message.toolName, message.toolInput == null ? null : JSON.stringify(message.toolInput),
          message.toolOutput == null ? null : JSON.stringify(message.toolOutput), message.thinking, message.status, message.createdAt])
        await connection.execute(`DELETE FROM ${table('agent_message_parts')} WHERE message_id=?`, [messageId])
        for (const [partIndex, part] of message.parts.entries()) {
          await connection.execute(`
            INSERT INTO ${table('agent_message_parts')}
              (id,message_id,part_index,type,content,payload,created_at) VALUES (?,?,?,?,?,?,?)
          `, [deterministicUuid(`flue-part:${messageId}:${partIndex}`), messageId, partIndex, part.type, part.content,
            part.payload == null ? null : JSON.stringify(part.payload), message.createdAt])
        }
        await connection.execute(`
          INSERT INTO ${table('agent_message_source_mappings')}
            (id,message_id,source_system,source_conversation_id,source_message_id,source_checksum,created_at)
          VALUES (?,?,?,?,?,?,NOW(3))
          ON DUPLICATE KEY UPDATE message_id=VALUES(message_id), source_checksum=VALUES(source_checksum)
        `, [deterministicUuid(`flue-message-map:${sourceConversation.sourceConversationId}:${message.sourceMessageId}`), messageId,
          'flue', sourceConversation.sourceConversationId, boundedSourceId(message.sourceMessageId), message.sourceChecksum])
        const sourceEntityId = boundedSourceId(`${sourceConversation.sourceConversationId}/${message.sourceMessageId}`)
        await connection.execute(`
          INSERT INTO ${table('migration_entity_mappings')}
            (id,run_id,source_system,source_table,source_id,target_table,target_id,mapping_kind,source_checksum,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,NOW(3))
          ON DUPLICATE KEY UPDATE
            run_id=VALUES(run_id),target_table=VALUES(target_table),target_id=VALUES(target_id),
            mapping_kind=VALUES(mapping_kind),source_checksum=VALUES(source_checksum)
        `, [deterministicUuid(`flue-entity-map:message:${sourceEntityId}`), runId, 'flue',
          'flue_conversation_stream_batches', sourceEntityId, 'agent_messages', messageId, 'generated', message.sourceChecksum])
      }
      const [allMessages] = await connection.query<RowDataPacket[]>(`
        SELECT id FROM ${table('agent_messages')} WHERE conversation_id=? ORDER BY created_at,sequence,id
      `, [target.id])
      for (const [sequence, row] of allMessages.entries()) {
        await connection.execute(`UPDATE ${table('agent_messages')} SET sequence=? WHERE id=?`, [sequence, row.id])
      }
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  }
  return {
    chatIndexes: streams.flatMap((stream) => stream.conversations).filter((conversation) => conversation.targetId).length,
    conversations: streams.flatMap((stream) => stream.conversations).filter((conversation) => conversation.targetId).length,
    messages: streams.flatMap((stream) => stream.conversations).reduce((sum, conversation) => sum + (conversation.targetId ? conversation.messages.length : 0), 0),
    parts: streams.flatMap((stream) => stream.conversations).reduce((sum, conversation) => sum + (conversation.targetId ? conversation.messages.reduce((inner, message) => inner + message.parts.length, 0) : 0), 0),
  }
}

async function verifyProjection(connection: PoolConnection, streams: SourceStream[]): Promise<string> {
  const conversations = streams.flatMap((stream) => stream.conversations).filter((conversation) => conversation.targetId)
  const verified: unknown[] = []
  for (const conversation of conversations) {
    const [pairRows] = await connection.query<RowDataPacket[]>(`
      SELECT c.id
      FROM ${table('chat_conversations')} c
      JOIN ${table('agent_conversations')} a ON a.id=c.id
      WHERE c.id=? AND c.user_id=a.user_id AND c.project_id <=> a.project_id
        AND BINARY c.title=BINARY a.title AND BINARY c.scope=BINARY a.scope
        AND (c.agent_id <=> a.external_session_id
          OR (c.agent_id IS NULL AND CHAR_LENGTH(a.external_session_id)>64))
    `, [conversation.targetId])
    if (pairRows.length !== 1) throw new Error(`Target conversation index/agent pair verification failed: ${conversation.sourceConversationId}`)
    const [conversationRows] = await connection.query<RowDataPacket[]>(`
      SELECT metadata FROM ${table('agent_conversations')} WHERE id=?
    `, [conversation.targetId])
    const metadata = parseMetadata(conversationRows[0]?.metadata)
    const storedImport = asObject(metadata.flueImport)
    if (!storedImport || storedImport.sourceConversationId !== conversation.sourceConversationId) throw new Error(`Target conversation verification failed: ${conversation.sourceConversationId}`)
    if (storedImport.checksum !== conversationContentChecksum(conversation)
      || checksum(storedImport.metadataEvents) !== checksum(conversation.metadataEvents)) {
      throw new Error(`Target conversation metadata verification failed: ${conversation.sourceConversationId}`)
    }
    const storedMessages: unknown[] = []
    for (const message of conversation.messages) {
      const [rows] = await connection.query<RowDataPacket[]>(`
        SELECT m.id,m.role,m.sequence,m.content,m.tool_name AS toolName,m.tool_input AS toolInput,m.tool_output AS toolOutput,
               m.thinking,m.status,UNIX_TIMESTAMP(m.created_at)*1000 AS createdAtMs,sm.source_checksum AS sourceChecksum
        FROM ${table('agent_message_source_mappings')} sm
        JOIN ${table('agent_messages')} m ON m.id=sm.message_id
        WHERE sm.source_system='flue' AND sm.source_conversation_id=? AND sm.source_message_id=?
      `, [conversation.sourceConversationId, boundedSourceId(message.sourceMessageId)])
      if (rows.length !== 1 || String(rows[0].sourceChecksum) !== message.sourceChecksum) throw new Error(`Target message verification failed: ${message.sourceMessageId}`)
      const [partRows] = await connection.query<RowDataPacket[]>(`
        SELECT type,content,payload FROM ${table('agent_message_parts')} WHERE message_id=? ORDER BY part_index
      `, [rows[0].id])
      const targetParts = partRows.map((row) => ({ type: String(row.type), content: row.content == null ? null : String(row.content), payload: row.payload == null ? null : jsonValue(row.payload, 'target part payload') }))
      if (checksum(targetParts) !== checksum(message.parts)) throw new Error(`Target message parts verification failed: ${message.sourceMessageId}`)
      const recomputedChecksum = sourceMessageChecksum({
        sourceMessageId: message.sourceMessageId,
        role: String(rows[0].role),
        sequence: Number(rows[0].sequence),
        content: rows[0].content == null ? null : String(rows[0].content),
        toolName: rows[0].toolName == null ? null : String(rows[0].toolName),
        toolInput: rows[0].toolInput == null ? null : jsonValue(rows[0].toolInput, 'target tool input'),
        toolOutput: rows[0].toolOutput == null ? null : jsonValue(rows[0].toolOutput, 'target tool output'),
        thinking: rows[0].thinking == null ? null : String(rows[0].thinking),
        status: String(rows[0].status),
        createdAt: new Date(Number(rows[0].createdAtMs)),
        parts: targetParts,
      })
      if (recomputedChecksum !== message.sourceChecksum) throw new Error(`Target message content verification failed: ${message.sourceMessageId}`)
      storedMessages.push({ sourceMessageId: message.sourceMessageId, sourceChecksum: recomputedChecksum, parts: targetParts })
    }
    verified.push({ sourceConversationId: conversation.sourceConversationId, metadataChecksum: checksum(storedImport.metadataEvents), messages: storedMessages })
  }
  return checksum(verified)
}

const issues: MigrationIssue[] = []
const sourceSha256 = await sha256File(sourcePath)
const source = readSourceDatabase(sourcePath, issues)
const fullSourceChecksum = importedContentChecksum(source.streams)
const sourceExclusion = await readSourceExclusion(
  values['exclude-source'], sourceSha256, fullSourceChecksum, source.counts,
)
const selectedStreams = sourceExclusion ? [] : source.streams
if (sourceExclusion) {
  issues.push({
    severity: 'warning', sourceTable: 'flue_conversation_streams', code: 'SOURCE_ACCEPTANCE_FIXTURE_EXCLUDED',
    message: 'The checksum-locked source is an approved acceptance fixture and is excluded from business migration.',
    payload: { disposition: sourceExclusion.disposition, reason: sourceExclusion.reason, fullSourceChecksum },
  })
}
await ensureSchema()
const connection = await pool.getConnection()
async function writeDefaultEvidence(report: JsonObject): Promise<void> {
  const directory = path.resolve(process.cwd(), '.runtime/migration-evidence/flue-sources')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const target = path.resolve(directory, `${sourceSha256}.json`)
  if (report.applied !== true) {
    try {
      const existing = asObject(jsonValue(await readFile(target, 'utf8'), 'existing Flue evidence'))
      if (existing?.applied === true && existing.sourceSha256 === sourceSha256) return
    } catch {
      // No prior successful evidence exists; write the current preview/failure below.
    }
  }
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
}
try {
  const explicitMappings = await readMappingFile(values.map)
  const targets = await loadTargets(connection, explicitMappings, issues)
  const plannedTargets = assignTargets(selectedStreams, targets, issues)
  await planMessageTargets(connection, selectedStreams, issues)
  const sourceChecksum = importedContentChecksum(selectedStreams)
  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length
  const previewReport: JsonObject = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ok: errorCount === 0,
    mode: apply ? 'apply' : 'preview',
    source: sourcePath,
    sourceSha256,
    flueSchemaVersion: source.schemaVersion,
    sourceCounts: source.counts,
    selectedCounts: {
      conversations: selectedStreams.flatMap((stream) => stream.conversations).length,
      messages: selectedStreams.flatMap((stream) => stream.conversations).reduce((sum, conversation) => sum + conversation.messages.length, 0),
      parts: selectedStreams.flatMap((stream) => stream.conversations).reduce((sum, conversation) => sum + conversation.messages.reduce((inner, message) => inner + message.parts.length, 0), 0),
    },
    excludedSource: sourceExclusion ? {
      disposition: sourceExclusion.disposition,
      reason: sourceExclusion.reason,
      fullSourceChecksum,
      counts: source.counts,
    } : null,
    plannedTargetCounts: {
      chatIndexes: plannedTargets.length,
      conversations: plannedTargets.length,
      messages: source.streams.flatMap((stream) => stream.conversations).reduce((sum, conversation) => sum + (conversation.targetId ? conversation.messages.length : 0), 0),
      parts: source.streams.flatMap((stream) => stream.conversations).reduce((sum, conversation) => sum + (conversation.targetId ? conversation.messages.reduce((inner, message) => inner + message.parts.length, 0) : 0), 0),
    },
    sourceChecksum,
    issueCounts: { errors: errorCount, warnings: warningCount },
    issues,
    readyToApply: errorCount === 0,
  }

  if (!apply) {
    await writeDefaultEvidence(previewReport)
    if (values.report) await writeFile(path.resolve(values.report), `${JSON.stringify(previewReport, null, 2)}\n`, { flag: 'wx' })
    console.log(JSON.stringify(previewReport))
  } else if (errorCount > 0) {
    await writeDefaultEvidence(previewReport)
    const runId = await insertRun(connection, { sourceSha256, sourceCounts: source.counts, sourceChecksum, status: 'failed', report: previewReport })
    await insertIssues(connection, runId, issues)
    throw new Error(`Flue migration refused: ${errorCount} blocking issue(s); migration run ${runId}`)
  } else {
    const runId = await insertRun(connection, { sourceSha256, sourceCounts: source.counts, sourceChecksum, status: 'running', report: previewReport })
    await insertIssues(connection, runId, issues)
    try {
      const targetCounts = await applyProjection(connection, selectedStreams, plannedTargets, runId)
      const targetChecksum = await verifyProjection(connection, selectedStreams)
      if (targetChecksum !== sourceChecksum) throw new Error('Source/target normalized content checksum mismatch')
      const report = { ...previewReport, ok: true, runId, targetCounts, targetChecksum, applied: true }
      await connection.execute(`
        UPDATE ${table('migration_runs')} SET status='succeeded',target_counts=?,target_checksum=?,report=?,completed_at=NOW(3) WHERE id=?
      `, [JSON.stringify(targetCounts), targetChecksum, JSON.stringify(report), runId])
      await writeDefaultEvidence(report)
      if (values.report) await writeFile(path.resolve(values.report), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
      console.log(JSON.stringify(report))
    } catch (error) {
      const failureReport = { ...previewReport, failure: (error as Error).message }
      await connection.execute(`UPDATE ${table('migration_runs')} SET status='failed',report=?,completed_at=NOW(3) WHERE id=?`, [JSON.stringify(failureReport), runId])
      await writeDefaultEvidence(failureReport)
      throw error
    }
  }
} finally {
  connection.release()
  await pool.end()
}
