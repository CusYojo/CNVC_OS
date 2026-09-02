import {
  AlertCircle, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, Search, X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState } from '../components/ui'
import { splitLeadIndustryTags } from '../lib/leadPresentation'
import { useAppStore, type LeadListQuery } from '../store/useAppStore'
import type { Lead, LeadRatingGrade } from '../types'

const CHANNEL_OPTIONS = ['36氪', '机构公众号', '高校公众号', '论文', '新闻', '微信群聊']
const INDUSTRY_OPTIONS = [
  '人工智能', '具身智能/机器人', '半导体/芯片', '前沿技术', '产业升级', '先进制造',
  '企业服务', '医疗健康', '生物医药', '新能源', '新材料', '汽车出行',
  '消费科技', '文化娱乐', '教育', '农业科技',
  '自然语言处理', '计算机视觉', '网络安全', '数据科学', '软件工程',
  '金融', '智能硬件/传感器', '工具软件', '算力基础设施', '能源环保', '物联网/硬件',
  '低空经济', '本地生活', '跨境出海', '物流', '旅游', '其他',
]
const REGION_OPTIONS = [
  '北京', '上海', '天津', '重庆', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东',
  '广西', '海南', '四川', '贵州', '云南', '西藏', '陕西', '甘肃', '青海', '宁夏',
  '新疆', '香港', '澳门', '台湾',
]
const STAGE_OPTIONS = ['种子轮', '天使轮', 'Pre-A轮', 'A轮', 'B轮', 'C轮及以后', '战略融资', '科研成果']
const UPDATED_OPTIONS = [
  { value: '7d', label: '近7天' },
  { value: '30d', label: '近30天' },
  { value: '90d', label: '近90天' },
]
const LIST_SCROLL_KEY = 'sbl-lead-pool-scroll-top'

function displayText(value: unknown, fallback = '待核验') {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  return text && !['null', 'undefined'].includes(text) ? text : fallback
}

function dateLabel(value?: string) {
  if (!value) return '待确认'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.replace(/-/g, '.')
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).replace(/\//g, '.')
}

function relativePoolTime(value?: string) {
  if (!value) return '入池时间待确认'
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return value
  const elapsed = Date.now() - time
  if (elapsed < 60 * 60 * 1000) return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前入池`
  if (elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / 3_600_000)} 小时前入池`
  return `${Math.floor(elapsed / 86_400_000)} 天前入池`
}

function leadType(lead: Lead) {
  return lead.leadType === 'research' || lead.radarProfile?.channel === '论文' ? '科研项目' : '企业线索'
}

function subjectName(lead: Lead) {
  if (leadType(lead) === '科研项目') {
    const lab = lead.radarProfile?.profile?.lab
    return displayText(lab || lead.companyName, '机构/实验室待核验')
  }
  return displayText(lead.companyName, '主体待核验')
}

function fundingDisplay(lead: Lead) {
  if (leadType(lead) === '科研项目') return { status: '-', amount: '-', valuation: '-' }
  const first = lead.fundingRounds?.[0]
  const profile = lead.radarProfile?.profile
  const reviewedFunding = lead.scoring?.dataQualityV1?.funding
  const rawAmount = first?.amount || profile?.financingAmount
  const status = displayText(lead.fundingStatusDisplay, '待核验')
  if (status === '不适用') return { status: '-', amount: '-', valuation: '-' }
  const rawAmountDisplay = displayText(reviewedFunding?.amountDisplay || (rawAmount ? '融资金额待核验' : ''), '未披露')
  const amount = status === '未融资'
    ? '—'
    : /待核验|待确认|待核实/.test(rawAmountDisplay)
      ? '待核验'
      : /未披露|暂未披露|未透露|^无$/.test(rawAmountDisplay)
        ? '未披露'
        : rawAmountDisplay
  const rawValuationDisplay = displayText(lead.valuationDisplay?.value || first?.valuation || profile?.latestValuation, '')
  const valuation = status === '未融资'
    ? '—'
    : rawValuationDisplay
      ? rawValuationDisplay
      : lead.valuationDisplay?.status === 'pending'
        ? '待核验'
        : '未披露'
  return { status, amount, valuation }
}

function signalLabels(lead: Lead) {
  const ratingTags = lead.scoring?.ratingV3?.detailView.rating.coreTags ?? []
  const radarSignals = Array.isArray(lead.radarProfile?.signals) ? lead.radarProfile.signals : []
  const labels = radarSignals.map((signal) => {
    if (typeof signal === 'string') return signal
    if (signal && typeof signal === 'object') return displayText(signal.code || signal.detail, '')
    return ''
  })
  return [...new Set([...ratingTags, ...labels, ...(lead.riskTags ?? [])].filter(Boolean))].slice(0, 3)
}

