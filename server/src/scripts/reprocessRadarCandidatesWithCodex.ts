import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

const SCHEMA_VERSION = 'radar-codex-extraction-v1'
const PROMPT_VERSION = 'radar-codex-evidence-extraction-v1'
const FIELD_KEYS = [
  'projectName', 'companyName', 'industry', 'region', 'coreHighlights', 'riskNotes',
  'teamComposition', 'lab', 'contact', 'projectRound', 'financingAmount',
  'latestValuation', 'institutions', 'affiliatedInstitutions',
  'translatedTitle', 'translatedSummary',
] as const
type FieldKey = typeof FIELD_KEYS[number]
type Decision = 'accept' | 'reject' | 'review'
type SubjectType = 'company' | 'project' | 'team' | 'lab' | 'paper' | null

type CandidateRow = RowDataPacket & {
  source_key_hash: string
  source_key: string
  content_hash: string
  source: string
  source_group: string | null
  worth_attention: number
  payload: unknown
}

type Candidate = {
  row: CandidateRow
  payload: Record<string, any>
  sourceText: string
  sourceHash: string
  modelInput: {
    candidateId: string
    source: string
    sourceGroup: string
    sourceName: string
    sourceText: string
  }
}

type ExtractedField = { key: FieldKey; value: string; quote: string }
type ModelRecord = {
  candidateId: string
  decision: Decision
  subjectType: SubjectType
  subjectName: string
  legalName: string
  confidence: number
  reason: string
  evidenceQuote: string
  fields: ExtractedField[]
}

const apply = process.argv.includes('--apply')
const attentionOnly = process.argv.includes('--attention-only')
const force = process.argv.includes('--force')
const limit = Math.max(1, Math.min(Number(
  process.argv.find((item) => item.startsWith('--limit='))?.slice(8),
) || 10_000, 20_000))
const batchSize = Math.max(1, Math.min(Number(
  process.argv.find((item) => item.startsWith('--batch-size='))?.slice(13),
) || 10, 20))
const concurrency = Math.max(1, Math.min(Number(
  process.argv.find((item) => item.startsWith('--concurrency='))?.slice(14),
) || 4, 6))
const retries = Math.max(0, Math.min(Number(
  process.argv.find((item) => item.startsWith('--retries='))?.slice(10),
) || 2, 3))
const shardCount = Math.max(1, Math.min(Number(
  process.argv.find((item) => item.startsWith('--shard-count='))?.slice(14),
) || 1, 32))
const shardIndex = Math.max(0, Math.min(Number(
  process.argv.find((item) => item.startsWith('--shard-index='))?.slice(14),
) || 0, shardCount - 1))
const model = process.argv.find((item) => item.startsWith('--model='))?.slice(8) || 'gpt-5.6-sol'
const runId = process.argv.find((item) => item.startsWith('--run-id='))?.slice(9)
  || `radar-codex-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`

const candidatesTable = quoteMysqlIdentifier(mysqlTableName('radar_candidates'))
const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
const runDir = join(process.cwd(), '.runtime', 'radar-codex-runs', runId, `shard-${shardIndex}`)

function record(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)) } catch { return {} }
  }
  return {}
}

function compact(value: unknown, max = 8_000) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
    : ''
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function subjectIdentity(value: unknown) {
  return compact(value, 256).replace(/[\p{P}\p{S}\s]+/gu, '').toLocaleLowerCase()
}

function sourceText(payload: Record<string, any>) {
  const authors = Array.isArray(payload.authors) ? payload.authors.map((item: unknown) => compact(item, 120)).filter(Boolean).join('、') : ''
  return [
    ['标题', compact(payload.title, 1_000)],
    ['摘要', compact(payload.summary || payload.description, 3_000)],
    ['正文', compact(payload.article_text || payload.articleText, 8_000)],
    ['作者', authors],
    ['来源', compact(payload.source_name || payload.account_name || payload.wx_name || payload.source, 300)],
  ].filter(([, value]) => value).map(([label, value]) => `${label}：${value}`).join('\n')
}

