import {
  decodeInstitutionTrackingKey,
  encodeInstitutionTrackingKey,
} from '../contracts/institutionTrackingContract.js'

export { decodeInstitutionTrackingKey, encodeInstitutionTrackingKey }

type InstitutionDictionaryEntry = {
  id: string
  canonicalName: string
  aliases: string[]
  institutionType: string
  tier: string | null
  major: boolean
  status: string
}

type LeadInstitution = { name: string }
type DiscoveryCardEdits = {
  name: string
  primaryDate: string
  summary: string
  region: string
  sourceChannel: string
  briefFacts: Record<string, string>
}
type DiscoveryLead = {
  id: string
  name: string
  companyName?: string | null
  region?: string | null
  leadType?: string
  poolEnteredAt?: string | null
  latestUpdates?: Array<{ occurredAt?: string; title?: string }>
  radarProfile?: {
    channel?: unknown
    publishedAt?: unknown
    profile?: {
      discoveryCardEdits?: unknown
    }
  }
  investmentProfile?: unknown
  availableData?: {
    institutions?: LeadInstitution[]
    financing?: { latestRound?: string; latestRoundDate?: string; latestAmount?: string }
    industryTags?: string[]
  }
}

function cardEdits(lead: DiscoveryLead): DiscoveryCardEdits | undefined {
  const value = lead.radarProfile?.profile?.discoveryCardEdits
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const edits = value as Partial<DiscoveryCardEdits>
  return typeof edits.name === 'string' && edits.briefFacts && typeof edits.briefFacts === 'object' && !Array.isArray(edits.briefFacts)
    ? edits as DiscoveryCardEdits : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function investmentProfile(lead: DiscoveryLead): {
  institutions?: LeadInstitution[]
  financing?: { latestRound?: string; latestRoundDate?: string; latestAmount?: string }
  industry?: { level1?: string }
} | undefined {
  const value = lead.investmentProfile
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ReturnType<typeof investmentProfile> : undefined
}

function institutionList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => item && typeof item === 'object' && typeof item.name === 'string' ? [item.name] : [])
}

export type InstitutionTrackingProject = {
  leadId: string
  name: string
  companyName: string
  announcedAt: string
  round: string
  amount: string
  industry: string
  region: string
  summary: string
  sourceChannel: string
}

export type InstitutionTrackingProfile = {
  key: string
  name: string
  aliases: string[]
  institutionType: string
  tier: string | null
  major: boolean
  projectCount: number
  latestInvestmentAt: string
  focusIndustries: string[]
  recentProjects: InstitutionTrackingProject[]
}

function identity(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\p{P}\p{S}\s]+/gu, '')
}

function institutionNames(lead: DiscoveryLead): string[] {
  if (lead.leadType === 'research') return []
  const edits = cardEdits(lead)
  const editedInvestors = edits?.briefFacts?.['投资方']
  const investment = investmentProfile(lead)
  const verifiedNames = institutionList(investment?.institutions)
  const source = typeof editedInvestors === 'string'
    ? editedInvestors.split(/[、,，;；\n]+/u)
    : verifiedNames.length ? verifiedNames : institutionList(lead.availableData?.institutions)
  const placeholders = new Set(['未披露', '待补充', '待核验', '无', '不适用', '-'])
  return [...new Set(source.map((name) => name.normalize('NFKC').trim())
    .filter((name) => name.length > 0 && name.length <= 255 && !placeholders.has(name)))].slice(0, 20)
}

function trackingProject(lead: DiscoveryLead): InstitutionTrackingProject {
  const edits = cardEdits(lead)
  const investment = investmentProfile(lead)
  const financing = investment?.financing?.latestRound
    || investment?.financing?.latestAmount
    || investment?.financing?.latestRoundDate
    ? investment.financing
    : lead.availableData?.financing ?? investment?.financing
  return {
    leadId: lead.id,
    name: edits?.name || lead.name,
    companyName: lead.companyName || '',
    announcedAt: (edits?.primaryDate || financing?.latestRoundDate || text(lead.radarProfile?.publishedAt)
      || lead.latestUpdates?.[0]?.occurredAt || lead.poolEnteredAt || '').slice(0, 10),
    round: edits?.briefFacts?.['融资轮次'] ?? financing?.latestRound ?? '',
    amount: edits?.briefFacts?.['融资金额'] ?? financing?.latestAmount ?? '',
    industry: edits?.briefFacts?.['行业分类'] ?? investment?.industry?.level1
      ?? lead.availableData?.industryTags?.[0] ?? '',
    region: edits?.region ?? lead.region ?? '',
    summary: edits?.summary ?? lead.latestUpdates?.[0]?.title ?? '',
    sourceChannel: edits?.sourceChannel ?? text(lead.radarProfile?.channel),
  }
}

