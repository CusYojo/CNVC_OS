import { createHash } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { radarAiReviews } from '../db/schema.js'
import { isSpecificLeadSubjectName } from './leadSubjectName.js'
import { redactSensitiveText } from '../security/redactSecrets.js'
import {
  finishLeadPipelineRun,
  openLeadPipelineReview,
  recordLeadPipelineDecision,
  registerLeadPipelinePromptVersion,
  startLeadPipelineRun,
} from './leadPipelineAuditService.js'
import { radarAiDecisionAuditKey, radarAiReviewAuditKey } from './radarAiAuditPolicy.js'
import {
  LEAD_SUBJECT_AGENT_PROFILE,
  LEAD_SUBJECT_AGENT_PROFILE_VERSION,
  LEAD_SUBJECT_AGENT_SCHEMA_VERSION,
  LEAD_SUBJECT_AGENT_TOOLSET_VERSION,
  leadSubjectAgentRuntime,
  runLeadSubjectAgentBatch,
  type LeadSubjectAgentExecution,
} from './leadSubjectAgentService.js'

const PROMPT_VERSION = 'radar-subject-v3-paper-v2'
const PAPER_PROMPT_VERSION = 'radar-paper-project-v5'
const EVIDENCE_VALIDATION_REASON = '模型给出的主体名称或来源证据无法在原文中核验'
const DEFAULT_MODEL = process.env.RADAR_AI_REVIEW_MODEL
  || process.env.LEAD_ENRICHMENT_MODEL
  || process.env.LLM_MODEL
  || 'claude-sonnet-4-6'
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

export type LeadSubjectAgentRunner = typeof runLeadSubjectAgentBatch

export type RadarAiReviewStatus = 'accepted' | 'rejected' | 'review' | 'failed'
export type RadarSubjectType = 'company' | 'project' | 'team' | 'lab' | 'paper'

export interface RadarAiReviewDecision {
  decision: 'accept' | 'reject' | 'review'
  subjectType: RadarSubjectType | null
  subjectName: string
  legalName: string
  evidence: string
  translatedTitle?: string
  paperProjectName?: string
  paperProjectNameZh?: string
  translatedSummary?: string
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
  promptVersion: string
}

interface PreparedRadarCandidate {
  candidateId: string
  cacheKey: string
  sourceKey: string
  contentHash: string
  sourceText: string
  promptText: string
  isPaper: boolean
  promptVersion: string
}

const modelReviewSchema = z.object({
  candidateId: z.string().min(1),
  decision: z.enum(['accept', 'reject', 'review']),
  subjectType: z.enum(['company', 'project', 'team', 'lab', 'paper']).nullish(),
  subjectName: z.string().nullish(),
  legalName: z.string().nullish(),
  evidence: z.string().nullish(),
  translatedTitle: z.string().nullish(),
  paperProjectName: z.string().nullish(),
  paperProjectNameZh: z.string().nullish(),
  translatedSummary: z.string().nullish(),
  confidence: z.coerce.number(),
  rejectReason: z.string().nullish(),
})

const modelResponseSchema = z.object({
  reviews: z.array(modelReviewSchema),
})

export const RADAR_SUBJECT_REVIEW_SYSTEM_PROMPT = `你是私募股权/创业投资线索池的严格准入审查员。

任务：判断每条公开信息是否包含一个可明确识别、值得进入投资线索池的公司、商业化项目、创业团队、实验室或前沿论文，并给出该标的在原文中的规范名称。

论文候选特别规则：
- 当候选明确标注“线索类型：论文”时，不要要求融资、公司主体或已商业化；
- 论文标题完整、研究对象具体且摘要能说明技术贡献时可接受；
- subjectType 必须为 paper，subjectName 必须是原文中的完整论文标题，evidence 必须连续引用包含该标题的原文；
- translatedTitle 保存完整中文论文标题，不得删掉主标题或副标题；
- paperProjectName 保存原文中最能表达研究对象、方法、系统或数据集的简洁项目名，paperProjectNameZh 保存其准确、名词化的中文名称；
- 对“传播性主标题：实质性副标题”结构，项目名称取实质性副标题。例如 When Agents Coordinate: Measuring Coordination in Multi-Agent AI Coding 的 paperProjectName 是 Measuring Coordination in Multi-Agent AI Coding，paperProjectNameZh 是“多智能体 AI 编程中的协作度量”；
- 对“专名：解释性副标题”结构，保留专名。例如 GeoMix: Descriptor-Free Visual Localization... 的项目名称是 GeoMix；
- 若无法安全缩短，paperProjectName 使用完整原标题；不得从摘要创造原文没有出现的英文项目专名；
- 英文论文必须同时给出准确、简洁的 translatedTitle、paperProjectNameZh，以及不超过 300 个汉字、忠实概括原摘要的中文摘要 translatedSummary；不得增加原文没有的实验结果、机构、融资或商业化判断；
- 中文论文的 translatedTitle 可直接使用原标题，paperProjectName 与 paperProjectNameZh 可相同，translatedSummary 使用中文概括。非论文候选的这些字段返回空字符串。

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
{"reviews":[{"candidateId":"原样返回","decision":"accept|reject|review","subjectType":"company|project|team|lab|paper|null","subjectName":"原文专名或空字符串","legalName":"原文明示的工商全称或空字符串","evidence":"原文连续引文或空字符串","translatedTitle":"完整论文中文标题或空字符串","paperProjectName":"论文原文项目名或空字符串","paperProjectNameZh":"论文中文项目名或空字符串","translatedSummary":"论文中文摘要或空字符串","confidence":0.0,"rejectReason":"拒绝/不确定原因或空字符串"}]}`

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

