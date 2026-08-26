import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

const PROFILE_FIELDS = [
  'projectIntroduction',
  'product',
  'productDescription',
  'applicationScenario',
  'applicationDescription',
  'mainBusiness',
  'mainBusinessDescription',
] as const
type ProfileField = typeof PROFILE_FIELDS[number]

type LeadRow = RowDataPacket & {
  reserve_id: number
  src_id: string | null
  lead_id: string
  name: string
  company_name: string | null
  business_region: string | null
  business_region_source: string | null
  business_region_confidence: string | null
  scoring: unknown
  sources: unknown
  detail_json: unknown
}

type ModelField = {
  value: string
  quote: string
  sourceKey: 'intro' | 'oneWord'
}

type ModelRecord = {
  leadId: string
} & Record<ProfileField, ModelField | null>

type Candidate = {
  row: LeadRow
  scoring: Record<string, any>
  sources: Array<Record<string, any>>
  detail: Record<string, any>
  sourceUrl: string
  requestedFields: ProfileField[]
  modelInput: {
    leadId: string
    brandName: string
    companyName: string
    oneWord: string
    intro: string
    tags: string[]
    requestedFields: ProfileField[]
  }
}

const apply = process.argv.includes('--apply')
const limit = Math.max(1, Math.min(Number(
  process.argv.find((item) => item.startsWith('--limit='))?.slice('--limit='.length),
) || 2_000, 2_000))
const batchSize = Math.max(1, Math.min(Number(
  process.argv.find((item) => item.startsWith('--batch-size='))?.slice('--batch-size='.length),
) || 8, 50))
const concurrency = Math.max(1, Math.min(Number(
  process.argv.find((item) => item.startsWith('--concurrency='))?.slice('--concurrency='.length),
) || 4, 6))
const retries = Math.max(0, Math.min(Number(
  process.argv.find((item) => item.startsWith('--retries='))?.slice('--retries='.length),
) || 2, 3))
const model = process.argv.find((item) => item.startsWith('--model='))?.slice('--model='.length) || 'gpt-5.6-sol'
const runId = process.argv.find((item) => item.startsWith('--run-id='))?.slice('--run-id='.length)
  || `lead-profile-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const reserveTable = quoteMysqlIdentifier(mysqlTableName('lead_reserve'))
const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
const runDir = join(process.cwd(), '.runtime', 'lead-codex-runs', runId)

function record(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, any> } catch { return {} }
  }
  return {}
}

function array(value: unknown): Array<Record<string, any>> {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object') as Array<Record<string, any>>
  if (typeof value === 'string') {
    try { return array(JSON.parse(value)) } catch { return [] }
  }
  return []
}

function compact(value: unknown, max = 4_000) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max)
    : ''
}

function meaningful(value: unknown) {
  const text = compact(value, 4_000)
  return text && !/^(?:待核验|待核实|待补充|未披露|未公开|暂无|无|null|undefined|-)$/.test(text)
    ? text
    : ''
}

function valueIdentity(value: unknown) {
  return compact(value, 1_000).replace(/[\s（）()，,。；;:：\-—_]/g, '').toLocaleLowerCase()
}

function stableHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function uniqueText(values: unknown[]) {
  return [...new Set(values.map((item) => compact(item, 100)).filter(Boolean))]
}

function tagNames(value: unknown) {
  if (!Array.isArray(value)) return []
  return uniqueText(value.flatMap((item) => {
    if (typeof item === 'string') return [item]
    const data = record(item)
    return [data.name, data.label, data.title, data.tagName, data.industryName]
  }))
}

function normalizeSourceUrl(srcId: unknown, detail: Record<string, any>) {
  const identity = compact(srcId || detail.companyId, 128)
  return /^\d+$/.test(identity) ? `https://pitchhub.36kr.com/project/${identity}` : ''
}

function normalizeWebsite(value: unknown) {
  let raw = compact(value, 1_000)
  if (!raw || /待核验|待补充|未披露/.test(raw)) return ''
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    if (!url.hostname.includes('.') || /(?:^|\.)(?:weixin\.qq\.com|mp\.weixin\.qq\.com)$/.test(url.hostname)) return ''
    return url.toString()
  } catch { return '' }
}

