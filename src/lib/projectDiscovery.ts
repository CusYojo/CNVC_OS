import type { LeadListItem } from '../types'

export type ProjectDiscoveryPeriod = 'today' | 'week'
export type ProjectDiscoveryKind = 'all' | 'company' | 'research'

export type ProjectDiscoveryFilters = {
  period: ProjectDiscoveryPeriod
  query: string
  kind: ProjectDiscoveryKind
  now?: Date
}

export function projectDiscoveryDay(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] ?? ''
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

export function projectDiscoveryCandidateDay(lead: LeadListItem): string {
  return projectDiscoveryDay(lead.poolEnteredAt || lead.latestUpdates?.[0]?.occurredAt || lead.dataUpdatedAt)
}

export function shouldLoadNextProjectDiscoveryPage(
  candidates: readonly LeadListItem[],
  page: number,
  totalPages: number,
  now = new Date(),
): boolean {
  if (page >= totalPages) return false
  if (candidates.length === 0) return false
  const weekStart = projectDiscoveryDay(new Date(now.getTime() - 6 * 86_400_000).toISOString())
  const lastDay = projectDiscoveryCandidateDay(candidates[candidates.length - 1])
  return !lastDay || lastDay >= weekStart
}

export function filterProjectDiscoveryCandidates(
  candidates: readonly LeadListItem[],
  filters: ProjectDiscoveryFilters,
): LeadListItem[] {
  const now = filters.now ?? new Date()
  const today = projectDiscoveryDay(now.toISOString())
  const weekStart = projectDiscoveryDay(new Date(now.getTime() - 6 * 86_400_000).toISOString())
  const query = filters.query.trim().toLocaleLowerCase('zh-CN')

  return candidates.filter((lead) => {
    const kind = discoveryCandidateKind(lead)
    const day = projectDiscoveryCandidateDay(lead)
    if (!day || day > today) return false
    if (filters.period === 'today' && day !== today) return false
    if (filters.period === 'week' && day < weekStart) return false
    if (filters.kind !== 'all' && kind !== filters.kind) return false
    if (!query) return true
    return projectDiscoverySearchText(lead).includes(query)
  }).sort((left, right) => (
    projectDiscoveryCandidateDay(right).localeCompare(projectDiscoveryCandidateDay(left))
      || (right.poolEnteredAt || right.latestUpdates?.[0]?.occurredAt || right.dataUpdatedAt || '').localeCompare(left.poolEnteredAt || left.latestUpdates?.[0]?.occurredAt || left.dataUpdatedAt || '')
      || left.id.localeCompare(right.id)
  ))
}

export function buildProjectDiscoverySummary(candidates: readonly LeadListItem[]) {
  return candidates.reduce((summary, lead) => {
    const kind = discoveryCandidateKind(lead)
    const status = kind === 'research'
      ? lead.researchProfile?.dataStatus?.status
      : lead.investmentProfile?.dataStatus?.status
    return {
      total: summary.total + 1,
      companies: summary.companies + Number(kind === 'company'),
      research: summary.research + Number(kind === 'research'),
      verified: summary.verified + Number(status === 'verified' || status === 'partial'),
    }
  }, { total: 0, companies: 0, research: 0, verified: 0 })
}

export function discoveryCandidateKind(lead: LeadListItem): Exclude<ProjectDiscoveryKind, 'all'> {
  return lead.leadType === 'research' || lead.radarProfile?.channel === '论文' ? 'research' : 'company'
}

export function projectDiscoverySearchText(lead: LeadListItem): string {
  const investment = lead.investmentProfile
  const research = lead.researchProfile
  return [
    lead.name,
    lead.companyName,
    lead.region,
    ...(lead.businessTags?.industry ?? []),
    ...(lead.businessTags?.region ?? []),
    investment?.industry.level1,
    investment?.industry.level2,
    investment?.industry.segment,
    ...investment?.products.flatMap((item) => [item.name, item.productRoute, item.technologyRoute, item.productionStage]) ?? [],
    ...investment?.institutions.map((item) => item.name) ?? [],
    ...research?.direction?.categories ?? [],
    research?.direction?.researchProblem,
    ...research?.direction?.methods ?? [],
    ...research?.team?.authors?.map((item) => item.name) ?? [],
    ...lead.latestUpdates?.map((item) => item.title) ?? [],
  ].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN')
}
