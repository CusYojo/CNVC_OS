import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { z } from 'zod'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { gatewayJson } from '../services/inProcessAiWorkflowService.js'
import {
  deterministicLeadStageReview,
  LEAD_DATA_QUALITY_SCHEMA_VERSION,
  readLeadDataQuality,
  type LeadDataEvidenceStatus,
  type LeadDataQualityV1,
} from '../services/leadDataQualityService.js'
import { extractLeadFinancingFacts, normalizeFinancingText } from '../services/leadFinancingFactService.js'

type LeadRow = RowDataPacket & {
  id: string
  name: string
  source: string
  summary: string | null
  highlights: unknown
  funding_rounds: unknown
  scoring: unknown
  radar_profile: unknown
}

type Candidate = {
  row: LeadRow
  scoring: Record<string, any>
  rawStage: string
  sourceStage: string
  isResearch: boolean
  deterministic: ReturnType<typeof deterministicLeadStageReview>
}

const apply = process.argv.includes('--apply')
const leadId = process.argv.find((argument) => argument.startsWith('--lead-id='))?.slice('--lead-id='.length) || ''
const model = process.argv.find((argument) => argument.startsWith('--model='))?.slice('--model='.length) || 'gpt-5.6-sol'
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))

function objectValue(value: unknown): Record<string, any> {
  if (!value) return {}
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, any> } catch { return {} }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
  }
  return []
}

function compact(value: unknown, max = 360) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function fundingAmountReview(candidate: Candidate) {
  if (candidate.isResearch) {
    return { amountDisplay: '不适用', amountEvidenceStatus: 'not_applicable' as const }
  }
  const firstFunding = objectValue(arrayValue(candidate.row.funding_rounds)[0])
  const radar = objectValue(candidate.row.radar_profile)
  const profile = objectValue(radar.profile)
  const rawAmount = compact(firstFunding.amount || profile.financingAmount, 160)
  const sourceUrl = compact(firstFunding.sourceUrl || radar.link, 500)
  const evidenceTexts = [
    compact(candidate.row.summary, 1_200),
    ...arrayValue(candidate.row.highlights).map((item) => compact(item, 600)),
    compact(radar.sourceTitle, 600),
    compact(radar.articleText, 20_000),
  ].filter(Boolean)
  const extractedFacts = evidenceTexts.flatMap((evidence) => extractLeadFinancingFacts({
    text: evidence,
    sourceUrl,
    publishedAt: radar.publishedAt,
  }))
  const extractedAmount = extractedFacts.find((fact) => fact.amount && fact.amount !== '未披露')?.amount || ''
  if (!rawAmount || /^(?:未披露|暂未披露|未透露|待核验|待核实|无|-)$/.test(rawAmount)) {
    if (extractedAmount) return { amountDisplay: extractedAmount, amountEvidenceStatus: 'source_labeled' as const }
    return { amountDisplay: '融资金额未披露', amountEvidenceStatus: 'unverified' as const }
  }
  if (candidate.row.source === '36氪项目库' && compact(firstFunding.sourceUrl || objectValue(candidate.row.radar_profile).link, 500)) {
    return { amountDisplay: rawAmount, amountEvidenceStatus: 'source_labeled' as const }
  }
  const normalizedAmount = normalizeFinancingText(rawAmount).replace(/\s+/g, '')
  const extractedSupport = extractedFacts.some((fact) => fact.amount === normalizedAmount)
  if (extractedSupport) return { amountDisplay: rawAmount, amountEvidenceStatus: 'source_labeled' as const }
  const tokens = [...new Set(rawAmount.split(/[、,，;；/]/).map((item) => item.trim()).filter((item) => /\d/.test(item)))]
  const supported = tokens.find((token) => evidenceTexts.some((evidence) => {
    const index = evidence.indexOf(token)
    if (index < 0) return false
    const suffix = evidence.slice(index + token.length, index + token.length + 4)
    if (/^(?:家|户|人|个|项|名|家公司|家企业)/.test(suffix)) return false
    const window = evidence.slice(Math.max(0, index - 32), Math.min(evidence.length, index + token.length + 32))
    if (/融资受限|融资难|资金投入|市场规模|企业数量|合同金额|销售额|营收|估值/.test(window)) return false
    return /融资|募资|融得|融资规模|完成.{0,10}轮|获.{0,10}轮/.test(window)
  }))
  return supported
    ? { amountDisplay: supported, amountEvidenceStatus: 'source_labeled' as const }
    : { amountDisplay: '融资金额待核验', amountEvidenceStatus: 'unverified' as const }
}

