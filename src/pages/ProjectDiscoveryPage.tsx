import {
  ArrowRight, Building2, CalendarDays, CheckCircle2, FlaskConical, LoaderCircle,
  MapPin, RefreshCw, Search, Sparkles, TrendingUp, X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { EmptyState } from '../components/ui'
import {
  buildProjectDiscoverySummary,
  discoveryCandidateKind,
  filterProjectDiscoveryCandidates,
  projectDiscoveryCandidateDay,
  type ProjectDiscoveryKind,
  type ProjectDiscoveryPeriod,
} from '../lib/projectDiscovery'
import { useAppStore } from '../store/useAppStore'
import type { LeadListItem } from '../types'
import './ProjectDiscoveryPage.css'

const periods: Array<{ value: ProjectDiscoveryPeriod; label: string }> = [
  { value: 'today', label: '今天新发现' },
  { value: 'week', label: '近 7 天' },
  { value: 'all', label: '全部' },
]

const kinds: Array<{ value: ProjectDiscoveryKind; label: string }> = [
  { value: 'all', label: '全部类型' },
  { value: 'company', label: '企业项目' },
  { value: 'research', label: '科研成果' },
]

export function ProjectDiscoveryPage() {
  const fetchLeads = useAppStore((state) => state.fetchLeads)
  const navigate = useNavigate()
  const location = useLocation()
  const [candidates, setCandidates] = useState<LeadListItem[]>([])
  const [period, setPeriod] = useState<ProjectDiscoveryPeriod>('week')
  const [kind, setKind] = useState<ProjectDiscoveryKind>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const loadCandidates = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setLoading(true)
    setError('')
    try {
      const response = await fetchLeads({ page: 1, pageSize: 50, sort: 'latest' })
      if (response) setCandidates(response.list)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新项目读取失败')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [fetchLeads])

  useEffect(() => { void loadCandidates() }, [loadCandidates])

  const visible = useMemo(() => filterProjectDiscoveryCandidates(candidates, {
    period, query, kind,
  }), [candidates, kind, period, query])
  const summary = useMemo(() => buildProjectDiscoverySummary(visible), [visible])

  const openLead = (lead: LeadListItem) => {
    navigate(`/sourcing/${lead.id}`, { state: { from: `${location.pathname}${location.search}` } })
  }

  return <div className="project-discovery-page">
    <header className="project-discovery-hero">
      <div className="project-discovery-title">
        <span><Sparkles aria-hidden="true" /></span>
        <div><h1>新项目发现</h1><p>从已收录的公开信源中，按时间线发现值得研判的企业与科研成果。</p></div>
      </div>
      <button type="button" className="project-discovery-refresh" disabled={loading || refreshing} onClick={() => void loadCandidates(true)}>
        <RefreshCw className={refreshing ? 'is-spinning' : ''} aria-hidden="true" />{refreshing ? '正在刷新' : '刷新发现'}
      </button>
    </header>

    <section className="project-discovery-metrics" aria-label="发现概览">
      <DiscoveryMetric icon={<TrendingUp />} label="当前结果" value={summary.total} tone="blue" />
      <DiscoveryMetric icon={<Building2 />} label="企业项目" value={summary.companies} tone="cyan" />
      <DiscoveryMetric icon={<FlaskConical />} label="科研成果" value={summary.research} tone="purple" />
      <DiscoveryMetric icon={<CheckCircle2 />} label="可研判画像" value={summary.verified} tone="green" />
    </section>

    <section className="project-discovery-toolbar" aria-label="项目发现筛选">
      <div className="project-discovery-periods" role="group" aria-label="发现时间范围">
        {periods.map((item) => <button key={item.value} type="button" aria-pressed={period === item.value} onClick={() => setPeriod(item.value)}>{item.label}</button>)}
      </div>
      <label className="project-discovery-kind">
        <span className="sr-only">发现类型</span>
        <select value={kind} aria-label="发现类型" onChange={(event) => setKind(event.target.value as ProjectDiscoveryKind)}>
          {kinds.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label className="project-discovery-search">
        <Search aria-hidden="true" />
        <input value={query} maxLength={100} onChange={(event) => setQuery(event.target.value.slice(0, 100))} placeholder="搜索项目、赛道、产品或机构" aria-label="搜索新发现项目" />
        {query && <button type="button" onClick={() => setQuery('')} aria-label="清空发现搜索"><X /></button>}
      </label>
    </section>

    <section className="project-discovery-results" aria-labelledby="project-discovery-results-title">
      <div className="project-discovery-results-heading">
        <div><h2 id="project-discovery-results-title">待查看项目</h2><p>按最新资料时间排序，点击卡片进入线索详情核对来源与证据。</p></div>
        <strong>{visible.length} 项</strong>
      </div>

      {loading ? <div className="project-discovery-state"><LoaderCircle className="is-spinning" /><strong>正在整理最新项目信号</strong><p>读取已收录的公开信源与结构化画像。</p></div>
        : error ? <div className="project-discovery-state project-discovery-error"><strong>新项目读取失败</strong><p>{error}</p><button type="button" onClick={() => void loadCandidates()}>重新加载</button></div>
          : visible.length === 0 ? <EmptyState title="当前范围没有新项目" description="试试切换到近 7 天、全部类型，或调整搜索关键词。" />
            : <div className="project-discovery-grid">{visible.map((lead) => <DiscoveryCard key={lead.id} lead={lead} onOpen={() => openLead(lead)} />)}</div>}
    </section>
  </div>
}

function DiscoveryMetric({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: string }) {
  return <article data-tone={tone}><span>{icon}</span><div><strong>{value}</strong><small>{label}</small></div></article>
}

function DiscoveryCard({ lead, onOpen }: { lead: LeadListItem; onOpen: () => void }) {
  const kind = discoveryCandidateKind(lead)
  const investment = lead.investmentProfile
  const research = lead.researchProfile
  const industries = kind === 'research'
    ? research?.direction?.categories ?? []
    : [investment?.industry.level1, investment?.industry.level2, investment?.industry.segment, ...(lead.businessTags?.industry ?? [])].filter((value): value is string => Boolean(value))
  const tags = [...new Set(industries)].slice(0, 3)
  const product = investment?.products.find((item) => item.name)?.name
  const researchProblem = research?.direction?.researchProblem
  const latestUpdate = lead.latestUpdates?.[0]
  const signal = latestUpdate?.title || researchProblem || product || '结构化信息待进一步核对'
  const stage = kind === 'research'
    ? research?.progress?.venue || research?.progress?.resourceType || '科研成果'
    : investment?.financing.latestRound || investment?.products[0]?.productionStage || '融资阶段未披露'
  const institution = kind === 'research'
    ? research?.team?.affiliations?.[0] || lead.companyName
    : investment?.institutions[0]?.name || lead.companyName
  const dataStatus = kind === 'research' ? research?.dataStatus.status : investment?.dataStatus.status

  return <article className="project-discovery-card" tabIndex={0} role="button" onClick={onOpen} onKeyDown={(event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
  }} aria-label={`查看${lead.name}线索详情`}>
    <header>
      <span className={`project-discovery-kind-badge ${kind}`}>
        {kind === 'research' ? <FlaskConical /> : <Building2 />}{kind === 'research' ? '科研成果' : '企业项目'}
      </span>
      <span className="project-discovery-date"><CalendarDays />{projectDiscoveryCandidateDay(lead).replaceAll('-', '.')}</span>
    </header>
    <div className="project-discovery-card-body">
      <h3>{lead.name || lead.companyName || '未命名项目'}</h3>
      <p className="project-discovery-entity">{institution || '主体待核对'}</p>
      <div className="project-discovery-tags">{tags.length ? tags.map((tag) => <span key={tag}>{tag}</span>) : <span>赛道待补充</span>}</div>
      <div className="project-discovery-signal"><Sparkles /><p>{signal}</p></div>
      <dl>
        <div><dt>当前阶段</dt><dd>{stage}</dd></div>
        <div><dt>所在地</dt><dd><MapPin />{lead.region || '待核对'}</dd></div>
        <div><dt>画像状态</dt><dd>{dataStatus === 'verified' ? '已核验' : dataStatus === 'partial' ? '部分核验' : '待完善'}</dd></div>
      </dl>
    </div>
    <footer><span>查看证据与完整画像</span><ArrowRight /></footer>
  </article>
}
