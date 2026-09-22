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
export type ProjectDiscoveryKeywordKind = 'institution' | 'academic' | 'industry' | 'technology'
export type ProjectDiscoveryKeyword = { kind: ProjectDiscoveryKeywordKind; label: string; value: string }
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
  const candidate = lead.availableData
  const profile = lead.radarProfile?.profile
  const industry = [investment?.industry.level1, investment?.industry.level2]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' / ')
    || candidate?.industryTags.slice(0, 2).join(' / ')
    || profile?.sourceIndustries?.slice(0, 2).join(' / ')
    || lead.businessTags?.industry?.slice(0, 2).join(' / ')
    || '待补充'
  const team = investment?.academicLinks
    .flatMap((link) => [link.person, link.departmentLab, link.institution])
    .filter((value): value is string => Boolean(value?.trim()))
    .slice(0, 3)
    .join('、')
    || profile?.teamComposition
    || candidate?.academicLinks
      .flatMap((link) => [link.person, link.institution])
      .filter((value): value is string => Boolean(value?.trim()))
      .slice(0, 3)
      .join('、')
    || '待补充'
  const financing = investment?.financing.latestRound
    || investment?.financing.latestAmount
    || investment?.financing.latestRoundDate
    ? investment.financing
    : candidate?.financing ?? investment?.financing
  const institutions = investment?.institutions?.length ? investment.institutions : candidate?.institutions ?? []

  return {
    summary,
    facts: [
      { label: '行业分类', value: industry },
      { label: '最新融资日期', value: financing?.latestRoundDate || investment?.financing.latestCompletedAt || '未披露' },
      { label: '融资金额', value: financing?.latestAmount || investment?.financing.latestAmountSummary?.raw || '未披露' },
      { label: '融资轮次', value: financing?.latestRound || investment?.financing.latestCompletedRound || '未披露' },
      { label: '投资方', value: institutions.slice(0, 4).map((institution) => institution.name).filter(Boolean).join('、') || '未披露', wide: true },
      { label: '核心团队背景', value: team, wide: true },
    ],
  }
}

export function projectDiscoveryPrimaryDate(lead: LeadListItem): { label: string; value: string } {
  if (discoveryCandidateKind(lead) === 'research') {
    return {
      label: '公开日期',
      value: lead.researchProfile?.progress?.publishedAt || projectDiscoveryCandidateDay(lead) || '未披露',
    }
  }

  const investment = lead.investmentProfile
  const financing = investment?.financing.latestRound
    || investment?.financing.latestAmount
    || investment?.financing.latestRoundDate
    ? investment.financing
    : lead.availableData?.financing ?? investment?.financing

  return {
    label: '融资日期',
    value: financing?.latestRoundDate || investment?.financing.latestCompletedAt || '未披露',
  }
}