function cleanChineseTranslation(value: unknown, maxChars: number) {
  const text = cleanText(value, maxChars).replace(/\s+/g, ' ')
  return /[\u3400-\u9fff]/.test(text) ? text : ''
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
  const promptVersion = isPaper ? PAPER_PROMPT_VERSION : PROMPT_VERSION
  const cacheKey = sha256(`${promptVersion}\n${model}\n${sourceKey}\n${contentHash}`)
  return {
    candidateId: cacheKey.slice(0, 16),
    cacheKey,
    sourceKey,
    contentHash,
    sourceText,
    promptText,
    isPaper,
    promptVersion,
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
  const isPaperDecision = allowPaperTitle && parsed.subjectType === 'paper'
  const translatedTitle = isPaperDecision
    ? cleanChineseTranslation(parsed.translatedTitle, 180)
    : ''
  const rawPaperProjectName = isPaperDecision
    ? cleanText(parsed.paperProjectName, 180).replace(/\s+/g, ' ')
    : ''
  const paperProjectNameAppearsInSource = Boolean(
    normalizeComparable(rawPaperProjectName)
    && comparableSource.includes(normalizeComparable(rawPaperProjectName)),
  )
  const paperProjectName = paperProjectNameAppearsInSource ? rawPaperProjectName : subjectName
  const rawPaperProjectNameZh = isPaperDecision
    ? cleanText(parsed.paperProjectNameZh, 180).replace(/\s+/g, ' ')
    : ''
  // Coined method/system names such as GeoMix and gmsEDA are intentionally
  // unchanged in Chinese; otherwise require an actual Chinese translation.
  const paperProjectNameZh = /[\u3400-\u9fff]/.test(rawPaperProjectNameZh)
    || normalizeComparable(rawPaperProjectNameZh) === normalizeComparable(paperProjectName)
    ? rawPaperProjectNameZh
    : ''
  const translatedSummary = isPaperDecision
    ? cleanChineseTranslation(parsed.translatedSummary, 600)
    : ''
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
      translatedTitle,
      paperProjectName,
      paperProjectNameZh,
      translatedSummary,
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
    translatedTitle: decision.translatedTitle,
    paperProjectName: decision.paperProjectName,
    paperProjectNameZh: decision.paperProjectNameZh,
    translatedSummary: decision.translatedSummary,
    confidence: decision.confidence,
    rejectReason: '',
  }, sourceText, model, decision.reviewedAt, true)
}

async function callReviewBatch(
  batch: PreparedRadarCandidate[],
  agentRunner: LeadSubjectAgentRunner,
  model: string,
) {
  if (process.env.RADAR_AI_REVIEW_DISABLE === '1') {
    throw new Error('RADAR_AI_REVIEW_DISABLE=1')
  }
  const execution = await agentRunner({
    systemPrompt: RADAR_SUBJECT_REVIEW_SYSTEM_PROMPT,
    candidates: batch.map((item) => ({
      candidateId: item.candidateId,
      promptText: item.promptText,
    })),
    model,
  })
  return {
    reviews: modelResponseSchema.parse(execution.output).reviews,
    ...execution,
  }
}

function retryDelay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nonRetryableAuditError(error: unknown) {
  const wrapped = error instanceof Error ? error : new Error(String(error))
  ;(wrapped as Error & { retryable?: boolean }).retryable = false
  return wrapped
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
      promptVersion: preparedItem?.promptVersion || row.promptVersion,
    }
    cached.set(row.cacheKey, result)
    if (status !== row.status) promoted.push(result)
  }
  await Promise.all(promoted.map((result) => persistReview(result)))
  return cached
}

