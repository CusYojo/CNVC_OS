import { z } from 'zod'

export const LEAD_COMPANY_INTEL_FIELDS = [
  'companyName',
  'companyIntroduction',
  'website',
  'registeredCapital',
  'legalRepresentative',
  'foundedAt',
  'creditCode',
  'registrationStatus',
  'companyType',
  'registeredAddress',
] as const

export type LeadCompanyIntelField = typeof LEAD_COMPANY_INTEL_FIELDS[number]

export type LeadCompanyIntelEvidence = {
  field: LeadCompanyIntelField
  value: string
  quote: string
  sourceUrl: string
}

export type LeadCompanyIntelSearchEvidence = {
  title?: string
  snippet?: string
  url?: string
}

export const leadCompanyIntelExtractionSchema = z.object({
  fields: z.array(z.object({
    field: z.enum(LEAD_COMPANY_INTEL_FIELDS),
    value: z.string().min(1).max(1_000),
    quote: z.string().min(1).max(2_000),
    sourceUrl: z.string().url().max(4_000),
  }).strict()).max(LEAD_COMPANY_INTEL_FIELDS.length),
}).strict()

function compact(value: unknown) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : ''
}

function comparable(value: unknown) {
  return compact(value).toLocaleLowerCase().replace(/[\s,，。；;：:（）()【】\[\]"'“”‘’·\-_/]/g, '')
}

export function validLegalCompanyName(value: unknown) {
  return /(?:有限责任公司|股份有限公司|集团有限公司|有限公司)$/.test(compact(value))
}

export function validLeadCompanyIntelValue(field: LeadCompanyIntelField, value: string, sourceUrl: string, quote = '') {
  if (field === 'companyName') return validLegalCompanyName(value)
  if (field === 'companyIntroduction') return value.length >= 20 && value.length <= 1_000
  if (field === 'website') {
    try {
      const parsed = new URL(value)
      const evidenceUrl = new URL(sourceUrl)
      return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
        && parsed.hostname.toLocaleLowerCase() === evidenceUrl.hostname.toLocaleLowerCase()
        && !/(?:^|\.)(?:bing\.com|sogou\.com)$/.test(parsed.hostname.toLocaleLowerCase())
    } catch { return false }
  }
  if (field === 'creditCode') return /^[0-9A-HJ-NPQRTUWXY]{18}$/.test(value.toUpperCase())
  if (field === 'foundedAt') return /^(?:19|20)\d{2}(?:[-/.年](?:1[0-2]|0?[1-9])(?:[-/.月](?:3[01]|[12]\d|0?[1-9])日?)?)?$/.test(value)
    && /(?:工商|登记|注册成立|成立日期|注册日期)/.test(quote)
  if (field === 'registeredCapital') return /\d/.test(value) && /(?:元|万|亿|币|资本)/.test(value)
  return value.length >= 2
}

/**
 * Treat model output as a proposal only. Every accepted scalar must point to an exact search
 * result URL, quote text from that result, and (except website) repeat the value in that quote.
 */
export function validateLeadCompanyIntelExtraction(input: {
  raw: unknown
  requestedFields: LeadCompanyIntelField[]
  searchEvidence: LeadCompanyIntelSearchEvidence[]
}) {
  const parsed = leadCompanyIntelExtractionSchema.parse(input.raw)
  const requested = new Set(input.requestedFields)
  const evidenceByUrl = new Map(
    input.searchEvidence
      .map((item) => [compact(item.url), compact(`${item.title || ''} ${item.snippet || ''}`)] as const)
      .filter(([url]) => Boolean(url)),
  )
  const accepted = new Map<LeadCompanyIntelField, LeadCompanyIntelEvidence>()
  for (const candidate of parsed.fields) {
    if (!requested.has(candidate.field) || accepted.has(candidate.field)) continue
    const value = compact(candidate.value)
    const quote = compact(candidate.quote)
    const sourceUrl = compact(candidate.sourceUrl)
    const sourceText = evidenceByUrl.get(sourceUrl)
    if (!sourceText || !comparable(sourceText).includes(comparable(quote))) continue
    if (!['website', 'companyIntroduction'].includes(candidate.field) && !comparable(quote).includes(comparable(value))) continue
    if (!validLeadCompanyIntelValue(candidate.field, value, sourceUrl, quote)) continue
    accepted.set(candidate.field, {
      field: candidate.field,
      value: candidate.field === 'creditCode' ? value.toUpperCase() : value,
      quote,
      sourceUrl,
    })
  }
  return [...accepted.values()]
}
