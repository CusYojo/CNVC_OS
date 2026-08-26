import { z } from 'zod'

export const LEAD_RATING_V3_SCHEMA_VERSION = 'lead-rating-v3' as const
export const LEAD_RATING_V3_WORKFLOW = 'score-lead-rating-v3' as const

export const LEAD_RATING_DIMENSIONS = [
  { key: 'financial_operations', dimension: '财务经营状况', weight: 15 },
  { key: 'product_competitiveness', dimension: '核心产品体系与产品竞争力', weight: 15 },
  { key: 'technology_rd', dimension: '核心技术壁垒与研发能力', weight: 15 },
  { key: 'industry_policy_space', dimension: '行业赛道、政策环境与发展空间', weight: 15 },
  { key: 'industrialization_fit', dimension: '技术产业化能力与行业适配性', weight: 10 },
  { key: 'business_market', dimension: '商业模式与市场落地能力', weight: 20 },
  { key: 'founder_team', dimension: '创始人及核心团队', weight: 10 },
] as const

export const LEAD_RATING_CORE_DIMENSION_KEYS = new Set([
  'product_competitiveness',
  'technology_rd',
  'business_market',
  'founder_team',
])

type RatingGrade = 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'C-' | 'D'
type RatingStatus = '正式评级' | '参考评级' | '无法评级'
type Confidence = '高' | '中' | '低'

const evidenceSchema = z.object({
  content: z.string().trim().min(1).max(8_000),
  evidence_level: z.enum(['E1', 'E2', 'E3']),
  fact_id: z.string().uuid().nullable().optional().default(null),
  evidence_ids: z.array(z.string().uuid()).max(20).optional().default([]),
})

const diligenceItemSchema = z.object({
  question: z.string().trim().min(1).max(4_000),
  required_material_or_method: z.string().trim().min(1).max(4_000),
})

export const leadRatingV3ModelOutputSchema = z.object({
  project: z.object({
    name: z.string().trim().max(256).default(''),
    industry: z.string().trim().max(128).default(''),
    stage: z.string().trim().max(128).default(''),
  }),
  rating: z.object({
    one_sentence_judgment: z.string().trim().min(1).max(2_000),
    core_tags: z.array(z.string().trim().min(1).max(64)).max(12).default([]),
    recommended_action: z.enum(['优先深度尽调', '继续跟踪', '有条件推进', '谨慎观察', '暂缓']),
  }),
  evidence_summary: z.object({
    confirmed_facts: z.array(z.string().trim().min(1).max(8_000)).max(50).default([]),
    unverified_company_claims: z.array(z.string().trim().min(1).max(8_000)).max(50).default([]),
    conflicting_information: z.array(z.string().trim().min(1).max(8_000)).max(50).default([]),
    critical_missing_information: z.array(z.string().trim().min(1).max(8_000)).max(50).default([]),
  }),
  dimension_scores: z.array(z.object({
    key: z.string().trim().min(1),
    dimension: z.string().trim().min(1),
    score: z.number().min(0).max(10).nullable(),
    assessment: z.string().trim().min(1).max(8_000),
    key_evidence: z.array(evidenceSchema).max(30).default([]),
    risks_or_gaps: z.array(z.string().trim().min(1).max(4_000)).max(30).default([]),
  })).length(LEAD_RATING_DIMENSIONS.length),
  investment_thesis: z.array(z.object({
    thesis: z.string().trim().min(1).max(4_000),
    supporting_basis: z.string().trim().min(1).max(8_000),
    necessary_conditions: z.array(z.string().trim().min(1).max(4_000)).max(20).default([]),
  })).max(12).default([]),
  key_risks: z.array(z.string().trim().min(1).max(4_000)).max(30).default([]),
  failure_scenario: z.array(z.string().trim().min(1).max(4_000)).max(20).default([]),
  investment_red_flags: z.array(z.string().trim().min(1).max(4_000)).max(20).default([]),
  transaction_value: z.object({
    valuation_information_available: z.boolean(),
    terms_information_available: z.boolean(),
    assessment: z.string().trim().min(1).max(8_000),
  }),
  due_diligence: z.object({
    P0: z.array(diligenceItemSchema).max(30).default([]),
    P1: z.array(diligenceItemSchema).max(30).default([]),
    P2: z.array(diligenceItemSchema).max(30).default([]),
  }),
  rating_system_improvements: z.array(z.string().trim().min(1).max(4_000)).max(20).default([]),
})

