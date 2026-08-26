import { normalizeFinancingText } from './leadFinancingFactService.js'

export const LEAD_DATA_QUALITY_SCHEMA_VERSION = 'lead-data-quality-v1' as const

export type LeadDataEvidenceStatus = 'source_supported' | 'source_labeled' | 'unverified' | 'not_applicable'
export type LeadFundingStatusDisplay = '已融资' | '未融资' | '未披露' | '待核验' | '不适用'

export type LeadDataQualityV1 = {
  schemaVersion: typeof LEAD_DATA_QUALITY_SCHEMA_VERSION
  method: 'codex-semantic-normalization-v1'
  model: string
  reviewedAt: string
  sourceStage: string
  funding: {
    stageDisplay: string
    evidenceStatus: LeadDataEvidenceStatus
    amountDisplay?: string
    amountEvidenceStatus?: LeadDataEvidenceStatus
  }
  businessStage: {
    stageDisplay: string
    evidenceStatus: LeadDataEvidenceStatus
  }
  reason: string
}

const PLACEHOLDER_STAGE = /^(?:待核验|待核实|待确认|阶段未知|经营与融资阶段待核验|融资轮次待核实)$/
const UNDISCLOSED_STAGE = /^(?:未披露|阶段未披露|项目阶段未披露|融资、工程化与商业化阶段均未披露)$/
const STANDARD_FINANCING_STAGE = /^(?:种子(?:\+{0,2})?轮|天使(?:\+{0,2})?轮|Pre-[ABC](?:\+)?轮?|[A-F](?:\d|\+{1,2})?轮|Pre-IPO|IPO|PE|私募|股权融资|战略融资|战略投资|风险投资\/联合投资|分拆增资融资|首轮融资|新一轮融资)$/i
const BUSINESS_STAGE_WORDS = /研发|原型|样机|试点|验证|测试|经营|运营|产品|商业化|量产|产业化|项目形态|主体性质|工程化|门店/

function text(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

export function readLeadDataQuality(value: unknown): LeadDataQualityV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<LeadDataQualityV1>
  if (candidate.schemaVersion !== LEAD_DATA_QUALITY_SCHEMA_VERSION
    || candidate.method !== 'codex-semantic-normalization-v1'
    || !candidate.funding || !candidate.businessStage) return null
  const validStatus = new Set<LeadDataEvidenceStatus>([
    'source_supported', 'source_labeled', 'unverified', 'not_applicable',
  ])
  if (!text(candidate.funding.stageDisplay) || !validStatus.has(candidate.funding.evidenceStatus)) return null
  if (!text(candidate.businessStage.stageDisplay) || !validStatus.has(candidate.businessStage.evidenceStatus)) return null
  return candidate as LeadDataQualityV1
}

export type DeterministicStageReview = Omit<LeadDataQualityV1, 'schemaVersion' | 'method' | 'model' | 'reviewedAt' | 'reason'> & {
  requiresModel: boolean
  reason: string
}

function historicalRound(value: string) {
  const match = value.match(/(?:历史(?:记录|资料)?(?:显示|披露|为)?|记录)(?:至)?(?:\d{4}年)?\s*(Pre-[ABC](?:\+)?|[A-F](?:\d|\+{1,2})?|种子|天使|战略融资|股权融资)轮?/i)
  if (!match) return ''
  const round = match[1]
  return /^(?:战略融资|股权融资)$/.test(round) ? round : `${round}轮`
}

export function publicLeadFundingStatus(
  stageDisplay: unknown,
  evidenceStatus: LeadDataEvidenceStatus,
): LeadFundingStatusDisplay {
  const stage = text(stageDisplay).replace(/^未融资（来源标注）$/, '未融资')
  if (evidenceStatus === 'not_applicable' || stage === '不适用') return '不适用'
  if (stage === '未融资') return '未融资'
  if (/未披露/.test(stage)) return '未披露'
  if (/历史|已披露融资|已完成融资/.test(stage) || STANDARD_FINANCING_STAGE.test(stage)) return '已融资'
  return '待核验'
}