function stageFrom(candidate: Record<string, any>) {
  return compact(candidate.ratingV3?.detailView?.project?.stage, 160)
}

const reviewSchema = z.object({
  reviews: z.array(z.object({
    key: z.string().min(1).max(32),
    fundingStageDisplay: z.string().min(1).max(80),
    businessStageDisplay: z.enum(['研发阶段', '原型/样机阶段', '试点验证阶段', '商业化阶段', '规模化阶段', '待核验']),
    evidenceStatus: z.enum(['source_supported', 'source_labeled', 'unverified']).optional(),
    reason: z.string().min(1).max(240).optional(),
    review: z.string().min(1).max(240).optional(),
  })),
})

type ModelStageReview = {
  key: string
  fundingStageDisplay: string
  businessStageDisplay: '研发阶段' | '原型/样机阶段' | '试点验证阶段' | '商业化阶段' | '规模化阶段' | '待核验'
  evidenceStatus: 'source_supported' | 'source_labeled' | 'unverified'
  reason: string
}

function validFundingDisplay(value: string) {
  return /^(?:融资轮次待核验|融资信息未披露|未融资|已披露融资，轮次待核验|历史.{1,20}，当前轮次待核验|种子(?:\+{0,2})?轮|天使(?:\+{0,2})?轮|Pre-[ABC](?:\+)?轮|[A-F](?:\d|\+{1,2})?轮|Pre-IPO|IPO|PE|私募|股权融资|战略融资|战略投资|风险投资\/联合投资|分拆增资融资|首轮融资|新一轮融资)$/.test(value)
}

async function codexReview(candidates: Candidate[]) {
  const unique = new Map<string, { key: string; rawStage: string; examples: Array<Record<string, unknown>> }>()
  for (const candidate of candidates.filter((item) => item.deterministic.requiresModel)) {
    const identity = candidate.rawStage || candidate.sourceStage || '（空）'
    const current = unique.get(identity) || { key: `S${String(unique.size + 1).padStart(3, '0')}`, rawStage: identity, examples: [] }
    if (current.examples.length < 3) {
      const profile = objectValue(objectValue(candidate.row.radar_profile).profile)
      current.examples.push({
        name: candidate.row.name,
        source: candidate.row.source,
        summary: compact(candidate.row.summary),
        highlights: arrayValue(candidate.row.highlights).map((item) => compact(item, 220)).filter(Boolean).slice(0, 2),
        sourceFundingLabel: candidate.sourceStage,
        firstFundingRound: objectValue(arrayValue(candidate.row.funding_rounds)[0]),
        profileEvidence: {
          projectRound: compact(profile.projectRound, 100),
          financingAmount: compact(profile.financingAmount, 100),
        },
      })
    }
    unique.set(identity, current)
  }

  const items = [...unique.values()]
  const result = new Map<string, ModelStageReview>()
  for (let offset = 0; offset < items.length; offset += 10) {
    const batch = items.slice(offset, offset + 10)
    const rawReview = await gatewayJson({
      model,
      timeoutMs: 180_000,
      system: [
        '你是投资线索数据库质量审计员。只依据输入字段，不使用外部事实，不补齐未给出的轮次、经营进展或融资金额。',
        '融资轮次与经营阶段必须分开。来源写“未融资”只能输出“未融资”，并使用 source_labeled 证据状态。历史轮次不能写成当前轮次。',
        '文章出现行业金额、企业数量、技术参数，不等于项目融资。没有明确证据时必须输出待核验。严格返回 JSON。',
      ].join(''),
      prompt: `${JSON.stringify({ stages: batch })}\n请逐项返回 reviews。fundingStageDisplay 只能使用：标准融资轮次、历史X轮，当前轮次待核验、已披露融资，轮次待核验、未融资、融资信息未披露、融资轮次待核验。businessStageDisplay 只能使用给定枚举。key 必须原样返回。`,
    })
    let parsed: z.infer<typeof reviewSchema>
    try {
      parsed = reviewSchema.parse(rawReview)
    } catch (error) {
      console.error(JSON.stringify({ event: 'codex_quality_schema_rejected', rawReview }, null, 2))
      throw error
    }
    const expectedKeys = new Set(batch.map((item) => item.key))
    for (const review of parsed.reviews) {
      // Some compatible gateways append examples after the requested array. Only exact
      // host-issued keys may influence persisted data; extras are ignored.
      if (!expectedKeys.has(review.key)) continue
      expectedKeys.delete(review.key)
      const batchItem = batch.find((item) => item.key === review.key)!
      if (!validFundingDisplay(review.fundingStageDisplay)) {
        const fallback = deterministicLeadStageReview({
          rawStage: batchItem.rawStage,
          sourceStage: batchItem.examples[0]?.sourceFundingLabel,
        })
        result.set(batchItem.rawStage, {
          key: review.key,
          fundingStageDisplay: fallback.funding.stageDisplay,
          businessStageDisplay: '待核验',
          evidenceStatus: fallback.funding.evidenceStatus === 'not_applicable' ? 'unverified' : fallback.funding.evidenceStatus,
          reason: `Codex 返回值未通过主机枚举校验，已采用保守规则：${fallback.reason}`,
        })
        continue
      }
      const evidenceStatus = review.evidenceStatus
        || (review.fundingStageDisplay === '未融资' || validFundingDisplay(review.fundingStageDisplay) && !/待核验|未披露/.test(review.fundingStageDisplay)
          ? 'source_labeled'
          : 'unverified')
      result.set(batchItem.rawStage, {
        key: review.key,
        fundingStageDisplay: review.fundingStageDisplay,
        businessStageDisplay: review.businessStageDisplay,
        evidenceStatus,
        reason: review.reason || review.review || 'Codex 已将融资轮次与经营阶段分开，并按现有证据强度降级展示。',
      })
    }
    for (const missingKey of expectedKeys) {
      const batchItem = batch.find((item) => item.key === missingKey)!
      const fallback = deterministicLeadStageReview({
        rawStage: batchItem.rawStage,
        sourceStage: batchItem.examples[0]?.sourceFundingLabel,
      })
      result.set(batchItem.rawStage, {
        key: missingKey,
        fundingStageDisplay: fallback.funding.stageDisplay,
        businessStageDisplay: '待核验',
        evidenceStatus: fallback.funding.evidenceStatus === 'not_applicable' ? 'unverified' : fallback.funding.evidenceStatus,
        reason: `Codex 未返回该项，已采用保守规则：${fallback.reason}`,
      })
    }
    console.log(JSON.stringify({ event: 'codex_quality_batch_completed', completed: Math.min(offset + batch.length, items.length), total: items.length }))
  }
  return result
}