async function persistReview(result: RadarAiReviewResult, promptVersion = result.promptVersion) {
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
  }).onDuplicateKeyUpdate({
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
    translatedTitle: '',
    paperProjectName: '',
    paperProjectNameZh: '',
    translatedSummary: '',
    confidence: 0,
    rejectReason: `AI 主体审查暂不可用：${cleanText(redactSensitiveText(error.message), 240)}`,
    model,
    reviewedAt: new Date().toISOString(),
    attempts,
    cacheHit: false,
    promptVersion: item.promptVersion,
  }
}

async function reviewUncachedBatch(
  batch: PreparedRadarCandidate[],
  agentRunner: LeadSubjectAgentRunner,
  model: string,
  auditEventIds: Map<string, string>,
) {
  const runtime = leadSubjectAgentRuntime(model, agentRunner !== runLeadSubjectAgentBatch)
  let lastError = new Error('AI 主体审查未返回结果')
  let lastAuditRunId: string | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const eventIds = batch.map((item) => auditEventIds.get(item.cacheKey)).filter((value): value is string => Boolean(value))
    const startedAt = new Date()
    let auditRun: Awaited<ReturnType<typeof startLeadPipelineRun>> | null = null
    let auditRunFinished = false
    try {
      if (eventIds.length) {
        try {
          const auditPromptVersion = runtime === 'codex-cli'
            ? `${batch[0].promptVersion}-codex-v1`
            : batch[0].promptVersion
          const promptVersion = await registerLeadPipelinePromptVersion({
            agentProfile: LEAD_SUBJECT_AGENT_PROFILE,
            promptVersion: auditPromptVersion,
            schemaVersion: LEAD_SUBJECT_AGENT_SCHEMA_VERSION,
            skillVersion: LEAD_SUBJECT_AGENT_PROFILE_VERSION,
            toolsetVersion: LEAD_SUBJECT_AGENT_TOOLSET_VERSION,
            prompt: RADAR_SUBJECT_REVIEW_SYSTEM_PROMPT,
            configuration: {
              runtime,
              maxAttempts: MAX_ATTEMPTS,
              tools: [],
              skills: [],
              permissionMode: 'dontAsk',
              outputFormat: 'json_schema',
            },
          })
          auditRun = await startLeadPipelineRun({
            eventIds,
            runtime,
            agentProfile: LEAD_SUBJECT_AGENT_PROFILE,
            promptVersionId: promptVersion.id,
            model,
            attempt,
            startedAt,
            metadata: {
              cacheKeys: batch.map((item) => item.cacheKey),
              transport: runtime,
              toolsetVersion: LEAD_SUBJECT_AGENT_TOOLSET_VERSION,
              tokenAccounting: 'exact-batch',
            },
          })
        } catch (error) {
          throw nonRetryableAuditError(error)
        }
        lastAuditRunId = auditRun.id
      }
      const modelResponse = await callReviewBatch(batch, agentRunner, model)
      const byId = new Map(modelResponse.reviews.map((review) => [review.candidateId, review]))
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
          promptVersion: item.promptVersion,
        }
      })
      if (auditRun) {
        try {
          for (let index = 0; index < results.length; index += 1) {
            const result = results[index]
            const item = batch[index]
            const eventId = auditEventIds.get(item.cacheKey)
            if (!eventId) continue
            const outcome = result.status === 'accepted'
              ? 'accept' as const
              : result.status === 'rejected'
                ? 'reject' as const
                : result.status === 'failed'
                  ? 'failed' as const
                  : 'review' as const
            const reason = result.rejectReason || (outcome === 'accept'
              ? 'radar subject passed model and host evidence validation'
              : `radar subject decision: ${outcome}`)
            const decision = await recordLeadPipelineDecision({
              idempotencyKey: radarAiDecisionAuditKey({
                cacheKey: result.cacheKey,
                status: result.status,
                runId: auditRun.id,
              }),
              eventId,
              runId: auditRun.id,
              decisionType: 'subject_identification',
              outcome,
              subjectType: result.subjectType,
              subjectName: result.subjectName,
              legalName: result.legalName,
              confidence: result.confidence * 100,
              reason,
              output: result as unknown as Record<string, unknown>,
              actorType: 'agent',
              actorId: result.model,
              evidence: result.evidence ? [{
                sourceId: item.sourceKey,
                sourceType: 'radar',
                locator: 'candidate source text',
                claim: outcome === 'accept'
                  ? `原文支持主体 ${result.subjectName} 及其投资相关性`
                  : reason,
                quote: result.evidence,
                verificationStatus: outcome === 'accept' ? 'verified' : 'unverified',
                metadata: { contentHash: item.contentHash },
              }] : [],
            })
            if (outcome === 'review') {
              await openLeadPipelineReview({
                idempotencyKey: radarAiReviewAuditKey({
                  cacheKey: result.cacheKey,
                  decisionId: decision.id,
                }),
                eventId,
                triggerDecisionId: decision.id,
                reason,
              })
            }
          }
          await finishLeadPipelineRun(auditRun.id, {
            status: 'succeeded',
            ...modelResponse.usage,
            toolCalls: modelResponse.toolCalls,
            durationMs: modelResponse.durationMs,
            costMicrousd: modelResponse.costMicrousd,
          })
          auditRunFinished = true
        } catch (error) {
          throw nonRetryableAuditError(error)
        }
      }
      await Promise.all(results.map((result) => persistReview(result)))
      return results
    } catch (error) {
      lastError = error as Error
      if (auditRun && !auditRunFinished) {
        const metrics = (lastError as Error & {
          leadRunMetrics?: Partial<LeadSubjectAgentExecution>
        }).leadRunMetrics
        await finishLeadPipelineRun(auditRun.id, {
          status: 'failed',
          ...(metrics?.usage || {}),
          toolCalls: metrics?.toolCalls,
          durationMs: metrics?.durationMs ?? Date.now() - startedAt.getTime(),
          costMicrousd: metrics?.costMicrousd,
          error: lastError,
        }).catch(() => undefined)
      }
      const retryable = (lastError as Error & { retryable?: boolean }).retryable !== false
      if (!retryable || attempt === MAX_ATTEMPTS) break
      await retryDelay(300 * attempt)
    }
  }
  const failed = batch.map((item) => failedReview(item, lastError, MAX_ATTEMPTS, model))
  if (lastAuditRunId) {
    for (let index = 0; index < failed.length; index += 1) {
      const result = failed[index]
      const eventId = auditEventIds.get(batch[index].cacheKey)
      if (!eventId) continue
      await recordLeadPipelineDecision({
        idempotencyKey: radarAiDecisionAuditKey({
          cacheKey: result.cacheKey,
          status: 'failed',
          runId: lastAuditRunId,
        }),
        eventId,
        runId: lastAuditRunId,
        decisionType: 'subject_identification',
        outcome: 'failed',
        confidence: 0,
        reason: result.rejectReason,
        output: result as unknown as Record<string, unknown>,
        actorType: 'agent',
        actorId: model,
      })
    }
  }
  await Promise.all(failed.map((result) => persistReview(result)))
  return failed
}