type ModelOutput = z.infer<typeof leadRatingV3ModelOutputSchema>

export function leadRatingGradeForScore(score: number): RatingGrade {
  if (score >= 90) return 'A+'
  if (score >= 85) return 'A'
  if (score >= 80) return 'A-'
  if (score >= 75) return 'B+'
  if (score >= 70) return 'B'
  if (score >= 65) return 'B-'
  if (score >= 60) return 'C+'
  if (score >= 50) return 'C'
  return 'C-'
}

export function leadRatingStatusFor(assessableDimensions: number, informationCoverage: number): RatingStatus {
  if (assessableDimensions >= 5 && informationCoverage >= 60) return '正式评级'
  if (assessableDimensions >= 4 && informationCoverage >= 50) return '参考评级'
  return '无法评级'
}

function confidenceFor(input: ModelOutput, coverage: number): Confidence {
  if (coverage < 60) return '低'
  const evidence = input.dimension_scores.flatMap((dimension) => dimension.key_evidence)
  const strong = evidence.filter((item) => item.evidence_level === 'E1' || item.evidence_level === 'E2').length
  const weak = evidence.filter((item) => item.evidence_level === 'E3').length
  if (coverage >= 80 && strong > 0 && strong >= weak) return '高'
  return '中'
}

function normalizeDimensions(input: ModelOutput) {
  const byKey = new Map(input.dimension_scores.map((dimension) => [dimension.key, dimension]))
  if (byKey.size !== LEAD_RATING_DIMENSIONS.length
    || LEAD_RATING_DIMENSIONS.some((definition) => !byKey.has(definition.key))) {
    throw new Error('V3 评级维度不完整、重复或包含未定义维度')
  }
  return LEAD_RATING_DIMENSIONS.map((definition) => {
    const raw = byKey.get(definition.key)!
    const onlyE3 = raw.key_evidence.length > 0
      && raw.key_evidence.every((evidence) => evidence.evidence_level === 'E3')
    const score = raw.score == null ? null : Number(Math.min(onlyE3 ? 8 : 10, raw.score).toFixed(1))
    return {
      key: definition.key,
      dimension: definition.dimension,
      weight: definition.weight,
      score,
      assessment: raw.assessment,
      keyEvidence: raw.key_evidence.map((evidence) => ({
        content: evidence.content,
        evidenceLevel: evidence.evidence_level,
        factId: evidence.fact_id,
        evidenceIds: evidence.evidence_ids,
      })),
      risksOrGaps: raw.risks_or_gaps,
    }
  })
}

function mapDiligence(items: ModelOutput['due_diligence']['P0']) {
  return items.map((item) => ({
    question: item.question,
    requiredMaterialOrMethod: item.required_material_or_method,
  }))
}

