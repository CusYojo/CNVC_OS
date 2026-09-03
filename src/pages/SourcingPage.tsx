import {
  AlertCircle, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, Search, X,
} from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState } from '../components/ui'
import {
  LEAD_POOL_CHANNELS,
  LEAD_POOL_INDUSTRIES,
  LEAD_POOL_REGIONS,
  LEAD_POOL_STAGES,
  LEAD_POOL_UPDATED_RANGES,
  leadPoolFilterSearchParams,
  leadPoolKeywordSearchParams,
  normalizedLeadPoolSearchParams,
  readLeadPoolUrlQuery,
  syncLeadPoolKeywordInput,
} from '../lib/leadPoolFilters'
import { executeLeadPoolRequest } from '../lib/leadPoolRequest'
import { useAppStore, type LeadListQuery } from '../store/useAppStore'
import type { Lead, LeadListItem } from '../types'

const LIST_SCROLL_KEY = 'sbl-lead-pool-scroll-top'

const LIST_EMPTY_VALUES = new Set([
  '', 'null', 'undefined', '待核验', '待核实', '待确认', '未披露', '未披露/待核实',
  '融资轮次待核实', '融资信息未披露', '联网候选', '已有资料', '已有/联网资料',
  '已有资料 · 待核验', '联网候选 · 待核验', '已有/联网资料 · 待核验',
  '无', 'N/A', '不适用', '-',
])

function displayText(value: unknown, fallback = '-') {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  return text && !LIST_EMPTY_VALUES.has(text) ? text : fallback
}

function dateLabel(value?: string) {
  if (!value || displayText(value, '') === '') return '-'
  if (/^\d{4}-\d{2}$/.test(value)) return value.replace('-', '.')
  if (/^\d{4}$/.test(value)) return value
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return displayText(value.replace(/-/g, '.'))
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).replace(/\//g, '.')
}

function relativePoolTime(value?: string) {
  if (!value || displayText(value, '') === '') return '-'
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return value
  const elapsed = Date.now() - time
  if (elapsed < 60 * 60 * 1000) return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前入池`
  if (elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / 3_600_000)} 小时前入池`
  return `${Math.floor(elapsed / 86_400_000)} 天前入池`
}

function leadType(lead: LeadListItem) {
  return lead.leadType === 'research' || lead.radarProfile?.channel === '论文' ? '科研项目' : '企业线索'
}

function subjectName(lead: LeadListItem) {
  if (leadType(lead) === '科研项目') {
    const lab = lead.radarProfile?.profile?.lab
    return displayText(lab || lead.companyName)
  }
  return displayText(lead.companyName)
}

function productStageLabel(product: NonNullable<Lead['investmentProfile']>['products'][number]) {
  const stage = displayText(product.productionStage, '')
  if (!stage || product.productionStageStatus === 'undisclosed') return ''
  if (product.productionStageStatus === 'planned') return `计划：${stage}`
  if (product.productionStageStatus === 'realized') return `已实现：${stage}`
  return stage
}

function pageItems(page: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1)
  const pages = new Set([1, totalPages, page - 2, page - 1, page, page + 1, page + 2])
  const sorted = [...pages].filter((item) => item >= 1 && item <= totalPages).sort((a, b) => a - b)
  const result: Array<number | '…'> = []
  sorted.forEach((item, index) => {
    if (index && item - sorted[index - 1] > 1) result.push('…')
    result.push(item)
  })
  return result
}

