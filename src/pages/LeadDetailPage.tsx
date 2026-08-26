import {
  AlertTriangle, ArrowLeft, Building2, CalendarDays, ExternalLink,
  LoaderCircle, MapPin, Sparkles, Trash2, UserRound, UsersRound,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Button, EmptyState, Modal } from '../components/ui'
import { useToast } from '../components/Toast'
import { apiDelete, apiGet } from '../lib/api'
import {
  displayLeadEvidenceStatus,
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

function text(value: unknown, fallback = '待核验') {
  const result = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  return result && !['null', 'undefined'].includes(result) ? result : fallback
}

function isResearch(lead: Lead) {
  return lead.leadType === 'research' || lead.radarProfile?.channel === '论文'
}

function displayDate(value?: string) {
  if (!value) return '待核验'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).replace(/\//g, '.')
}

function externalUrl(value?: string | null) {
  if (!value) return ''
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''
  } catch { return '' }
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
  evidence: LeadEnrichmentEvidence[]
}

type LeadEnrichmentFactsResponse = {
  facts: LeadEnrichmentFact[]
  total: number
  hasMore: boolean
  page: number
  pageSize: number
}

function isEvidenceBackedFact(fact: LeadEnrichmentFact) {
  return fact.verificationStatus === 'verified'
    && fact.evidence.some((evidence) => Boolean(externalUrl(evidence.sourceUrl)))
}

