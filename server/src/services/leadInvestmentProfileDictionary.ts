import { createHash } from 'node:crypto'

export type LeadInstitutionDictionaryRow = {
  canonical_name: string
  aliases: unknown
  institution_type: string
  tier: string | null
  major: number | boolean
}

export type LeadCustomerDictionaryRow = {
  canonical_name: string
  aliases: unknown
  tier: string
  confidentiality: string
}

export type LeadIndustryDictionaryRow = {
  canonical_name: string
  aliases: unknown
  level1: string
  level2: string | null
  segment: string | null
  chain_position: string | null
}

export type LeadAcademicInstitutionDictionaryRow = {
  canonical_name: string
  aliases: unknown
  institution_type: string
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function stringArray(value: unknown): string[] {
  const parsed = jsonValue(value)
  return Array.isArray(parsed) ? parsed.map(String).map((item) => item.normalize('NFKC').trim()).filter(Boolean) : []
}

function normalizedName(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
}

function stableTextCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function addDictionaryAlias<T extends { canonicalName: string }>(
  target: Record<string, T>,
  alias: string,
  item: T,
  kind: string,
) {
  const key = normalizedName(alias)
  if (!key) return
  const existing = target[key]
  if (existing && existing.canonicalName !== item.canonicalName) {
    throw new Error(`${kind} dictionary alias collision: ${alias}`)
  }
  target[key] = item
}

export function buildLeadInvestmentProfileDictionaries(input: {
  institutions: LeadInstitutionDictionaryRow[]
  customers: LeadCustomerDictionaryRow[]
  industries?: LeadIndustryDictionaryRow[]
  academicInstitutions?: LeadAcademicInstitutionDictionaryRow[]
}) {
  const institutionRows = [...input.institutions]
    .sort((left, right) => stableTextCompare(left.canonical_name, right.canonical_name))
  const customerRows = [...input.customers]
    .sort((left, right) => stableTextCompare(left.canonical_name, right.canonical_name))
  const industryRows = [...(input.industries ?? [])]
    .sort((left, right) => stableTextCompare(left.canonical_name, right.canonical_name))
  const academicInstitutionRows = [...(input.academicInstitutions ?? [])]
    .sort((left, right) => stableTextCompare(left.canonical_name, right.canonical_name))
  const institutions: Record<string, {
    canonicalName: string; type: string; tier?: string; major: boolean;
  }> = {}
  for (const row of institutionRows) {
    const item = {
      canonicalName: row.canonical_name,
      type: row.institution_type,
      tier: row.tier ?? undefined,
      major: Boolean(row.major),
    }
    for (const alias of [row.canonical_name, ...stringArray(row.aliases)].sort(stableTextCompare)) {
      addDictionaryAlias(institutions, alias, item, 'institution')
    }
  }
  const customers: Record<string, {
    canonicalName: string; tier: 'A' | 'B' | 'C'; confidentiality: 'public' | 'confidential' | 'restricted';
  }> = {}
  for (const row of customerRows) {
    if (!['A', 'B', 'C'].includes(row.tier)) throw new Error(`customer dictionary tier is invalid: ${row.tier}`)
    if (!['public', 'confidential', 'restricted'].includes(row.confidentiality)) {
      throw new Error(`customer dictionary confidentiality is invalid: ${row.confidentiality}`)
    }
    const item = {
      canonicalName: row.canonical_name,
      tier: row.tier as 'A' | 'B' | 'C',
      confidentiality: row.confidentiality as 'public' | 'confidential' | 'restricted',
    }
    for (const alias of [row.canonical_name, ...stringArray(row.aliases)].sort(stableTextCompare)) {
      addDictionaryAlias(customers, alias, item, 'customer')
    }
  }
  const industries: Record<string, {
    canonicalName: string; level1: string; level2?: string; segment?: string; chainPosition?: string;
  }> = {}
  for (const row of industryRows) {
    const item = {
      canonicalName: row.canonical_name,
      level1: row.level1,
      level2: row.level2 ?? undefined,
      segment: row.segment ?? undefined,
      chainPosition: row.chain_position ?? undefined,
    }
    // Only the canonical leaf and explicit aliases are match identities. Parent
    // names repeat across child rows and must not create ambiguous mappings.
    const identities = [row.canonical_name, ...stringArray(row.aliases)]
    for (const alias of identities.sort(stableTextCompare)) addDictionaryAlias(industries, alias, item, 'industry')
  }
  const academicInstitutions: Record<string, { canonicalName: string; type: string }> = {}
  for (const row of academicInstitutionRows) {
    const item = { canonicalName: row.canonical_name, type: row.institution_type }
    for (const alias of [row.canonical_name, ...stringArray(row.aliases)].sort(stableTextCompare)) {
      addDictionaryAlias(academicInstitutions, alias, item, 'academic institution')
    }
  }
  const canonical = {
    institutions: institutionRows.map((row) => ({
      canonicalName: row.canonical_name,
      aliases: stringArray(row.aliases).sort(stableTextCompare),
      type: row.institution_type,
      tier: row.tier,
      major: Boolean(row.major),
    })),
    customers: customerRows.map((row) => ({
      canonicalName: row.canonical_name,
      aliases: stringArray(row.aliases).sort(stableTextCompare),
      tier: row.tier,
      confidentiality: row.confidentiality,
    })),
    industries: industryRows.map((row) => ({
      canonicalName: row.canonical_name,
      aliases: stringArray(row.aliases).sort(stableTextCompare),
      level1: row.level1,
      level2: row.level2,
      segment: row.segment,
      chainPosition: row.chain_position,
    })),
    academicInstitutions: academicInstitutionRows.map((row) => ({
      canonicalName: row.canonical_name,
      aliases: stringArray(row.aliases).sort(stableTextCompare),
      type: row.institution_type,
    })),
  }
  const hashValue = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const hashes = {
    institutionHash: hashValue(canonical.institutions),
    customerHash: hashValue(canonical.customers),
    industryHash: hashValue(canonical.industries),
    academicHash: hashValue(canonical.academicInstitutions),
  }
  const hash = hashValue(canonical)
  return { institutions, customers, industries, academicInstitutions, hash, hashes }
}