function modelSchema() {
  return {
    type: 'object', additionalProperties: false, required: ['records'],
    properties: {
      records: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['candidateId', 'decision', 'subjectType', 'subjectName', 'legalName', 'confidence', 'reason', 'evidenceQuote', 'fields'],
          properties: {
            candidateId: { type: 'string' },
            decision: { type: 'string', enum: ['accept', 'reject', 'review'] },
            subjectType: { anyOf: [{ type: 'null' }, { type: 'string', enum: ['company', 'project', 'team', 'lab', 'paper'] }] },
            subjectName: { type: 'string' },
            legalName: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' },
            evidenceQuote: { type: 'string' },
            fields: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false, required: ['key', 'value', 'quote'],
                properties: {
                  key: { type: 'string', enum: [...FIELD_KEYS] },
                  value: { type: 'string' },
                  quote: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }
}

function batchPrompt(batch: Candidate[]) {
  return [
    '你是中国股权投资雷达的数据抽取员。只依据每条记录的 sourceText，不联网，不使用外部知识，不采信旧的结构化字段，不猜测。',
    '判断原文是否包含可明确识别且对投资判断有实际价值的公司、商业化项目、创业团队、实验室或前沿论文。会议、政策、招聘、榜单、新闻合集和无法识别唯一主体的内容应 reject 或 review。',
    'accept 时 subjectName 必须是原文出现的最短完整专名；legalName 仅在原文明确出现工商全称时填写。论文 subjectType=paper，subjectName 使用完整原标题。',
    'fields 只返回有连续原文证据的字段；每个 value 必须绑定 sourceText 中逐字连续出现的 quote。行业可做保守归类，译文可做忠实翻译，但 quote 仍须引用对应原文。',
    '不得把来源账号、投资方、作者荣誉或行业数字写成项目公司；不得把行业规模写成融资金额；缺失字段直接省略。',
    'coreHighlights、riskNotes、teamComposition、translatedSummary 要客观简洁；禁止营销措辞和无依据评价。reason 说明准入判断。严格按 Schema 返回 JSON。',
    JSON.stringify({ records: batch.map((item) => item.modelInput) }),
  ].join('\n')
}

function validateBatchOutput(batch: Candidate[], raw: unknown) {
  const payload = record(raw)
  if (!Array.isArray(payload.records)) throw new Error('model output missing records')
  const expected = new Map(batch.map((item) => [item.row.source_key_hash, item]))
  const output = new Map<string, ModelRecord>()
  for (const rawItem of payload.records) {
    const item = record(rawItem)
    let candidateId = compact(item.candidateId, 64)
    let candidate = expected.get(candidateId)
    if (!candidate || output.has(candidateId)) {
      const evidence = compact(item.evidenceQuote, 1_200)
      const evidenceMatches = evidence ? batch.filter((entry) => (
        !output.has(entry.row.source_key_hash) && compact(entry.sourceText, 20_000).includes(evidence)
      )) : []
      if (evidenceMatches.length === 1) {
        candidate = evidenceMatches[0]
        candidateId = candidate.row.source_key_hash
      }
    }
    if (!candidate || output.has(candidateId)) throw new Error(`unexpected or duplicate candidateId ${candidateId}`)
    let decision = ['accept', 'reject', 'review'].includes(item.decision) ? item.decision as Decision : 'review'
    let subjectType = ['company', 'project', 'team', 'lab', 'paper'].includes(item.subjectType) ? item.subjectType as Exclude<SubjectType, null> : null
    let subjectName = compact(item.subjectName, 180)
    let legalName = compact(item.legalName, 180)
    const evidenceQuote = compact(item.evidenceQuote, 1_200)
    const normalizedSource = compact(candidate.sourceText, 20_000)
    const evidenceValid = !evidenceQuote || normalizedSource.includes(evidenceQuote)
    const subjectValid = !subjectName || subjectIdentity(normalizedSource).includes(subjectIdentity(subjectName))
    if (decision === 'accept' && (!subjectType || !subjectName || !evidenceQuote || !evidenceValid || !subjectValid)) {
      decision = 'review'
      subjectType = null
      subjectName = ''
      legalName = ''
    }
    if (legalName && !subjectIdentity(normalizedSource).includes(subjectIdentity(legalName))) {
      legalName = ''
    }
    const fields: ExtractedField[] = []
    const seen = new Set<FieldKey>()
    for (const rawField of Array.isArray(item.fields) ? item.fields : []) {
      const field = record(rawField)
      if (!FIELD_KEYS.includes(field.key) || seen.has(field.key)) continue
      const value = compact(field.value, field.key === 'translatedSummary' ? 1_500 : 800)
      const quote = compact(field.quote, 1_200)
      if (!value || !quote || !normalizedSource.includes(quote)) continue
      seen.add(field.key)
      fields.push({ key: field.key, value, quote })
    }
    output.set(candidateId, {
      candidateId,
      decision,
      subjectType,
      subjectName,
      legalName,
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
      reason: compact(
        decision === 'review' && item.decision === 'accept'
          ? `主机证据校验未通过，已降级人工复核。${compact(item.reason, 800)}`
          : item.reason,
        1_000,
      ),
      evidenceQuote: evidenceValid ? evidenceQuote : '',
      fields,
    })
  }
  if (output.size !== expected.size) throw new Error(`model returned ${output.size}/${expected.size} records`)
  return output
}

async function runCodexBatch(batch: Candidate[], batchIndex: number, schemaPath: string) {
  const batchDir = join(runDir, `batch-${String(batchIndex).padStart(5, '0')}`)
  await mkdir(batchDir, { recursive: true })
  const outputPath = join(batchDir, 'output.json')
  await writeFile(join(batchDir, 'input.json'), JSON.stringify({ records: batch.map((item) => item.modelInput) }, null, 2))
  let lastError = ''
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('codex', [
        'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
        '-m', model, '-s', 'read-only', '-C', batchDir, '--output-schema', schemaPath,
        '--output-last-message', outputPath, '-',
      ], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-20_000) })
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000) })
      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
      }, 300_000)
      child.on('error', reject)
      child.on('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }) })
      child.stdin.end(batchPrompt(batch))
    })
    if (result.code === 0) {
      try {
        const validated = validateBatchOutput(batch, JSON.parse(await readFile(outputPath, 'utf8')))
        console.log(JSON.stringify({ event: 'radar_codex_batch_completed', shardIndex, batchIndex, attempt, records: batch.length }))
        return validated
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    } else {
      lastError = compact(result.stderr || result.stdout, 2_000) || `codex exited ${result.code}`
    }
    console.error(JSON.stringify({ event: 'radar_codex_batch_retry', shardIndex, batchIndex, attempt, error: lastError }))
    if (attempt <= retries) await new Promise((resolve) => setTimeout(resolve, attempt * 5_000))
  }
  throw new Error(`batch ${batchIndex} failed after ${retries + 1} attempts: ${lastError}`)
}