function displayFactValue(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((item) => displayFactValue(item)).filter(Boolean).join('、')
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${key}：${displayFactValue(item)}`).join('；')
  return '未披露'
}

async function loadAllLeadVerifiedFacts(leadId: string) {
  const all: LeadEnrichmentFact[] = []
  for (let page = 1; page <= 20; page += 1) {
    const result = await apiGet<LeadEnrichmentFactsResponse>(`/leads/${leadId}/verified-facts?page=${page}&pageSize=100`)
    all.push(...result.facts)
    if (!result.hasMore) break
  }
  return [...new Map(all.map((fact) => [fact.id, fact])).values()]
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
        : '作者身份待通过ORCID、机构或主页进一步消歧'
      const contributionNote = contributionByAuthor.has(name) ? '论文原文标注了作者贡献' : '仅确认论文署名顺序'
      return `《${paperTitle}》${contributionNote}；${identityNote}${institutions.length ? `；来源确认机构：${institutions.join('、')}` : '；未强行分配作者机构'}。`
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
      background: backgrounds.length ? [...new Set(backgrounds)].join('；') : '公开来源仅确认成员身份，履历待进一步核验。',
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

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError('')
    const [result, profileResult, factsResult] = await Promise.all([
      fetchLeadDetail(id),
      apiGet<LeadVerifiedProfile>(`/leads/${id}/verified-profile`).catch(() => null),
      loadAllLeadVerifiedFacts(id).catch(() => []),
    ])
    if (result) setLead(result)
    else setError('线索不存在、已移除，或当前账号无权访问。')
    setVerifiedProfile(profileResult)
    setEnrichmentFacts(factsResult)
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
  const profile = lead.radarProfile?.profile ?? {}
  const paperMeta = lead.radarProfile?.paperMeta
  const registry = lead.companyRegistry ?? lead.scoring?.registry ?? {}
  const verifiedFacts = enrichmentFacts.filter(isEvidenceBackedFact)
  const verifiedFact = (...factKeys: string[]) => verifiedFacts.find((fact) => factKeys.includes(fact.factKey))
  const verifiedFactText = (factKeys: string[], fallback = '') => {
    const fact = verifiedFact(...factKeys)
    return fact ? displayFactValue(fact.value) : fallback
  }
  const companyName = research ? lead.name : text(lead.companyName, lead.name)
  const verifiedWebsite = verifiedFactText(['profile.website'])
  const officialSite = research
    ? externalUrl(verifiedWebsite) || externalUrl(lead.scoring?.officialSite) || externalUrl(lead.website) || externalUrl(lead.radarProfile?.link)
    : externalUrl(verifiedWebsite) || verifiedCompanyWebsite(lead.scoring?.officialSite, lead.website)
  const articleSourceUrl = externalUrl(lead.fundingRounds?.[0]?.sourceUrl)
    || externalUrl(lead.sourceUrl)
    || (!research ? externalUrl(lead.radarProfile?.link) : '')
  const converted = lead.poolStatus === '已转专属项目' || Boolean(lead.convertedProjectId)
  const industryValue = verifiedFactText(['profile.industry'], text(lead.industry))
  const industryTags = splitLeadIndustryTags(industryValue)
  const firstFunding = lead.fundingRounds?.[0]
  const rawFundingStage = displayLeadFundingValue(lead.stageDisplay, firstFunding?.round, lead.round) || '融资轮次待核验'
  const fundingStage = rawFundingStage === '未融资（来源标注）' ? '未融资' : rawFundingStage
  const isUnfinanced = fundingStage === '未融资'
  const fundingAmount = displayLeadFundingValue(
    lead.scoring?.dataQualityV1?.funding.amountDisplay,
    firstFunding?.amount,
    profile.financingAmount,
  )
  const fundingEvidenceStatus = displayLeadEvidenceStatus(
    firstFunding?.evidenceStatus || lead.scoring?.dataQualityV1?.funding.amountEvidenceStatus || lead.stageEvidenceStatus,
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
    if (!field) return fallback
    return <span className="lead-review-rights-note">{field.value}<a className="lead-review-inline-link" href={externalUrl(field.sourceUrl)} target="_blank" rel="noreferrer">来源<ExternalLink /></a><small>{field.evidenceStatus === 'derived_source_labeled' ? 'Codex 基于原文归纳，待交叉核验' : '原文已标注，待交叉核验'}</small></span>
  }
  const verifiedFactNode = (factKeys: string[], fallback: ReactNode = '待核验'): ReactNode => {
    const fact = verifiedFact(...factKeys)
    if (!fact) return fallback
    const evidence = fact.evidence[0]
    return evidence ? <span className="lead-review-rights-note">{displayFactValue(fact.value)}<a className="lead-review-inline-link" href={externalUrl(evidence.sourceUrl) || undefined} target="_blank" rel="noreferrer">来源<ExternalLink /></a></span> : displayFactValue(fact.value)
  }
  const registryFact = (value: unknown, field: string, fallback = '待核验'): ReactNode => {
    const displayed = text(value, fallback)
    const evidence = registryEvidence.find((item) => item.field === field && Boolean(externalUrl(item.sourceUrl)))
    return evidence
      ? <span className="lead-review-rights-note">{displayed}<a className="lead-review-inline-link" href={externalUrl(evidence.sourceUrl)} target="_blank" rel="noreferrer">来源<ExternalLink /></a><small>{evidence.evidenceStatus === 'derived_source_labeled' ? '原文推算，待工商核验' : '原文已标注，待交叉核验'}</small></span>
      : fallback
  }
  const claimedFoundedAt = text(lead.foundedAt, '')
  const registeredAt = text(registry.foundedAt, '')
  const claimedFoundedAtSource = externalUrl(lead.scoring?.claimedFoundedAtEvidence?.sourceUrl)
  const companyFacts: Array<[string, ReactNode]> = [
    ['品牌名称', text(lead.name)],
    [legalCompanyName ? '公司全称' : '主体名称', verifiedFactNode(['registry.company_name'], registryFact(lead.companyName || lead.name, 'companyName'))],
    ...(!legalCompanyName ? [['工商全称', '待核验'] as [string, ReactNode]] : []),
    ['工商成立日期', verifiedFactNode(['registry.founded_at'], registryFact(registeredAt, 'foundedAt'))],
    ...(claimedFoundedAt && claimedFoundedAt !== registeredAt && claimedFoundedAtSource ? [['品牌/团队成立时间',
      <span className="lead-review-rights-note">{claimedFoundedAt}<a className="lead-review-inline-link" href={claimedFoundedAtSource} target="_blank" rel="noreferrer">来源<ExternalLink /></a></span>,
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
    [isUnfinanced ? '融资状态' : '融资轮次', verifiedFactNode(['financing.status', 'financing.round'], articleSourceUrl ? fundingStage : '待核验')],
    ['业务阶段', verifiedFactNode(['profile.development_stage', 'profile.project_stage'], '待核验')],
    ...(!isUnfinanced && hasFundingAmount ? [[
      '融资金额',
      verifiedFact('financing.amount') ? verifiedFactNode(['financing.amount']) : fundingEvidenceStatus
        ? <span className="lead-review-rights-note">{fundingAmount}<small>{fundingEvidenceStatus}</small></span>
        : fundingAmount,
    ] as [string, ReactNode]] : []),
    ...(!isUnfinanced && leadInvestors.length ? [[
      '领投方',
      verifiedFactText(['financing.investors'], leadInvestors.join('、')),
    ] as [string, ReactNode]] : []),
    ...(!isUnfinanced && articleSourceUrl ? [[
      '融资证据',
      <span className="lead-review-rights-note">
        <a className="lead-review-inline-link" href={articleSourceUrl} target="_blank" rel="noreferrer">查看原文<ExternalLink /></a>
        {fundingEvidenceStatus && <small>{fundingEvidenceStatus}</small>}
      </span>,
    ] as [string, ReactNode]] : []),
  ]
  const paperAffiliations = paperMeta?.affiliations ?? []
  const paperAuthorAffiliations = paperMeta?.authorAffiliations ?? []
  const articleLicense = paperMeta?.rights?.articleLicense
  const datasetRights = paperMeta?.rights?.dataset
  const intellectualProperty = paperMeta?.rights?.intellectualProperty
  const metadataSourceUrl = externalUrl(paperMeta?.metadataSource?.url)
  const researchFacts: Array<[string, ReactNode]> = [
    ['所属机构', paperAffiliations.length ? <span className="lead-review-inline-tags">{paperAffiliations.map((affiliation) => <a href={externalUrl(affiliation.sourceUrl) || undefined} target="_blank" rel="noreferrer" key={affiliation.name}>{affiliation.name}<ExternalLink /></a>)}</span> : '机构待核验'],
    ['研究团队', text(paperMeta?.researchTeam?.name || verifiedFactText(['profile.team_name']), '研究团队待核验')],
    ['作者—机构对应', paperAuthorAffiliations.length ? <span className="lead-review-rights-note">{paperAuthorAffiliations.map((item) => `${item.author}—${item.affiliation}`).join('；')}<small>仅展示来源明确确认的逐人对应关系</small></span> : <span className="lead-review-rights-note">未确认<small>不根据机构列表强行分配作者</small></span>],
    ['研究方向', industryValue],
    ['成果公开时间', displayDate(paperMeta?.publishedAt || lead.radarProfile?.publishedAt)],
    ...(paperMeta?.publicationDateStatus === 'source_declared_future' && paperMeta.declaredPublishedAt ? [[
      '来源声明日期',
      <span className="lead-review-rights-note">{displayDate(paperMeta.declaredPublishedAt)}<small>来源填写为未来日期，未作为公开时间</small></span>,
    ] as [string, ReactNode]] : []),
    ['成果形态', text(paperMeta?.resourceType || paperMeta?.venue || paperMeta?.categories?.join('、'), '论文/科研成果')],
    ['论文/成果许可', articleLicense ? <a className="lead-review-inline-link" href={externalUrl(articleLicense.url) || undefined} target="_blank" rel="noreferrer">{articleLicense.label}<ExternalLink /></a> : '未披露'],
    ['数据集许可', datasetRights ? <a className="lead-review-inline-link" href={externalUrl(datasetRights.url) || undefined} target="_blank" rel="noreferrer">待核验<ExternalLink /></a> : '未披露'],
    ['知识产权归属', <span className="lead-review-rights-note" title={intellectualProperty?.note || '论文开放许可不等于知识产权归属'}>{intellectualProperty?.label || '未披露'}<small>论文许可不代表成果所有权</small></span>],
    ['元数据来源', metadataSourceUrl ? <a className="lead-review-inline-link" href={metadataSourceUrl} target="_blank" rel="noreferrer">{text(paperMeta?.metadataSource?.provider, '原始论文页面')}<ExternalLink /></a> : '待核验'],
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
  const generatedCompanyIntroduction = text(generatedIntroductions?.companyIntroduction, '')
  const generatedTeamIntroduction = text(generatedIntroductions?.teamIntroduction, '')
  const generatedProjectIntroduction = text(generatedIntroductions?.projectIntroduction, '')
  const generatedIntroductionSources = verifiedProfile?.introductionSources
  const introductionSource = (fact: LeadEnrichmentFact | undefined, generated: LeadEnrichmentEvidence[] | undefined) => (
    fact?.evidence.find((evidence) => Boolean(externalUrl(evidence.sourceUrl)))
      || generated?.find((evidence) => Boolean(externalUrl(evidence.sourceUrl)))
  )
  const headlineIntroductionSource = introductionSource(headlineIntroduction, research
    ? generatedIntroductionSources?.projectIntroduction : generatedIntroductionSources?.companyIntroduction)
    || (companyIntroductionEvidence?.sourceUrl ? { sourceUrl: companyIntroductionEvidence.sourceUrl } : undefined)
  const projectIntroductionSource = introductionSource(verifiedProjectIntroduction, generatedIntroductionSources?.projectIntroduction)
  const teamIntroductionSource = introductionSource(verifiedTeamIntroduction, generatedIntroductionSources?.teamIntroduction)
  const headlineIntroductionText = headlineIntroduction
    ? displayFactValue(headlineIntroduction.value)
    : research ? generatedProjectIntroduction : generatedCompanyIntroduction
  const productValue = verifiedFact('product.name', 'profile.product')
    ? verifiedFactText(['product.name', 'profile.product'])
    : sourceLabeledNode('product', '产品信息待核验')
  const productDescription = verifiedFact('product.performance', 'product.parameter', 'product.matrix')
    ? verifiedFactText(['product.performance', 'product.parameter', 'product.matrix'])
    : sourceLabeledNode('productDescription', '暂无经过来源验证的产品参数或性能数据。')
  const applicationValue = verifiedFact('profile.application_scenario', 'product.use_case')
    ? verifiedFactText(['profile.application_scenario', 'product.use_case'])
    : sourceLabeledNode('applicationScenario', '应用场景待核验')
  const applicationDescription = verifiedFact('profile.customer_type', 'profile.user_problem')
    ? verifiedFactText(['profile.customer_type', 'profile.user_problem'])
    : sourceLabeledNode('applicationDescription', '暂无经过来源验证的客户类型或用户问题。')
  const mainBusinessValue = verifiedFact('profile.main_business')
    ? verifiedFactText(['profile.main_business'])
    : sourceLabeledNode('mainBusiness', '主营业务待核验')
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
  const relatedSources = evidenceSources.length ? evidenceSources : (lead.sources ?? []).filter((source) => Boolean(externalUrl(source.url)))

  return <div className="lead-review-page">
    <div className="lead-review-shell">
      <button className="lead-review-back" type="button" onClick={goBack}><ArrowLeft />返回共享线索池</button>
      <header className="lead-review-hero">
        <div className="lead-review-identity">
          <div className="lead-review-heading-line"><h1>{companyName}</h1><div className="lead-review-meta"><span><MapPin />{text(lead.region)}</span></div></div>
          <p className="lead-review-positioning">{headlineIntroductionText
            ? headlineIntroductionText
            : evidenceBoundCompanyIntroduction || `暂无已验证的${research ? '项目' : '企业'}介绍`}{headlineIntroductionSource && <a className="lead-review-inline-link" href={externalUrl(headlineIntroductionSource.sourceUrl) || undefined} target="_blank" rel="noreferrer">来源<ExternalLink /></a>}</p>
          <div className="lead-review-website-line"><span>{research ? '项目主页' : '公司官网'}：</span>{officialSite ? <a href={officialSite} target="_blank" rel="noreferrer">{officialSite}<ExternalLink /></a> : <span>待补充</span>}</div>
          {!research && articleSourceUrl && <div className="lead-review-website-line"><span>文章来源：</span><a href={articleSourceUrl} target="_blank" rel="noreferrer">{articleSourceUrl}<ExternalLink /></a></div>}
          <div className="lead-review-kicker">{industryTags.map((tag) => <span key={`industry-${tag}`}>{tag}</span>)}{(lead.backgroundTags ?? []).map((tag) => <span className="background" key={`background-${tag}`}>{tag}</span>)}</div>
        </div>
        <div className="lead-review-actions">
          <button className="lead-review-convert-button" type="button" disabled={converted || converting} onClick={() => void handleConvert()}>{converting ? '正在转换…' : converted ? '已转为我的专属项目' : '转为我的专属项目'}</button>
          {currentUser?.role === '系统管理员' && <button className="lead-review-delete-button" type="button" onClick={() => setDeleteConfirmOpen(true)}><Trash2 />删除线索</button>}
        </div>
      </header>

      <main className="lead-review-content">
        <ReviewSection title="项目简介" icon={<Sparkles />}><p className="lead-review-introduction">{verifiedProjectIntroduction ? displayFactValue(verifiedProjectIntroduction.value) : generatedProjectIntroduction || sourceLabeledNode('projectIntroduction', '暂无已验证的项目介绍，不使用企业介绍或原始宣传文案替代')}{projectIntroductionSource && <a className="lead-review-inline-link" href={externalUrl(projectIntroductionSource.sourceUrl) || undefined} target="_blank" rel="noreferrer">来源<ExternalLink /></a>}</p></ReviewSection>
        <ReviewSection title={research ? '科研主体信息' : '主体基础信息'} icon={<Building2 />}><dl className="lead-review-fact-table">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></ReviewSection>
        <ReviewSection title="产品与商业化" icon={<Sparkles />}><div className="lead-review-business-grid">
          <BusinessCard label="产品" value={productValue} description={productDescription} />
          <BusinessCard label="应用场景" value={applicationValue} description={applicationDescription} />
          <BusinessCard label="主营业务" value={mainBusinessValue} description={mainBusinessDescription} />
        </div></ReviewSection>
        <ReviewSection title="团队成员" icon={<UsersRound />}><>{(verifiedTeamIntroduction || generatedTeamIntroduction || sourceLabeledField('teamIntroduction')) && <p className="lead-review-team-summary">{verifiedTeamIntroduction ? displayFactValue(verifiedTeamIntroduction.value) : generatedTeamIntroduction || sourceLabeledNode('teamIntroduction', '')}{teamIntroductionSource && <a className="lead-review-inline-link" href={externalUrl(teamIntroductionSource.sourceUrl) || undefined} target="_blank" rel="noreferrer">来源<ExternalLink /></a>}</p>}<div className="lead-review-team-list">{team.length ? team.map((member, index) => <article key={`${member.name}-${index}`}><span><UserRound /></span><div><h3>{member.profileUrl ? <a href={externalUrl(member.profileUrl) || undefined} target="_blank" rel="noreferrer">{text(member.name)}<ExternalLink /></a> : text(member.name)}<em>{text(member.title, '角色待核验')}</em></h3><p>{text(member.background, '团队背景待核验')}{member.sourceUrl && <a className="lead-review-inline-link" href={externalUrl(member.sourceUrl) || undefined} target="_blank" rel="noreferrer">来源<ExternalLink /></a>}</p></div></article>) : <p className="lead-review-section-empty">暂无可验证的团队成员信息</p>}</div></></ReviewSection>
        <ReviewSection title="证据与动态" icon={<CalendarDays />}><div className="lead-review-evidence-grid">
          <section className="lead-review-path-panel"><header><span>01</span><div><h3>动态路径</h3><p>仅展示已有来源的已验证进展</p></div></header><div className="lead-review-path">{updates.length ? updates.map((item) => <article key={`${item.occurredAt}-${item.title}`}><time>{displayDate(item.occurredAt)}</time>{item.sourceUrl ? <a href={externalUrl(item.sourceUrl) || undefined} target="_blank" rel="noreferrer"><strong>{item.title}</strong><ExternalLink /></a> : <strong>{item.title}</strong>}</article>) : <p className="lead-review-section-empty">暂无经过来源标注的动态</p>}</div></section>
          <section className="lead-review-news-panel"><header><span>02</span><div><h3>相关来源</h3><p>展示可打开的原始来源与已验证事实来源</p></div></header><div className="lead-review-news-list">{relatedSources.slice(0, 10).map((source, index) => <a className="lead-review-news-item" href={externalUrl(source.url) || undefined} target="_blank" rel="noreferrer" key={`${source.url}-${index}`}><div><span>{source.publisher || '公开来源'}</span><time>{displayDate(source.publishedAt || source.accessedAt)}</time></div><strong>{source.title || '原始来源'}</strong><ExternalLink /></a>)}</div></section>
        </div></ReviewSection>
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
  return <article><span>{label}</span><strong>{value}</strong><p>{description}</p></article>
}
