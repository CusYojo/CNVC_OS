import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import XLSX from 'xlsx'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { decodeAndValidateProjectFile } from '../security/projectFileValidation.js'
import { redactSensitiveText } from '../security/redactSecrets.js'
import { commitRadarLeadPipelineReady } from './aiSummaryService.js'
import { openLeadPipelineReview, recordLeadPipelineDecision } from './leadPipelineAuditService.js'
import { recordLeadPipelineRawEvent, transitionLeadPipelineItem } from './leadPipelineEventService.js'
import { isSpecificLeadSubjectName } from './leadSubjectName.js'
import { extractText } from './ragService.js'
import { readLeadIntakeFile, saveLeadIntakeFile } from './leadIntakeFileStorageService.js'

type IntakeActor = { userId: string; userName: string }
type ScheduleScoring = (leadId: string) => Promise<boolean>
type NormalizedLead = {
  name: string
  companyName?: string
  industry?: string
  businessRegion?: string
  source?: string
  summary?: string
  highlights?: string[]
  risks?: string[]
  team?: string
  fundingRounds?: unknown[]
}

type IntakeFileRow = RowDataPacket & {
  id: string
  kind: 'batch' | 'bp'
  original_name: string
  type_label: string
  content_type: string
  storage_path: string
  status: string
  stage: string
  progress: number
  execution_attempts: number
  last_error: string | null
  event_id: string | null
  lead_id: string | null
  review_id: string | null
  uploaded_by: string
  created_at: Date
  updated_at: Date
  completed_at: Date | null
}

type ImportBatchRow = RowDataPacket & {
  id: string
  file_id: string
  status: string
  total_rows: number
  valid_rows: number
  error_rows: number
  committed_rows: number
  review_rows: number
  failed_rows: number
  created_by: string
  created_at: Date
  updated_at: Date
  completed_at: Date | null
}

type ImportRow = RowDataPacket & {
  id: string
  batch_id: string
  row_number: number
  raw_data: Record<string, unknown> | string
  normalized_data: NormalizedLead | string
  validation_errors: string[] | string
  status: string
  event_id: string | null
  lead_id: string | null
  review_id: string | null
  result_message: string | null
}

const filesTable = quoteMysqlIdentifier(mysqlTableName('lead_intake_files'))
const batchesTable = quoteMysqlIdentifier(mysqlTableName('lead_import_batches'))
const rowsTable = quoteMysqlIdentifier(mysqlTableName('lead_import_rows'))
const reviewsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_reviews'))
const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
const MAX_IMPORT_ROWS = 2_000
const MAX_BP_TEXT = 120_000
const BP_MAX_ATTEMPTS = 3
let bpScheduleScoring: ScheduleScoring | undefined
let bpTimer: NodeJS.Timeout | undefined
let bpPolling = false
let bpStopping = false

const HEADER_ALIASES: Record<string, keyof NormalizedLead> = {
  项目名称: 'name', 项目名: 'name', 线索名称: 'name', name: 'name',
  公司名称: 'companyName', 公司全称: 'companyName', company: 'companyName', companyname: 'companyName',
  行业: 'industry', 赛道: 'industry', industry: 'industry',
  地区: 'businessRegion', 注册地: 'businessRegion', region: 'businessRegion',
  来源: 'source', 渠道: 'source', source: 'source',
  项目简介: 'summary', 简介: 'summary', summary: 'summary',
  投资亮点: 'highlights', 亮点: 'highlights', highlights: 'highlights',
  风险: 'risks', 风险点: 'risks', risks: 'risks',
  团队: 'team', 核心团队: 'team', team: 'team',
  融资轮次: 'fundingRounds', 融资: 'fundingRounds', funding: 'fundingRounds',
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function safeError(error: unknown) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error ?? '')).slice(0, 8_000)
}

function parseJson<T>(value: T | string, fallback: T): T {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as T } catch { return fallback }
}

function cleanCell(value: unknown, maxLength = 8_000) {
  const text = String(value ?? '').normalize('NFKC').replace(/\u0000/g, '').trim()
  return text.slice(0, maxLength)
}

function listCell(value: unknown) {
  return cleanCell(value).split(/[\n；;|]+/).map((item) => item.trim()).filter(Boolean).slice(0, 20)
}