function FastClampedText({ text, className, ariaLabel, role }: { text: string; className: string; ariaLabel: string; role?: 'cell' }) {
  const [tooltip, setTooltip] = useState<{ left: number; top: number; width: number } | null>(null)
  const show = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect()
    const width = Math.min(380, window.innerWidth - 32)
    setTooltip({
      left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
      top: Math.max(16, Math.min(rect.bottom + 6, window.innerHeight - 170)),
      width,
    })
  }
  return <>
    <div
      className={className}
      role={role}
      tabIndex={0}
      aria-label={`${ariaLabel}：${text}`}
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseLeave={() => setTooltip(null)}
      onFocus={(event) => show(event.currentTarget)}
      onBlur={() => setTooltip(null)}
    ><p>{text}</p></div>
    {tooltip && createPortal(<div className="lead-pool-fast-tooltip" role="tooltip" style={tooltip}>{text}</div>, document.body)}
  </>
}

function FastReasonText({ text }: { text: string }) {
  return <FastClampedText text={text} className="lead-pool-reason-copy" ariaLabel="完整推荐理由" />
}

function FastSummaryText({ text }: { text: string }) {
  return <FastClampedText text={text} className="lead-pool-summary" ariaLabel="完整一句话摘要" role="cell" />
}

function joinedReason(highlights: string[]) {
  const sentences = highlights
    .map((item) => item.trim().replace(/[，,；;。！？!?]+$/g, ''))
    .filter(Boolean)
  return sentences.length ? `${sentences.join('；')}。` : '推荐依据待进一步核验'
}

function ratingReason(lead: Lead) {
  const ratingV3 = lead.scoring?.ratingV3
  const judgment = ratingV3?.detailView.rating.oneSentenceJudgment?.trim() || ''
  const legacyHighlights = (lead.highlights ?? []).filter(Boolean).slice(0, 2)
  if (!ratingV3) return joinedReason(legacyHighlights)

  // D / 无法评级线索应直接解释证据缺口，避免继续展示历史正向推荐语。
  if (ratingV3?.detailView.rating.status === '无法评级' || ratingV3?.mainView.displayGrade === 'D') {
    return judgment ? joinedReason([judgment]) : '现有材料不足，暂无法形成有效评级。'
  }

  const investmentTheses = (ratingV3?.detailView.investmentThesis ?? [])
    .map((item) => item.thesis)
    .filter(Boolean)
    .slice(0, 2)
  if (investmentTheses.length) return joinedReason(investmentTheses)
  if (judgment) return joinedReason([judgment])
  return '推荐依据待进一步核验'
}

