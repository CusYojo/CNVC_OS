import { createHash } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { radarAiReviews } from '../db/schema.js'
import { isSpecificLeadSubjectName } from './leadSubjectName.js'

const PROMPT_VERSION = 'radar-subject-v3-paper-v2'
const EVIDENCE_VALIDATION_REASON = '模型给出的主体名称或来源证据无法在原文中核验'
const DEFAULT_MODEL = process.env.RADAR_AI_REVIEW_MODEL
  || process.env.LLM_MODEL
  || 'claude-sonnet-4-6'
const GW_BASE = (
  process.env.LLM_BASE_URL
  || process.env.OPENAI_BASE_URL
  || 'http://127.0.0.1:18081/v1'
).replace(/\/$/, '')
const GW_KEY = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || ''
const REQUEST_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.RADAR_AI_REVIEW_TIMEOUT_MS) || 120_000,
)
const MAX_ATTEMPTS = Math.max(
  1,
  Math.min(3, Number(process.env.RADAR_AI_REVIEW_MAX_ATTEMPTS) || 3),
)
const BATCH_SIZE = Math.max(
  1,
  Math.min(8, Number(process.env.RADAR_AI_REVIEW_BATCH_SIZE) || 5),
)
const CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.RADAR_AI_REVIEW_CONCURRENCY) || 2),
)

export type RadarAiReviewStatus = 'accepted' | 'rejected' | 'review' | 'failed'
export type RadarSubjectType = 'company' | 'project' | 'team' | 'lab' | 'paper'

export interface RadarAiReviewDecision {
  decision: 'accept' | 'reject' | 'review'
  subjectType: RadarSubjectType | null
  subjectName: string
  legalName: string
  evidence: string
  confidence: number
  rejectReason: string
  model: string
  reviewedAt: string
}

export interface RadarAiReviewResult extends RadarAiReviewDecision {
  cacheKey: string
  sourceKey: string
  contentHash: string
  status: RadarAiReviewStatus
  attempts: number
  cacheHit: boolean
}

interface PreparedRadarCandidate {
  candidateId: string
  cacheKey: string
  sourceKey: string
  contentHash: string
  sourceText: string
  promptText: string
  isPaper: boolean
}

const modelReviewSchema = z.object({
  candidateId: z.string().min(1),
  decision: z.enum(['accept', 'reject', 'review']),
  subjectType: z.enum(['company', 'project', 'team', 'lab', 'paper']).nullish(),
  subjectName: z.string().nullish(),
  legalName: z.string().nullish(),
  evidence: z.string().nullish(),
  confidence: z.coerce.number(),
  rejectReason: z.string().nullish(),
})

const modelResponseSchema = z.object({
  reviews: z.array(modelReviewSchema),
})