function legalCompanyName(value: unknown) {
  const name = compact(value, 256)
  return /(?:有限责任公司|股份有限公司|集团有限公司|有限公司|公司)$/.test(name) ? name : ''
}

function sourceProfile(value: string, quote: string, sourceUrl: string, sourceTitle: string) {
  return {
    value,
    quote,
    sourceUrl,
    sourceTitle,
    evidenceStatus: 'derived_source_labeled' as const,
    note: 'Codex仅根据36氪原始项目介绍作客观归纳，待交叉核验',
  }
}

function mergeBy<T extends Record<string, any>>(incoming: T[], existing: T[], key: (item: T) => string) {
  const seen = new Set<string>()
  return [...incoming, ...existing].filter((item) => {
    const identity = key(item)
    if (!identity || seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

function modelSchema() {
  const fieldSchema = {
    anyOf: [
      { type: 'null' },
      {
        type: 'object', additionalProperties: false,
        required: ['value', 'quote', 'sourceKey'],
        properties: {
          value: { type: 'string' },
          quote: { type: 'string' },
          sourceKey: { type: 'string', enum: ['intro', 'oneWord'] },
        },
      },
    ],
  }
  return {
    type: 'object', additionalProperties: false, required: ['records'],
    properties: {
      records: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['leadId', ...PROFILE_FIELDS],
          properties: {
            leadId: { type: 'string' },
            ...Object.fromEntries(PROFILE_FIELDS.map((field) => [field, fieldSchema])),
          },
        },
      },
    },
  }
}

function batchPrompt(batch: Candidate[]) {
  return [
    '你是中国股权投资线索的数据整理员。仅依据输入中的36氪原始 oneWord、intro 和 tags 做客观归纳，不联网，不使用外部知识，不补写输入未披露的客户、收入、融资、性能、市场规模或经营结论。',
    '为每条记录返回全部指定键；非 requestedFields 必须为 null。requestedFields 若证据不足也必须为 null，不能为了覆盖率猜测。',
    '字段要求：projectIntroduction 35-120字，说明项目是什么；product 5-80字，列出明确产品或服务；productDescription 20-180字；applicationScenario 5-80字；applicationDescription 20-180字，说明来源明确提出的客户问题；mainBusiness 5-80字；mainBusinessDescription 20-180字。',
    '去除“领先、首创、爆发式、赋能、愿景”等宣传措辞。保留必要的品牌和产品专名。每个非空字段必须绑定 sourceKey，并给出该 sourceKey 原文中的一段连续原句 quote；quote 不得改写。value 是对 quote 与该来源文本的保守归纳。',
    '严格按输出 schema 返回单一 JSON，不要解释。',
    JSON.stringify({ records: batch.map((item) => item.modelInput) }),
  ].join('\n')
}

function validateBatchOutput(batch: Candidate[], raw: unknown) {
  const payload = record(raw)
  if (!Array.isArray(payload.records)) throw new Error('model output missing records')
  const expected = new Map(batch.map((item) => [item.row.lead_id, item]))
  const output = new Map<string, Partial<Record<ProfileField, ModelField>>>()
  for (const item of payload.records) {
    const modelRecord = record(item) as ModelRecord
    const candidate = expected.get(compact(modelRecord.leadId, 64))
    if (!candidate || output.has(candidate.row.lead_id)) throw new Error(`unexpected or duplicate leadId ${modelRecord.leadId}`)
    const values: Partial<Record<ProfileField, ModelField>> = {}
    for (const field of PROFILE_FIELDS) {
      if (!candidate.requestedFields.includes(field)) continue
      const result = record(modelRecord[field])
      if (!Object.keys(result).length) continue
      const value = compact(result.value, 220)
      const quote = compact(result.quote, 500)
      const sourceKey = result.sourceKey === 'oneWord' ? 'oneWord' : result.sourceKey === 'intro' ? 'intro' : ''
      const sourceText = sourceKey ? compact(candidate.modelInput[sourceKey], 4_000) : ''
      if (!value || !quote || !sourceText || !sourceText.includes(quote)) continue
      if (/^(?:待核验|待补充|未披露|暂无|不详)$/.test(value)) continue
      values[field] = { value, quote, sourceKey: sourceKey as 'intro' | 'oneWord' }
    }
    output.set(candidate.row.lead_id, values)
  }
  if (output.size !== expected.size) throw new Error(`model returned ${output.size}/${expected.size} records`)
  return output
}

async function runCodexBatch(batch: Candidate[], batchIndex: number, schemaPath: string) {
  const batchDir = join(runDir, `batch-${String(batchIndex).padStart(3, '0')}`)
  await mkdir(batchDir, { recursive: true })
  const inputPath = join(batchDir, 'input.json')
  const outputPath = join(batchDir, 'output.json')
  await writeFile(inputPath, JSON.stringify({ records: batch.map((item) => item.modelInput) }, null, 2))
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
      }, 240_000)
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timeout)
        resolve({ code, stdout, stderr })
      })
      child.stdin.end(batchPrompt(batch))
    })
    if (result.code === 0) {
      try {
        const parsed = JSON.parse(await readFile(outputPath, 'utf8')) as unknown
        const validated = validateBatchOutput(batch, parsed)
        console.log(JSON.stringify({ event: 'codex_profile_batch_completed', batchIndex, attempt, records: batch.length }))
        return validated
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    } else {
      lastError = compact(result.stderr || result.stdout, 2_000) || `codex exited ${result.code}`
    }
    console.error(JSON.stringify({ event: 'codex_profile_batch_retry', batchIndex, attempt, error: lastError }))
  }
  throw new Error(`batch ${batchIndex} failed after ${retries + 1} attempts: ${lastError}`)
}