export function computeLeadRatingV3(value: unknown) {
  const input = leadRatingV3ModelOutputSchema.parse(value)
  const dimensionScores = normalizeDimensions(input)
  const assessable = dimensionScores.filter((dimension) => dimension.score != null)
  const assessableWeight = assessable.reduce((sum, dimension) => sum + dimension.weight, 0)
  const informationCoverage = Number(assessableWeight.toFixed(1))
  const hasSevereEvidenceConflict = input.evidence_summary.conflicting_information.some((item) => (
    /重大.{0,12}(矛盾|冲突)|无法.{0,12}判断.{0,12}真实性|真实性.{0,12}无法.{0,12}判断/.test(item)
  ))
  const ratingStatus = hasSevereEvidenceConflict
    ? '无法评级' as const
    : leadRatingStatusFor(assessable.length, informationCoverage)
  const rawScore = assessableWeight > 0
    ? assessable.reduce((sum, dimension) => sum + (dimension.score! / 10) * dimension.weight, 0)
      / assessableWeight * 100
    : null
  const score = ratingStatus === '无法评级' || rawScore == null ? null : Number(rawScore.toFixed(1))
  const confidence = confidenceFor(input, informationCoverage)
  // 资料覆盖未达到参考评级门槛时，不虚构综合分，但统一以 D 级表示
  // “已完成审阅、证据不足”，避免在列表中继续显示为尚未执行的待评级。
  let grade: RatingGrade | null = ratingStatus === '无法评级'
    ? 'D'
    : score == null ? null : leadRatingGradeForScore(score)
  if (grade === 'A+') {
    const coreDimensionsAtNine = dimensionScores.filter((dimension) => (
      LEAD_RATING_CORE_DIMENSION_KEYS.has(dimension.key) && dimension.score != null && dimension.score >= 9
    )).length
    const qualifiesForAPlus = informationCoverage >= 80
      && confidence === '高'
      && coreDimensionsAtNine >= 3
      && input.investment_red_flags.length === 0
    if (!qualifiesForAPlus) grade = 'A'
  }
  const displayGrade = grade ?? '待评级'
  const detailView = {
    project: input.project,
    rating: {
      grade,
      status: ratingStatus,
      score,
      informationCoverage,
      confidence,
      oneSentenceJudgment: input.rating.one_sentence_judgment,
      coreTags: input.rating.core_tags,
      recommendedAction: input.rating.recommended_action,
    },
    evidenceSummary: {
      confirmedFacts: input.evidence_summary.confirmed_facts,
      unverifiedCompanyClaims: input.evidence_summary.unverified_company_claims,
      conflictingInformation: input.evidence_summary.conflicting_information,
      criticalMissingInformation: input.evidence_summary.critical_missing_information,
    },
    dimensionScores,
    investmentThesis: input.investment_thesis.map((item) => ({
      thesis: item.thesis,
      supportingBasis: item.supporting_basis,
      necessaryConditions: item.necessary_conditions,
    })),
    keyRisks: input.key_risks,
    failureScenario: input.failure_scenario,
    investmentRedFlags: input.investment_red_flags,
    transactionValue: {
      valuationInformationAvailable: input.transaction_value.valuation_information_available,
      termsInformationAvailable: input.transaction_value.terms_information_available,
      assessment: input.transaction_value.assessment,
    },
    dueDiligence: {
      P0: mapDiligence(input.due_diligence.P0),
      P1: mapDiligence(input.due_diligence.P1),
      P2: mapDiligence(input.due_diligence.P2),
    },
    ratingSystemImprovements: input.rating_system_improvements,
  }
  return {
    schemaVersion: LEAD_RATING_V3_SCHEMA_VERSION,
    mainView: { displayGrade },
    detailView,
    computed: { score, assessableWeight, informationCoverage, ratingStatus },
  }
}