const SYSTEM_PROMPT = `你是私募股权/创业投资线索池的严格准入审查员。

任务：判断每条公开信息是否包含一个可明确识别、值得进入投资线索池的公司、商业化项目、创业团队、实验室或前沿论文，并给出该标的在原文中的规范名称。

论文候选特别规则：
- 当候选明确标注“线索类型：论文”时，不要要求融资、公司主体或已商业化；
- 论文标题完整、研究对象具体且摘要能说明技术贡献时可接受；
- subjectType 必须为 paper，subjectName 必须是原文中的完整论文标题，evidence 必须连续引用包含该标题的原文。

准入条件（必须同时满足）：
1. 原文明确出现具体公司、项目、创业团队、实验室或论文名称；
2. 信息对投资判断有实际价值，例如融资/估值、产品与技术、客户/订单、商业化、产业化、团队创业或市场验证；
3. subjectName 必须是原文已经出现的专名，不得把标题句子、描述短语、新闻栏目、机构来源、投资方、人物荣誉或泛行业词当作名称；
4. evidence 必须逐字复制原文中能同时证明“名称存在”和“投资相关性”的一段连续文字，禁止改写或拼接。

名称选择：
- 选择能唯一指向投资标的的最短完整专名；
- 融资主体为公司时优先公司/品牌简称，不要把产品名、人名、新闻栏目拼进公司名；
- 例如“月之暗面Kimi已完成融资”中的公司主体名应为“月之暗面”，Kimi 是产品名；
- 只有原文明确以某个产品或技术计划作为独立项目时，才把它作为 project。

必须拒绝：
- 获奖、荣誉、任职、招聘、招生、会议、论坛、政策、采访、综述、榜单、新闻合集；
- 非“论文”类型的学术资讯，且未出现明确商业化主体及产业化/融资/客户验证；
- 只有模糊描述，例如“创业团队”“科研团队”“全新突破”“文章来源”“项目成果”；
- 不能从原文确定唯一标的，或需要猜测、补全、创造公司名称。

subjectType 只能是 company、project、team、lab、paper。
confidence 使用 0 到 1。信息不足时必须 review 或 reject，不得猜测。
只返回 JSON 对象，格式：
{"reviews":[{"candidateId":"原样返回","decision":"accept|reject|review","subjectType":"company|project|team|lab|paper|null","subjectName":"原文专名或空字符串","legalName":"原文明示的工商全称或空字符串","evidence":"原文连续引文或空字符串","confidence":0.0,"rejectReason":"拒绝/待复核原因或空字符串"}]}`

function cleanText(value: unknown, maxChars = 12_000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, maxChars)
}

function meaningfulObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeEvidence(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase()
}

function normalizeComparable(value: string) {
  return normalizeEvidence(value).replace(/[\p{P}\p{S}\s]+/gu, '')
}

function sourceKeyOf(item: Record<string, unknown>) {
  const source = cleanText(item.source, 80) || 'unknown'
  for (const field of ['source_id', 'fingerprint', 'link', 'title']) {
    const value = cleanText(item[field], 500)
    if (value) return `${source}:${value}`
  }
  return `${source}:anonymous:${sha256(JSON.stringify(item)).slice(0, 24)}`
}

export function prepareRadarAiCandidate(
  item: Record<string, unknown>,
  model = DEFAULT_MODEL,
): PreparedRadarCandidate {
  const profile = meaningfulObject(item.project_profile)
  const sourceDescriptor = [item.source, item.source_group, item.source_key, item.source_type, item.source_name]
    .map((value) => cleanText(value, 120))
    .join(' ')
  const isPaper = cleanText(item.source_group, 40) === '论文' || /arxiv/i.test(sourceDescriptor)
  const fields: Array<[string, unknown, number?]> = [
    ['线索类型', isPaper ? '论文' : '投资项目', 20],
    ['标题', item.title, 1_000],
    ['摘要', item.summary, 4_000],
    ['正文', item.article_text, 8_000],
    ['雷达初步项目名（仅供参考，不得无证据采信）', profile.project_name, 500],
    ['雷达初步公司名（仅供参考，不得无证据采信）', profile.company_name, 500],
    ['工商全称字段（仅供参考，不得无证据采信）', profile.legal_entity || profile.company_full_name, 500],
    ['核心亮点', profile.core_highlights, 2_000],
    ['团队', profile.team_composition, 1_500],
    ['实验室', profile.lab, 800],
    ['融资轮次', profile.project_round, 300],
    ['融资金额', profile.financing_amount, 300],
    ['估值', profile.latest_valuation, 300],
    ['机构', profile.institutions, 800],
  ]
  const sourceText = fields
    .map(([, value, max]) => cleanText(value, max))
    .filter(Boolean)
    .join('\n')
  const promptText = fields
    .map(([label, value, max]) => {
      const text = cleanText(value, max)
      return text ? `${label}：${text}` : ''
    })
    .filter(Boolean)
    .join('\n')
  const sourceKey = sourceKeyOf(item)
  const contentHash = sha256(sourceText)
  const cacheKey = sha256(`${PROMPT_VERSION}\n${model}\n${sourceKey}\n${contentHash}`)
  return {
    candidateId: cacheKey.slice(0, 16),
    cacheKey,
    sourceKey,
    contentHash,
    sourceText,
    promptText,
    isPaper,
  }
}