function extractionPatch(candidate: Candidate, result: ModelRecord) {
  const values = Object.fromEntries(result.fields.map((field) => [field.key, field.value])) as Partial<Record<FieldKey, string>>
  const existingProfile = record(candidate.payload.project_profile)
  const nextProfile = {
    ...existingProfile,
    project_name: values.projectName || (result.decision === 'accept' ? result.subjectName : ''),
    company_name: values.companyName || result.legalName || '',
    industry: values.industry || '',
    region: values.region || '',
    core_highlights: values.coreHighlights || '',
    risk_notes: values.riskNotes || '',
    team_composition: values.teamComposition || '',
    lab: values.lab || '',
    contact: values.contact || '',
    project_round: values.projectRound || '',
    financing_amount: values.financingAmount || '',
    latest_valuation: values.latestValuation || '',
    institutions: values.institutions || '',
    affiliated_institutions: values.affiliatedInstitutions || '',
  }
  return {
    ...candidate.payload,
    project_profile: nextProfile,
    codex_extraction: {
      schemaVersion: SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
      model,
      runId,
      sourceContentHash: candidate.sourceHash,
      processedAt: new Date().toISOString(),
      decision: result.decision,
      subjectType: result.subjectType,
      subjectName: result.subjectName,
      legalName: result.legalName,
      confidence: result.confidence,
      reason: result.reason,
      evidenceQuote: result.evidenceQuote,
      fields: result.fields,
      translatedTitle: values.translatedTitle || '',
      translatedSummary: values.translatedSummary || '',
    },
  }
}

await mkdir(runDir, { recursive: true })
const schemaPath = join(runDir, 'output-schema.json')
await writeFile(schemaPath, JSON.stringify(modelSchema(), null, 2))

