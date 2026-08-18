import { createHash } from 'node:crypto'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ingestRadarCandidates } from './radarDataMigrationService.js'

type JsonObject = Record<string, unknown>

export type RadarWechatChatMessageInput = {
  msg_key?: unknown
  group_name?: unknown
  group_serial_no?: unknown
  sender_name?: unknown
  sender_serial_no?: unknown
  cite_content?: unknown
  msg_time?: unknown
  send_time?: unknown
  message_time?: unknown
  content?: unknown
  msg_content?: unknown
  msg_content_decoded?: unknown
  raw_msg_content?: unknown
  file?: unknown
  msg_type?: unknown
}

export type RadarWechatChatPushInput = {
  merchant_no?: unknown
  pushed_at?: unknown
  messages: RadarWechatChatMessageInput[]
}

type ChatRow = RowDataPacket & {
  id: string
  content_hash: string
  merchant_no: string
  msg_key: string
  group_name: string
  group_serial_no: string
  sender_name: string
  sender_serial_no: string
  cite_content: string
  message_content: string
  message_date: string
  message_time: Date | string | null
  message_time_raw: string
  pushed_at: Date | string | null
  pushed_at_raw: string
  msg_type: string
  file: JsonObject | string
  raw_payload: JsonObject | string
  received_at: Date | string
}

type NormalizedChatMessage = {
  id: string
  contentHash: string
  merchantNo: string
  msgKey: string
  groupName: string
  groupSerialNo: string
  senderName: string
  senderSerialNo: string
  citeContent: string
  messageContent: string
  messageDate: string
  messageTime: Date | null
  messageTimeRaw: string
  pushedAt: Date | null
  pushedAtRaw: string
  msgType: string
  file: JsonObject
  rawPayload: JsonObject
  receivedAt: Date
}

const messagesTable = quoteMysqlIdentifier(mysqlTableName('radar_wechat_chat_messages'))
const candidatesTable = quoteMysqlIdentifier(mysqlTableName('radar_candidates'))
const CHAT_CONTEXT_BEFORE = 4
const CHAT_CONTEXT_AFTER = 4
const CHAT_INVESTMENT_HINT_TERMS = [
  '融资', '天使轮', '种子轮', 'Pre-A', 'A轮', 'B轮', '估值', 'BP', '商业计划书',
  '路演', '项目', '尽调', '看项目', '推荐项目', 'FA', '投资人', '创始人', '创业公司',
  '未上市', '客户', '订单', '量产', '专利', '临床', '注册证', '样机', '芯片',
  '机器人', '人工智能', '大模型', '生物医药', '医疗器械', '新材料', '新能源',
] as const

function text(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

function htmlToText(value: unknown): string {
  return text(String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"))
}

function decodeRawContent(value: unknown): string {
  const encoded = text(value)
  if (!encoded) return ''
  try { return Buffer.from(encoded, 'base64').toString('utf8').trim() } catch { return '' }
}

function parseDate(value: unknown): Date | null {
  const raw = text(value)
  if (!raw) return null
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T00:00:00+08:00`
    : /^\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw)
      ? `${raw.replaceAll('/', '-').replace(' ', 'T')}+08:00`
      : raw
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function shanghaiDate(value = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value)
}

function jsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as JsonObject
}

function parsedJsonObject(value: JsonObject | string): JsonObject {
  if (typeof value !== 'string') return value
  try { return jsonObject(JSON.parse(value)) } catch { return {} }
}

function normalizeFile(value: unknown): JsonObject {
  const file = jsonObject(value)
  const normalized = {
    file_serial_no: text(file.file_serial_no),
    file_name: text(file.file_name),
    file_url: text(file.file_url),
  }
  return Object.values(normalized).some(Boolean) ? normalized : {}
}

function normalizeGroupSerial(groupName: string): string {
  return groupName.toLocaleLowerCase('zh-CN').replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 191) || md5(groupName)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function normalizeMessage(push: RadarWechatChatPushInput, input: RadarWechatChatMessageInput): NormalizedChatMessage | null {
  const merchantNo = text(push.merchant_no)
  const pushedAtRaw = text(push.pushed_at)
  const msgKey = text(input.msg_key)
  const groupName = text(input.group_name) || '未命名群'
  const groupSerialNo = text(input.group_serial_no) || normalizeGroupSerial(groupName)
  const senderName = text(input.sender_name) || '未知成员'
  const messageTimeRaw = text(input.message_time) || text(input.send_time) || text(input.msg_time) || pushedAtRaw
  const messageContent = text(input.msg_content_decoded)
    || htmlToText(input.msg_content)
    || htmlToText(input.content)
    || decodeRawContent(input.raw_msg_content)
  const citeContent = htmlToText(input.cite_content)
  const file = normalizeFile(input.file)
  if (!messageContent && !citeContent && Object.keys(file).length === 0) return null
  const digest = md5(`${merchantNo}:${groupSerialNo}:${msgKey || senderName}:${text(input.message_time) || text(input.send_time) || text(input.msg_time)}:${messageContent}`)
  const messageTime = parseDate(messageTimeRaw)
  const pushedAt = parseDate(pushedAtRaw)
  const rawPayload = { ...input }
  const contentHash = sha256(stableJson({ merchantNo, msgKey, groupSerialNo, senderName, messageTimeRaw, messageContent, citeContent, file }))
  return {
    id: `chatmsg:${digest}`, contentHash, merchantNo, msgKey, groupName, groupSerialNo,
    senderName, senderSerialNo: text(input.sender_serial_no), citeContent, messageContent,
    messageDate: shanghaiDate(messageTime || pushedAt || new Date()), messageTime: messageTime || pushedAt,
    messageTimeRaw, pushedAt, pushedAtRaw, msgType: text(input.msg_type), file, rawPayload,
    receivedAt: new Date(),
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

async function insertMessages(messages: NormalizedChatMessage[]): Promise<number> {
  let inserted = 0
  for (const batch of chunks(messages, 50)) {
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
    const params = batch.flatMap((row) => [
      row.id, row.contentHash, row.merchantNo, row.msgKey, row.groupName, row.groupSerialNo,
      row.senderName, row.senderSerialNo, row.citeContent, row.messageContent, row.messageDate,
      row.messageTime, row.messageTimeRaw, row.pushedAt, row.pushedAtRaw, row.msgType,
      JSON.stringify(row.file), JSON.stringify(row.rawPayload), row.receivedAt,
    ])
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT IGNORE INTO ${messagesTable}
       (id,content_hash,merchant_no,msg_key,group_name,group_serial_no,sender_name,sender_serial_no,cite_content,message_content,message_date,message_time,message_time_raw,pushed_at,pushed_at_raw,msg_type,file,raw_payload,received_at)
       VALUES ${placeholders}`,
      params,
    )
    inserted += result.affectedRows
  }
  return inserted
}