export async function reviewRadarCandidatesWithAi(
  items: Record<string, unknown>[],
  options: {
    agentRunner?: LeadSubjectAgentRunner
    model?: string
    eventIds?: string[]
  } = {},
): Promise<RadarAiReviewResult[]> {
  const model = options.model || DEFAULT_MODEL
  const agentRunner = options.agentRunner || runLeadSubjectAgentBatch
  const prepared = items.map((item) => prepareRadarAiCandidate(item, model))
  if (options.eventIds && options.eventIds.length !== prepared.length) {
    throw new Error('Radar AI review eventIds must align one-to-one with candidates')
  }
  const auditEventIds = new Map(prepared.map((item, index) => [item.cacheKey, options.eventIds?.[index]])
    .filter((entry): entry is [string, string] => Boolean(entry[1])))
  const cached = await loadCachedReviews(prepared)
  const pending = prepared.filter((item) => !cached.has(item.cacheKey))
  const chunks: PreparedRadarCandidate[][] = []
  const pendingByPromptVersion = new Map<string, PreparedRadarCandidate[]>()
  for (const item of pending) {
    const group = pendingByPromptVersion.get(item.promptVersion) ?? []
    group.push(item)
    pendingByPromptVersion.set(item.promptVersion, group)
  }
  for (const group of pendingByPromptVersion.values()) {
    for (let index = 0; index < group.length; index += BATCH_SIZE) {
      chunks.push(group.slice(index, index + BATCH_SIZE))
    }
  }

  const fresh = new Map<string, RadarAiReviewResult>()
  let nextChunk = 0
  const worker = async () => {
    while (nextChunk < chunks.length) {
      const chunk = chunks[nextChunk]
      nextChunk += 1
      const results = await reviewUncachedBatch(chunk, agentRunner, model, auditEventIds)
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