export function SourcingPage() {
  const leads = useAppStore((state) => state.leads)
  const pagination = useAppStore((state) => state.leadPagination)
  const fetchLeads = useAppStore((state) => state.fetchLeads)
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const listRef = useRef<HTMLDivElement>(null)
  const requestSerial = useRef(0)
  const normalizedParams = useMemo(() => normalizedLeadPoolSearchParams(params), [params])
  const paramsAreCanonical = normalizedParams.toString() === params.toString()
  const urlQuery = useMemo(() => readLeadPoolUrlQuery(normalizedParams), [normalizedParams])
  const [queryInput, setQueryInput] = useState(urlQuery.keyword)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const { page, pageSize, keyword, leadType: leadTypeValue, industry, stage, region, channel, updatedRange } = urlQuery
  const effectiveLeadType = leadTypeValue || 'company'

  useEffect(() => {
    if (!paramsAreCanonical) setParams(normalizedParams, { replace: true })
  }, [normalizedParams, paramsAreCanonical, setParams])

  useEffect(() => {
    setQueryInput((current) => syncLeadPoolKeywordInput(current, keyword))
  }, [keyword])

  useEffect(() => {
    if (!paramsAreCanonical) return
    const timer = window.setTimeout(() => {
      const next = leadPoolKeywordSearchParams(params, queryInput)
      if (!next) return
      window.sessionStorage.removeItem(LIST_SCROLL_KEY)
      setParams(next, { replace: true })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [keyword, params, paramsAreCanonical, queryInput, setParams])

  const request = useMemo<LeadListQuery>(() => ({
    page, pageSize,
    keyword,
    leadType: effectiveLeadType as LeadListQuery['leadType'],
    industry, stage, region, channel,
    updatedRange: updatedRange as LeadListQuery['updatedRange'],
  }), [channel, effectiveLeadType, industry, keyword, page, pageSize, region, stage, updatedRange])

  const runRequest = useCallback(async () => {
    const serial = ++requestSerial.current
    setLoading(true)
    setError('')
    try {
      const outcome = await executeLeadPoolRequest(
        () => fetchLeads(request),
        () => serial === requestSerial.current,
      )
      if (outcome.status === 'stale') return
      if (outcome.status === 'error') {
        setError(outcome.message)
        return
      }
      const response = outcome.response
      if (!response) return
      if (response.page !== request.page) {
        const next = new URLSearchParams(params)
        next.set('page', String(response.page))
        setParams(next, { replace: true })
      }
      const scrollTop = Number(window.sessionStorage.getItem(LIST_SCROLL_KEY) || 0)
      if (scrollTop > 0) window.requestAnimationFrame(() => listRef.current?.scrollTo({ top: scrollTop }))
    } finally {
      if (serial !== requestSerial.current) return
      setLoading(false)
    }
  }, [fetchLeads, params, request, setParams])

  useEffect(() => {
    if (!paramsAreCanonical) return
    void runRequest()
    return () => { requestSerial.current++ }
  }, [paramsAreCanonical, runRequest])

  const updateParam = (key: string, value: string) => {
    const next = key === 'page'
      ? new URLSearchParams(params)
      : leadPoolFilterSearchParams(params, key, value)
    if (key === 'page') next.set('page', value)
    window.sessionStorage.removeItem(LIST_SCROLL_KEY)
    setParams(next)
  }

  const resetFilters = () => {
    setQueryInput('')
    window.sessionStorage.removeItem(LIST_SCROLL_KEY)
    const next = new URLSearchParams(params)
    for (const key of ['keyword', 'source', 'leadType', 'industry', 'industryLevel1', 'industryLevel2', 'industrySegment', 'stage', 'region', 'channel', 'updatedRange',
      'productRoute', 'institution', 'institutionType', 'academicInstitution', 'latestRound', 'customerStageMin', 'profileStatus',
      'hasConflict', 'sort', 'productionStage', 'hasMajorInstitution', 'academicRelation',
      'hasCommercializationLink', 'fundingDateFrom', 'fundingDateTo', 'valuationMin', 'valuationMax',
      'valuationCurrency', 'valuationType', 'customerTier', 'hasVerifiedCustomer']) {
      next.delete(key)
    }
    next.set('page', '1')
    next.set('pageSize', String(pageSize))
    setParams(next)
  }

  const openLead = (leadId: string) => {
    window.sessionStorage.setItem(LIST_SCROLL_KEY, String(listRef.current?.scrollTop ?? 0))
    navigate(`/sourcing/${leadId}`, { state: { from: `${location.pathname}${location.search}` } })
  }

  const activeFilterCount = [leadTypeValue, industry, stage, region, channel, updatedRange].filter(Boolean).length
  const pages = pageItems(page, Math.max(1, pagination.totalPages))
  const researchLayout = effectiveLeadType === 'research' || channel === '论文' || stage === '科研成果'

  return <div className="lead-pool-page">
    <header className="lead-pool-hero">
      <div><h1>共享线索池</h1><p>汇聚公开渠道与机构推荐，快速发现值得关注的项目机会</p></div>
      <label className="lead-pool-search">
        <Search aria-hidden="true" />
        <input value={queryInput} maxLength={100} onChange={(event) => setQueryInput(event.target.value.slice(0, 100))} placeholder="搜索项目名、团队、领域、关键词…" aria-label="搜索线索" />
        {queryInput && <button type="button" onClick={() => setQueryInput('')} aria-label="清空搜索"><X /></button>}
      </label>
    </header>

    <section className="lead-pool-filter-panel" aria-label="线索筛选">
      <div className="lead-pool-filters">
        <PoolSelect label="线索类型" value={effectiveLeadType} options={[{ value: 'company', label: '企业线索' }, { value: 'research', label: '科研项目' }]} onChange={(value) => updateParam('leadType', value || 'company')} />
        <PoolSelect label="行业" value={industry} options={LEAD_POOL_INDUSTRIES.map((value) => ({ value, label: value }))} onChange={(value) => updateParam('industry', value)} />
        <PoolSelect label="阶段" value={stage} options={LEAD_POOL_STAGES.map((value) => ({ value, label: value }))} onChange={(value) => updateParam('stage', value)} />
        <PoolSelect label="地区" value={region} options={LEAD_POOL_REGIONS.map((value) => ({ value, label: value }))} onChange={(value) => updateParam('region', value)} />
        <PoolSelect label="渠道" value={channel} options={LEAD_POOL_CHANNELS.map((value) => ({ value, label: value }))} onChange={(value) => updateParam('channel', value)} />
        <PoolSelect label="更新时间" value={updatedRange} options={LEAD_POOL_UPDATED_RANGES.map((option) => ({ ...option }))} onChange={(value) => updateParam('updatedRange', value)} />
      </div>
      {(activeFilterCount > 0 || queryInput) && <button className="lead-pool-clear" type="button" onClick={resetFilters}>清空筛选{activeFilterCount ? ` · ${activeFilterCount}` : ''}</button>}
    </section>

    <section className="lead-pool-table-card" aria-label="共享线索池列表">
      <div className="lead-pool-table-scroll">
        <div className={`lead-pool-table${researchLayout ? ' lead-pool-table--research' : ''}`} role="table" aria-label={researchLayout ? '论文板块线索池' : '企业线索池'}>
          <div className="lead-pool-table-head" role="row">
            {researchLayout
              ? <><span role="columnheader">项目 / 论文</span><span role="columnheader">方向 / 研究问题</span><span role="columnheader">作者 / 机构</span><span role="columnheader">最新动态</span><span role="columnheader">更新时间</span></>
              : <><span role="columnheader">企业主体</span><span role="columnheader">方向 / 产品</span><span role="columnheader">团队 / 资本背景</span><span role="columnheader">进展 / 阶段</span><span role="columnheader">最新动态</span><span role="columnheader">更新时间</span></>}
          </div>
          {loading && !leads.length ? <div className="lead-pool-state"><LoaderCircle className="lead-pool-spinner" /><strong>正在读取共享线索</strong><p>请稍候，系统正在加载当前筛选结果。</p></div>
              : error ? <div className="lead-pool-state lead-pool-error"><AlertCircle /><strong>共享线索读取失败</strong><p>{error}</p><button type="button" onClick={() => { void runRequest() }}>重新加载</button></div>
              : leads.length ? <div className="lead-pool-row-group" role="rowgroup" ref={listRef}>{leads.map((lead) => <LeadRow key={lead.id} lead={lead} researchLayout={researchLayout} onOpen={() => openLead(lead.id)} />)}</div>
                : <div className="lead-pool-empty"><EmptyState title="没有匹配的线索" description="请调整搜索词或筛选条件后重试。" /></div>}
          {loading && leads.length > 0 && <div className="lead-pool-refreshing"><LoaderCircle />正在更新</div>}
        </div>
      </div>
      <footer className="lead-pool-pagination">
        <div><strong>共 {pagination.total} 条</strong></div>
        <nav aria-label="共享线索池分页">
          <button type="button" disabled={page <= 1} onClick={() => updateParam('page', String(page - 1))} aria-label="上一页"><ChevronLeft /></button>
          {pages.map((item, index) => item === '…' ? <span key={`ellipsis-${index}`}>…</span> : <button type="button" key={item} className={page === item ? 'active' : ''} onClick={() => updateParam('page', String(item))}>{item}</button>)}
          <button type="button" disabled={page >= pagination.totalPages} onClick={() => updateParam('page', String(page + 1))} aria-label="下一页"><ChevronRight /></button>
        </nav>
        <label className="lead-pool-page-size"><select value={pageSize} onChange={(event) => updateParam('pageSize', event.target.value)} aria-label="每页条数"><option value={10}>10 条/页</option><option value={20}>20 条/页</option><option value={50}>50 条/页</option></select><ChevronDown /></label>
      </footer>
    </section>

  </div>
}

function PoolSelect({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  const selected = options.find((option) => option.value === value)?.label
  return <label className={value ? 'active' : ''}><span>{selected || label}</span><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}><option value="">{label}</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown /></label>
}

export function LeadRow({ lead, onOpen, researchLayout = false }: { lead: LeadListItem; onOpen: () => void; researchLayout?: boolean }) {
  const type = leadType(lead)
  if (type === '科研项目') return <ResearchLeadRow lead={lead} onOpen={onOpen} researchLayout={researchLayout} />
  const profile = lead.investmentProfile
  const availableData = lead.availableData
  const profileIndustryTags = [
    profile?.industry.level1,
    profile?.industry.level2,
    profile?.industry.segment,
    profile?.industry.chainPosition,
  ].filter((value): value is string => displayText(value, '') !== '')
  const allIndustryTags = [...new Set((profileIndustryTags.length ? profileIndustryTags : (availableData?.industryTags ?? []))
    .filter((value) => displayText(value, '') !== ''))]
  const industryTags = allIndustryTags.slice(0, 4)
  const candidateProducts = (availableData?.products ?? []).filter((product) => (
    [product.name, product.productRoute, product.technologyRoute, product.productionStage]
      .some((value) => displayText(value, '') !== '')
  ))
  const allProducts = profile?.products.length ? profile.products : candidateProducts
  const products = allProducts.slice(0, 2)
  const candidateInstitutions = (availableData?.institutions ?? [])
    .filter((institution) => displayText(institution.name, '') !== '')
  const candidateAcademicLinks = (availableData?.academicLinks ?? [])
    .filter((link) => displayText(link.institution, '') !== '')
  const profileInstitutions = profile?.institutions.length ? profile.institutions : candidateInstitutions
  const profileAcademicLinks = profile?.academicLinks.length ? profile.academicLinks : candidateAcademicLinks
  const hasInstitutionAndAcademic = profileInstitutions.length > 0 && profileAcademicLinks.length > 0
  const institutions = profileInstitutions.slice(0, hasInstitutionAndAcademic ? 1 : 2)
  const academicLinks = profileAcademicLinks.slice(0, hasInstitutionAndAcademic ? 1 : 2)
  const hiddenIndustryCount = Math.max(0, allIndustryTags.length - industryTags.length)
  const hiddenProductCount = Math.max(0, allProducts.length - products.length)
  const hiddenBackgroundCount = Math.max(0, profileInstitutions.length + profileAcademicLinks.length
    - institutions.length - academicLinks.length)
  const profileFinancing = profile?.financing
  const fallbackFinancing = availableData?.financing
  const financing = !profileFinancing && !fallbackFinancing ? null : {
    status: displayText(profileFinancing?.status, '') || displayText(fallbackFinancing?.status, ''),
    latestRound: displayText(profileFinancing?.latestRound, '') || displayText(fallbackFinancing?.latestRound, ''),
    latestRoundDate: displayText(profileFinancing?.latestRoundDate, '') || displayText(fallbackFinancing?.latestRoundDate, ''),
    latestAmount: displayText(profileFinancing?.latestAmount, '') || displayText(fallbackFinancing?.latestAmount, ''),
  }
  const updates = (lead.latestUpdates ?? []).slice(0, 2)
  const subjectTags = [type, displayText(lead.region, '')].filter((tag) => tag && tag !== '-')
  return <article className="lead-pool-row" role="row" tabIndex={0} aria-label={`查看${lead.name}详情页`} onClick={onOpen} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen() } }}>
    <div className="lead-pool-project" role="cell"><button type="button" onClick={(event) => { event.stopPropagation(); onOpen() }}><span><strong>{displayText(lead.name, '未命名线索')}</strong><small title={subjectName(lead)}>{subjectName(lead)}</small></span></button><div className="lead-pool-tags">{subjectTags.map((tag, index) => <em key={`${tag}-${index}`}>{tag}</em>)}</div></div>
    <div className="lead-pool-profile-cell" role="cell"><div className="lead-pool-tags">{industryTags.length ? industryTags.map((tag) => <em key={tag}>{tag}</em>) : <span>-</span>}{hiddenIndustryCount > 0 && <small>+{hiddenIndustryCount}</small>}</div>{products.length ? products.map((product) => <p key={`${product.name}-${product.productRoute}`}><strong>{displayText(product.name)}</strong><span>{[displayText(product.productRoute, ''), displayText(product.technologyRoute, ''), productStageLabel(product)].filter(Boolean).join(' · ') || '-'}</span></p>) : <p>-</p>}{hiddenProductCount > 0 && <small>+{hiddenProductCount} 个产品</small>}</div>
    <div className="lead-pool-profile-cell" role="cell">{institutions.map((item) => <p key={`${item.name}-${item.round}`}><strong>{displayText(item.name)}{item.major ? ' · 重点机构' : ''}</strong><span>{[displayText(item.round, ''), item.role === 'lead' ? '领投' : item.role === 'follow' ? '跟投' : item.role === 'strategic' ? '战略投资' : ''].filter(Boolean).join(' · ')}</span></p>)}{academicLinks.map((item) => <p key={`${item.institution}-${item.person}`}><strong>{displayText(item.institution)}</strong><span>{[displayText(item.person, ''), displayText(item.relationType, ''), item.commercialization ? '成果转化' : ''].filter(Boolean).join(' · ')}</span></p>)}{!institutions.length && !academicLinks.length && <p>-</p>}{hiddenBackgroundCount > 0 && <small>+{hiddenBackgroundCount} 项背景</small>}</div>
    <dl className="lead-pool-profile-list" role="cell">{financing ? <><div><dt>状态</dt><dd>{displayText(financing.status, '-')}</dd></div><div><dt>轮次</dt><dd>{[displayText(financing.latestRound, ''), financing.latestRoundDate ? dateLabel(financing.latestRoundDate) : ''].filter(Boolean).join(' · ') || '-'}</dd></div><div><dt>本轮</dt><dd>{displayText(financing.latestAmount, '-')}</dd></div></> : <div><dd>-</dd></div>}</dl>
    <div className="lead-pool-updates" role="cell">{updates.length ? updates.map((item, index) => <div key={`${item.occurredAt}-${item.title}`}><i className={index === 0 ? 'unread' : ''} /><span><time>{dateLabel(item.occurredAt).slice(5)}</time>{item.title}</span></div>) : <span className="lead-pool-no-update">暂无更新</span>}</div>
    <div className="lead-pool-updated" role="cell"><strong>{dateLabel(lead.dataUpdatedAt || lead.poolEnteredAt)}</strong><span>{relativePoolTime(lead.poolEnteredAt)}</span><div className="lead-pool-row-actions"><button className="lead-pool-open-button" type="button" onClick={(event) => { event.stopPropagation(); onOpen() }} aria-label={`打开${lead.name}详情页`} title="查看详情"><ChevronRight /></button></div></div>
  </article>
}