function fundingCell(value: unknown) {
  return listCell(value).map((item) => ({ round: item, source: '批量导入文件' }))
}

function publicFile(row: IntakeFileRow) {
  return {
    id: row.id, kind: row.kind, name: row.original_name, status: row.status, stage: row.stage,
    progress: Number(row.progress), attempts: Number(row.execution_attempts), error: row.last_error,
    eventId: row.event_id, leadId: row.lead_id, reviewId: row.review_id,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
  }
}

function publicImportRow(row: ImportRow) {
  return {
    id: row.id, rowNumber: Number(row.row_number), raw: parseJson(row.raw_data, {}),
    normalized: parseJson(row.normalized_data, {} as NormalizedLead),
    errors: parseJson(row.validation_errors, []), status: row.status,
    eventId: row.event_id, leadId: row.lead_id, reviewId: row.review_id, message: row.result_message,
  }
}

async function findReviewId(eventId: string) {
  const [rows] = await pool.query<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM ${reviewsTable} WHERE event_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1`,
    [eventId],
  )
  return rows[0]?.id ?? null
}

async function commitNormalizedLead(input: {
  lead: NormalizedLead
  sourceType: 'batch-import' | 'bp-upload'
  sourceId: string
  actor: IntakeActor
  evidenceQuote: string
}) {
  const payload = {
    title: input.lead.name,
    summary: input.lead.summary ?? '',
    article_text: input.evidenceQuote.slice(0, MAX_BP_TEXT),
    project_profile: {
      project_name: input.lead.name,
      company_name: input.lead.companyName ?? '',
      industry: input.lead.industry ?? '',
      business_region: input.lead.businessRegion ?? '',
      core_highlights: input.lead.highlights ?? [],
      team_composition: input.lead.team ?? '',
      funding_rounds: input.lead.fundingRounds ?? [],
    },
    intake: { sourceType: input.sourceType, sourceId: input.sourceId, submittedBy: input.actor.userName },
  }
  const captured = await recordLeadPipelineRawEvent({ sourceType: input.sourceType, sourceId: input.sourceId, payload })
  if (captured.item.status === 'ready' && captured.item.leadId) {
    return { status: 'unchanged' as const, eventId: captured.event.id, leadId: captured.item.leadId, reviewId: null }
  }
  const quote = input.evidenceQuote.trim().slice(0, 8_000) || input.lead.name
  if (!isSpecificLeadSubjectName(input.lead.name)) {
    const reason = '上传材料中的主体名称不够明确，需要人工复核后才能进入公共线索池'
    const decision = await recordLeadPipelineDecision({
      idempotencyKey: `${captured.event.id}:uploaded-subject-review:v1`, eventId: captured.event.id,
      decisionType: 'subject_validation', outcome: 'review', subjectName: input.lead.name || null,
      confidence: 30, reason, output: { candidate: input.lead }, actorType: 'system', actorId: 'lead-intake',
    })
    const review = await openLeadPipelineReview({
      idempotencyKey: `${captured.event.id}:uploaded-subject-review:v1`, eventId: captured.event.id,
      triggerDecisionId: decision.id, reason,
    })
    await transitionLeadPipelineItem(captured.event.id, {
      status: 'review', reason, evidence: [{ sourceId: input.sourceId }], confidence: 30,
      actorType: 'system', actorId: 'lead-intake',
    })
    return { status: 'review' as const, eventId: captured.event.id, leadId: null, reviewId: review.id }
  }
  const decision = await recordLeadPipelineDecision({
    idempotencyKey: `${captured.event.id}:uploaded-material-accept:v1`, eventId: captured.event.id,
    decisionType: 'uploaded_material_intake', outcome: 'accept', subjectType: 'project',
    subjectName: input.lead.name, legalName: input.lead.companyName, confidence: 80,
    reason: '用户提交的原始材料通过格式与主体名称校验，按未核验来源进入公共线索池',
    output: { sourceType: input.sourceType, candidate: input.lead }, actorType: 'system', actorId: 'lead-intake',
    evidence: [{
      sourceId: input.sourceId, sourceType: input.sourceType, locator: '用户上传原始文件',
      claim: `上传材料声明主体为“${input.lead.name}”`, quote,
      reliability: 'self_reported', verificationStatus: 'unverified',
    }],
  })
  try {
    const result = await commitRadarLeadPipelineReady({
      lead: {
        ...input.lead,
        source: input.lead.source || (input.sourceType === 'bp-upload' ? '用户上传 BP' : '批量导入'),
        poolStatus: '成功',
        risks: [...(input.lead.risks ?? []), '上传材料为项目方/用户自报信息，关键事实仍需独立核验'],
        sources: [{ title: input.sourceType === 'bp-upload' ? '用户上传 BP' : '批量导入文件', sourceId: input.sourceId }],
        radarProfile: {
          channel: input.sourceType === 'bp-upload' ? 'BP上传' : '批量导入',
          qualityRejected: false,
          intake: { sourceType: input.sourceType, sourceId: input.sourceId, decisionId: decision.id },
          articleText: input.evidenceQuote.slice(0, 50_000),
        },
        radarSourceKeys: [`${input.sourceType}:${input.sourceId}`],
      },
      eventId: captured.event.id,
      transition: {
        reason: '上传材料已通过结构与主体校验，正式写入公共线索池',
        evidence: [{ decisionId: decision.id, sourceId: input.sourceId }], confidence: 80,
        actorType: 'system', actorId: 'lead-intake',
      },
      userId: input.actor.userId,
    })
    return { status: result.status, eventId: captured.event.id, leadId: result.row.id, reviewId: null }
  } catch (error) {
    const typed = error as Error & { code?: string; reviewStaged?: boolean }
    if (typed.code === 'RADAR_LEAD_ENTITY_AMBIGUOUS' && typed.reviewStaged) {
      return { status: 'review' as const, eventId: captured.event.id, leadId: null, reviewId: await findReviewId(captured.event.id) }
    }
    throw error
  }
}

export async function buildLeadImportTemplate() {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'SBL 公共线索池'
  const sheet = workbook.addWorksheet('线索导入模板', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [
    { header: '项目名称*', key: 'name', width: 24 }, { header: '公司名称', key: 'companyName', width: 28 },
    { header: '行业', key: 'industry', width: 18 }, { header: '地区', key: 'region', width: 14 },
    { header: '来源', key: 'source', width: 18 }, { header: '项目简介', key: 'summary', width: 48 },
    { header: '投资亮点（分号分隔）', key: 'highlights', width: 36 }, { header: '风险点（分号分隔）', key: 'risks', width: 36 },
    { header: '核心团队', key: 'team', width: 36 }, { header: '融资轮次（分号分隔）', key: 'funding', width: 30 },
  ]
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }
  sheet.autoFilter = 'A1:J1'
  sheet.addRow({ name: '示例科技', companyName: '示例科技有限公司', industry: '人工智能', region: '北京', source: '合作伙伴推荐', summary: '示例行，请导入前删除。' })
  const guide = workbook.addWorksheet('填写说明')
  guide.addRows([
    ['字段', '说明'], ['项目名称*', '必填，需为明确的公司、项目、团队或实验室名称'],
    ['多值字段', '投资亮点、风险点、融资轮次使用分号或换行分隔'],
    ['数据安全', '不要填写公式；单次最多 2000 行，上传后会先预检，不会立即入池'],
  ])
  guide.getRow(1).font = { bold: true }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

function normalizedHeaders(row: unknown[]) {
  return row.map((value) => cleanCell(value, 100).replace(/[\s_*＊]+/g, '').toLowerCase())
}

function normalizeImportRecord(headers: string[], values: unknown[]) {
  const raw: Record<string, unknown> = {}
  const lead: Partial<NormalizedLead> = {}
  headers.forEach((header, index) => {
    if (!header) return
    const value = cleanCell(values[index])
    raw[header] = value
    const key = HEADER_ALIASES[header]
    if (!key || !value) return
    if (key === 'highlights' || key === 'risks') lead[key] = listCell(value)
    else if (key === 'fundingRounds') lead[key] = fundingCell(value)
    else lead[key] = value as never
  })
  const normalized = lead as NormalizedLead
  const errors: string[] = []
  if (!normalized.name) errors.push('缺少必填字段“项目名称”')
  else if (!isSpecificLeadSubjectName(normalized.name)) errors.push('项目名称不是明确的公司、项目、团队或实验室主体')
  for (const [key, value] of Object.entries(raw)) {
    if (/^[=+@]/.test(String(value).trim())) errors.push(`字段“${key}”不能使用公式或危险前缀`)
  }
  if ((normalized.summary?.length ?? 0) > 4_000) errors.push('项目简介不能超过 4000 字')
  return { raw, normalized, errors: [...new Set(errors)] }
}

async function queryBatch(batchId: string, userId: string) {
  const [batches] = await pool.query<ImportBatchRow[]>(
    `SELECT * FROM ${batchesTable} WHERE id=? AND created_by=? LIMIT 1`, [batchId, userId],
  )
  const batch = batches[0]
  if (!batch) throw Object.assign(new Error('导入批次不存在或无权访问'), { status: 404, code: 'IMPORT_BATCH_NOT_FOUND' })
  const [rows] = await pool.query<ImportRow[]>(`SELECT * FROM ${rowsTable} WHERE batch_id=? ORDER BY row_number`, [batch.id])
  return {
    id: batch.id, status: batch.status, totalRows: Number(batch.total_rows), validRows: Number(batch.valid_rows),
    errorRows: Number(batch.error_rows), committedRows: Number(batch.committed_rows), reviewRows: Number(batch.review_rows),
    failedRows: Number(batch.failed_rows), createdAt: batch.created_at, updatedAt: batch.updated_at,
    completedAt: batch.completed_at, rows: rows.map(publicImportRow),
  }
}

export async function previewLeadImport(input: {
  name: string; declaredType?: string; dataBase64: string; idempotencyKey?: string
}, actor: IntakeActor) {
  const validated = await decodeAndValidateProjectFile(input)
  if (!['xls', 'xlsx', 'xlsm', 'csv'].includes(validated.extension)) {
    throw Object.assign(new Error('批量导入仅支持 XLS、XLSX、XLSM 或 CSV'), { status: 415, code: 'IMPORT_FILE_UNSUPPORTED' })
  }
  const idempotencyKey = sha256(`lead-import-v1:${actor.userId}:${input.idempotencyKey || validated.sha256}`)
  const [existing] = await pool.query<Array<RowDataPacket & { batch_id: string }>>(
    `SELECT b.id AS batch_id FROM ${filesTable} f JOIN ${batchesTable} b ON b.file_id=f.id WHERE f.idempotency_key=? LIMIT 1`,
    [idempotencyKey],
  )
  if (existing[0]) return await queryBatch(existing[0].batch_id, actor.userId)

  const workbook = XLSX.read(validated.buffer, { type: 'buffer', cellFormula: false, cellHTML: false })
  const worksheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!worksheet) throw Object.assign(new Error('工作簿中没有可读取的工作表'), { status: 400, code: 'IMPORT_SHEET_EMPTY' })
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: false, defval: '', blankrows: false })
  if (matrix.length < 2) throw Object.assign(new Error('导入文件没有数据行'), { status: 400, code: 'IMPORT_ROWS_EMPTY' })
  if (matrix.length - 1 > MAX_IMPORT_ROWS) throw Object.assign(new Error(`单次最多导入 ${MAX_IMPORT_ROWS} 行`), { status: 413, code: 'IMPORT_TOO_MANY_ROWS' })
  const headers = normalizedHeaders(matrix[0])
  if (!headers.some((header) => HEADER_ALIASES[header] === 'name')) {
    throw Object.assign(new Error('表头缺少“项目名称”列，请使用系统模板'), { status: 400, code: 'IMPORT_HEADER_INVALID' })
  }
  const parsed = matrix.slice(1).map((values) => normalizeImportRecord(headers, values))
    .filter((item) => Object.values(item.raw).some((value) => String(value).trim()))
  if (!parsed.length) throw Object.assign(new Error('导入文件没有有效数据行'), { status: 400, code: 'IMPORT_ROWS_EMPTY' })
  const fileId = randomUUID()
  const batchId = randomUUID()
  const storagePath = await saveLeadIntakeFile(actor.userId, fileId, validated.buffer)
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query(
      `INSERT INTO ${filesTable} (id,kind,idempotency_key,original_name,type_label,content_type,byte_size,sha256,storage_path,status,stage,progress,uploaded_by,uploaded_by_name,created_at,updated_at)
       VALUES (?, 'batch', ?, ?, ?, ?, ?, ?, ?, 'preview', 'validated', 100, ?, ?, NOW(3), NOW(3))`,
      [fileId, idempotencyKey, validated.name, validated.typeLabel, validated.contentType, validated.byteSize, validated.sha256, storagePath, actor.userId, actor.userName],
    )
    const validRows = parsed.filter((row) => !row.errors.length).length
    await connection.query(
      `INSERT INTO ${batchesTable} (id,file_id,status,total_rows,valid_rows,error_rows,created_by,created_at,updated_at)
       VALUES (?, ?, 'preview', ?, ?, ?, ?, NOW(3), NOW(3))`,
      [batchId, fileId, parsed.length, validRows, parsed.length - validRows, actor.userId],
    )
    for (let index = 0; index < parsed.length; index += 1) {
      const item = parsed[index]
      await connection.query(
        `INSERT INTO ${rowsTable} (id,batch_id,row_number,raw_data,normalized_data,validation_errors,status,created_at,updated_at)
         VALUES (?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?, NOW(3), NOW(3))`,
        [randomUUID(), batchId, index + 2, JSON.stringify(item.raw), JSON.stringify(item.normalized), JSON.stringify(item.errors), item.errors.length ? 'invalid' : 'valid'],
      )
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally { connection.release() }
  return await queryBatch(batchId, actor.userId)
}

export async function getLeadImportBatch(batchId: string, actor: IntakeActor) {
  return await queryBatch(batchId, actor.userId)
}

export async function commitLeadImportBatch(batchId: string, actor: IntakeActor, scheduleScoring: ScheduleScoring) {
  const batch = await queryBatch(batchId, actor.userId)
  if (batch.status === 'completed') return batch
  if (batch.errorRows) throw Object.assign(new Error('请先修复全部预检错误后再确认导入'), { status: 409, code: 'IMPORT_HAS_ERRORS' })
  await pool.query(`UPDATE ${batchesTable} SET status='committing',updated_at=NOW(3) WHERE id=? AND status='preview'`, [batchId])
  let committed = 0
  let review = 0
  let failed = 0
  for (const row of batch.rows.filter((item) => ['valid', 'failed'].includes(item.status))) {
    try {
      const result = await commitNormalizedLead({
        lead: row.normalized as NormalizedLead, sourceType: 'batch-import', sourceId: `${batchId}:${row.rowNumber}`,
        actor, evidenceQuote: Object.entries(row.raw).map(([key, value]) => `${key}：${value}`).join('\n'),
      })
      const rowStatus = result.status === 'review' ? 'review' : 'committed'
      if (rowStatus === 'review') review += 1
      else {
        committed += 1
        if (result.leadId) await scheduleScoring(result.leadId).catch(() => false)
      }
      await pool.query(
        `UPDATE ${rowsTable} SET status=?,event_id=?,lead_id=?,review_id=?,result_message=?,updated_at=NOW(3) WHERE id=?`,
        [rowStatus, result.eventId, result.leadId, result.reviewId, rowStatus === 'review' ? '已进入人工复核' : '已写入公共线索池', row.id],
      )
    } catch (error) {
      failed += 1
      await pool.query(`UPDATE ${rowsTable} SET status='failed',result_message=?,updated_at=NOW(3) WHERE id=?`, [safeError(error), row.id])
    }
  }
  await pool.query(
    `UPDATE ${batchesTable} SET status=?,committed_rows=?,review_rows=?,failed_rows=?,completed_at=IF(?='completed',NOW(3),NULL),updated_at=NOW(3) WHERE id=?`,
    [failed ? 'partial_failed' : 'completed', committed, review, failed, failed ? 'partial_failed' : 'completed', batchId],
  )
  return await queryBatch(batchId, actor.userId)
}

function candidateFromBp(name: string, text: string): NormalizedLead {
  const baseName = path.basename(name, path.extname(name)).replace(/(?:商业计划书|融资计划书|项目介绍|路演材料|BP|bp)[-_\s]*/g, '').trim()
  const labeledName = text.match(/(?:项目名称|项目名|品牌名称)\s*[：:]\s*([^\n\r]{2,60})/)?.[1]?.trim()
  const companyName = text.match(/[\u4e00-\u9fffA-Za-z0-9（）()·]{2,50}(?:股份有限公司|有限责任公司|有限公司)/)?.[0]?.trim()
  const candidates = [labeledName, baseName, companyName].filter((value): value is string => Boolean(value))
  const subject = candidates.find((value) => isSpecificLeadSubjectName(value)) ?? candidates[0] ?? baseName ?? '待确认主体'
  const industries: Array<[RegExp, string]> = [
    [/人工智能|大模型|机器学习|AIGC/i, '人工智能'], [/机器人|具身智能/i, '具身智能/机器人'],
    [/半导体|芯片|集成电路/i, '半导体/芯片'], [/生物医药|创新药|医疗器械/i, '生物医药'],
    [/新能源|储能|光伏|电池/i, '新能源'], [/新材料/i, '新材料'], [/企业服务|SaaS/i, '企业服务'],
  ]
  const industry = industries.find(([pattern]) => pattern.test(text))?.[1]
  const summary = text.replace(/\s+/g, ' ').trim().slice(0, 2_000)
  const highlights = [...text.matchAll(/(?:核心亮点|项目亮点|竞争优势)\s*[：:]\s*([^\n\r]{4,300})/g)].map((match) => match[1].trim()).slice(0, 8)
  const risks = [...text.matchAll(/(?:风险|挑战)\s*[：:]\s*([^\n\r]{4,300})/g)].map((match) => match[1].trim()).slice(0, 8)
  return { name: subject.slice(0, 128), companyName, industry, summary, highlights, risks }
}

export async function uploadLeadBp(input: {
  name: string; declaredType?: string; dataBase64: string; idempotencyKey?: string
}, actor: IntakeActor) {
  const validated = await decodeAndValidateProjectFile(input)
  if (!['pdf', 'doc', 'docx', 'ppt', 'pptx', 'txt', 'md', 'markdown'].includes(validated.extension)) {
    throw Object.assign(new Error('BP 上传仅支持 PDF、Word、PPT 或文本文件'), { status: 415, code: 'BP_FILE_UNSUPPORTED' })
  }
  const idempotencyKey = sha256(`lead-bp-v1:${actor.userId}:${input.idempotencyKey || validated.sha256}`)
  const [existing] = await pool.query<IntakeFileRow[]>(`SELECT * FROM ${filesTable} WHERE idempotency_key=? LIMIT 1`, [idempotencyKey])
  if (existing[0]) return publicFile(existing[0])
  const fileId = randomUUID()
  const storagePath = await saveLeadIntakeFile(actor.userId, fileId, validated.buffer)
  await pool.query(
    `INSERT INTO ${filesTable} (id,kind,idempotency_key,original_name,type_label,content_type,byte_size,sha256,storage_path,status,stage,progress,uploaded_by,uploaded_by_name,created_at,updated_at)
     VALUES (?, 'bp', ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 5, ?, ?, NOW(3), NOW(3))`,
    [fileId, idempotencyKey, validated.name, validated.typeLabel, validated.contentType, validated.byteSize, validated.sha256, storagePath, actor.userId, actor.userName],
  )
  void pollBpQueue()
  return await getLeadBpUpload(fileId, actor)
}

export async function getLeadBpUpload(id: string, actor: IntakeActor) {
  const [rows] = await pool.query<IntakeFileRow[]>(`SELECT * FROM ${filesTable} WHERE id=? AND kind='bp' AND uploaded_by=? LIMIT 1`, [id, actor.userId])
  if (!rows[0]) throw Object.assign(new Error('BP 上传任务不存在或无权访问'), { status: 404, code: 'BP_UPLOAD_NOT_FOUND' })
  return publicFile(rows[0])
}

export async function retryLeadBpUpload(id: string, actor: IntakeActor) {
  const [result] = await pool.query(
    `UPDATE ${filesTable} SET status='queued',stage='queued',progress=5,next_attempt_at=NOW(3),lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=NOW(3)
     WHERE id=? AND kind='bp' AND uploaded_by=? AND status IN ('failed','dead_letter')`, [id, actor.userId],
  )
  if (!(result as { affectedRows?: number }).affectedRows) throw Object.assign(new Error('当前任务不可重试'), { status: 409, code: 'BP_RETRY_NOT_ALLOWED' })
  void pollBpQueue()
  return await getLeadBpUpload(id, actor)
}

async function claimBpJob() {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<IntakeFileRow[]>(
      `SELECT * FROM ${filesTable} WHERE kind='bp' AND status IN ('queued','retrying') AND next_attempt_at<=NOW(3)
       AND (lease_expires_at IS NULL OR lease_expires_at<NOW(3)) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    )
    const row = rows[0]
    if (!row) { await connection.rollback(); return null }
    await connection.query(
      `UPDATE ${filesTable} SET status='processing',stage='extracting',progress=20,execution_attempts=execution_attempts+1,lease_owner=?,lease_expires_at=DATE_ADD(NOW(3),INTERVAL 15 MINUTE),updated_at=NOW(3) WHERE id=?`,
      [owner, row.id],
    )
    await connection.commit()
    row.execution_attempts = Number(row.execution_attempts) + 1
    return row
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}