function normalizeConfidence(value: number) {
  if (!Number.isFinite(value)) return 0
  const normalized = value > 1 && value <= 100 ? value / 100 : value
  return Math.max(0, Math.min(1, normalized))
}

export function validateRadarAiDecision(
  raw: z.infer<typeof modelReviewSchema>,
  sourceText: string,
  model = DEFAULT_MODEL,
  reviewedAt = new Date().toISOString(),
  allowPaperTitle = false,
): { status: RadarAiReviewStatus; decision: RadarAiReviewDecision } {
  const parsed = modelReviewSchema.parse(raw)
  const confidence = normalizeConfidence(parsed.confidence)
  const subjectName = cleanText(parsed.subjectName, 120).replace(/\s+/g, ' ')
  let legalName = cleanText(parsed.legalName, 120).replace(/\s+/g, ' ')
  const evidence = cleanText(parsed.evidence, 1_200).replace(/\s+/g, ' ')
  const sourceEvidence = normalizeEvidence(sourceText)
  const comparableSource = normalizeComparable(sourceText)
  const subjectAppearsInSource = Boolean(
    normalizeComparable(subjectName)
    && comparableSource.includes(normalizeComparable(subjectName)),
  )
  const evidenceAppearsInSource = Boolean(
    normalizeEvidence(evidence)
    && sourceEvidence.includes(normalizeEvidence(evidence)),
  )
  // 论文审查时，模型常会把我们提示中的“标题：/摘要：”标签一并复制到 evidence。
  // 标签不属于论文原文，但完整标题本身已在原文中逐字可核验。
  const paperTitleEvidenceValid = Boolean(
    allowPaperTitle
    && subjectAppearsInSource
    && normalizeComparable(evidence).includes(normalizeComparable(subjectName)),
  )
  if (legalName && !comparableSource.includes(normalizeComparable(legalName))) legalName = ''

  let status: RadarAiReviewStatus
  let decision = parsed.decision
  let rejectReason = cleanText(parsed.rejectReason, 300)
  if (parsed.decision === 'reject') {
    status = 'rejected'
  } else if (parsed.decision === 'review') {
    status = 'review'
  } else if (
    !parsed.subjectType
    || subjectName.length < 2
    || !subjectAppearsInSource
    || (!evidenceAppearsInSource && !paperTitleEvidenceValid)
  ) {
    status = 'review'
    decision = 'review'
    rejectReason = EVIDENCE_VALIDATION_REASON
  } else if (confidence >= 0.8) {
    // AI 模型判断接受，但仍需通过规则兜底校验：名称不能是谓语片段/新闻标题/通用词等。
    // 规格与线索池入口一致，由 leadSubjectName.isSpecificLeadSubjectName 统一维护。
    if (!isSpecificLeadSubjectName(subjectName, allowPaperTitle)) {
      status = 'review'
      decision = 'review'
      rejectReason ||= '模型给出的主体名称未通过名称规范化校验（谓语片段/通用词/描述短语）'
    } else {
      status = 'accepted'
    }
  } else if (confidence >= 0.6) {
    status = 'review'
    decision = 'review'
    rejectReason ||= '模型置信度不足，需人工复核'
  } else {
    status = 'rejected'
    decision = 'reject'
    rejectReason ||= '模型置信度过低'
  }

  return {
    status,
    decision: {
      decision,
      subjectType: parsed.subjectType ?? null,
      subjectName,
      legalName,
      evidence,
      confidence,
      rejectReason,
      model,
      reviewedAt,
    },
  }
}