function semanticReview(value: LeadDataQualityV1 | null | undefined) {
  if (!value) return null
  const { reviewedAt: _reviewedAt, ...semantic } = value
  return semantic
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  )
}

const [rows] = await pool.query<LeadRow[]>(
  `SELECT id,name,source,summary,highlights,funding_rounds,scoring,radar_profile
   FROM ${leadsTable}
   WHERE pool_status NOT IN ('已删除','已合并') ${leadId ? 'AND id=?' : ''}
   ORDER BY id`,
  leadId ? [leadId] : [],
)

const candidates: Candidate[] = rows.map((row) => {
  const scoring = objectValue(row.scoring)
  const radar = objectValue(row.radar_profile)
  const profile = objectValue(radar.profile)
  const fundingRound = objectValue(arrayValue(row.funding_rounds)[0])
  const isResearch = radar.channel === '论文' || Object.keys(objectValue(radar.paperMeta)).length > 0
  const articleFact = extractLeadFinancingFacts({
    text: compact(radar.articleText, 20_000) || compact(row.summary, 1_200),
    sourceUrl: radar.link || fundingRound.sourceUrl,
    publishedAt: radar.publishedAt,
  })[0]
  const storedStage = [compact(profile.projectRound, 160), compact(fundingRound.round, 160)]
    .find((value) => value && !/待核验|待核实|未披露/.test(value)) || ''
  const rawStage = storedStage || articleFact?.round || stageFrom(scoring)
  const sourceStage = storedStage || articleFact?.round || compact(profile.projectRound, 160) || compact(fundingRound.round, 160)
  return {
    row, scoring, rawStage, sourceStage, isResearch,
    deterministic: deterministicLeadStageReview({ rawStage, sourceStage, isResearch }),
  }
})

const existingModelReviews = new Map<string, LeadDataQualityV1>()
for (const candidate of candidates) {
  const existing = readLeadDataQuality(candidate.scoring.dataQualityV1)
  if (candidate.deterministic.requiresModel && existing && existing.sourceStage === (candidate.sourceStage || candidate.rawStage)) {
    existingModelReviews.set(candidate.rawStage || candidate.sourceStage, existing)
  }
}
const needsFreshModel = candidates.filter((candidate) => (
  candidate.deterministic.requiresModel
  && !existingModelReviews.has(candidate.rawStage || candidate.sourceStage)
))
const modelReviews = await codexReview(needsFreshModel)
const reviewedAt = new Date().toISOString()
const patches: Array<{ id: string; name: string; scoring: Record<string, unknown>; quality: LeadDataQualityV1 }> = []
const summary = {
  scanned: rows.length,
  researchNotApplicable: 0,
  sourceLabeledUnfinanced: 0,
  financingRoundUnverified: 0,
  financingUndisclosed: 0,
  fundingAmountSourceLabeled: 0,
  fundingAmountUnverified: 0,
  fundingAmountUndisclosed: 0,
  historicalRoundQualified: 0,
  modelReviewedStagePatterns: modelReviews.size,
  reusedModelStagePatterns: existingModelReviews.size,
  candidates: 0,
}