export function deterministicLeadStageReview(input: {
  rawStage?: unknown
  sourceStage?: unknown
  isResearch?: boolean
}): DeterministicStageReview {
  if (input.isResearch) {
    return {
      sourceStage: text(input.rawStage || input.sourceStage),
      funding: { stageDisplay: '不适用', evidenceStatus: 'not_applicable' },
      businessStage: { stageDisplay: '科研成果', evidenceStatus: 'source_supported' },
      requiresModel: false,
      reason: '科研成果不适用企业融资轮次口径。',
    }
  }

  const rawStage = normalizeFinancingText(text(input.rawStage || input.sourceStage))
  const sourceStage = normalizeFinancingText(text(input.sourceStage))
  if (!rawStage || PLACEHOLDER_STAGE.test(rawStage)) {
    return {
      sourceStage,
      funding: { stageDisplay: '融资轮次待核验', evidenceStatus: 'unverified' },
      businessStage: { stageDisplay: '待核验', evidenceStatus: 'unverified' },
      requiresModel: false,
      reason: '现有字段没有可确认的融资轮次或经营阶段。',
    }
  }
  if (UNDISCLOSED_STAGE.test(rawStage)) {
    return {
      sourceStage,
      funding: { stageDisplay: '融资信息未披露', evidenceStatus: 'unverified' },
      businessStage: { stageDisplay: '待核验', evidenceStatus: 'unverified' },
      requiresModel: BUSINESS_STAGE_WORDS.test(rawStage),
      reason: '现有来源未披露可确认的融资轮次。',
    }
  }
  if (/^未融资$/.test(rawStage)) {
    return {
      sourceStage: sourceStage || rawStage,
      funding: { stageDisplay: '未融资', evidenceStatus: 'source_labeled' },
      businessStage: { stageDisplay: '待核验', evidenceStatus: 'unverified' },
      requiresModel: false,
      reason: '“未融资”仅作为来源标签展示，不提升为已核验事实。',
    }
  }
  if (STANDARD_FINANCING_STAGE.test(rawStage)) {
    return {
      sourceStage: sourceStage || rawStage,
      funding: { stageDisplay: rawStage.replace(/^Pre-([ABC])$/i, 'Pre-$1轮'), evidenceStatus: 'source_labeled' },
      businessStage: { stageDisplay: '待核验', evidenceStatus: 'unverified' },
      requiresModel: false,
      reason: '融资轮次沿用来源标签，经营阶段未作推断。',
    }
  }
  const historical = historicalRound(rawStage)
  if (historical) {
    return {
      sourceStage: sourceStage || rawStage,
      funding: { stageDisplay: `历史${historical}，当前轮次待核验`, evidenceStatus: 'source_labeled' },
      businessStage: { stageDisplay: '待核验', evidenceStatus: 'unverified' },
      requiresModel: BUSINESS_STAGE_WORDS.test(rawStage),
      reason: '仅保留来源中的历史融资轮次，不把历史记录表述为当前轮次。',
    }
  }
  return {
    sourceStage: sourceStage || rawStage,
    funding: { stageDisplay: '融资轮次待核验', evidenceStatus: 'unverified' },
    businessStage: { stageDisplay: '待核验', evidenceStatus: 'unverified' },
    requiresModel: true,
    reason: '原字段混合融资、经营或其他语义，需要 Codex 结构化复核。',
  }
}

export function publicLeadStageDisplay(input: {
  dataQuality?: unknown
  fallbackStage?: unknown
  isResearch?: boolean
}) {
  const quality = readLeadDataQuality(input.dataQuality)
  if (quality) {
    const fundingStage = quality.funding.stageDisplay === '未融资（来源标注）' ? '未融资' : quality.funding.stageDisplay
    return {
      fundingStage,
      fundingStatus: publicLeadFundingStatus(fundingStage, quality.funding.evidenceStatus),
      businessStage: quality.businessStage.stageDisplay,
      evidenceStatus: quality.funding.evidenceStatus,
    }
  }
  const fallback = deterministicLeadStageReview({ rawStage: input.fallbackStage, isResearch: input.isResearch })
  return {
    fundingStage: fallback.funding.stageDisplay,
    fundingStatus: publicLeadFundingStatus(fallback.funding.stageDisplay, fallback.funding.evidenceStatus),
    businessStage: fallback.businessStage.stageDisplay,
    evidenceStatus: fallback.funding.evidenceStatus,
  }
}