export function leadRatingV3JsonSchema(): Record<string, unknown> {
  const dimensionKeys = LEAD_RATING_DIMENSIONS.map((dimension) => dimension.key)
  const stringArray = { type: 'array', items: { type: 'string' } }
  const diligenceArray = {
    type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['question', 'required_material_or_method'],
      properties: { question: { type: 'string' }, required_material_or_method: { type: 'string' } },
    },
  }
  return {
    type: 'object', additionalProperties: false,
    required: [
      'project', 'rating', 'evidence_summary', 'dimension_scores', 'investment_thesis',
      'key_risks', 'failure_scenario', 'investment_red_flags', 'transaction_value',
      'due_diligence', 'rating_system_improvements',
    ],
    properties: {
      project: {
        type: 'object', additionalProperties: false, required: ['name', 'industry', 'stage'],
        properties: { name: { type: 'string' }, industry: { type: 'string' }, stage: { type: 'string' } },
      },
      rating: {
        type: 'object', additionalProperties: false,
        required: ['one_sentence_judgment', 'core_tags', 'recommended_action'],
        properties: {
          one_sentence_judgment: { type: 'string' }, core_tags: stringArray,
          recommended_action: { type: 'string', enum: ['优先深度尽调', '继续跟踪', '有条件推进', '谨慎观察', '暂缓'] },
        },
      },
      evidence_summary: {
        type: 'object', additionalProperties: false,
        required: ['confirmed_facts', 'unverified_company_claims', 'conflicting_information', 'critical_missing_information'],
        properties: {
          confirmed_facts: stringArray, unverified_company_claims: stringArray,
          conflicting_information: stringArray, critical_missing_information: stringArray,
        },
      },
      dimension_scores: {
        type: 'array', minItems: 7, maxItems: 7,
        items: {
          type: 'object', additionalProperties: false,
          required: ['key', 'dimension', 'score', 'assessment', 'key_evidence', 'risks_or_gaps'],
          properties: {
            key: { type: 'string', enum: dimensionKeys }, dimension: { type: 'string' },
            score: { anyOf: [{ type: 'number', minimum: 0, maximum: 10 }, { type: 'null' }] },
            assessment: { type: 'string' }, risks_or_gaps: stringArray,
            key_evidence: {
              type: 'array', items: {
                type: 'object', additionalProperties: false, required: ['content', 'evidence_level', 'fact_id', 'evidence_ids'],
                properties: {
                  content: { type: 'string' }, evidence_level: { type: 'string', enum: ['E1', 'E2', 'E3'] },
                  fact_id: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
                  evidence_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
                },
              },
            },
          },
        },
      },
      investment_thesis: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          required: ['thesis', 'supporting_basis', 'necessary_conditions'],
          properties: { thesis: { type: 'string' }, supporting_basis: { type: 'string' }, necessary_conditions: stringArray },
        },
      },
      key_risks: stringArray, failure_scenario: stringArray, investment_red_flags: stringArray,
      transaction_value: {
        type: 'object', additionalProperties: false,
        required: ['valuation_information_available', 'terms_information_available', 'assessment'],
        properties: {
          valuation_information_available: { type: 'boolean' }, terms_information_available: { type: 'boolean' }, assessment: { type: 'string' },
        },
      },
      due_diligence: {
        type: 'object', additionalProperties: false, required: ['P0', 'P1', 'P2'],
        properties: { P0: diligenceArray, P1: diligenceArray, P2: diligenceArray },
      },
      rating_system_improvements: stringArray,
    },
  }
}

export function leadRatingV3PromptTemplate() {
  return [
    '评分类型：共享线索池项目 V3 标准评级。',
    `七个维度及权重：${JSON.stringify(LEAD_RATING_DIMENSIONS)}`,
    '待评分资料：<runtime-input-json>',
    '必须结合项目阶段评价。信息缺失的维度 score 必须为 null，不得按 0 分或低分处理。',
    '只使用输入资料。禁止虚构财务、客户、订单、技术参数、市场规模、融资、团队、合作、知识产权和资质。',
    '区分确认事实、企业单方陈述、冲突和缺失信息。每条维度证据标记 E1、E2 或 E3。',
    '输入包含 enrichmentSnapshot 时，每个非空评分维度的 key_evidence 必须填写输入中真实存在的 fact_id 和至少一个属于该事实的 evidence_ids；不得生成或改写ID。',
    '必须遵守 enrichmentSnapshot.topicStates 的适用性：financial_operations 为 not_applicable 时财务经营维度 score 必须为 null；transaction_exit 为 missing/not_applicable 时估值与条款可用性必须均为 false。',
    '仅 E3 支持的维度不得给出 8 分以上。重大红线必须单独进入 investment_red_flags。',
    '核心维度指产品竞争力、技术研发、商业市场、创始人团队；A+ 至少需要其中三个维度达到 9 分。',
    '存在无法判断真实性的重大材料冲突时，必须写入 conflicting_information，宿主将强制标记为无法评级。',
    '未达到参考评级证据门槛时，宿主保留综合分为空并将最终等级确定为 D。',
    'dimension_scores 必须且只能覆盖七个定义 key。不要计算综合分、覆盖率或最终等级，宿主会确定性计算。',
    '交易估值或条款缺失时，在 transaction_value.assessment 明确说明不能据此判断本轮交易价格吸引力。',
  ].join('\n')
}