function directTeam(detail: Record<string, any>, sourceUrl: string) {
  return array(detail.teamList).map((member) => {
    const name = compact(member.name, 80)
    const title = compact(member.profile, 100) || '职务待核验'
    const experience = compact(member.experience, 800)
    if (!name) return null
    return {
      name,
      title,
      background: experience || '36氪项目页列为团队成员，未披露更多履历。',
      sourceUrl,
      evidenceStatus: 'source_labeled' as const,
    }
  }).filter(Boolean) as Array<Record<string, any>>
}

function buildPatch(candidate: Candidate, modelValues: Partial<Record<ProfileField, ModelField>>) {
  const { row, scoring, detail, sourceUrl } = candidate
  const sourceTitle = `${compact(detail.name || row.name, 128)} | 项目信息-36氪`
  const existingProfile = record(scoring.sourceLabeledProfile)
  const sourceLabeledProfile: Record<string, any> = { ...existingProfile }
  for (const field of PROFILE_FIELDS) {
    if (sourceLabeledProfile[field] || !modelValues[field]) continue
    const item = modelValues[field]!
    sourceLabeledProfile[field] = sourceProfile(item.value, item.quote, sourceUrl, sourceTitle)
  }
  const incomingTeam = directTeam(detail, sourceUrl)
  const structuredTeam = mergeBy(incomingTeam, array(scoring.structuredTeam), (item) => (
    `${compact(item.name, 80)}|${compact(item.title, 100)}`
  ))
  if (incomingTeam.length && !sourceLabeledProfile.teamIntroduction) {
    const names = incomingTeam.slice(0, 4).map((item) => `${item.name}${item.title ? `（${item.title}）` : ''}`).join('、')
    sourceLabeledProfile.teamIntroduction = sourceProfile(
      `36氪项目页列出${names}${incomingTeam.length > 4 ? `等${incomingTeam.length}名` : ''}团队成员；职务和履历仍待交叉核验。`,
      compact(array(detail.teamList)[0]?.experience || array(detail.teamList)[0]?.profile, 500),
      sourceUrl,
      sourceTitle,
    )
  }

  const business = record(detail.business)
  const registry = { ...record(scoring.registry) }
  const registryEvidence = array(scoring.registryEvidence)
  const incomingEvidence: Array<Record<string, any>> = []
  const registryConflicts = array(record(scoring.codexSourceLabeledEnrichment).registryConflicts)
  const registryInputs: Array<[string, string, string]> = [
    ['companyName', legalCompanyName(business.name || detail.companyName), compact(business.name || detail.companyName, 256)],
    ['foundedAt', compact(business.estiblishTime || detail.setupDate, 64), compact(business.estiblishTime || detail.setupDate, 64)],
    ['legalRepresentative', compact(business.legalPersonName, 100), compact(business.legalPersonName, 100)],
    ['registeredAddress', compact(business.regLocation, 500), compact(business.regLocation, 500)],
  ]
  for (const [field, value, quote] of registryInputs) {
    if (!value) continue
    const currentValue = meaningful(registry[field])
    const mayReplaceAlias = field === 'companyName' && !legalCompanyName(currentValue) && legalCompanyName(value)
    if (!currentValue || mayReplaceAlias) registry[field] = value
    if (field === 'registeredAddress' && !meaningful(registry.regLocation)) registry.regLocation = value
    if (valueIdentity(registry[field]) === valueIdentity(value)) {
      incomingEvidence.push({
        field, value, quote, sourceUrl, evidenceStatus: 'source_labeled',
        note: '36氪项目页原文标注，待官方工商来源交叉核验',
      })
    } else {
      registryConflicts.push({
        field,
        storedValue: registry[field],
        sourceValue: value,
        sourceUrl,
        status: 'open',
      })
    }
  }
  const nextRegistryEvidence = mergeBy(incomingEvidence, registryEvidence, (item) => (
    `${compact(item.field, 80)}|${compact(item.sourceUrl, 1_000)}|${compact(item.value, 500)}`
  ))
  const website = normalizeWebsite(detail.corpWebUrl)
  const officialSite = normalizeWebsite(scoring.officialSite) || website || meaningful(scoring.officialSite)
  const sources = mergeBy([{
    id: `pitchhub-${compact(row.src_id || detail.companyId, 128)}`,
    title: compact(detail.name || row.name, 128),
    url: sourceUrl,
    publisher: '36氪项目库',
    category: '36氪',
    reliability: '中',
    excerpt: compact(detail.oneWord || detail.intro, 500),
  }], candidate.sources, (item) => compact(item.url, 1_000))
  const nextScoring = {
    ...scoring,
    ...(officialSite ? { officialSite } : {}),
    registry,
    registryEvidence: nextRegistryEvidence,
    sourceLabeledProfile,
    structuredTeam,
    codexSourceLabeledEnrichment: {
      method: 'codex-cli-evidence-bound-profile-v1',
      model,
      runId,
      completedAt: new Date().toISOString(),
      completedFields: Object.keys(sourceLabeledProfile),
      sourceUrl,
      registryConflicts: mergeBy(registryConflicts, [], (item) => (
        `${compact(item.field, 80)}|${valueIdentity(item.storedValue)}|${valueIdentity(item.sourceValue)}`
      )),
    },
  }
  const sourceCompanyName = legalCompanyName(business.name || detail.companyName)
  const companyName = legalCompanyName(row.company_name) || sourceCompanyName || row.company_name
  const region = meaningful(row.business_region) || compact(detail.provinceName || detail.cityName, 32)
  return {
    scoring: nextScoring,
    sources,
    companyName,
    region,
    regionSource: meaningful(row.business_region) ? row.business_region_source : region ? '36氪项目页地区字段' : row.business_region_source,
    regionConfidence: meaningful(row.business_region) ? row.business_region_confidence : region ? '中' : row.business_region_confidence,
  }
}