export function buildProjectDiscoveryKeywords(lead: LeadListItem): ProjectDiscoveryKeyword[] {
  const editedKeywords = lead.radarProfile?.profile?.discoveryKeywords
  if (Array.isArray(editedKeywords)) {
    return editedKeywords.filter((keyword): keyword is ProjectDiscoveryKeyword => (
      Boolean(keyword)
      && ['institution', 'academic', 'industry', 'technology'].includes(keyword.kind)
      && typeof keyword.label === 'string'
      && Boolean(keyword.label.trim())
      && typeof keyword.value === 'string'
      && Boolean(keyword.value.trim())
    )).slice(0, 8).map((keyword) => ({
      kind: keyword.kind,
      label: keyword.label.trim(),
      value: keyword.value.trim(),
    }))
  }
  if (discoveryCandidateKind(lead) === 'research') return buildResearchKeywords(lead)

  const investment = lead.investmentProfile
  const candidate = lead.availableData
  const profile = lead.radarProfile?.profile
  const institutions = investment?.institutions?.length ? investment.institutions : candidate?.institutions ?? []
  const rankedInstitutions = institutions
    .map((institution, index) => ({ institution, index }))
    .sort((left, right) => (
      Number(right.institution.major) - Number(left.institution.major)
      || Number(right.institution.role === 'lead') - Number(left.institution.role === 'lead')
      || left.index - right.index
    ))
    .map(({ institution }) => institution.name)

  const academicInstitutions = uniqueMeaningful([
    ...(investment?.academicLinks?.map((link) => link.institution) ?? []),
    ...(candidate?.academicLinks?.map((link) => link.institution) ?? []),
    ...(investment?.academicLinks?.flatMap((link) => extractAcademicInstitutions(link.departmentLab)) ?? []),
    ...extractAcademicInstitutions(profile?.teamComposition),
  ])
  const industry = firstMeaningful([
    investment?.industry.level2,
    investment?.industry.segment,
    investment?.industry.chainPosition,
    ...(candidate?.industryTags.slice(1) ?? []),
    ...(candidate?.industryTags ?? []),
    ...(profile?.sourceIndustries?.slice(1) ?? []),
    ...(profile?.sourceIndustries ?? []),
    ...(lead.businessTags?.industry ?? []),
  ])
  const products = investment?.products?.length ? investment.products : candidate?.products ?? []
  const technology = firstMeaningful([
    ...(profile?.coreTechnologies ?? []),
    ...products.map((product) => product.technologyRoute),
    ...products.map((product) => product.name),
    ...products.map((product) => product.productRoute),
    ...(profile?.products ?? []),
  ])

  return [
    ...uniqueMeaningful(rankedInstitutions).slice(0, 2).map((value): ProjectDiscoveryKeyword => ({ kind: 'institution', label: '机构', value })),
    ...academicInstitutions.slice(0, 1).map((value): ProjectDiscoveryKeyword => ({ kind: 'academic', label: '院校', value })),
    ...(industry ? [{ kind: 'industry', label: '产业', value: industry } as ProjectDiscoveryKeyword] : []),
    ...(technology ? [{ kind: 'technology', label: '技术', value: technology } as ProjectDiscoveryKeyword] : []),
  ]
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
    ...(lead.availableData?.industryTags ?? []),
    ...lead.availableData?.products.flatMap((item) => [item.name, item.productRoute, item.technologyRoute, item.productionStage]) ?? [],
    ...lead.availableData?.institutions.map((item) => item.name) ?? [],
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

const academicInstitutionPattern = /清华大学|清华|北京大学|北大|上海交通大学|上海交大|浙江大学|浙大|复旦大学|复旦|中国科学技术大学|中科大|南京大学|南大|哈尔滨工业大学|哈工大|北京航空航天大学|北航|西安交通大学|西安交大|同济大学|同济|武汉大学|武大|华中科技大学|华中科大|东南大学|电子科技大学|电子科大|西北工业大学|西工大|厦门大学|厦大|中山大学|天津大学|南开大学|中国科学院|中科院/gu

function extractAcademicInstitutions(value?: string): string[] {
  if (!value?.trim()) return []
  return value.match(academicInstitutionPattern) ?? []
}

function uniqueMeaningful(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => (
    typeof value === 'string' && value.length > 0 && !/^(?:其他|待补充|未披露|不适用)$/u.test(value)
  )))]
}

function firstMeaningful(values: Array<string | undefined>): string | undefined {
  return uniqueMeaningful(values)[0]
}

function buildResearchKeywords(lead: LeadListItem): ProjectDiscoveryKeyword[] {
  const research = lead.researchProfile
  const academic = uniqueMeaningful([
    ...(research?.team?.affiliations ?? []),
    lead.radarProfile?.profile?.lab,
    lead.companyName,
  ])[0]
  const industry = firstMeaningful([
    ...(research?.direction?.categories ?? []),
    research?.direction?.researchProblem,
  ])
  const technology = firstMeaningful(research?.direction?.methods ?? [])

  return [
    ...(academic ? [{ kind: 'academic', label: '机构', value: academic } as ProjectDiscoveryKeyword] : []),
    ...(industry ? [{ kind: 'industry', label: '方向', value: industry } as ProjectDiscoveryKeyword] : []),
    ...(technology ? [{ kind: 'technology', label: '方法', value: technology } as ProjectDiscoveryKeyword] : []),
  ]
}