const where = [
  `MOD(CONV(SUBSTR(source_key_hash,1,8),16,10),?)=?`,
]
if (!force) {
  where.push(`(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.codex_extraction.schemaVersion'))<>?`
    + ` OR JSON_UNQUOTE(JSON_EXTRACT(payload,'$.codex_extraction.schemaVersion')) IS NULL)`)
}
if (attentionOnly) where.push('worth_attention=1')
const [rows] = await pool.query<CandidateRow[]>(
  `SELECT source_key_hash,source_key,content_hash,source,source_group,worth_attention,payload
   FROM ${candidatesTable} WHERE ${where.join(' AND ')} ORDER BY cursor_timestamp DESC LIMIT ?`,
  [shardCount, shardIndex, ...(!force ? [SCHEMA_VERSION] : []), limit],
)
const candidates = rows.flatMap((row) => {
  const payload = record(row.payload)
  const text = sourceText(payload)
  if (!text) return []
  const currentHash = sha256(text)
  const prior = record(payload.codex_extraction)
  if (!force && prior.schemaVersion === SCHEMA_VERSION && prior.sourceContentHash === currentHash) return []
  return [{
    row,
    payload,
    sourceText: text,
    sourceHash: currentHash,
    modelInput: {
      candidateId: row.source_key_hash,
      source: row.source,
      sourceGroup: row.source_group || '',
      sourceName: compact(payload.source_name || payload.account_name || payload.wx_name, 300),
      sourceText: text,
    },
  } satisfies Candidate]
})

await writeFile(join(runDir, 'manifest.json'), JSON.stringify({
  runId, model, apply, attentionOnly, force, limit, batchSize, concurrency, retries,
  shardCount, shardIndex, databaseRows: rows.length, selected: candidates.length,
  candidateIds: candidates.map((item) => item.row.source_key_hash),
}, null, 2))

const batches: Candidate[][] = []
for (let offset = 0; offset < candidates.length; offset += batchSize) batches.push(candidates.slice(offset, offset + batchSize))
let cursor = 0
let failed: Error | null = null
const results = new Map<string, ModelRecord>()
let applied = 0
let stale = 0

async function applyBatch(batch: Candidate[], batchResults: Map<string, ModelRecord>) {
  if (!apply || !batchResults.size) return
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    for (const candidate of batch) {
      const result = batchResults.get(candidate.row.source_key_hash)
      if (!result) continue
      const [currentRows] = await connection.query<Array<RowDataPacket & { payload: unknown }>>(
        `SELECT payload FROM ${candidatesTable} WHERE source_key_hash=? FOR UPDATE`,
        [candidate.row.source_key_hash],
      )
      const currentPayload = record(currentRows[0]?.payload)
      const currentCandidate = { ...candidate, payload: currentPayload, sourceText: sourceText(currentPayload) }
      currentCandidate.sourceHash = sha256(currentCandidate.sourceText)
      if (!currentCandidate.sourceText || currentCandidate.sourceHash !== candidate.sourceHash) { stale += 1; continue }
      await connection.query(
        `UPDATE ${candidatesTable} SET payload=CAST(? AS JSON),updated_at=NOW(3) WHERE source_key_hash=?`,
        [JSON.stringify(extractionPatch(currentCandidate, result)), candidate.row.source_key_hash],
      )
      applied += 1
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

async function worker() {
  while (!failed && cursor < batches.length) {
    const batchIndex = cursor++
    try {
      const batchResults = await runCodexBatch(batches[batchIndex], batchIndex, schemaPath)
      for (const [candidateId, result] of batchResults) results.set(candidateId, result)
      await applyBatch(batches[batchIndex], batchResults)
    } catch (error) {
      failed = error instanceof Error ? error : new Error(String(error))
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, batches.length)) }, () => worker()))
if (failed) { await pool.end(); throw failed }

if (apply && results.size) {
  await pool.query(
    `INSERT INTO ${auditTable}
      (id,user_id,user_name,module,action,target,result,request_id,created_at)
     VALUES (?,NULL,'Codex','Radar候选','Codex证据化重新抽取',?,'success',?,NOW(3))`,
    [randomUUID(), JSON.stringify({ runId, model, shardCount, shardIndex, selected: candidates.length, applied, stale }), runId],
  )
}

const decisionCounts = Object.fromEntries(['accept', 'review', 'reject'].map((decision) => [
  decision, [...results.values()].filter((item) => item.decision === decision).length,
]))
console.log(JSON.stringify({
  ok: true, mode: apply ? 'apply' : 'preview', runId, runDir, model, shardCount, shardIndex,
  selected: candidates.length, processed: results.size, applied, stale, batches: batches.length,
  concurrency, decisionCounts,
  samples: candidates.slice(0, 5).map((candidate) => results.get(candidate.row.source_key_hash)),
}, null, 2))
await pool.end()