for (const candidate of candidates) {
  const identity = candidate.rawStage || candidate.sourceStage
  const modelReview = modelReviews.get(identity)
  const reusedReview = existingModelReviews.get(identity)
  const deterministic = candidate.deterministic
  const stageQuality: LeadDataQualityV1 = modelReview ? {
    schemaVersion: LEAD_DATA_QUALITY_SCHEMA_VERSION,
    method: 'codex-semantic-normalization-v1',
    model,
    reviewedAt,
    sourceStage: candidate.sourceStage || candidate.rawStage,
    funding: {
      stageDisplay: modelReview.fundingStageDisplay,
      evidenceStatus: modelReview.evidenceStatus as LeadDataEvidenceStatus,
    },
    businessStage: {
      stageDisplay: modelReview.businessStageDisplay,
      evidenceStatus: modelReview.businessStageDisplay === '待核验' ? 'unverified' : modelReview.evidenceStatus as LeadDataEvidenceStatus,
    },
    reason: modelReview.reason,
  } : reusedReview || {
    schemaVersion: LEAD_DATA_QUALITY_SCHEMA_VERSION,
    method: 'codex-semantic-normalization-v1',
    model: 'codex-host-evidence-rules-v1',
    reviewedAt,
    sourceStage: deterministic.sourceStage,
    funding: deterministic.funding,
    businessStage: deterministic.businessStage,
    reason: deterministic.reason,
  }
  const normalizedFundingStage = stageQuality.funding.stageDisplay === '未融资（来源标注）'
    ? '未融资'
    : stageQuality.funding.stageDisplay
  const amountReview = normalizedFundingStage === '未融资'
    ? { amountDisplay: '不适用', amountEvidenceStatus: 'not_applicable' as const }
    : fundingAmountReview(candidate)
  const quality: LeadDataQualityV1 = {
    ...stageQuality,
    funding: { ...stageQuality.funding, stageDisplay: normalizedFundingStage, ...amountReview },
  }
  if (quality.funding.evidenceStatus === 'not_applicable') summary.researchNotApplicable += 1
  if (quality.funding.stageDisplay === '未融资') summary.sourceLabeledUnfinanced += 1
  if (quality.funding.stageDisplay === '融资轮次待核验') summary.financingRoundUnverified += 1
  if (quality.funding.stageDisplay === '融资信息未披露') summary.financingUndisclosed += 1
  if (quality.funding.stageDisplay.startsWith('历史')) summary.historicalRoundQualified += 1
  if (quality.funding.amountEvidenceStatus === 'source_labeled') summary.fundingAmountSourceLabeled += 1
  if (quality.funding.amountDisplay === '融资金额待核验') summary.fundingAmountUnverified += 1
  if (quality.funding.amountDisplay === '融资金额未披露') summary.fundingAmountUndisclosed += 1
  const existing = readLeadDataQuality(candidate.scoring.dataQualityV1)
  if (JSON.stringify(stableValue(semanticReview(existing))) === JSON.stringify(stableValue(semanticReview(quality)))) continue
  patches.push({
    id: candidate.row.id,
    name: candidate.row.name,
    scoring: { ...candidate.scoring, dataQualityV1: quality },
    quality,
  })
}
summary.candidates = patches.length

console.log(JSON.stringify({
  ok: true,
  mode: apply ? 'apply' : 'preview',
  model,
  ...summary,
  samples: patches.slice(0, 12).map((patch) => ({ name: patch.name, quality: patch.quality })),
}, null, 2))

if (apply && patches.length) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    for (const patch of patches) {
      await connection.query(`UPDATE ${leadsTable} SET scoring=? WHERE id=?`, [JSON.stringify(patch.scoring), patch.id])
    }
    await connection.query(
      `INSERT INTO ${auditTable}
        (id,user_id,user_name,module,action,target,result,request_id,created_at)
       VALUES (?,NULL,'Codex','项目获取池','优化线索数据严谨性',?,'success',?,NOW(3))`,
      [randomUUID(), JSON.stringify({ model, ...summary }), randomUUID()],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

await pool.end()