function aliasIndex(dictionary: readonly InstitutionDictionaryEntry[]): Map<string, InstitutionDictionaryEntry | null> {
  const result = new Map<string, InstitutionDictionaryEntry | null>()
  for (const entry of dictionary.filter((item) => item.status === 'active')) {
    if (typeof entry.canonicalName !== 'string' || !entry.canonicalName.trim()) continue
    for (const name of [entry.canonicalName, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]) {
      if (typeof name !== 'string') continue
      const key = identity(name)
      if (!key) continue
      const current = result.get(key)
      result.set(key, current && current.id !== entry.id ? null : current === null ? null : entry)
    }
  }
  return result
}

export function buildInstitutionTrackingDirectory(
  leads: readonly DiscoveryLead[],
  dictionary: readonly InstitutionDictionaryEntry[],
): InstitutionTrackingProfile[] {
  const aliases = aliasIndex(dictionary)
  const directory = new Map<string, InstitutionTrackingProfile>()
  for (const entry of dictionary.filter((item) => item.status === 'active')) {
    if (typeof entry.canonicalName !== 'string' || !entry.canonicalName.trim()) continue
    directory.set(entry.canonicalName, {
      key: encodeInstitutionTrackingKey(entry.canonicalName),
      name: entry.canonicalName,
      aliases: Array.isArray(entry.aliases) ? entry.aliases.filter((name): name is string => typeof name === 'string') : [],
      institutionType: entry.institutionType,
      tier: entry.tier,
      major: entry.major,
      projectCount: 0,
      latestInvestmentAt: '',
      focusIndustries: [],
      recentProjects: [],
    })
  }
  for (const lead of leads) {
    const project = trackingProject(lead)
    const seen = new Set<string>()
    for (const name of institutionNames(lead)) {
      const matched = aliases.get(identity(name))
      if (matched === null) continue // Ambiguous dictionary aliases require human resolution.
      const canonicalName = matched?.canonicalName ?? name
      if (seen.has(canonicalName)) continue
      seen.add(canonicalName)
      const current = directory.get(canonicalName) ?? {
        key: encodeInstitutionTrackingKey(canonicalName),
        name: canonicalName,
        aliases: [],
        institutionType: '',
        tier: null,
        major: false,
        projectCount: 0,
        latestInvestmentAt: '',
        focusIndustries: [],
        recentProjects: [],
      }
      directory.set(canonicalName, {
        ...current,
        projectCount: current.projectCount + 1,
        recentProjects: [...current.recentProjects, project],
      })
    }
  }
  return [...directory.values()].map((entry) => {
    const recentProjects = [...entry.recentProjects].sort((left, right) =>
      right.announcedAt.localeCompare(left.announcedAt) || left.leadId.localeCompare(right.leadId))
    return {
      ...entry,
      recentProjects,
      latestInvestmentAt: recentProjects[0]?.announcedAt ?? '',
      focusIndustries: [...new Set(recentProjects.map((project) => project.industry).filter(Boolean))].slice(0, 5),
    }
  }).sort((left, right) => right.projectCount - left.projectCount || left.name.localeCompare(right.name, 'zh-CN'))
}

export function findInstitutionTrackingProfile(
  key: string,
  leads: readonly DiscoveryLead[],
  dictionary: readonly InstitutionDictionaryEntry[],
): InstitutionTrackingProfile | null {
  const requestedName = decodeInstitutionTrackingKey(key)
  if (!requestedName) return null
  const directory = buildInstitutionTrackingDirectory(leads, dictionary)
  const nameKey = identity(requestedName)
  const matching = directory.filter((item) => [item.name, ...item.aliases].some((name) => identity(name) === nameKey))
  return matching.length === 1 ? matching[0] : null
}
