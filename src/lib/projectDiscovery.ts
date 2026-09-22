import type { LeadListItem } from '../types'

export type ProjectDiscoveryPeriod = 'today' | 'week' | 'all'
export type ProjectDiscoveryKind = 'all' | 'company' | 'research'

export type ProjectDiscoveryFilters = {
  period: ProjectDiscoveryPeriod
  query: string
  kind: ProjectDiscoveryKind
  now?: Date
}

export type ProjectDiscoveryBriefFact = { label: string; value: string; wide?: boolean }
export type ProjectDiscoveryBrief = { summary: string; facts: ProjectDiscoveryBriefFact[] }
export type ProjectDiscoveryPage<T> = { list: T[]; page: number; totalPages: number }
export type LoadedProjectDiscoveryPage<T> = ProjectDiscoveryPage<T> & { items: T[] }

export async function loadProjectDiscoveryPage<T extends { id: string }>(
  fetchPage: (page: number) => Promise<ProjectDiscoveryPage<T> | null | undefined>,
  page: number,
  existing: readonly T[],
  onItems: (items: T[]) => void,
): Promise<LoadedProjectDiscoveryPage<T> | null> {
  const response = await fetchPage(page)
  if (!response) return null
  const unique = new Map([...existing, ...response.list].map((item) => [item.id, item]))
  const items = [...unique.values()]
  onItems(items)
  return { ...response, items }
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
  return projectDiscoveryDay(lead.radarProfile?.publishedAt || lead.latestUpdates?.[0]?.occurredAt || lead.poolEnteredAt || lead.dataUpdatedAt)
}

export function shouldLoadNextProjectDiscoveryPage(
  _candidates: readonly LeadListItem[],
  page: number,
  totalPages: number,
  _now = new Date(),
): boolean {
  return page < totalPages
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
      || (right.radarProfile?.publishedAt || right.latestUpdates?.[0]?.occurredAt || right.poolEnteredAt || right.dataUpdatedAt || '').localeCompare(left.radarProfile?.publishedAt || left.latestUpdates?.[0]?.occurredAt || left.poolEnteredAt || left.dataUpdatedAt || '')
      || left.id.localeCompare(right.id)
  ))
}

export function buildProjectDiscoveryBrief(lead: LeadListItem): ProjectDiscoveryBrief {
  const kind = discoveryCandidateKind(lead)
  const summary = oneSentence(
    lead.latestUpdates?.[0]?.title
      || lead.researchProfile?.direction?.researchProblem
      || lead.investmentProfile?.products[0]?.name
      || '结构化信息待进一步核对',
  )

  if (kind === 'research') {
    const research = lead.researchProfile
    const legacyDirection = (research as unknown as { researchDirection?: string } | undefined)?.researchDirection
    const direction = research?.direction?.researchProblem
      || research?.direction?.categories?.join(' / ')
      || legacyDirection
      || '待补充'
    const team = research?.team?.authors?.slice(0, 3).map((author) => author.name).filter(Boolean).join('、') || '待补充'
    return {
      summary,
      facts: [
        { label: '研究方向', value: direction },
        { label: '公开日期', value: research?.progress?.publishedAt || projectDiscoveryCandidateDay(lead) || '未披露' },
        { label: '成果类型', value: research?.progress?.resourceType || '科研成果' },
        { label: '公开场合', value: research?.progress?.venue || '未披露' },
        { label: '所属机构', value: research?.team?.affiliations?.slice(0, 3).join('、') || lead.companyName || lead.radarProfile?.profile?.lab || '待补充', wide: true },
        { label: '核心团队背景', value: team, wide: true },
      ],
    }
  }

  const investment = lead.investmentProfile
  const industry = [investment?.industry.level1, investment?.industry.level2]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' / ')
    || lead.businessTags?.industry?.slice(0, 2).join(' / ')
    || '待补充'
  const team = investment?.academicLinks
    .flatMap((link) => [link.person, link.departmentLab, link.institution])
    .filter((value): value is string => Boolean(value?.trim()))
    .slice(0, 3)
    .join('、') || '待补充'

  return {
    summary,
    facts: [
      { label: '行业分类', value: industry },
      { label: '最新融资日期', value: investment?.financing.latestRoundDate || investment?.financing.latestCompletedAt || '未披露' },
      { label: '融资金额', value: investment?.financing.latestAmount || investment?.financing.latestAmountSummary?.raw || '未披露' },
      { label: '融资轮次', value: investment?.financing.latestRound || investment?.financing.latestCompletedRound || '未披露' },
      { label: '投资方', value: investment?.institutions.slice(0, 4).map((institution) => institution.name).filter(Boolean).join('、') || '未披露', wide: true },
      { label: '核心团队背景', value: team, wide: true },
    ],
  }
}

export function discoveryCandidateKind(lead: LeadListItem): Exclude<ProjectDiscoveryKind, 'all'> {
  return lead.leadType === 'research' || lead.radarProfile?.channel === '论文' ? 'research' : 'company'
}

export function projectDiscoveryStatusLabel(poolStatus: LeadListItem['poolStatus']): string {
  if (poolStatus === '已转专属项目') return '已入库'
  if (poolStatus === '已合并') return '已合并'
  return '待审核'
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

function oneSentence(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  const selected = (normalized.match(/[^。！？!?]+[。！？!?]?/u)?.[0] ?? normalized).trim()
  return selected.length > 120 ? `${selected.slice(0, 119).trimEnd()}…` : selected
}
