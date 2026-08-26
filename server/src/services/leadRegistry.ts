import { formatShanghaiDateKey } from '../utils/shanghaiTime.js'

export type LeadRegistry = Record<string, unknown> & {
  companyName?: string
  foundedAt?: string
  registeredCapital?: string
  legalRepresentative?: string
  creditCode?: string
  registrationStatus?: string
  companyType?: string
  registeredAddress?: string
  regLocation?: string
}

export type CompanyRegistrationEligibility = {
  normalizedStatus: string
  eligibleForLeadPool: boolean
  reason: string | null
}

const PLACEHOLDERS = new Set([
  '', '待核验', '待核实', '未披露', '未披露/待核实', '未披露/待验证',
  '未识别/待核实', '不适用', '无', '-', 'N/A', 'null', 'undefined',
])

export function meaningfulLeadRegistryText(value: unknown): string {
  const text = typeof value === 'string' || typeof value === 'number'
    ? String(value).normalize('NFKC').trim()
    : ''
  return text && !PLACEHOLDERS.has(text) ? text : ''
}

/**
 * Deterministic public-pool admission rule. Only an explicit deregistration signal
 * blocks admission; unknown, migrating or ambiguous descriptions stay reviewable.
 * “吊销” is deliberately not folded into “注销” because it is a different legal state.
 */
export function companyRegistrationEligibility(value: unknown): CompanyRegistrationEligibility {
  const normalizedStatus = meaningfulLeadRegistryText(value)
    .normalize('NFKC')
    .replace(/[\s（）()【】\[\]]+/g, '')
  const deregistered = /^(?:已)?注销(?:企业|登记)?$/.test(normalizedStatus)
    || /(?:登记状态|企业状态|经营状态)[:：]?(?:已)?注销/.test(normalizedStatus)
  return {
    normalizedStatus,
    eligibleForLeadPool: !deregistered,
    reason: deregistered ? '工商登记状态明确为注销，不符合共享线索池准入条件' : null,
  }
}

export function isDeregisteredCompany(value: unknown): boolean {
  return !companyRegistrationEligibility(value).eligibleForLeadPool
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function first(sources: Record<string, unknown>[], keys: string[]): string {
  for (const source of sources) {
    for (const key of keys) {
      const value = meaningfulLeadRegistryText(source[key])
      if (value) return value
    }
  }
  return ''
}

export function normalizeLeadFoundedAt(value: unknown): string {
  const text = meaningfulLeadRegistryText(value)
  if (!text) return ''
  if (/^\d{12,}$/.test(text)) {
    const parsed = new Date(Number(text))
    return Number.isNaN(parsed.getTime()) ? '' : formatShanghaiDateKey(parsed)
  }
  // Longer alternatives must come first; otherwise "18" would be accepted as day "1".
  const dateMatch = text.match(/(?:19|20)\d{2}[-/.年](?:1[0-2]|0?[1-9])[-/.月](?:3[01]|[12]\d|0?[1-9])日?/)
  if (dateMatch) return dateMatch[0].replace(/[年/.]/g, '-').replace('月', '-').replace('日', '')
  return text.slice(0, 32)
}

/**
 * Merge registry objects by priority (first source wins), discard placeholders and expose
 * one canonical field contract. Legacy keys remain readable but never override canonical data.
 */
export function normalizeLeadRegistry(...values: unknown[]): LeadRegistry {
  const sources = values.map(record)
  const merged: LeadRegistry = {}
  for (const source of [...sources].reverse()) {
    for (const [key, raw] of Object.entries(source)) {
      const value = meaningfulLeadRegistryText(raw)
      if (value) merged[key] = value
    }
  }
  const companyName = first(sources, ['companyName', 'company_name', 'name'])
  const foundedAt = normalizeLeadFoundedAt(first(sources, [
    'foundedAt', 'establishDate', 'establishedAt', 'estiblishTime', 'setupDate',
  ]))
  const registeredCapital = first(sources, ['registeredCapital', 'registered_capital', 'regCapital'])
  const legalRepresentative = first(sources, ['legalRepresentative', 'legalPersonName', 'legalPerson'])
  const creditCode = first(sources, ['creditCode', 'unifiedSocialCreditCode', 'socialCreditCode'])
  const registrationStatus = first(sources, [
    'registrationStatus', 'businessStatus', 'regStatus', 'regStatusName', 'enterpriseStatus',
  ])
  const companyType = first(sources, ['companyType', 'enterpriseType'])
  const registeredAddress = first(sources, ['registeredAddress', 'regLocation', 'address'])

  if (companyName) merged.companyName = companyName
  if (foundedAt) merged.foundedAt = foundedAt
  if (registeredCapital) merged.registeredCapital = registeredCapital
  if (legalRepresentative) merged.legalRepresentative = legalRepresentative
  if (creditCode) merged.creditCode = creditCode
  if (registrationStatus) merged.registrationStatus = registrationStatus
  if (companyType) merged.companyType = companyType
  if (registeredAddress) {
    merged.registeredAddress = registeredAddress
    merged.regLocation = registeredAddress
  }
  return merged
}