function ratingLabel(lead: Lead): { label: LeadRatingGrade | '补全中' | '待复核' | '评级中' | '评级过期' | '补全失败' | '评级失败'; className?: string } {
  if (['queued', 'running'].includes(lead.scoring?.enrichment?.status || '')) return { label: '补全中', className: 'pending' }
  if (lead.scoring?.enrichment?.status === 'review') return { label: '待复核', className: 'failed' }
  if (lead.scoring?.enrichment?.status === 'rejected') return { label: '补全失败', className: 'failed' }
  if (lead.rating?.status === 'running') return { label: '评级中', className: 'pending' }
  if (lead.rating?.status === 'failed') return { label: '评级失败', className: 'failed' }
  if (lead.rating?.status === 'stale') return { label: '评级过期', className: 'failed' }
  const grade = lead.rating?.displayGrade ?? '待评级'
  return {
    label: grade,
    className: grade === '待评级' ? 'pending' : grade === 'D' ? 'grade-d' : undefined,
  }
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
  const [queryInput, setQueryInput] = useState(params.get('keyword') ?? '')
  const [debouncedQuery, setDebouncedQuery] = useState(queryInput)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const page = Math.max(1, Number(params.get('page') || 1))
  const pageSize = [10, 20, 50].includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 20
  const leadTypeValue = params.get('leadType') ?? ''
  const industry = params.get('industry') ?? ''
  const stage = params.get('stage') ?? ''
  const region = params.get('region') ?? ''
  const channel = params.get('channel') ?? ''
  const updatedRange = params.get('updatedRange') ?? ''

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(queryInput.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [queryInput])

  useEffect(() => {
    const currentKeyword = params.get('keyword') ?? ''
    if (currentKeyword === debouncedQuery) return
    const next = new URLSearchParams(params)
    if (debouncedQuery) next.set('keyword', debouncedQuery)
    else next.delete('keyword')
    next.set('page', '1')
    window.sessionStorage.removeItem(LIST_SCROLL_KEY)
    setParams(next, { replace: true })
  }, [debouncedQuery, params, setParams])

  const request = useMemo<LeadListQuery>(() => ({
    page, pageSize,
    keyword: params.get('keyword') ?? '',
    leadType: leadTypeValue as LeadListQuery['leadType'],
    industry, stage, region, channel,
    updatedRange: updatedRange as LeadListQuery['updatedRange'],
  }), [channel, industry, leadTypeValue, page, pageSize, params, region, stage, updatedRange])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void fetchLeads(request).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : '共享线索读取失败')
    }).finally(() => {
      if (!active) return
      setLoading(false)
      const scrollTop = Number(window.sessionStorage.getItem(LIST_SCROLL_KEY) || 0)
      if (scrollTop > 0) window.requestAnimationFrame(() => listRef.current?.scrollTo({ top: scrollTop }))
    })
    return () => { active = false }
  }, [fetchLeads, request])

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    next.set('page', key === 'page' ? value : '1')
    window.sessionStorage.removeItem(LIST_SCROLL_KEY)
    setParams(next)
  }

  const resetFilters = () => {
    setQueryInput('')
    window.sessionStorage.removeItem(LIST_SCROLL_KEY)
    setParams(new URLSearchParams({ page: '1', pageSize: String(pageSize) }))
  }

  const openLead = (leadId: string) => {
    window.sessionStorage.setItem(LIST_SCROLL_KEY, String(listRef.current?.scrollTop ?? 0))
    navigate(`/sourcing/${leadId}`, { state: { from: `${location.pathname}${location.search}` } })
  }

  const activeFilterCount = [leadTypeValue, industry, stage, region, channel, updatedRange].filter(Boolean).length
  const pages = pageItems(page, Math.max(1, pagination.totalPages))

  return <div className="lead-pool-page">
    <header className="lead-pool-hero">
      <div><h1>共享线索池</h1><p>汇聚公开渠道与机构推荐，快速发现值得关注的项目机会</p></div>
      <label className="lead-pool-search">
        <Search aria-hidden="true" />
        <input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="搜索项目名、团队、领域、关键词…" aria-label="搜索线索" />
        {queryInput && <button type="button" onClick={() => setQueryInput('')} aria-label="清空搜索"><X /></button>}
      </label>
    </header>

    <section className="lead-pool-filter-panel" aria-label="线索筛选">
      <div className="lead-pool-filters">
        <PoolSelect label="线索类型" value={leadTypeValue} options={[{ value: 'company', label: '企业线索' }, { value: 'research', label: '科研项目' }]} onChange={(value) => updateParam('leadType', value)} />
        <PoolSelect label="行业" value={industry} options={INDUSTRY_OPTIONS.map((value) => ({ value, label: value }))} onChange={(value) => updateParam('industry', value)} />
        <PoolSelect label="阶段" value={stage} options={STAGE_OPTIONS.map((value) => ({ value, label: value }))} onChange={(value) => updateParam('stage', value)} />
        <PoolSelect label="地区" value={region} options={REGION_OPTIONS.map((value) => ({ value, label: value }))} onChange={(value) => updateParam('region', value)} />
        <PoolSelect label="渠道" value={channel} options={CHANNEL_OPTIONS.map((value) => ({ value, label: value }))} onChange={(value) => updateParam('channel', value)} />
        <PoolSelect label="更新时间" value={updatedRange} options={UPDATED_OPTIONS} onChange={(value) => updateParam('updatedRange', value)} />
      </div>
      {(activeFilterCount > 0 || queryInput) && <button className="lead-pool-clear" type="button" onClick={resetFilters}>清空筛选{activeFilterCount ? ` · ${activeFilterCount}` : ''}</button>}
    </section>

    <section className="lead-pool-table-card" aria-label="共享线索池列表">
      <div className="lead-pool-table" role="table" aria-label="共享线索池">
        <div className="lead-pool-table-head" role="row">
          <span role="columnheader">项目概况</span><span role="columnheader">一句话摘要</span><span role="columnheader">核心信息</span><span role="columnheader">推荐理由 / 信号</span><span role="columnheader">融资 / 估值</span><span role="columnheader">最新动态</span><span role="columnheader">更新时间</span>
        </div>
        {loading && !leads.length ? <div className="lead-pool-state"><LoaderCircle className="lead-pool-spinner" /><strong>正在读取共享线索</strong><p>请稍候，系统正在加载当前筛选结果。</p></div>
          : error ? <div className="lead-pool-state lead-pool-error"><AlertCircle /><strong>共享线索读取失败</strong><p>{error}</p><button type="button" onClick={() => { setError(''); setLoading(true); void fetchLeads(request).finally(() => setLoading(false)) }}>重新加载</button></div>
            : leads.length ? <div className="lead-pool-row-group" role="rowgroup" ref={listRef}>{leads.map((lead) => <LeadRow key={lead.id} lead={lead} onOpen={() => openLead(lead.id)} />)}</div>
              : <div className="lead-pool-empty"><EmptyState title="没有匹配的线索" description="请调整搜索词或筛选条件后重试。" /></div>}
        {loading && leads.length > 0 && <div className="lead-pool-refreshing"><LoaderCircle />正在更新</div>}
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