function dateValue(value: Date | string | null): string {
  if (!value) return ''
  if (value instanceof Date) return value.toISOString()
  const parsed = parseDate(value)
  return parsed ? parsed.toISOString() : text(value)
}

function publicMessage(row: ChatRow): JsonObject {
  const keyTime = row.message_time_raw || dateValue(row.message_time) || row.pushed_at_raw || dateValue(row.pushed_at)
  return {
    source: 'wechat_chat_message', source_id: row.id, merchant_no: row.merchant_no,
    pushed_at: row.pushed_at_raw || dateValue(row.pushed_at), received_at: dateValue(row.received_at),
    msg_key: row.msg_key, group_name: row.group_name, group_serial_no: row.group_serial_no,
    sender_name: row.sender_name, sender_serial_no: row.sender_serial_no,
    cite_content: row.cite_content, msg_content: row.message_content, file: parsedJsonObject(row.file),
    msg_time: keyTime, send_time: keyTime, message_time: keyTime, msg_type: row.msg_type,
    date: row.message_date, sort_time: keyTime,
  }
}

function signalText(row: ChatRow): string {
  const file = parsedJsonObject(row.file)
  return [row.cite_content, row.message_content, text(file.file_name), text(file.file_url)].filter(Boolean).join('\n')
}

function hitTerms(value: string): string[] {
  const folded = value.toLocaleLowerCase('zh-CN')
  return CHAT_INVESTMENT_HINT_TERMS.filter((term) => folded.includes(term.toLocaleLowerCase('zh-CN'))).slice(0, 10)
}

function buildCandidate(rows: ChatRow[], index: number): JsonObject | null {
  const row = rows[index]
  const directSignal = signalText(row)
  const directHits = hitTerms(directSignal)
  if (!directSignal || directHits.length === 0) return null
  const contextRows = rows.slice(Math.max(0, index - CHAT_CONTEXT_BEFORE), index + CHAT_CONTEXT_AFTER + 1)
  const context = contextRows.map((item) => {
    const content = signalText(item)
    if (!content) return ''
    const marker = item.id === row.id ? ' *' : ''
    return `[${item.message_time_raw || dateValue(item.message_time)}] ${item.sender_name}${marker}: ${content}`
  }).filter(Boolean).join('\n')
  const allHits = [...new Set([...directHits, ...hitTerms(context)])].slice(0, 10)
  const score = Math.min(90, Math.max(60, 52 + allHits.length * 4))
  const sourceId = row.id.replace(/^chatmsg:/, 'wechat_chat:')
  const keyTime = row.message_time_raw || dateValue(row.message_time) || row.pushed_at_raw || dateValue(row.pushed_at)
  const subject = row.message_content.slice(0, 32) || row.group_name
  return {
    source: 'wechat_chat', source_id: sourceId, fingerprint: md5(sourceId).slice(0, 16),
    title: `群聊线索｜${subject}`, summary: `${row.sender_name} 在 ${keyTime} 于「${row.group_name}」提出关键信息。命中信号：${allHits.join('、')}。`,
    article_text: `关键信息\n${directSignal}\n\n聊天前后文\n${context}`,
    article_text_length: context.length, source_name: row.group_name, source_group: '微信群聊',
    source_key: row.group_serial_no || row.group_name, source_type: 'wechat_chat', date: row.message_date,
    merchant_no: row.merchant_no, group_name: row.group_name, group_serial_no: row.group_serial_no,
    sender_name: row.sender_name, sender_serial_no: row.sender_serial_no, key_message_time: keyTime,
    published_at: keyTime, updated_at: dateValue(row.received_at),
    categories: ['微信群聊', row.group_name, row.sender_name].filter(Boolean),
    chat_context: contextRows.map((item) => ({
      time: item.message_time_raw || dateValue(item.message_time), sender_name: item.sender_name,
      content: signalText(item), is_key_message: item.id === row.id,
    })).filter((item) => item.content),
    file: parsedJsonObject(row.file), attention_score: score, worth_attention: true,
    signals: [{ code: 'wechat_chat_hint', score: 8, detail: `群聊投资线索词: ${allHits.slice(0, 8).join('、')}` }],
    decision: 'watchlist', decision_label: '保留观察', filter_reasons: [],
    private_market_thesis: '群聊中出现投资相关线索，需结合上下文人工核实。',
    collected_at: dateValue(row.received_at),
  }
}