async function processBpJob(row: IntakeFileRow) {
  try {
    const buffer = await readLeadIntakeFile(row.storage_path)
    const text = (await extractText(buffer, row.type_label, row.original_name)).trim()
    if (text.length < 20) throw Object.assign(new Error('未从 BP 中提取到足够的可读文字，请改传带文字层的 PDF、Word 或 PPT'), { retryable: false })
    await pool.query(`UPDATE ${filesTable} SET stage='structuring',progress=55,updated_at=NOW(3) WHERE id=? AND lease_owner=?`, [row.id, owner])
    const lead = candidateFromBp(row.original_name, text.slice(0, MAX_BP_TEXT))
    const result = await commitNormalizedLead({
      lead, sourceType: 'bp-upload', sourceId: row.id,
      actor: { userId: row.uploaded_by, userName: 'BP 上传用户' }, evidenceQuote: text,
    })
    if (result.leadId) await bpScheduleScoring?.(result.leadId).catch(() => false)
    const status = result.status === 'review' ? 'review' : 'ready'
    await pool.query(
      `UPDATE ${filesTable} SET status=?,stage=?,progress=100,event_id=?,lead_id=?,review_id=?,lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,completed_at=NOW(3),updated_at=NOW(3) WHERE id=? AND lease_owner=?`,
      [status, status, result.eventId, result.leadId, result.reviewId, row.id, owner],
    )
  } catch (error) {
    const attempts = Number(row.execution_attempts)
    const retryable = (error as { retryable?: boolean }).retryable !== false && attempts < BP_MAX_ATTEMPTS
    const delaySeconds = Math.min(300, 10 * (2 ** Math.max(0, attempts - 1)))
    await pool.query(
      `UPDATE ${filesTable} SET status=?,stage=?,progress=?,next_attempt_at=DATE_ADD(NOW(3),INTERVAL ? SECOND),lease_owner=NULL,lease_expires_at=NULL,last_error=?,completed_at=IF(?='dead_letter',NOW(3),NULL),updated_at=NOW(3) WHERE id=? AND lease_owner=?`,
      [retryable ? 'retrying' : 'dead_letter', retryable ? 'retry_wait' : 'dead_letter', retryable ? 20 : 100,
        delaySeconds, safeError(error), retryable ? 'retrying' : 'dead_letter', row.id, owner],
    )
  }
}

async function pollBpQueue() {
  if (bpPolling || bpStopping || !bpScheduleScoring) return
  bpPolling = true
  try {
    const job = await claimBpJob()
    if (job) await processBpJob(job)
  } finally { bpPolling = false }
}

export async function startLeadBpWorker(scheduleScoring: ScheduleScoring) {
  if (bpTimer) return
  bpScheduleScoring = scheduleScoring
  bpStopping = false
  await pool.query(
    `UPDATE ${filesTable} SET status='retrying',stage='retry_wait',lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NOW(3),updated_at=NOW(3)
     WHERE kind='bp' AND status='processing' AND lease_expires_at<NOW(3)`,
  )
  bpTimer = setInterval(() => void pollBpQueue(), 1_000)
  bpTimer.unref()
  await pollBpQueue()
  console.log(`[lead-bp-worker] ready owner=${owner}`)
}

export async function stopLeadBpWorker() {
  bpStopping = true
  if (bpTimer) clearInterval(bpTimer)
  bpTimer = undefined
  for (let index = 0; bpPolling && index < 200; index += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  bpScheduleScoring = undefined
}