export function revalidateEvidenceOnlyPaperReview(
  decision: RadarAiReviewDecision,
  sourceText: string,
  model = decision.model,
) {
  if (
    decision.decision !== 'review'
    || decision.subjectType !== 'paper'
    || decision.confidence < 0.8
    || decision.rejectReason !== EVIDENCE_VALIDATION_REASON
  ) return null
  return validateRadarAiDecision({
    candidateId: 'cached-paper',
    decision: 'accept',
    subjectType: 'paper',
    subjectName: decision.subjectName,
    legalName: decision.legalName,
    evidence: decision.evidence,
    confidence: decision.confidence,
    rejectReason: '',
  }, sourceText, model, decision.reviewedAt, true)
}

function parseFirstJsonObject(value: string) {
  const cleaned = value.trim().replace(/^```json\s*/i, '').replace(/\s*```[\s\S]*$/, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    // 部分兼容网关会在 JSON 前后附加说明；仅截取完整对象，不修补内部内容。
  }
  const start = value.indexOf('{')
  if (start < 0) throw new Error('模型未返回 JSON 对象')
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      if (depth === 0) return JSON.parse(value.slice(start, index + 1))
    }
  }
  throw new Error('模型 JSON 对象未闭合')
}

async function callReviewBatch(
  batch: PreparedRadarCandidate[],
  fetchImpl: typeof fetch,
  model: string,
) {
  if (process.env.RADAR_AI_REVIEW_DISABLE === '1') {
    throw new Error('RADAR_AI_REVIEW_DISABLE=1')
  }
  const userPrompt = batch
    .map((item) => `【candidateId=${item.candidateId}】\n${item.promptText || '无可用原文'}`)
    .join('\n\n')
  const response = await fetchImpl(`${GW_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(GW_KEY ? { Authorization: `Bearer ${GW_KEY}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 3_000,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const detail = cleanText(await response.text(), 500).replace(/\s+/g, ' ')
    const error = new Error(`主体审查模型 ${response.status}${detail ? `：${detail}` : ''}`)
    ;(error as Error & { retryable?: boolean }).retryable = response.status === 408
      || response.status === 429
      || response.status >= 500
    throw error
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = payload.choices?.[0]?.message?.content?.trim() ?? ''
  return modelResponseSchema.parse(parseFirstJsonObject(content)).reviews
}

function retryDelay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function loadCachedReviews(prepared: PreparedRadarCandidate[]) {
  const cacheKeys = prepared.map((item) => item.cacheKey)
  if (!cacheKeys.length) return new Map<string, RadarAiReviewResult>()
  const preparedByKey = new Map(prepared.map((item) => [item.cacheKey, item]))
  const rows = await db.select().from(radarAiReviews)
    .where(inArray(radarAiReviews.cacheKey, cacheKeys))
  const cached = new Map<string, RadarAiReviewResult>()
  const promoted: RadarAiReviewResult[] = []
  for (const row of rows) {
    if (row.status === 'failed') continue
    let decision = row.decision as unknown as RadarAiReviewDecision
    if (!decision || typeof decision.subjectName !== 'string') continue
    let status = row.status as RadarAiReviewStatus
    const preparedItem = preparedByKey.get(row.cacheKey)
    const revalidated = preparedItem?.isPaper
      ? revalidateEvidenceOnlyPaperReview(decision, preparedItem.sourceText, row.model)
      : null
    if (revalidated) {
      decision = revalidated.decision
      status = revalidated.status
    }
    const result: RadarAiReviewResult = {
      ...decision,
      cacheKey: row.cacheKey,
      sourceKey: row.sourceKey,
      contentHash: row.contentHash,
      status,
      attempts: row.attempts,
      cacheHit: true,
    }
    cached.set(row.cacheKey, result)
    if (status !== row.status) promoted.push(result)
  }
  await Promise.all(promoted.map((result) => persistReview(result)))
  return cached
}

async function persistReview(result: RadarAiReviewResult, promptVersion = PROMPT_VERSION) {
  const storedDecision = { ...result } as Record<string, unknown>
  await db.insert(radarAiReviews).values({
    cacheKey: result.cacheKey,
    sourceKey: result.sourceKey,
    contentHash: result.contentHash,
    promptVersion,
    model: result.model,
    status: result.status,
    decision: storedDecision,
    attempts: result.attempts,
    lastError: result.status === 'failed' ? result.rejectReason : null,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: radarAiReviews.cacheKey,
    set: {
      status: result.status,
      decision: storedDecision,
      attempts: result.attempts,
      lastError: result.status === 'failed' ? result.rejectReason : null,
      updatedAt: new Date(),
    },
  })
}

function failedReview(
  item: PreparedRadarCandidate,
  error: Error,
  attempts: number,
  model: string,
): RadarAiReviewResult {
  return {
    cacheKey: item.cacheKey,
    sourceKey: item.sourceKey,
    contentHash: item.contentHash,
    status: 'failed',
    decision: 'review',
    subjectType: null,
    subjectName: '',
    legalName: '',
    evidence: '',
    confidence: 0,
    rejectReason: `AI 主体审查暂不可用：${cleanText(error.message, 240)}`,
    model,
    reviewedAt: new Date().toISOString(),
    attempts,
    cacheHit: false,
  }
}

async function reviewUncachedBatch(
  batch: PreparedRadarCandidate[],
  fetchImpl: typeof fetch,
  model: string,
) {
  let lastError = new Error('AI 主体审查未返回结果')
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const rawReviews = await callReviewBatch(batch, fetchImpl, model)
      const byId = new Map(rawReviews.map((review) => [review.candidateId, review]))
      const results = batch.map((item): RadarAiReviewResult => {
        const raw = byId.get(item.candidateId)
        if (!raw) throw new Error(`模型遗漏候选项 ${item.candidateId}`)
        const validated = validateRadarAiDecision(raw, item.sourceText, model, new Date().toISOString(), item.isPaper)
        return {
          ...validated.decision,
          cacheKey: item.cacheKey,
          sourceKey: item.sourceKey,
          contentHash: item.contentHash,
          status: validated.status,
          attempts: attempt,
          cacheHit: false,
        }
      })
      await Promise.all(results.map((result) => persistReview(result)))
      return results
    } catch (error) {
      lastError = error as Error
      const retryable = (lastError as Error & { retryable?: boolean }).retryable !== false
      if (!retryable || attempt === MAX_ATTEMPTS) break
      await retryDelay(300 * attempt)
    }
  }
  const failed = batch.map((item) => failedReview(item, lastError, MAX_ATTEMPTS, model))
  await Promise.all(failed.map((result) => persistReview(result)))
  return failed
}