await mkdir(runDir, { recursive: true })
const schemaPath = join(runDir, 'output-schema.json')
await writeFile(schemaPath, JSON.stringify(modelSchema(), null, 2))
const [rows] = await pool.query<LeadRow[]>(
  `SELECT r.id reserve_id,r.src_id,r.detail_json,l.id lead_id,l.name,l.company_name,
          l.business_region,l.business_region_source,l.business_region_confidence,l.scoring,l.sources
   FROM ${reserveTable} r
   JOIN ${leadsTable} l ON l.id=r.imported_lead_id
   WHERE r.imported=1 AND r.imported_lead_id IS NOT NULL AND r.detail_json IS NOT NULL
     AND l.pool_status IN ('成功','公共池')
   ORDER BY r.id`,
)

const candidates: Candidate[] = []
for (const row of rows) {
  const scoring = record(row.scoring)
  const detail = record(row.detail_json)
  const sourceUrl = normalizeSourceUrl(row.src_id, detail)
  if (!sourceUrl) continue
  const existingProfile = record(scoring.sourceLabeledProfile)
  const requestedFields = PROFILE_FIELDS.filter((field) => !record(existingProfile[field]).value)
  const intro = compact(detail.intro, 4_000)
  const oneWord = compact(detail.oneWord, 500)
  const rawTeam = array(detail.teamList)
  const displayableTeam = array(scoring.structuredTeam).some((item) => (
    item.evidenceStatus === 'source_labeled' && normalizeWebsite(item.sourceUrl)
  ))
  const business = record(detail.business)
  const registry = record(scoring.registry)
  const directGap = Boolean(
    (!normalizeWebsite(scoring.officialSite) && normalizeWebsite(detail.corpWebUrl))
    || (rawTeam.length && !displayableTeam)
    || (!meaningful(registry.companyName) && legalCompanyName(business.name || detail.companyName))
    || (!meaningful(registry.foundedAt) && meaningful(business.estiblishTime || detail.setupDate))
    || (!meaningful(registry.legalRepresentative) && meaningful(business.legalPersonName))
    || (!meaningful(registry.registeredAddress) && meaningful(business.regLocation))
  )
  if ((!intro && !oneWord) || (!requestedFields.length && !directGap)) continue
  candidates.push({
    row,
    scoring,
    sources: array(row.sources),
    detail,
    sourceUrl,
    requestedFields,
    modelInput: {
      leadId: row.lead_id,
      brandName: compact(detail.name || row.name, 128),
      companyName: compact(business.name || detail.companyName || row.company_name, 256),
      oneWord,
      intro,
      tags: uniqueText([
        ...tagNames(detail.tagList), ...tagNames(detail.labelList), ...tagNames(detail.industryList),
      ]).slice(0, 20),
      requestedFields,
    },
  })
  if (candidates.length >= limit) break
}