export function validateSnapshotBoundLeadRatingEvidence(ratingV3: unknown, snapshotFacts: unknown[]) {
  const rating = ratingV3 && typeof ratingV3 === 'object' ? ratingV3 as Record<string, unknown> : {}
  const detail = rating.detailView && typeof rating.detailView === 'object' ? rating.detailView as Record<string, unknown> : {}
  const dimensions = Array.isArray(detail.dimensionScores) ? detail.dimensionScores : []
  const factMap = new Map(snapshotFacts.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const fact = value as Record<string, unknown>
    const id = String(fact.id || '')
    return id ? [[id, new Set(Array.isArray(fact.evidenceIds) ? fact.evidenceIds.map(String) : [])] as const] : []
  }))
  for (const raw of dimensions) {
    const dimension = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    if (dimension.score == null) continue
    const evidence = Array.isArray(dimension.keyEvidence) ? dimension.keyEvidence : []
    if (!evidence.length) throw new Error(`snapshot-bound dimension ${String(dimension.key || '')} has no traceable evidence`)
    for (const rawEvidence of evidence) {
      const item = rawEvidence && typeof rawEvidence === 'object' ? rawEvidence as Record<string, unknown> : {}
      const factId = String(item.factId || '')
      const evidenceIds = Array.isArray(item.evidenceIds) ? item.evidenceIds.map(String) : []
      const allowed = factMap.get(factId)
      if (!allowed || !evidenceIds.length || evidenceIds.some((id) => !allowed.has(id))) {
        throw new Error(`snapshot-bound rating evidence references an unknown fact/evidence id for ${String(dimension.key || '')}`)
      }
    }
  }
  return true
}

export function validateSnapshotBoundLeadRatingApplicability(ratingV3: unknown, topicStates: unknown) {
  const states = topicStates && typeof topicStates === 'object' && !Array.isArray(topicStates)
    ? topicStates as Record<string, unknown> : {}
  const rating = ratingV3 && typeof ratingV3 === 'object' && !Array.isArray(ratingV3)
    ? ratingV3 as Record<string, unknown> : {}
  const detail = rating.detailView && typeof rating.detailView === 'object' && !Array.isArray(rating.detailView)
    ? rating.detailView as Record<string, unknown> : {}
  const dimensions = Array.isArray(detail.dimensionScores) ? detail.dimensionScores : []
  if (states.financial_operations === 'not_applicable') {
    const financial = dimensions.find((item) => item && typeof item === 'object'
      && !Array.isArray(item) && (item as Record<string, unknown>).key === 'financial_operations') as Record<string, unknown> | undefined
    if (financial?.score != null) throw new Error('not-applicable financial topic must produce a null financial dimension score')
  }
  if (['missing', 'not_applicable'].includes(String(states.transaction_exit || ''))) {
    const transaction = detail.transactionValue && typeof detail.transactionValue === 'object' && !Array.isArray(detail.transactionValue)
      ? detail.transactionValue as Record<string, unknown> : {}
    if (transaction.valuationInformationAvailable !== false || transaction.termsInformationAvailable !== false) {
      throw new Error('missing or not-applicable transaction topic cannot claim valuation or terms availability')
    }
  }
  return true
}
