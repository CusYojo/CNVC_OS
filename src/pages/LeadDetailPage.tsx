import {
  AlertTriangle, ArrowLeft, Building2, CalendarDays, Download, ExternalLink,
  LoaderCircle, MapPin, Sparkles, Trash2, UserRound, UsersRound,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Button, EmptyState, Modal } from '../components/ui'
import { useToast } from '../components/Toast'
import { apiDelete, apiGet } from '../lib/api'
import {
  displayLeadDetailValue,
  displayLeadFundingValue,
  displayLeadInvestorNames,
  displayLeadRegisteredAddress,
  isLegalCompanyName,
  splitLeadIndustryTags,
  verifiedCompanyWebsite,
} from '../lib/leadPresentation'
import { useAppStore } from '../store/useAppStore'
import { useAuthStore } from '../store/useAuthStore'
import type { Lead } from '../types'

function text(value: unknown, fallback = '-') {
  return displayLeadDetailValue(value, fallback)
}

function multilineText(value: unknown, fallback: string) {
  return text(value, fallback)
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\r\n?/g, '\n')
}

function isResearch(lead: Lead) {
  return lead.leadType === 'research' || lead.radarProfile?.channel === '论文'
}

export function leadDetailSectionVisibility(lead: Pick<Lead, 'radarProfile'>) {
  const isPaperChannel = lead.radarProfile?.channel === '论文'
  return {
    productCommercialization: !isPaperChannel,
    investmentProfile: false,
  }
}

function displayDate(value?: string) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return displayLeadDetailValue(value)
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).replace(/\//g, '.')
}

function externalUrl(value?: string | null) {
  if (!value) return ''
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''
  } catch { return '' }
}

function productionStageLabel(product: NonNullable<Lead['investmentProfile']>['products'][number]) {
  if (!product.productionStage) return ''
  if (product.productionStageStatus === 'planned') return `计划：${product.productionStage}`
  if (product.productionStageStatus === 'realized') return `已实现：${product.productionStage}`
  return `阶段口径未披露：${product.productionStage}`
}

type DisplayTeamMember = {
  name: string
  title?: string
  background?: string
  profileUrl?: string
  sourceUrl?: string
}

type LeadVerifiedProfile = {
  frozenAt?: string | null
  introductions: {
    companyIntroduction?: string | null
    teamIntroduction?: string | null
    projectIntroduction?: string | null
  }
  introductionSources: {
    companyIntroduction: LeadEnrichmentEvidence[]
    teamIntroduction: LeadEnrichmentEvidence[]
    projectIntroduction: LeadEnrichmentEvidence[]
  }
}

type LeadEnrichmentEvidence = {
  sourceUrl: string
  title?: string | null
  publisher?: string | null
  accessedAt?: string
}

type LeadEnrichmentFact = {
  id: string
  subjectType: string
  factKey: string
  instanceKey?: string
  value: unknown
  verificationStatus: string
  investmentProfileSource?: boolean
  evidence: LeadEnrichmentEvidence[]
}

type LeadEnrichmentFactsResponse = {
  facts: LeadEnrichmentFact[]
  total: number
  hasMore: boolean
  page: number
  pageSize: number
}

export type InvestmentProfileEvidenceArea = 'industryProduct' | 'background' | 'financing' | 'valuation' | 'customers'

export function canManageLeadPool(user: { role?: string; permissionCodes?: string[] } | null | undefined): boolean {
  return Boolean(user?.permissionCodes?.includes('system.manage') || user?.role === '系统管理员')
}

export function canReviewLeadInvestmentProfileConflicts(
  user: { role?: string; permissionCodes?: string[] } | null | undefined,
  conflictCount: number | undefined,
): boolean {
  return canManageLeadPool(user) && Number.isInteger(conflictCount) && Number(conflictCount) > 0
}

export function shouldRetainLeadConflictReview(input: {
  user: { role?: string; permissionCodes?: string[] } | null | undefined
  routeLeadId: string | undefined
  loadedLeadId: string | undefined
  conflictCount: number | undefined
}): boolean {
  return Boolean(
    input.routeLeadId
    && input.loadedLeadId === input.routeLeadId
    && canReviewLeadInvestmentProfileConflicts(input.user, input.conflictCount),
  )
}

const INVESTMENT_PROFILE_FACT_MATCHERS: Record<InvestmentProfileEvidenceArea, (factKey: string) => boolean> = {
  industryProduct: (factKey) => /^(?:industry\.|product\.)/.test(factKey)
    || /^(?:technology\.route|production\.stage)$/.test(factKey),
  background: (factKey) => /^financing\.(?:lead_investor|investors|investor_role)$/.test(factKey)
    || /^team\.(?:institution|institution_relation|department_lab|institution_period|member|founder|cofounder)$/.test(factKey)
    || factKey === 'technology.transfer_status',
  financing: (factKey) => /^financing\./.test(factKey),
  valuation: (factKey) => /^transaction\.(?:valuation|pre_money|post_money|round|currency|date)$/.test(factKey)
    || /^financing\.(?:round|date)$/.test(factKey),
  customers: (factKey) => /^(?:customer\.|contract\.|order\.|delivery\.|cash_collection\.)/.test(factKey),
}

function isEvidenceBackedFact(fact: LeadEnrichmentFact) {
  return fact.verificationStatus === 'verified'
    && fact.evidence.some((evidence) => Boolean(externalUrl(evidence.sourceUrl)))
}

export function investmentProfileEvidenceSources(facts: LeadEnrichmentFact[], area: InvestmentProfileEvidenceArea) {
  const matcher = INVESTMENT_PROFILE_FACT_MATCHERS[area]
  const sources = facts
    .filter((fact) => fact.investmentProfileSource === true && isEvidenceBackedFact(fact) && matcher(fact.factKey))
    .flatMap((fact) => fact.evidence)
    .flatMap((evidence) => {
      const sourceUrl = externalUrl(evidence.sourceUrl)
      return sourceUrl ? [{ ...evidence, sourceUrl }] : []
    })
  return [...new Map(sources.map((source) => [source.sourceUrl, source])).values()]
}

function investmentProfileCustomerName(customer: NonNullable<Lead['investmentProfile']>['customers']['representatives'][number]) {
  if (!customer.anonymized) return customer.name
  const label = customer.name.trim()
  return /^(?:某.{0,18}(?:客户|企业|公司|机构)|(?:匿名|保密)客户(?:\s*\d+)?)$/.test(label) ? label : '某保密客户'
}

