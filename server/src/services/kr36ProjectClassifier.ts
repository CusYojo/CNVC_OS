import { companyRegistrationEligibility } from './leadRegistry.js'

export const KR36_SCOPE_RULES_VERSION = 'kr36-all-industries-v2'
export const KR36_MIN_FOUNDED_YEAR = 2025

export type Kr36SectorLabel = 'artificial_intelligence' | 'embodied_intelligence' | 'semiconductor'
export type Kr36ScopeStatus = 'eligible' | 'founded_before_2025' | 'founded_at_pending' | 'sector_unmatched' | 'registration_ineligible'

export type Kr36ScopeDecision = {
  status: Kr36ScopeStatus
  eligible: boolean
  foundedAt: string | null
  sectorLabels: Kr36SectorLabel[]
  reasons: string[]
  rulesVersion: string
}

const SECTOR_PATTERNS: Array<[Kr36SectorLabel, RegExp]> = [
  ['artificial_intelligence', /(?:人工智能|大模型|智能体|AIGC|\bAGI\b|\bAI\b|机器学习|深度学习|多模态|计算机视觉|自然语言|生成式|模型训练|模型推理|智能算力)/iu],
  ['embodied_intelligence', /(?:具身|人形机器人|机器人|\brobot(?:ics)?\b|灵巧手|机械臂|\bVLA\b|运动控制|伺服系统|大小脑控制|外骨骼)/iu],
  ['semiconductor', /(?:半导体|芯片|集成电路|晶圆|\bEDA\b|封装测试|先进封装|光刻|掩膜|探针卡|功率器件|\bSoC\b|\bGPU\b|\bNPU\b|\bFPGA\b|\bMCU\b|\bASIC\b|IP核)/iu],
]

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : ''
}

export function normalizeKr36FoundedAt(detailValue: unknown): string | null {
  const detail = objectValue(detailValue)
  const business = objectValue(detail.business)
  const raw = business.estiblishTime ?? detail.setupDate
  if (raw === null || raw === undefined || raw === '') return null
  const text = String(raw).trim()
  let date: Date | null = null
  if (/^\d{12,}$/.test(text)) {
    date = new Date(Number(text))
    if (Number.isNaN(date.getTime())) return null
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date)
  }
  else if (/^\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?$/.test(text)) {
    const match = text.match(/^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2})日?)?$/)
    if (match) date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3] ?? 1)))
  } else if (/^\d{4}$/.test(text)) date = new Date(Date.UTC(Number(text), 0, 1))
  if (!date || Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

export function kr36ClassificationText(detailValue: unknown, listItemValue?: unknown): string {
  const detail = objectValue(detailValue)
  const listItem = objectValue(listItemValue)
  const arrayText = (value: unknown) => Array.isArray(value)
    ? value.map((item) => {
      const object = objectValue(item)
      return normalizedText(object.name ?? object.label ?? item)
    }).filter(Boolean).join(' ')
    : ''
  return [
    detail.name, detail.companyName, detail.oneWord, detail.intro,
    arrayText(detail.industryList), arrayText(detail.tagList),
    listItem.name, listItem.companyName, listItem.oneWord, listItem.intro,
    arrayText(listItem.industryList), arrayText(listItem.tagList),
  ].map(normalizedText).filter(Boolean).join(' ')
}

export function classifyKr36Project(input: {
  detail: unknown
  listItem?: unknown
  minimumYear?: number
  rulesVersion?: string
}): Kr36ScopeDecision {
  const minimumYear = input.minimumYear ?? KR36_MIN_FOUNDED_YEAR
  const foundedAt = normalizeKr36FoundedAt(input.detail)
  const text = kr36ClassificationText(input.detail, input.listItem)
  const detail = objectValue(input.detail)
  const business = objectValue(detail.business)
  const registrationStatus = normalizedText(
    business.registrationStatus ?? business.businessStatus ?? business.regStatus ?? business.regStatusName
      ?? detail.registrationStatus ?? detail.businessStatus ?? detail.regStatus,
  )
  const registration = companyRegistrationEligibility(registrationStatus)
  const sectorLabels = SECTOR_PATTERNS.flatMap(([label, pattern]) => pattern.test(text) ? [label] : [])
  const reasons: string[] = []

  if (!foundedAt) reasons.push('36氪详情未提供可验证的成立日期')
  else if (Number(foundedAt.slice(0, 4)) < minimumYear) reasons.push(`成立年份早于${minimumYear}年`)
  if (!registration.eligibleForLeadPool) reasons.push(registration.reason ?? '工商登记状态不符合共享线索池准入条件')

  let status: Kr36ScopeStatus = 'eligible'
  if (!foundedAt) status = 'founded_at_pending'
  else if (Number(foundedAt.slice(0, 4)) < minimumYear) status = 'founded_before_2025'
  else if (!registration.eligibleForLeadPool) status = 'registration_ineligible'
  if (status === 'eligible') reasons.push(`成立于${minimumYear}年及以后且工商登记状态符合全行业准入规则`)

  return {
    status,
    eligible: status === 'eligible',
    foundedAt,
    sectorLabels,
    reasons,
    rulesVersion: input.rulesVersion ?? KR36_SCOPE_RULES_VERSION,
  }
}
