import {
  ArrowRight, Bot, Building2, CalendarDays, CheckCircle2, FileUp, FlaskConical, LoaderCircle,
  MapPin, Radar, RefreshCw, Search, Sparkles, TrendingUp, X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { EmptyState } from '../components/ui'
import { apiGet, apiPost } from '../lib/api'
import {
  buildProjectDiscoverySummary,
  discoveryCandidateKind,
  filterProjectDiscoveryCandidates,
  projectDiscoveryCandidateDay,
  shouldLoadNextProjectDiscoveryPage,
  type ProjectDiscoveryKind,
  type ProjectDiscoveryPeriod,
} from '../lib/projectDiscovery'
import { useAppStore } from '../store/useAppStore'
import type { LeadListItem } from '../types'
import './ProjectDiscoveryPage.css'

const periods: Array<{ value: ProjectDiscoveryPeriod; label: string }> = [
  { value: 'today', label: '今天新发现' },
  { value: 'week', label: '近 7 天' },
]

const kinds: Array<{ value: ProjectDiscoveryKind; label: string }> = [
  { value: 'all', label: '全部类型' },
  { value: 'company', label: '企业项目' },
  { value: 'research', label: '科研成果' },
]

type RadarSyncResult = { created: number; updated: number; unchanged: number; skipped: number; fetched: number }
type BpUploadResult = { id: string; name: string; status: string; progress: number; error?: string | null; leadId?: string | null; reviewId?: string | null }

const readFileAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onerror = () => reject(new Error('文件读取失败，请重新选择'))
  reader.onload = () => resolve(String(reader.result))
  reader.readAsDataURL(file)
})

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))

async function waitForBpUpload(id: string): Promise<BpUploadResult> {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const result = await apiGet<BpUploadResult>(`/leads/bp-uploads/${id}`)
    if (['ready', 'review', 'rejected', 'dead_letter'].includes(result.status)) return result
    await wait(2_000)
  }
  throw new Error('材料仍在后台解析，可稍后点击“刷新发现”查看结果。')
}