function LeadRow({ lead, onOpen }: { lead: Lead; onOpen: () => void }) {
  const type = leadType(lead)
  const rating = ratingLabel(lead)
  const funding = fundingDisplay(lead)
  const signals = signalLabels(lead)
  const industryTags = [...new Set([
    ...(lead.businessTags?.industry ?? []),
    ...splitLeadIndustryTags(lead.industry),
  ])].slice(0, 6)
  const updates = (lead.latestUpdates ?? []).slice(0, 2)
  const summaryText = displayText(lead.summary, '暂无可验证摘要')
  const reasonText = ratingReason(lead)
  const researchFacts = [
    ['成果', displayText(lead.radarProfile?.paperMeta?.venue || lead.radarProfile?.paperMeta?.categories?.[0], '论文/成果')],
    ['验证', lead.verificationStatus], ['转化', displayText(lead.businessStageDisplay || lead.stageDisplay, '待核验')],
  ]
  const companyFacts = [
    ['成立', displayText(lead.companyRegistry?.foundedAt || lead.foundedAtDisplay)],
    ['法人', displayText(lead.companyRegistry?.legalRepresentative)],
    ['地点', displayText(lead.region)],
  ]
  return <article className="lead-pool-row" role="row" tabIndex={0} aria-label={`查看${lead.name}研判页`} onClick={onOpen} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen() } }}>
    <div className="lead-pool-project" role="cell"><button type="button" onClick={(event) => { event.stopPropagation(); onOpen() }}><span><strong>{displayText(lead.name, '未命名线索')}</strong><small title={subjectName(lead)}>{subjectName(lead)}</small></span></button><div className="lead-pool-tags"><em>{type}</em>{industryTags.map((tag) => <em key={`industry-${tag}`}>{tag}</em>)}{(lead.backgroundTags ?? []).map((tag) => <em className="background" key={`background-${tag}`}>{tag}</em>)}</div></div>
    <FastSummaryText text={summaryText} />
    <dl className="lead-pool-facts" role="cell">{(type === '科研项目' ? researchFacts : companyFacts).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <div className="lead-pool-reason" role="cell"><FastReasonText text={reasonText} />{signals.length > 0 && <div className="lead-pool-signals">{signals.map((signal) => <span key={signal}>{signal}</span>)}</div>}<div className="lead-pool-rating" aria-label={`线索评级 ${rating.label}`}><span>线索评级</span><strong className={rating.className}>{rating.label}</strong></div></div>
    <dl className="lead-pool-funding" role="cell">{[
      ['融资状态', funding.status], ['融资金额', funding.amount], ['估值', funding.valuation],
    ].map(([label, value], index) => <div key={label}><dt>{label}</dt><dd className={index === 0 ? 'status' : undefined} title={value}>{value}</dd></div>)}</dl>
    <div className="lead-pool-updates" role="cell">{updates.length ? updates.map((item, index) => <div key={`${item.occurredAt}-${item.title}`}><i className={index === 0 ? 'unread' : ''} /><span><time>{dateLabel(item.occurredAt).slice(5)}</time>{item.title}</span></div>) : <span className="lead-pool-no-update">暂无更新</span>}</div>
    <div className="lead-pool-updated" role="cell"><strong>{dateLabel(lead.dataUpdatedAt || lead.poolEnteredAt)}</strong><span>{relativePoolTime(lead.poolEnteredAt)}</span><div className="lead-pool-row-actions"><button className="lead-pool-open-button" type="button" onClick={(event) => { event.stopPropagation(); onOpen() }} aria-label={`打开${lead.name}研判页`} title="查看详情"><ChevronRight /></button></div></div>
  </article>
}
