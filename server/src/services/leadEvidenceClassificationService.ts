import type { LeadEvidenceLevel } from './leadEnrichmentContract.js'

const REGULATORY_FILING_DOMAINS = [
  'cninfo.com.cn', 'sse.com.cn', 'szse.cn', 'bse.cn', 'hkexnews.hk',
  'sec.gov', 'sedarplus.ca',
] as const

const OFFICIAL_PUBLIC_RECORD_DOMAINS = [
  'gov.cn', 'court.gov.cn', 'cnipa.gov.cn', 'wipo.int', 'epo.org', 'uspto.gov',
  'gov.uk', 'europa.eu', 'go.jp', 'go.kr', 'gov.sg', 'gov.au',
] as const

function normalizedHost(value: string) {
  try { return new URL(value).hostname.toLowerCase().replace(/\.$/, '') } catch { return '' }
}

function matchesDomain(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`)
}

export function classifyLeadWebEvidence(input: { sourceUrl: string }): {
  evidenceLevel: LeadEvidenceLevel
  sourceType: 'official_regulatory_filing' | 'official_public_record' | 'controlled_web_fetch'
} {
  const host = normalizedHost(input.sourceUrl)
  if (host && REGULATORY_FILING_DOMAINS.some((domain) => matchesDomain(host, domain))) {
    return { evidenceLevel: 'E1', sourceType: 'official_regulatory_filing' }
  }
  if (host && OFFICIAL_PUBLIC_RECORD_DOMAINS.some((domain) => matchesDomain(host, domain))) {
    return { evidenceLevel: 'E2', sourceType: 'official_public_record' }
  }
  return { evidenceLevel: 'E3', sourceType: 'controlled_web_fetch' }
}