async function groupRows(date: string, groupSerialNo: string): Promise<ChatRow[]> {
  const [rows] = await pool.query<ChatRow[]>(
    `SELECT * FROM ${messagesTable} WHERE message_date=? AND group_serial_no=?
     ORDER BY COALESCE(message_time,pushed_at,received_at), id`,
    [date, groupSerialNo],
  )
  return rows
}

export async function ingestRadarWechatChatPush(input: RadarWechatChatPushInput) {
  const normalized = input.messages.map((message) => normalizeMessage(input, message))
    .filter((message): message is NormalizedChatMessage => Boolean(message))
  const stored = await insertMessages(normalized)
  const affectedGroups = [...new Map(normalized.map((row) => [`${row.messageDate}\u0000${row.groupSerialNo}`, {
    date: row.messageDate, groupName: row.groupName, groupSerialNo: row.groupSerialNo,
  }])).values()]
  const candidates: JsonObject[] = []
  for (const group of affectedGroups) {
    const rows = await groupRows(group.date, group.groupSerialNo)
    for (let index = 0; index < rows.length; index += 1) {
      const candidate = buildCandidate(rows, index)
      if (candidate) candidates.push(candidate)
    }
  }
  const writtenCandidates = await ingestRadarCandidates(candidates)
  return {
    received: input.messages.length, stored, groups: affectedGroups.length,
    candidates: candidates.length, written_candidates: writtenCandidates,
    candidate_file: null, group_candidate_files: [], message_files: [],
    storage: 'mysql', items: candidates.slice(0, 50),
  }
}

export async function listRadarWechatChatMessages(options: {
  date?: string
  groupName?: string
  groupSerialNo?: string
  limit: number
}) {
  const date = options.date || shanghaiDate()
  const where = ['message_date=?']
  const params: unknown[] = [date]
  if (options.groupSerialNo) { where.push('group_serial_no=?'); params.push(options.groupSerialNo) }
  else if (options.groupName) { where.push('group_name=?'); params.push(options.groupName) }
  const [countRows] = await pool.query<Array<RowDataPacket & { total: number }>>(
    `SELECT COUNT(*) AS total FROM ${messagesTable} WHERE ${where.join(' AND ')}`, params,
  )
  const [rows] = await pool.query<ChatRow[]>(
    `SELECT * FROM ${messagesTable} WHERE ${where.join(' AND ')}
     ORDER BY group_name, COALESCE(message_time,pushed_at,received_at), id LIMIT ?`,
    [...params, options.limit],
  )
  return { date, total: Number(countRows[0]?.total) || 0, items: rows.map(publicMessage) }
}

export async function listRadarWechatChatGroups(date = shanghaiDate()) {
  const [rows] = await pool.query<Array<RowDataPacket & {
    group_name: string
    group_serial_no: string
    message_count: number
    first_message_time: Date | string | null
    last_message_time: Date | string | null
  }>>(
    `SELECT group_name,group_serial_no,COUNT(*) AS message_count,
       MIN(COALESCE(message_time,pushed_at,received_at)) AS first_message_time,
       MAX(COALESCE(message_time,pushed_at,received_at)) AS last_message_time
     FROM ${messagesTable} WHERE message_date=? GROUP BY group_name,group_serial_no ORDER BY group_name`, [date],
  )
  const [candidateRows] = await pool.query<Array<RowDataPacket & { payload: JsonObject | string }>>(
    `SELECT payload FROM ${candidatesTable} WHERE source='wechat_chat'`,
  )
  const counts = new Map<string, number>()
  for (const candidateRow of candidateRows) {
    const payload = parsedJsonObject(candidateRow.payload)
    if (text(payload.date) !== date) continue
    const key = text(payload.group_serial_no)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const groups = rows.map((row) => ({
    date, group_name: row.group_name, group_serial_no: row.group_serial_no,
    message_count: Number(row.message_count) || 0, candidate_count: counts.get(row.group_serial_no) || 0,
    message_file: null, candidate_file: null,
    first_message_time: dateValue(row.first_message_time), last_message_time: dateValue(row.last_message_time),
  }))
  return { date, total: groups.length, groups }
}