await writeFile(join(runDir, 'manifest.json'), JSON.stringify({
  runId, model, apply, batchSize, concurrency, retries,
  databaseRows: rows.length,
  selected: candidates.length,
  leadIds: candidates.map((item) => item.row.lead_id),
}, null, 2))

const modelCandidates = candidates.filter((item) => item.requestedFields.length)
const batches: Candidate[][] = []
for (let offset = 0; offset < modelCandidates.length; offset += batchSize) {
  batches.push(modelCandidates.slice(offset, offset + batchSize))
}
const modelResults = new Map<string, Partial<Record<ProfileField, ModelField>>>()
let cursor = 0
let failed: Error | null = null
async function worker() {
  while (!failed && cursor < batches.length) {
    const batchIndex = cursor++
    try {
      const result = await runCodexBatch(batches[batchIndex], batchIndex, schemaPath)
      for (const [leadId, fields] of result) modelResults.set(leadId, fields)
    } catch (error) {
      failed = error instanceof Error ? error : new Error(String(error))
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, batches.length)) }, () => worker()))
if (failed) {
  await pool.end()
  throw failed
}

const patches = candidates.map((candidate) => ({
  candidate,
  patch: buildPatch(candidate, modelResults.get(candidate.row.lead_id) || {}),
}))
let before = patches.map(({ candidate }) => ({
  id: candidate.row.lead_id,
  companyName: candidate.row.company_name,
  businessRegion: candidate.row.business_region,
  businessRegionSource: candidate.row.business_region_source,
  businessRegionConfidence: candidate.row.business_region_confidence,
  scoring: candidate.row.scoring,
  sources: candidate.row.sources,
}))
await writeFile(join(runDir, 'before.json'), JSON.stringify(before))
await writeFile(join(runDir, 'validated-results.json'), JSON.stringify(
  [...modelResults].map(([leadId, fields]) => ({ leadId, fields })), null, 2,
))