export async function reviewRadarCandidatesWithAi(
  items: Record<string, unknown>[],
  options: {
    fetchImpl?: typeof fetch
    model?: string
  } = {},
): Promise<RadarAiReviewResult[]> {
  const model = options.model || DEFAULT_MODEL
  const fetchImpl = options.fetchImpl || fetch
  const prepared = items.map((item) => prepareRadarAiCandidate(item, model))
  const cached = await loadCachedReviews(prepared)
  const pending = prepared.filter((item) => !cached.has(item.cacheKey))
  const chunks: PreparedRadarCandidate[][] = []
  for (let index = 0; index < pending.length; index += BATCH_SIZE) {
    chunks.push(pending.slice(index, index + BATCH_SIZE))
  }

  const fresh = new Map<string, RadarAiReviewResult>()
  let nextChunk = 0
  const worker = async () => {
    while (nextChunk < chunks.length) {
      const chunk = chunks[nextChunk]
      nextChunk += 1
      const results = await reviewUncachedBatch(chunk, fetchImpl, model)
      results.forEach((result) => fresh.set(result.cacheKey, result))
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => worker()),
  )

  return prepared.map((item) => {
    const result = cached.get(item.cacheKey) || fresh.get(item.cacheKey)
    return result || failedReview(item, new Error('AI 主体审查结果缺失'), 0, model)
  })
}