function displayFactValue(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return displayLeadDetailValue(value)
  if (Array.isArray(value)) return displayLeadDetailValue(value.map((item) => displayFactValue(item)).filter(Boolean).join('、'), '未披露')
  if (value && typeof value === 'object') return displayLeadDetailValue(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${key}：${displayFactValue(item)}`).join('；'), '未披露')
  return '未披露'
}

function factObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function firstFactField(value: unknown, keys: string[]) {
  const record = factObject(value)
  for (const key of keys) {
    const displayed = text(record[key], '')
    if (displayed) return displayed
  }
  return ''
}

type ResearchTechnicalEvidence = {
  id: string
  metric: string
  result: string
  baseline: string
  context: string
  source?: LeadEnrichmentEvidence
}

function researchTechnicalEvidence(facts: LeadEnrichmentFact[]): ResearchTechnicalEvidence[] {
  const labels: Record<string, string> = {
    'technology.metric': '技术指标',
    'research.validation': '验证结果',
    'research.prototype': '原型进展',
    'research.reproducibility': '复现情况',
  }
  return facts.filter((fact) => isEvidenceBackedFact(fact) && Boolean(labels[fact.factKey])).map((fact) => {
    const structured = factObject(fact.value)
    const scalarResult = Object.keys(structured).length ? '' : displayFactValue(fact.value)
    return {
      id: fact.id,
      metric: firstFactField(fact.value, ['metric', 'indicator', 'name', 'label']) || labels[fact.factKey],
      result: firstFactField(fact.value, ['result', 'value', 'paperResult', 'current']) || scalarResult,
      baseline: firstFactField(fact.value, ['baseline', 'benchmark', 'comparison', 'comparedWith']),
      context: firstFactField(fact.value, ['dataset', 'scenario', 'condition', 'context']),
      source: fact.evidence.find((evidence) => Boolean(externalUrl(evidence.sourceUrl))),
    }
  }).filter((item) => item.result)
}

async function loadAllLeadVerifiedFacts(leadId: string) {
  const all: LeadEnrichmentFact[] = []
  for (let page = 1; page <= 20; page += 1) {
    const result = await apiGet<LeadEnrichmentFactsResponse>(`/leads/${leadId}/verified-facts?page=${page}&pageSize=100`)
    all.push(...result.facts)
    if (!result.hasMore) return [...new Map(all.map((fact) => [fact.id, fact])).values()]
    if (page === 20) throw new Error('已验证事实超过详情页安全读取上限，不能展示不完整来源链')
  }
  return []
}

function arxivAuthorQuery(name: string) {
  const parts = name.trim().replace(/[.,，。]+/g, '').split(/\s+/).filter(Boolean)
  if (parts.length < 2) return name.trim()
  const lastName = parts.at(-1)!
  const initials = parts.slice(0, -1).map((part) => part.charAt(0).toUpperCase()).filter(Boolean)
  return `${lastName}, ${initials.join(' ')}`
}

function arxivAuthorUrl(name: string, categories: string[] = []) {
  const archive = categories
    .map((category) => category.split('.')[0]?.toLowerCase())
    .find((value) => ['cs', 'econ', 'eess', 'math', 'physics', 'q-bio', 'q-fin', 'stat'].includes(value))
  const params = new URLSearchParams({ searchtype: 'author', query: arxivAuthorQuery(name) })
  return `https://arxiv.org/search/${archive || ''}?${params.toString()}`
}

function paperAuthorsAsTeam(lead: Lead): DisplayTeamMember[] {
  const paperMeta = lead.radarProfile?.paperMeta
  const detailedAuthors = paperMeta?.paperAuthors ?? []
  const authors = paperMeta?.authors?.length
    ? paperMeta.authors
    : [...detailedAuthors].sort((left, right) => Number(left.position || 0) - Number(right.position || 0)).map((author) => author.name)
  const categories = paperMeta?.categories ?? []
  const paperTitle = text(paperMeta?.titleOriginal || paperMeta?.title || lead.name, '该论文')
  const contributionByAuthor = new Map((paperMeta?.authorContributions ?? []).map((item) => [item.author, item]))
  const detailsByAuthor = new Map(detailedAuthors.map((author) => [author.name.normalize('NFKC').toLocaleLowerCase('en-US'), author]))
  return [...new Set(authors.map((author) => author.trim()).filter(Boolean))].map((name, index) => ({
    name,
    title: contributionByAuthor.get(name)?.label || (index === 0 ? '第一作者' : '共同作者'),
    background: (() => {
      const detail = detailsByAuthor.get(name.normalize('NFKC').toLocaleLowerCase('en-US'))
      const institutions = detail?.affiliations?.map((affiliation) => affiliation.name).filter(Boolean) || []
      const identityNote = detail?.identityStatus === 'confirmed'
        ? '作者身份已由稳定来源ID确认'
        : '论文署名作者，暂无稳定作者ID'
      const contributionNote = contributionByAuthor.has(name) ? '论文原文标注了作者贡献' : '仅确认论文署名顺序'
      return `《${paperTitle}》${contributionNote}；${identityNote}${institutions.length ? `；来源确认机构：${institutions.join('、')}` : '；作者—机构对应：-'}。`
    })(),
    profileUrl: (() => {
      const detail = detailsByAuthor.get(name.normalize('NFKC').toLocaleLowerCase('en-US'))
      if (detail?.orcid && /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(detail.orcid)) return `https://orcid.org/${detail.orcid}`
      if (detail?.openAlexAuthorId && /^A\d+$/i.test(detail.openAlexAuthorId)) return `https://openalex.org/${detail.openAlexAuthorId}`
      return arxivAuthorUrl(name, categories)
    })(),
  }))
}

function verifiedTeamAsMembers(facts: LeadEnrichmentFact[]): DisplayTeamMember[] {
  const verified = facts.filter((fact) => isEvidenceBackedFact(fact) && fact.subjectType === 'team')
  const memberKeys = new Set(['team.member', 'team.founder', 'team.cofounder', 'team.advisor', 'team.commercialization_member'])
  const roleLabels: Record<string, string> = {
    'team.founder': '创始人', 'team.cofounder': '联合创始人', 'team.advisor': '顾问',
    'team.commercialization_member': '商业化团队成员',
  }
  const memberFacts = verified.filter((fact) => memberKeys.has(fact.factKey))
  return memberFacts.flatMap((memberFact) => {
    const value = memberFact.value && typeof memberFact.value === 'object' && !Array.isArray(memberFact.value)
      ? memberFact.value as Record<string, unknown> : {}
    const name = text(value.name || value.person || value.author || memberFact.value, '')
    if (!name) return []
    const instanceKey = memberFact.instanceKey && memberFact.instanceKey !== 'singleton' ? memberFact.instanceKey : name
    const related = verified.filter((fact) => fact.instanceKey === instanceKey)
    const explicitRole = related.find((fact) => fact.factKey === 'team.role')
    const backgrounds = related.filter((fact) => [
      'team.education', 'team.employment', 'team.current_employment', 'team.historical_employment', 'team.full_time_status',
    ].includes(fact.factKey)).map((fact) => displayFactValue(fact.value)).filter(Boolean)
    return [{
      name,
      title: explicitRole ? displayFactValue(explicitRole.value) : roleLabels[memberFact.factKey] || '团队成员',
      background: backgrounds.length ? [...new Set(backgrounds)].join('；') : '-',
    }]
  }).filter((member, index, all) => all.findIndex((candidate) => candidate.name === member.name) === index)
}

function verifiedNewsUpdates(facts: LeadEnrichmentFact[]) {
  const verified = facts.filter(isEvidenceBackedFact)
  return verified.filter((fact) => fact.factKey === 'news.event').map((fact) => {
    const dateFact = verified.find((candidate) => (
      candidate.factKey === 'news.event_date' && candidate.instanceKey === fact.instanceKey
    ))
    return {
      occurredAt: dateFact ? displayFactValue(dateFact.value) : '',
      title: displayFactValue(fact.value),
      sourceUrl: fact.evidence[0]?.sourceUrl,
    }
  })
}

export function LeadDetailPage() {
  const { id } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { showToast } = useToast()
  const fetchLeadDetail = useAppStore((state) => state.fetchLeadDetail)
  const convertLead = useAppStore((state) => state.convertLead)
  const currentUser = useAuthStore((state) => state.user)
  const [lead, setLead] = useState<Lead | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [converting, setConverting] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [verifiedProfile, setVerifiedProfile] = useState<LeadVerifiedProfile | null>(null)
  const [enrichmentFacts, setEnrichmentFacts] = useState<LeadEnrichmentFact[]>([])
  const [factsLoadError, setFactsLoadError] = useState('')
  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError('')
    setFactsLoadError('')
    const [result, profileResult, factsResult] = await Promise.all([
      fetchLeadDetail(id),
      apiGet<LeadVerifiedProfile>(`/leads/${id}/verified-profile`).catch(() => null),
      loadAllLeadVerifiedFacts(id)
        .then((facts) => ({ facts, error: '' }))
        .catch((cause) => ({
          facts: [] as LeadEnrichmentFact[],
          error: cause instanceof Error ? cause.message : '画像来源暂时不可用',
        })),
    ])
    if (result) setLead(result)
    else setError('线索不存在、已移除，或当前账号无权访问。')
    setVerifiedProfile(profileResult)
    setEnrichmentFacts(factsResult.facts)
    setFactsLoadError(factsResult.error)
    setLoading(false)
  }, [fetchLeadDetail, id])

  useEffect(() => { void load() }, [load])

  const state = location.state as { from?: string } | null
  const goBack = () => navigate(state?.from || '/sourcing')

  const handleConvert = async () => {
    if (!lead || lead.poolStatus === '已转专属项目') return
    setConverting(true)
    try {
      const project = await convertLead(lead.id)
      if (project) {
        setLead((current) => current ? { ...current, poolStatus: '已转专属项目', convertedProjectId: project.id } : current)
        showToast(`已转为专属项目「${project.name}」`, 'success')
      }
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '转为专属项目失败', 'error')
    } finally { setConverting(false) }
  }

  const handleDelete = async () => {
    if (!lead || deleting) return
    setDeleting(true)
    try {
      const result = await apiDelete<{ code: number; message: string; deleted: string; name: string }>(`/leads/${lead.id}`)
      showToast(`已删除线索「${result.name || lead.name}」`, 'success')
      navigate(state?.from || '/sourcing', { replace: true })
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '删除失败，请稍后重试', 'error')
      setDeleting(false)
    }
  }

  if (loading && !lead) return <DetailShell onBack={goBack}><div className="lead-review-loading"><LoaderCircle /><strong>正在读取线索详情</strong></div></DetailShell>
  if (!lead || error) return <DetailShell onBack={goBack}><div className="lead-review-missing"><EmptyState title="未找到这条线索" description={error || '线索可能已被移除。'} /><button type="button" onClick={() => void load()}>重新加载</button></div></DetailShell>

  const research = isResearch(lead)
  const sectionVisibility = leadDetailSectionVisibility(lead)
  const profile = lead.radarProfile?.profile ?? {}
  const paperMeta = lead.radarProfile?.paperMeta
  const researchProfile = lead.researchProfile
  const registry = lead.companyRegistry ?? lead.scoring?.registry ?? {}
  const verifiedFacts = enrichmentFacts.filter(isEvidenceBackedFact)
  const verifiedFact = (...factKeys: string[]) => verifiedFacts.find((fact) => factKeys.includes(fact.factKey))
  const verifiedFactText = (factKeys: string[], fallback = '') => {
    const fact = verifiedFact(...factKeys)
    return fact ? displayFactValue(fact.value) : fallback
  }
  const researchProjectName = research
    ? text(paperMeta?.projectName || researchProfile?.subject.name || lead.name, '')
    : ''
  const companyName = research
    ? text(paperMeta?.titleZh || researchProfile?.subject.title || lead.name, lead.name)
    : text(lead.companyName, lead.name)
  const verifiedWebsite = verifiedFactText(['profile.website'])
  const paperSourceUrl = research ? externalUrl(lead.radarProfile?.link) : ''
  const paperPdfUrl = research ? externalUrl(paperMeta?.pdfUrl) : ''
  const officialSite = research
    ? paperSourceUrl
    : externalUrl(verifiedWebsite) || verifiedCompanyWebsite(lead.scoring?.officialSite, lead.website)
  const articleSourceUrl = externalUrl(lead.fundingRounds?.[0]?.sourceUrl)
    || externalUrl(lead.sourceUrl)
    || (!research ? externalUrl(lead.radarProfile?.link) : '')
  const converted = lead.poolStatus === '已转专属项目' || Boolean(lead.convertedProjectId)
  const industryValue = verifiedFactText(['profile.industry'], text(lead.industry))
  const industryTags = splitLeadIndustryTags(industryValue)
  const firstFunding = lead.fundingRounds?.[0]
  const rawFundingStage = displayLeadFundingValue(lead.stageDisplay, firstFunding?.round, lead.round) || '-'
  const fundingStage = rawFundingStage === '未融资（来源标注）' ? '未融资' : rawFundingStage
  const isUnfinanced = fundingStage === '未融资'
  const fundingAmount = displayLeadFundingValue(
    lead.scoring?.dataQualityV1?.funding.amountDisplay,
    firstFunding?.amount,
    profile.financingAmount,
  )
  const hasFundingAmount = Boolean(fundingAmount)
    && !/^(?:融资金额)?(?:未披露|暂未披露|未透露|无|不适用)$/.test(fundingAmount)
  const legalCompanyName = isLegalCompanyName(lead.companyName)
  const leadInvestors = displayLeadInvestorNames(firstFunding?.leadInvestors)
  const registryEvidence = lead.scoring?.registryEvidence ?? []
  const sourceLabeledProfile = lead.scoring?.sourceLabeledProfile ?? {}
  const sourceLabeledField = (key: keyof typeof sourceLabeledProfile) => {
    const field = sourceLabeledProfile[key]
    return field && text(field.value, '') && externalUrl(field.sourceUrl) ? field : undefined
  }
  const sourceLabeledNode = (key: keyof typeof sourceLabeledProfile, fallback: ReactNode): ReactNode => {
    const field = sourceLabeledField(key)
    if (!field) return typeof fallback === 'string' || typeof fallback === 'number' ? displayLeadDetailValue(fallback) : fallback
    return displayLeadDetailValue(field.value)
  }
  const verifiedFactNode = (factKeys: string[], fallback: ReactNode = '-'): ReactNode => {
    const fact = verifiedFact(...factKeys)
    if (!fact) return typeof fallback === 'string' || typeof fallback === 'number' ? displayLeadDetailValue(fallback) : fallback
    return displayFactValue(fact.value)
  }
  const registryFact = (value: unknown, field: string, fallback = '-'): ReactNode => {
    const displayed = text(value, fallback)
    const evidence = registryEvidence.find((item) => item.field === field && Boolean(externalUrl(item.sourceUrl)))
    return evidence ? displayed : fallback
  }
  const claimedFoundedAt = text(lead.foundedAt, '')
  const registeredAt = text(registry.foundedAt, '')
  const claimedFoundedAtSource = externalUrl(lead.scoring?.claimedFoundedAtEvidence?.sourceUrl)
  const companyFacts: Array<[string, ReactNode]> = [
    ['品牌名称', text(lead.name)],
    [legalCompanyName ? '公司全称' : '主体名称', verifiedFactNode(['registry.company_name'], registryFact(lead.companyName || lead.name, 'companyName'))],
    ...(!legalCompanyName ? [['工商全称', '-'] as [string, ReactNode]] : []),
    ['工商成立日期', verifiedFactNode(['registry.founded_at'], registryFact(registeredAt, 'foundedAt'))],
    ...(claimedFoundedAt && claimedFoundedAt !== registeredAt && claimedFoundedAtSource ? [['品牌/团队成立时间',
      claimedFoundedAt,
    ] as [string, ReactNode]] : []),
    ['注册资本', verifiedFactNode(['registry.registered_capital'], registryFact(registry.registeredCapital || lead.registeredCapital, 'registeredCapital'))],
    ['法定代表人', verifiedFactNode(['registry.legal_representative'], registryFact(registry.legalRepresentative || lead.legalRepresentative, 'legalRepresentative'))],
    ['统一社会信用代码', verifiedFactNode(['registry.credit_code'], registryFact(registry.creditCode || lead.creditCode, 'creditCode'))],
    ['登记状态', verifiedFactNode(['registry.registration_status'], registryFact(registry.registrationStatus || lead.registrationStatus, 'registrationStatus'))],
    ['公司类型', verifiedFactNode(['registry.company_type'], registryFact(registry.companyType || lead.companyType, 'companyType'))],
    ['注册地址', verifiedFactNode(['registry.registered_address'], registryFact(displayLeadRegisteredAddress(
      registry.registeredAddress,
      registry.regLocation,
      lead.registeredAddress,
    ), 'registeredAddress'))],
    ['所属行业', industryValue],
    ['所在地区', verifiedFactNode(['profile.headquarters'], registryFact(lead.region, 'registeredAddress'))],
    [isUnfinanced ? '融资状态' : '融资轮次', verifiedFactNode(['financing.status', 'financing.round'], articleSourceUrl ? fundingStage : '-')],
    ['业务阶段', verifiedFactNode(['profile.development_stage', 'profile.project_stage'], '-')],
    ...(!isUnfinanced && hasFundingAmount ? [[
      '融资金额',
      verifiedFact('financing.amount') ? verifiedFactNode(['financing.amount']) : fundingAmount,
    ] as [string, ReactNode]] : []),
    ...(!isUnfinanced && leadInvestors.length ? [[
      '领投方',
      verifiedFactText(['financing.investors'], leadInvestors.join('、')),
    ] as [string, ReactNode]] : []),
  ]
  const paperAffiliations = paperMeta?.affiliations ?? []
  const articleLicense = paperMeta?.rights?.articleLicense
  const datasetRights = paperMeta?.rights?.dataset
  const intellectualProperty = paperMeta?.rights?.intellectualProperty
  const metadataSourceUrl = externalUrl(paperMeta?.metadataSource?.url)
  const researchAffiliations = paperAffiliations.length
    ? paperAffiliations.map((affiliation) => affiliation.name)
    : researchProfile?.team.affiliations ?? []
  const researchDirections = [...new Set([
    ...(paperMeta?.categories ?? []),
    ...(researchProfile?.direction.categories ?? []),
    ...(industryValue !== '-' ? splitLeadIndustryTags(industryValue) : []),
  ].map((item) => text(item, '')).filter(Boolean))]
  const researchResourceType = text(paperMeta?.resourceType || researchProfile?.progress.resourceType, '-')
  const researchFacts: Array<[string, ReactNode]> = [
    ['所属机构', researchAffiliations.length ? [...new Set(researchAffiliations)].join('、') : '-'],
    ...(paperMeta?.researchTeam?.name || verifiedFactText(['profile.team_name']) ? [['研究团队', text(paperMeta?.researchTeam?.name || verifiedFactText(['profile.team_name']))] as [string, ReactNode]] : []),
    ['研究方向', researchDirections.length ? researchDirections.join('、') : '-'],
    ['成果形态', researchResourceType],
    ...(paperMeta?.publishedAt || lead.radarProfile?.publishedAt ? [['成果公开时间', displayDate(paperMeta?.publishedAt || lead.radarProfile?.publishedAt)] as [string, ReactNode]] : []),
    ...(paperMeta?.publicationDateStatus === 'source_declared_future' && paperMeta.declaredPublishedAt ? [[
      '来源声明日期',
      <span className="lead-review-rights-note">{displayDate(paperMeta.declaredPublishedAt)}<small>来源填写为未来日期，未作为公开时间</small></span>,
    ] as [string, ReactNode]] : []),
    ...(paperMeta?.venue ? [['发表载体', paperMeta.venue] as [string, ReactNode]] : []),
    ...(paperMeta?.comment ? [['论文备注', paperMeta.comment] as [string, ReactNode]] : []),
    ...(articleLicense?.label || researchProfile?.rights.articleLicense ? [['论文/成果许可', text(articleLicense?.label || researchProfile?.rights.articleLicense)] as [string, ReactNode]] : []),
    ...(datasetRights?.license || researchProfile?.rights.datasetLicense ? [['数据集许可', text(datasetRights?.license || researchProfile?.rights.datasetLicense)] as [string, ReactNode]] : []),
    ...(intellectualProperty?.status === 'confirmed' || researchProfile?.rights.intellectualProperty ? [['知识产权归属', text(intellectualProperty?.label || researchProfile?.rights.intellectualProperty)] as [string, ReactNode]] : []),
    ...(metadataSourceUrl ? [['元数据来源', text(paperMeta?.metadataSource?.provider, '原始论文页面')] as [string, ReactNode]] : []),
  ]
  const facts: Array<[string, ReactNode]> = research ? researchFacts : companyFacts
  const paperTeam = research ? paperAuthorsAsTeam(lead) : []
  const verifiedTeam = verifiedTeamAsMembers(enrichmentFacts)
  const sourceLabeledTeam = (lead.scoring?.structuredTeam ?? []).filter((member) => (
    member.evidenceStatus === 'source_labeled' && Boolean(externalUrl(member.sourceUrl))
  )).map((member) => ({ ...member, sourceUrl: member.sourceUrl }))
  const team = paperTeam.length ? paperTeam : verifiedTeam.length ? verifiedTeam : sourceLabeledTeam
  const verifiedUpdates = verifiedNewsUpdates(enrichmentFacts)
  const sourceBoundLegacyUpdates = (lead.latestUpdates ?? []).filter((item) => Boolean(externalUrl(item.sourceUrl)))
  const updates = verifiedUpdates.length ? verifiedUpdates : sourceBoundLegacyUpdates
  const verifiedIntroduction = (factKey: string) => enrichmentFacts.find((fact) => (
    fact.factKey === factKey && isEvidenceBackedFact(fact)
  ))
  const verifiedCompanyIntroduction = verifiedIntroduction('profile.company_introduction')
  const verifiedTeamIntroduction = verifiedIntroduction('profile.team_introduction')
  const verifiedProjectIntroduction = verifiedIntroduction('profile.project_introduction')
  const companyIntroductionEvidence = lead.scoring?.registryEvidence?.find((item) => (
    item.field === 'companyIntroduction' && Boolean(externalUrl(item.sourceUrl))
  ))
  const evidenceBoundCompanyIntroduction = companyIntroductionEvidence
    ? text(lead.scoring?.companyIntroduction, '')
    : ''
  const headlineIntroduction = research ? verifiedProjectIntroduction : verifiedCompanyIntroduction
  const generatedIntroductions = verifiedProfile?.introductions
  const generatedIntroductionSources = verifiedProfile?.introductionSources
  const generatedCompanyIntroduction = generatedIntroductionSources?.companyIntroduction.some((source) => Boolean(externalUrl(source.sourceUrl)))
    ? text(generatedIntroductions?.companyIntroduction, '') : ''
  const generatedTeamIntroduction = generatedIntroductionSources?.teamIntroduction.some((source) => Boolean(externalUrl(source.sourceUrl)))
    ? text(generatedIntroductions?.teamIntroduction, '') : ''
  const generatedProjectIntroduction = generatedIntroductionSources?.projectIntroduction.some((source) => Boolean(externalUrl(source.sourceUrl)))
    ? text(generatedIntroductions?.projectIntroduction, '') : ''
  const sourceLabeledProjectIntroduction = sourceLabeledField('projectIntroduction')
  const projectIntroductionCandidates = [
    { value: text(lead.projectIntroduction, ''), sourceUrl: externalUrl(lead.projectIntroductionSourceUrl) || articleSourceUrl },
    { value: verifiedProjectIntroduction ? displayFactValue(verifiedProjectIntroduction.value) : '', sourceUrl: verifiedProjectIntroduction?.evidence[0]?.sourceUrl },
    { value: generatedProjectIntroduction, sourceUrl: generatedIntroductionSources?.projectIntroduction?.[0]?.sourceUrl },
    { value: text(sourceLabeledProjectIntroduction?.value, ''), sourceUrl: sourceLabeledProjectIntroduction?.sourceUrl },
    { value: text(lead.summary, ''), sourceUrl: articleSourceUrl },
  ].filter((candidate) => candidate.value)
  const projectIntroduction = [...projectIntroductionCandidates].sort((left, right) => right.value.length - left.value.length)[0]
  const headlineIntroductionText = headlineIntroduction
    ? displayFactValue(headlineIntroduction.value)
    : research ? generatedProjectIntroduction : generatedCompanyIntroduction
  const positioningIntroductionText = headlineIntroductionText
    || (!research ? evidenceBoundCompanyIntroduction || '暂无已验证的企业介绍' : '')
  const productValue = verifiedFact('product.name', 'profile.product')
    ? verifiedFactText(['product.name', 'profile.product'])
    : sourceLabeledNode('product', '-')
  const productDescription = verifiedFact('product.performance', 'product.parameter', 'product.matrix')
    ? verifiedFactText(['product.performance', 'product.parameter', 'product.matrix'])
    : sourceLabeledNode('productDescription', '暂无经过来源验证的产品参数或性能数据。')
  const applicationValue = verifiedFact('profile.application_scenario', 'product.use_case')
    ? verifiedFactText(['profile.application_scenario', 'product.use_case'])
    : sourceLabeledNode('applicationScenario', '-')
  const applicationDescription = verifiedFact('profile.customer_type', 'profile.user_problem')
    ? verifiedFactText(['profile.customer_type', 'profile.user_problem'])
    : sourceLabeledNode('applicationDescription', '暂无经过来源验证的客户类型或用户问题。')
  const mainBusinessValue = verifiedFact('profile.main_business')
    ? verifiedFactText(['profile.main_business'])
    : sourceLabeledNode('mainBusiness', '-')
  const mainBusinessDescription = verifiedFact('profile.positioning', 'profile.solution')
    ? verifiedFactText(['profile.positioning', 'profile.solution'])
    : sourceLabeledNode('mainBusinessDescription', '暂无经过来源验证的业务定位或解决方案。')
  const evidenceSources = [...new Map(verifiedFacts.flatMap((fact) => fact.evidence).map((evidence) => [evidence.sourceUrl, {
    url: evidence.sourceUrl,
    title: evidence.title || evidence.publisher || '已验证事实来源',
    publisher: evidence.publisher || '公开来源',
    publishedAt: undefined,
    accessedAt: evidence.accessedAt,
  }])).values()]
  const paperSources: Array<{ url: string; title?: string; publisher?: string; publishedAt?: string; accessedAt?: string }> = research ? [
    paperSourceUrl ? { url: paperSourceUrl, title: text(paperMeta?.titleZh || paperMeta?.title || lead.name), publisher: text(paperMeta?.metadataSource?.provider, '论文原始页面') } : null,
    paperPdfUrl ? { url: paperPdfUrl, title: '论文 PDF', publisher: 'PDF' } : null,
    metadataSourceUrl && metadataSourceUrl !== paperSourceUrl ? { url: metadataSourceUrl, title: '论文元数据记录', publisher: text(paperMeta?.metadataSource?.provider, '元数据来源') } : null,
  ].filter((source): source is NonNullable<typeof source> => Boolean(source)) : []
  const relatedSources = [...new Map([
    ...evidenceSources,
    ...(lead.sources ?? []).filter((source) => Boolean(externalUrl(source.url))),
    ...paperSources,
  ].map((source) => [source.url, source])).values()]
  const investmentProfile = lead.investmentProfile
  const customerSourcesRestricted = Boolean(investmentProfile?.customers.representatives.some((item) => item.anonymized))
  const investmentProfileCards = investmentProfile ? [
    {
      label: '行业与产品路线',
      value: [investmentProfile.industry.segment, investmentProfile.industry.level2, investmentProfile.industry.level1].find(Boolean) || '-',
      detail: investmentProfile.products.slice(0, 2).map((item) => [item.name, item.productRoute, item.technologyRoute, productionStageLabel(item)].filter(Boolean).join(' · ')).join('；') || '-',
      sources: investmentProfileEvidenceSources(verifiedFacts, 'industryProduct'),
      expectsEvidence: Boolean(investmentProfile.industry.level1 || investmentProfile.industry.level2 || investmentProfile.industry.segment
        || investmentProfile.industry.chainPosition || investmentProfile.products.length),
      sourceRestricted: false,
    },
    {
      label: '机构与高校背景',
      value: investmentProfile.institutions.slice(0, 3).map((item) => `${item.name}${item.role === 'lead' ? '（领投）' : ''}`).join('、') || '-',
      detail: investmentProfile.academicLinks.slice(0, 3).map((item) => `${item.institution} · ${item.relationType}${item.commercialization ? ' · 成果转化' : ''}`).join('；') || '-',
      sources: investmentProfileEvidenceSources(verifiedFacts, 'background'),
      expectsEvidence: Boolean(investmentProfile.institutions.length || investmentProfile.academicLinks.length),
      sourceRestricted: false,
    },
    {
      label: '融资进展',
      value: research ? '-' : [investmentProfile.financing.status, investmentProfile.financing.latestRound, investmentProfile.financing.latestAmount].filter(Boolean).join(' · ') || '-',
      detail: research ? '-' : [`日期 ${displayDate(investmentProfile.financing.latestRoundDate)}`, `累计 ${text(investmentProfile.financing.cumulativeAmount)}`].join('；'),
      sources: research ? [] : investmentProfileEvidenceSources(verifiedFacts, 'financing'),
      expectsEvidence: !research && Boolean(investmentProfile.financing.latestRound || investmentProfile.financing.latestRoundDate
        || investmentProfile.financing.latestAmount || investmentProfile.financing.cumulativeAmount
        || !/^(?:未披露|不适用)$/.test(investmentProfile.financing.status)),
      sourceRestricted: false,
    },
    {
      label: '最新估值',
      value: research ? '-' : text(investmentProfile.valuation.value),
      detail: research ? '-' : [investmentProfile.valuation.type === 'pre_money' ? '投前' : investmentProfile.valuation.type === 'post_money' ? '投后' : '口径未披露', investmentProfile.valuation.currency, investmentProfile.valuation.round, displayDate(investmentProfile.valuation.date)].filter((item) => item && item !== '-').join(' · ') || '-',
      sources: research ? [] : investmentProfileEvidenceSources(verifiedFacts, 'valuation'),
      expectsEvidence: !research && Boolean(investmentProfile.valuation.value),
      sourceRestricted: false,
    },
    {
      label: '大客户验证',
      value: research ? '-' : investmentProfile.customers.representatives.map(investmentProfileCustomerName).join('、') || '-',
      detail: research ? '-' : `最高 ${text(investmentProfile.customers.highestStage)}；已验证 ${investmentProfile.customers.verifiedCount}；A/B/C ${investmentProfile.customers.tierACount}/${investmentProfile.customers.tierBCount}/${investmentProfile.customers.tierCCount}`,
      sources: research || customerSourcesRestricted ? [] : investmentProfileEvidenceSources(verifiedFacts, 'customers'),
      expectsEvidence: !research && Boolean(investmentProfile.customers.representatives.length || investmentProfile.customers.verifiedCount
        || (investmentProfile.customers.highestStage && investmentProfile.customers.highestStage !== 'L0')),
      sourceRestricted: customerSourcesRestricted,
    },
    {
      label: '数据状态',
      value: ({ verified: '已验证', partial: '部分验证', conflicted: '存在冲突', missing: '缺失', not_applicable: '不适用', stale: '数据过期' } as const)[investmentProfile.dataStatus.status],
      detail: `覆盖 ${investmentProfile.dataStatus.verifiedDimensions}/${investmentProfile.dataStatus.applicableDimensions}；冲突 ${investmentProfile.dataStatus.conflictCount}；更新 ${displayDate(investmentProfile.dataStatus.updatedAt)}`,
      sources: [],
      expectsEvidence: false,
      sourceRestricted: false,
    },
  ] : []
  const researchAbstract = text(
    paperMeta?.abstractZh || paperMeta?.abstractOriginal || paperMeta?.abstract
      || projectIntroduction?.value || researchProfile?.direction.researchProblem,
    '',
  )
  const researchInsightCards = research ? [
    { label: '核心发现', fact: verifiedFact('research.finding', 'research.conclusion', 'paper.conclusion') },
    { label: '创新点', fact: verifiedFact('research.innovation', 'paper.innovation') },
    { label: '研究局限', fact: verifiedFact('research.limitation', 'paper.limitations') },
  ].filter((item): item is { label: string; fact: LeadEnrichmentFact } => Boolean(item.fact)) : []
  const technicalEvidence = research ? researchTechnicalEvidence(verifiedFacts) : []
  const companyFundingRounds = research ? [] : (lead.fundingRounds ?? [])
  const overviewLatestValuation = text(
    investmentProfile?.valuation.value
      || (articleSourceUrl ? firstFunding?.valuation : '')
      || (externalUrl(lead.valuationDisplay?.sourceUrl) ? lead.valuationDisplay?.value : ''),
  )
  const companyOverview: Array<[string, ReactNode]> = research ? [] : [
    ['成立时间', verifiedFactNode(['registry.founded_at'], registryFact(registeredAt, 'foundedAt'))],
    ['最新轮次', verifiedFactNode(['financing.status', 'financing.round'], articleSourceUrl ? fundingStage : '-')],
    ['累计融资', text(investmentProfile?.financing.cumulativeAmount)],
    ['最新估值', overviewLatestValuation],
  ]

  return <div className="lead-review-page">
    <div className="lead-review-shell">
      <button className="lead-review-back" type="button" onClick={goBack}><ArrowLeft />返回共享线索池</button>
      <header className="lead-review-hero">
        <div className="lead-review-identity">
          <div className="lead-review-heading-line"><h1>{companyName}</h1>{!research && <div className="lead-review-meta"><span><MapPin />{text(lead.region)}</span></div>}</div>
          {research && paperMeta?.titleOriginal && paperMeta.titleOriginal !== companyName && <p className="lead-review-original-title">{paperMeta.titleOriginal}</p>}
          {!research && positioningIntroductionText && <p className="lead-review-positioning">{positioningIntroductionText}</p>}
          {research ? officialSite && <div className="lead-review-website-line"><span>论文地址：</span><a href={officialSite} target="_blank" rel="noreferrer">{officialSite}<ExternalLink /></a></div>
            : <div className="lead-review-website-line"><span>公司官网：</span>{officialSite ? <a href={officialSite} target="_blank" rel="noreferrer">{officialSite}<ExternalLink /></a> : <span>-</span>}</div>}
          {!research && articleSourceUrl && <div className="lead-review-website-line"><span>文章来源：</span><a href={articleSourceUrl} target="_blank" rel="noreferrer">{articleSourceUrl}<ExternalLink /></a></div>}
          <div className="lead-review-kicker">{research && researchProjectName && researchProjectName !== companyName && <span className="background">项目：{researchProjectName}</span>}{industryTags.map((tag) => <span key={`industry-${tag}`}>{tag}</span>)}{!research && (lead.backgroundTags ?? []).map((tag) => <span className="background" key={`background-${tag}`}>{tag}</span>)}</div>
          {research && (paperSourceUrl || paperPdfUrl) && <div className="lead-review-resource-actions">{paperSourceUrl && <a href={paperSourceUrl} target="_blank" rel="noreferrer">查看原文<ExternalLink /></a>}{paperPdfUrl && <a href={paperPdfUrl} target="_blank" rel="noreferrer"><Download />下载 PDF</a>}</div>}
        </div>
        <div className="lead-review-action-panel">
          <div className="lead-review-actions">
            <button className="lead-review-convert-button" type="button" disabled={converted || converting} onClick={() => void handleConvert()}>{converting ? '正在转换…' : converted ? '已转为我的专属项目' : '转为我的专属项目'}</button>
            {canManageLeadPool(currentUser) && <button className="lead-review-delete-button" type="button" onClick={() => setDeleteConfirmOpen(true)}><Trash2 />删除线索</button>}
          </div>
          {!research && <time className="lead-review-updated-at">更新于 {displayDate(lead.dataUpdatedAt || lead.poolEnteredAt)}</time>}
        </div>
      </header>

      <main className="lead-review-content">
        {(!research || researchAbstract) && <ReviewSection title={research ? '论文摘要 / 研究问题' : '项目简介'} icon={<Sparkles />}><p className="lead-review-introduction">{research ? multilineText(researchAbstract, '') : multilineText(projectIntroduction?.value, '暂无项目简介')}</p></ReviewSection>}
        {!research && <ReviewSection title="关键概览" icon={<Building2 />}><div className="lead-review-overview-grid">{companyOverview.map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}</div></ReviewSection>}
        {researchInsightCards.length > 0 && <ReviewSection title="核心结论与创新" icon={<Sparkles />}><div className="lead-review-research-insights">{researchInsightCards.map((item) => <article key={item.label}><span>{item.label}</span><p>{displayFactValue(item.fact.value)}</p>{item.fact.evidence[0] && <a href={externalUrl(item.fact.evidence[0].sourceUrl) || undefined} target="_blank" rel="noreferrer">查看证据<ExternalLink /></a>}</article>)}</div></ReviewSection>}
        {technicalEvidence.length > 0 && <ReviewSection title="技术证据" icon={<Sparkles />}><div className="lead-review-technical-table" role="table" aria-label="论文技术证据"><div className="lead-review-technical-head" role="row"><span role="columnheader">指标</span><span role="columnheader">本论文结果</span><span role="columnheader">对比基线</span><span role="columnheader">数据集 / 场景</span><span role="columnheader">证据来源</span></div>{technicalEvidence.map((item) => <div role="row" key={item.id}><strong role="cell">{item.metric}</strong><span role="cell">{item.result}</span><span role="cell">{item.baseline || '-'}</span><span role="cell">{item.context || '-'}</span><span role="cell">{item.source ? <a href={externalUrl(item.source.sourceUrl) || undefined} target="_blank" rel="noreferrer">{text(item.source.title || item.source.publisher, '查看来源')}<ExternalLink /></a> : '-'}</span></div>)}</div></ReviewSection>}
        {(!research || facts.length > 0) && <ReviewSection title={research ? '科研主体信息' : '主体基础信息'} icon={<Building2 />}><dl className="lead-review-fact-table">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></ReviewSection>}
        {sectionVisibility.productCommercialization && <ReviewSection title="产品与商业化" icon={<Sparkles />}><div className="lead-review-business-grid">
          <BusinessCard label="产品" value={productValue} description={productDescription} />
          <BusinessCard label="应用场景" value={applicationValue} description={applicationDescription} />
          <BusinessCard label="主营业务" value={mainBusinessValue} description={mainBusinessDescription} />
        </div></ReviewSection>}
        {!research && <ReviewSection title="融资历史" icon={<Building2 />}><div className="lead-review-funding-table" role="table" aria-label="企业融资历史"><div className="lead-review-funding-head" role="row"><span role="columnheader">轮次</span><span role="columnheader">时间</span><span role="columnheader">金额</span><span role="columnheader">估值</span><span role="columnheader">投资方</span><span role="columnheader">来源</span></div>{companyFundingRounds.length ? companyFundingRounds.map((round, index) => {
          const sourceUrl = externalUrl(round.sourceUrl)
          const investorNames = displayLeadInvestorNames(round.investors)
          return <div role="row" key={`${round.round}-${round.date}-${index}`}><strong role="cell">{text(round.round)}</strong><span role="cell">{displayDate(round.date)}</span><span role="cell">{text(round.amount)}</span><span role="cell">{text(round.valuation)}</span><span role="cell">{investorNames.length ? investorNames.join('、') : '-'}</span><span role="cell">{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">查看来源<ExternalLink /></a> : '-'}</span></div>
        }) : <p className="lead-review-section-empty">暂无融资历史数据</p>}</div></ReviewSection>}
        {research ? <ReviewSection title="团队成员" icon={<UsersRound />}><>{(verifiedTeamIntroduction || generatedTeamIntroduction || sourceLabeledField('teamIntroduction')) && <p className="lead-review-team-summary">{verifiedTeamIntroduction ? displayFactValue(verifiedTeamIntroduction.value) : generatedTeamIntroduction || sourceLabeledNode('teamIntroduction', '')}</p>}{team.length > 0 && <p className="lead-review-team-summary">展示论文署名、作者贡献与来源确认的机构信息；点击成员卡片可打开作者资料页。</p>}<div className="lead-review-team-list">{team.length ? team.map((member, index) => <TeamMemberCard member={member} index={index} key={`${member.name}-${index}`} />) : <p className="lead-review-section-empty">暂无可验证的团队成员信息</p>}</div></></ReviewSection>
          : <ReviewSection title="核心团队" icon={<UsersRound />}><>{(verifiedTeamIntroduction || generatedTeamIntroduction || sourceLabeledField('teamIntroduction')) && <p className="lead-review-team-summary">{verifiedTeamIntroduction ? displayFactValue(verifiedTeamIntroduction.value) : generatedTeamIntroduction || sourceLabeledNode('teamIntroduction', '')}</p>}<div className="lead-review-team-list">{team.length ? team.map((member, index) => <TeamMemberCard member={member} index={index} key={`${member.name}-${index}`} />) : <p className="lead-review-section-empty">暂无可验证的团队成员信息</p>}</div></></ReviewSection>}
        {research && (updates.length > 0 || relatedSources.length > 0) && <ReviewSection title="证据与动态" icon={<CalendarDays />}><div className={`lead-review-evidence-grid${!updates.length || !relatedSources.length ? ' single' : ''}`}>
          {updates.length > 0 && <section className="lead-review-path-panel"><header><span>01</span><div><h3>动态路径</h3><p>仅展示已有来源的已验证进展</p></div></header><div className="lead-review-path">{updates.map((item) => <article key={`${item.occurredAt}-${item.title}`}><time>{displayDate(item.occurredAt)}</time>{item.sourceUrl ? <a href={externalUrl(item.sourceUrl) || undefined} target="_blank" rel="noreferrer"><strong>{text(item.title)}</strong><ExternalLink /></a> : <strong>{text(item.title)}</strong>}</article>)}</div></section>}
          {relatedSources.length > 0 && <section className="lead-review-news-panel"><header><span>{!updates.length ? '01' : '02'}</span><div><h3>相关来源</h3><p>展示可打开的原始来源与已验证事实来源</p></div></header><div className="lead-review-news-list">{relatedSources.slice(0, 10).map((source, index) => <a className="lead-review-news-item" href={externalUrl(source.url) || undefined} target="_blank" rel="noreferrer" key={`${source.url}-${index}`}><div><span>{text(source.publisher, '公开来源')}</span><time>{displayDate(source.publishedAt || source.accessedAt)}</time></div><strong>{text(source.title, '原始来源')}</strong><ExternalLink /></a>)}</div></section>}
        </div></ReviewSection>}
        {!research && <ReviewSection title="最近动态" icon={<CalendarDays />}><div className="lead-review-latest-updates">{updates.length ? updates.slice(0, 4).map((item, index) => {
          const sourceUrl = externalUrl(item.sourceUrl)
          return <article key={`${item.occurredAt}-${item.title}`}><time>{displayDate(item.occurredAt)}</time><i className={index === 0 ? 'current' : ''} /><div><strong>{text(item.title)}</strong>{sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">查看来源<ExternalLink /></a>}</div></article>
        }) : <p className="lead-review-section-empty">暂无经过来源标注的动态</p>}</div></ReviewSection>}
        {!research && <ReviewSection title="相关来源" icon={<CalendarDays />}>{factsLoadError && <div className="lead-review-source-error" role="alert"><AlertTriangle /><span>相关来源暂时不可用</span><button type="button" onClick={() => void load()}>重新读取</button></div>}<div className="lead-review-source-grid">{relatedSources.length ? relatedSources.slice(0, 10).map((source, index) => <a className="lead-review-news-item" href={externalUrl(source.url) || undefined} target="_blank" rel="noreferrer" key={`${source.url}-${index}`}><div><span>{text(source.publisher, '公开来源')}</span><time>{displayDate(source.publishedAt || source.accessedAt)}</time></div><strong>{text(source.title, '原始来源')}</strong><ExternalLink /></a>) : <p className="lead-review-section-empty">暂无可打开的相关来源</p>}</div></ReviewSection>}
      </main>
    </div>
    <Modal
      open={deleteConfirmOpen}
      title="删除共享线索"
      width="max-w-lg"
      onClose={() => { if (!deleting) setDeleteConfirmOpen(false) }}
      footer={<>
        <Button variant="secondary" disabled={deleting} onClick={() => setDeleteConfirmOpen(false)}>取消</Button>
        <Button variant="danger" loading={deleting} onClick={() => void handleDelete()}>确认删除</Button>
      </>}
    >
      <div className="lead-pool-delete-confirm">
        <AlertTriangle aria-hidden="true" />
        <div>
          <strong>确认删除「{lead.name}」？</strong>
          <p>删除后，该线索将从共享线索池列表和统计中移除，待执行的评级任务会终止。历史导入记录、审计记录及已转化的专属项目会继续保留。</p>
        </div>
      </div>
    </Modal>
  </div>
}

function DetailShell({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return <div className="lead-review-page"><div className="lead-review-shell"><button className="lead-review-back" type="button" onClick={onBack}><ArrowLeft />返回共享线索池</button>{children}</div></div>
}

function ReviewSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <section className="lead-review-section"><header><span>{icon}</span><h2>{title}</h2></header><div>{children}</div></section>
}

function BusinessCard({ label, value, description }: { label: string; value: ReactNode; description: ReactNode }) {
  const display = (node: ReactNode) => typeof node === 'string' || typeof node === 'number' ? displayLeadDetailValue(node) : node
  return <article><span>{label}</span><strong>{display(value)}</strong><p>{display(description)}</p></article>
}

function TeamMemberCard({ member, index }: { member: DisplayTeamMember; index: number }) {
  const profileUrl = externalUrl(member.profileUrl)
  const content = <><span><UserRound /></span><div><h3>{text(member.name)}<em>{text(member.title, '-')}</em></h3><p>{text(member.background, '-')}</p>{profileUrl && <small>查看作者资料<ExternalLink /></small>}</div></>
  return profileUrl
    ? <a className="lead-review-team-card" href={profileUrl} target="_blank" rel="noreferrer" aria-label={`打开${text(member.name)}的作者资料`} data-member-index={index}>{content}</a>
    : <article className="lead-review-team-card" data-member-index={index}>{content}</article>
}