function ResearchLeadRow({ lead, onOpen, researchLayout }: { lead: LeadListItem; onOpen: () => void; researchLayout: boolean }) {
  const profile = lead.researchProfile
  const paperMeta = lead.radarProfile?.paperMeta
  const directions = (profile?.direction.categories ?? []).slice(0, 3)
  const methods = (profile?.direction.methods ?? []).slice(0, 2)
  const authors = (profile?.team.authors ?? []).slice(0, 3)
  const affiliations = (profile?.team.affiliations ?? []).slice(0, 2)
  const progress = profile?.progress
  const value = profile?.valueAndTransfer
  const rights = profile?.rights
  const updates = (profile?.latestDevelopments?.length ? profile.latestDevelopments : lead.latestUpdates ?? []).slice(0, 2)
  const artifacts = [
    progress?.codeUrl ? '代码已公开' : '', progress?.datasetUrl ? '数据集已公开' : '', progress?.modelUrl ? '模型已公开' : '',
  ].filter(Boolean)
  const valueLines = [
    value?.trl ? `TRL ${value.trl}` : '', value?.validation, value?.prototype,
    value?.applicationScenarios?.[0], value?.transferStatus, value?.commercialization,
    rights?.patents?.[0] ? `专利：${rights.patents[0]}` : '',
  ].map((item) => displayText(item, '')).filter(Boolean).slice(0, 3)
  const identity = profile?.subject.providerIds ?? {}
  const identityLabel = identity.doi ? `DOI ${identity.doi}` : identity.arxivId ? `arXiv ${identity.arxivId}` : identity.openAlexId ? `OpenAlex ${identity.openAlexId}` : ''
  if (researchLayout) {
    const projectName = displayText(paperMeta?.projectName, '') || displayText(profile?.subject.name || lead.name, '未命名科研项目')
    const paperTitle = displayText(paperMeta?.titleZh || profile?.subject.title || lead.name, projectName)
    return <article className="lead-pool-row lead-pool-row--research" role="row" tabIndex={0} aria-label={`查看${lead.name}研判页`} onClick={onOpen} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen() } }}>
      <div className="lead-pool-project" role="cell"><button type="button" onClick={(event) => { event.stopPropagation(); onOpen() }}><span><strong>{projectName}</strong><small title={paperTitle}>{paperTitle}</small></span></button><div className="lead-pool-tags"><em>科研项目</em>{identityLabel && <em className="background">{identityLabel}</em>}</div></div>
      <div className="lead-pool-profile-cell lead-pool-research-problem" role="cell"><div className="lead-pool-tags">{directions.length ? directions.map((tag) => <em key={tag}>{tag}</em>) : <span>-</span>}</div>{methods.length ? methods.map((method) => <p key={method}><strong>{method}</strong></p>) : profile?.direction.researchProblem ? <p title={profile.direction.researchProblem}><span>{profile.direction.researchProblem}</span></p> : null}</div>
      <div className="lead-pool-profile-cell" role="cell">{authors.length ? <p><strong>{authors.map((author) => author.name).join('、')}</strong><span>{profile && profile.team.authors.length > authors.length ? `共 ${profile.team.authors.length} 位作者` : authors.map((author) => displayText(author.role, '')).filter(Boolean).join(' · ')}</span></p> : <p>-</p>}{affiliations.map((affiliation) => <p key={affiliation}><span>{affiliation}</span></p>)}</div>
      <div className="lead-pool-updates" role="cell">{updates.length ? updates.map((item, index) => <div key={`${item.occurredAt}-${item.title}`}><i className={index === 0 ? 'unread' : ''} /><span><time>{dateLabel(item.occurredAt).slice(5)}</time>{item.title}</span></div>) : <span className="lead-pool-no-update">暂无更新</span>}</div>
      <div className="lead-pool-updated" role="cell"><strong>{dateLabel(profile?.dataStatus.updatedAt || lead.dataUpdatedAt || lead.poolEnteredAt)}</strong>{profile && <span>资料 {profile.dataStatus.verifiedDimensions}/{profile.dataStatus.applicableDimensions}</span>}<div className="lead-pool-row-actions"><button className="lead-pool-open-button" type="button" onClick={(event) => { event.stopPropagation(); onOpen() }} aria-label={`打开${lead.name}研判页`} title="查看详情"><ChevronRight /></button></div></div>
    </article>
  }
  return <article className="lead-pool-row" role="row" tabIndex={0} aria-label={`查看${lead.name}研判页`} onClick={onOpen} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen() } }}>
    <div className="lead-pool-project" role="cell"><button type="button" onClick={(event) => { event.stopPropagation(); onOpen() }}><span><strong>{displayText(profile?.subject.title || lead.name, '未命名科研线索')}</strong><small>{displayText(identityLabel || profile?.subject.provider, '-')}</small></span></button><div className="lead-pool-tags"><em>科研项目</em><em>{displayText(lead.region, '-')}</em></div></div>
    <div className="lead-pool-profile-cell" role="cell"><div className="lead-pool-tags">{directions.length ? directions.map((tag) => <em key={tag}>{tag}</em>) : <span>-</span>}</div>{methods.length ? methods.map((method) => <p key={method}><strong>{method}</strong></p>) : profile?.direction.researchProblem ? <p><span>{profile.direction.researchProblem}</span></p> : <p>-</p>}</div>
    <div className="lead-pool-profile-cell" role="cell">{authors.length ? <p><strong>{authors.map((author) => author.name).join('、')}</strong><span>{authors.map((author) => displayText(author.role, '')).filter(Boolean).join(' · ')}</span></p> : <p>-</p>}{affiliations.map((affiliation) => <p key={affiliation}><span>{affiliation}</span></p>)}</div>
    <dl className="lead-pool-profile-list" role="cell">{progress ? <><div><dt>发表</dt><dd>{[displayText(progress.venue, ''), dateLabel(progress.publishedAt)].filter((item) => item !== '-').join(' · ') || '-'}</dd></div>{artifacts.length ? <div><dt>成果</dt><dd>{artifacts.join(' · ')}</dd></div> : null}{progress.reproducibility ? <div><dt>复现</dt><dd>{progress.reproducibility}</dd></div> : null}</> : <div><dd>-</dd></div>}</dl>
    <dl className="lead-pool-profile-list" role="cell">{valueLines.length ? valueLines.map((line, index) => <div key={`${line}-${index}`}><dt>{index === 0 ? '价值' : ''}</dt><dd>{line}</dd></div>) : <div><dd>-</dd></div>}</dl>
    <div className="lead-pool-updates" role="cell">{updates.length ? updates.map((item, index) => <div key={`${item.occurredAt}-${item.title}`}><i className={index === 0 ? 'unread' : ''} /><span><time>{dateLabel(item.occurredAt).slice(5)}</time>{item.title}</span></div>) : <span className="lead-pool-no-update">暂无更新</span>}</div>
    <div className="lead-pool-updated" role="cell"><strong>{dateLabel(profile?.dataStatus.updatedAt || lead.dataUpdatedAt || lead.poolEnteredAt)}</strong><span>{relativePoolTime(lead.poolEnteredAt)}</span><div className="lead-pool-row-actions"><button className="lead-pool-open-button" type="button" onClick={(event) => { event.stopPropagation(); onOpen() }} aria-label={`打开${lead.name}研判页`} title="查看详情"><ChevronRight /></button></div></div>
  </article>
}