export function ProjectDiscoveryPage() {
  const fetchLeads = useAppStore((state) => state.fetchLeads)
  const navigate = useNavigate()
  const location = useLocation()
  const requestSerial = useRef(0)
  const [candidates, setCandidates] = useState<LeadListItem[]>([])
  const [period, setPeriod] = useState<ProjectDiscoveryPeriod>('week')
  const [kind, setKind] = useState<ProjectDiscoveryKind>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [action, setAction] = useState<'scan' | 'upload' | ''>('')
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const loadCandidates = useCallback(async (refresh = false) => {
    const serial = ++requestSerial.current
    refresh ? setRefreshing(true) : setLoading(true)
    setError('')
    try {
      let response = await fetchLeads({ page: 1, pageSize: 50, sort: 'latest' })
      if (!response) return
      const rows = [...response.list]
      while (shouldLoadNextProjectDiscoveryPage(response.list, response.page, response.totalPages)) {
        const next = await fetchLeads({ page: response.page + 1, pageSize: 50, sort: 'latest' })
        if (!next) return
        rows.push(...next.list)
        response = next
      }
      if (serial === requestSerial.current) {
        const unique = new Map(rows.map((lead) => [lead.id, lead]))
        setCandidates([...unique.values()])
      }
    } catch (cause) {
      if (serial === requestSerial.current) setError(cause instanceof Error ? cause.message : '新项目读取失败')
    } finally {
      if (serial === requestSerial.current) {
        setLoading(false)
        setRefreshing(false)
      }
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

  const runRadarScan = async () => {
    if (action) return
    setAction('scan')
    setNotice(null)
    try {
      const result = await apiPost<RadarSyncResult>('/leads/sync-radar', { limit: 50, incrementalPages: 1, source: 'all' })
      setNotice({ tone: 'success', text: `信源扫描完成：读取 ${result.fetched} 条，新增 ${result.created} 条，更新 ${result.updated} 条。` })
      await loadCandidates(true)
    } catch (cause) {
      setNotice({ tone: 'error', text: cause instanceof Error ? cause.message : '信源扫描失败，请稍后重试' })
    } finally {
      setAction('')
    }
  }

  const uploadBp = async (file?: File) => {
    if (!file || action) return
    if (file.size > 20 * 1024 * 1024) {
      setNotice({ tone: 'error', text: '文件不能超过 20 MB。' })
      return
    }
    if (!/\.(pdf|docx|pptx|xlsx?|png|jpe?g|gif|bmp|webp|txt|md|markdown)$/i.test(file.name)) {
      setNotice({ tone: 'error', text: '请选择 PDF、Office、图片或文本格式的项目材料。' })
      return
    }
    setAction('upload')
    setNotice(null)
    try {
      let uploaded = await apiPost<BpUploadResult>('/leads/bp-uploads', {
        name: file.name,
        declaredType: file.type || undefined,
        dataBase64: await readFileAsDataUrl(file),
      })
      if (!['ready', 'review', 'rejected', 'dead_letter'].includes(uploaded.status)) uploaded = await waitForBpUpload(uploaded.id)
      if (uploaded.status === 'dead_letter' || uploaded.status === 'rejected') {
        throw new Error(uploaded.error || '材料未通过解析或主体校验，请核对后重试。')
      }
      setNotice({
        tone: 'success',
        text: uploaded.status === 'review'
          ? `${uploaded.name} 已解析完成并进入人工复核队列。`
          : `${uploaded.name} 已解析完成，新线索已加入发现列表。`,
      })
      await loadCandidates(true)
    } catch (cause) {
      setNotice({ tone: 'error', text: cause instanceof Error ? cause.message : '项目材料上传失败，请稍后重试' })
    } finally {
      setAction('')
    }
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

    <section className="project-discovery-actions" aria-labelledby="project-discovery-actions-title">
      <div className="project-discovery-action-copy">
        <span><Bot aria-hidden="true" /></span>
        <div><h2 id="project-discovery-actions-title">补充发现来源</h2><p>扫描已配置的融资、产业与论文公开信源；新候选进入同一复核列表。</p></div>
      </div>
      <div className="project-discovery-action-buttons">
        <button type="button" disabled={Boolean(action)} onClick={() => void runRadarScan()}>
          {action === 'scan' ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Radar aria-hidden="true" />}
          {action === 'scan' ? '扫描中' : '启动信源扫描'}
        </button>
        <label className={action ? 'is-disabled' : ''}>
          {action === 'upload' ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <FileUp aria-hidden="true" />}
          {action === 'upload' ? '上传中' : '人工上传 BP'}
          <input type="file" disabled={Boolean(action)} accept=".pdf,.docx,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.bmp,.webp,.txt,.md,.markdown" aria-label="人工上传项目线索" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void uploadBp(file) }} />
        </label>
      </div>
    </section>
    {notice && <p className={`project-discovery-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}

    <section className="project-discovery-metrics" aria-label="发现概览">
      <DiscoveryMetric icon={<TrendingUp aria-hidden="true" />} label="当前结果" value={summary.total} tone="blue" />
      <DiscoveryMetric icon={<Building2 aria-hidden="true" />} label="企业项目" value={summary.companies} tone="cyan" />
      <DiscoveryMetric icon={<FlaskConical aria-hidden="true" />} label="科研成果" value={summary.research} tone="purple" />
      <DiscoveryMetric icon={<CheckCircle2 aria-hidden="true" />} label="可研判画像" value={summary.verified} tone="green" />
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
        {query && <button type="button" onClick={() => setQuery('')} aria-label="清空发现搜索"><X aria-hidden="true" /></button>}
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
  const entity = kind === 'research'
    ? research?.team?.affiliations?.[0] || lead.companyName
    : lead.companyName || investment?.subject?.legalEntityName
  const relatedInstitution = kind === 'company' ? investment?.institutions[0]?.name : undefined
  const dataStatus = kind === 'research' ? research?.dataStatus.status : investment?.dataStatus.status

  return <article className="project-discovery-card" tabIndex={0} role="button" onClick={onOpen} onKeyDown={(event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
  }} aria-label={`查看${lead.name}线索详情`}>
    <header>
      <span className={`project-discovery-kind-badge ${kind}`}>
        {kind === 'research' ? <FlaskConical aria-hidden="true" /> : <Building2 aria-hidden="true" />}{kind === 'research' ? '科研成果' : '企业项目'}
      </span>
      <span className="project-discovery-date"><CalendarDays aria-hidden="true" />{projectDiscoveryCandidateDay(lead).replaceAll('-', '.')}</span>
    </header>
    <div className="project-discovery-card-body">
      <h3>{lead.name || lead.companyName || '未命名项目'}</h3>
      <p className="project-discovery-entity">{entity || '主体待核对'}</p>
      <div className="project-discovery-tags">{tags.length ? tags.map((tag) => <span key={tag}>{tag}</span>) : <span>赛道待补充</span>}</div>
      <div className="project-discovery-signal"><Sparkles aria-hidden="true" /><p>{signal}</p></div>
      <dl>
        <div><dt>当前阶段</dt><dd>{stage}</dd></div>
        {relatedInstitution && <div><dt>关联机构</dt><dd>{relatedInstitution}</dd></div>}
        <div><dt>所在地</dt><dd><MapPin aria-hidden="true" />{lead.region || '待核对'}</dd></div>
        <div><dt>画像状态</dt><dd>{dataStatus === 'verified' ? '已核验' : dataStatus === 'partial' ? '部分核验' : '待完善'}</dd></div>
      </dl>
    </div>
    <footer><span>查看证据、复核并决定是否入库</span><ArrowRight aria-hidden="true" /></footer>
  </article>
}