const summary = {
  mode: apply ? 'apply' : 'preview',
  runId,
  runDir,
  model,
  scanned: rows.length,
  selected: candidates.length,
  modelProcessed: modelResults.size,
  batches: batches.length,
  concurrency,
  profilesWithProjectIntroduction: patches.filter((item) => item.patch.scoring.sourceLabeledProfile?.projectIntroduction).length,
  profilesWithProduct: patches.filter((item) => item.patch.scoring.sourceLabeledProfile?.product).length,
  profilesWithApplicationScenario: patches.filter((item) => item.patch.scoring.sourceLabeledProfile?.applicationScenario).length,
  profilesWithMainBusiness: patches.filter((item) => item.patch.scoring.sourceLabeledProfile?.mainBusiness).length,
  sourceLabeledTeam: patches.filter((item) => array(item.patch.scoring.structuredTeam).some((team) => team.evidenceStatus === 'source_labeled')).length,
}

if (apply && patches.length) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const currentBefore: typeof before = []
    for (const { candidate } of patches) {
      const [currentRows] = await connection.query<Array<RowDataPacket & {
        id: string
        name: string
        company_name: string | null
        business_region: string | null
        business_region_source: string | null
        business_region_confidence: string | null
        scoring: unknown
        sources: unknown
      }>>(
        `SELECT id,name,company_name,business_region,business_region_source,
                business_region_confidence,scoring,sources
         FROM ${leadsTable} WHERE id=? FOR UPDATE`,
        [candidate.row.lead_id],
      )
      const current = currentRows[0]
      if (!current) throw new Error(`lead disappeared before apply: ${candidate.row.lead_id}`)
      currentBefore.push({
        id: current.id,
        companyName: current.company_name,
        businessRegion: current.business_region,
        businessRegionSource: current.business_region_source,
        businessRegionConfidence: current.business_region_confidence,
        scoring: current.scoring,
        sources: current.sources,
      })
      const currentCandidate: Candidate = {
        ...candidate,
        row: {
          ...candidate.row,
          name: current.name,
          company_name: current.company_name,
          business_region: current.business_region,
          business_region_source: current.business_region_source,
          business_region_confidence: current.business_region_confidence,
          scoring: current.scoring,
          sources: current.sources,
        },
        scoring: record(current.scoring),
        sources: array(current.sources),
      }
      const patch = buildPatch(currentCandidate, modelResults.get(candidate.row.lead_id) || {})
      await connection.query(
        `UPDATE ${leadsTable}
         SET company_name=?,business_region=?,business_region_source=?,business_region_confidence=?,
             scoring=CAST(? AS JSON),sources=CAST(? AS JSON)
         WHERE id=?`,
        [
          patch.companyName,
          patch.region || current.business_region,
          patch.regionSource,
          patch.regionConfidence,
          JSON.stringify(patch.scoring),
          JSON.stringify(patch.sources),
          current.id,
        ],
      )
    }
    before = currentBefore
    await writeFile(join(runDir, 'before.json'), JSON.stringify(before))
    await connection.query(
      `INSERT INTO ${auditTable}
        (id,user_id,user_name,module,action,target,result,request_id,created_at)
       VALUES (?,NULL,'Codex','项目获取池','Codex批量补充来源标注资料',?,'success',?,NOW(3))`,
      [randomUUID(), JSON.stringify({ ...summary, beforeHash: stableHash(before) }), runId],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

console.log(JSON.stringify({
  ok: true,
  ...summary,
  samples: patches.slice(0, 5).map(({ candidate, patch }) => ({
    leadId: candidate.row.lead_id,
    name: candidate.row.name,
    requestedFields: candidate.requestedFields,
    profile: patch.scoring.sourceLabeledProfile,
    team: patch.scoring.structuredTeam,
  })),
}, null, 2))
await pool.end()
