import {
  ArrowRight, CalendarDays, ChevronDown, FileUp, LoaderCircle, Radar, Search, Sparkles, X,
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { encodeInstitutionTrackingKey } from '../../server/src/contracts/institutionTrackingContract'
import { EmptyState, Modal } from '../components/ui'
import { DiscoveryMonitoringPanel } from '../components/DiscoveryMonitoringPanel'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import { buildSaiDiscoverySnapshot } from '../lib/saiAgent'
import { LEAD_POOL_INDUSTRIES, LEAD_POOL_REGIONS } from '../lib/leadPoolFilters'
import {
  buildProjectDiscoveryKeywords,
  buildProjectDiscoveryBrief,
  discoveryCandidateKind,
  formatProjectDiscoveryKeywordText,
  loadProjectDiscoveryPage,
  parseProjectDiscoveryKeywordText,
  projectDiscoveryCandidateDay,
  projectDiscoveryDisplayName,
  projectDiscoveryDisplayRegion,
  projectDiscoveryDisplaySourceChannel,
  projectDiscoveryPrimaryDate,
  readProjectDiscoveryCardEdits,
  type ProjectDiscoveryKeyword,
  type ProjectDiscoveryPeriod,
} from '../lib/projectDiscovery'
import type { LeadListResponse } from '../store/useAppStore'
import { useSaiPageContext } from '../store/useSaiPageContext'
import type { LeadListItem, ProjectDiscoveryCardEdits } from '../types'
import './ProjectDiscoveryPage.css'

const periods: Array<{ value: ProjectDiscoveryPeriod; label: string }> = [
  { value: 'today', label: '今天新发现' },
  { value: 'week', label: '近 7 天' },
  { value: 'all', label: '全部项目' },
]

type ProjectDiscoverySort = 'latest' | 'funding' | 'score'
const sorts: Array<{ value: ProjectDiscoverySort; label: string }> = [
  { value: 'latest', label: '按时间排序' },
  { value: 'funding', label: '按融资金额排序' },
  { value: 'score', label: '按四维评分排序' },
]

type BpUploadResult = { id: string; name: string; status: string; progress: number; error?: string | null; leadId?: string | null; reviewId?: string | null }
type ProjectDiscoveryAssignmentPerson = { id: string; name: string; department: string }
type ProjectDiscoveryAssignmentOptions = {
  canAssignOthers: boolean
  departments: string[]
  people: ProjectDiscoveryAssignmentPerson[]
}

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
  throw new Error('材料仍在后台解析，可稍后点击“检查更新”查看结果。')
}

export function ProjectDiscoveryPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const requestSerial = useRef(0)
  const moreRequestSerial = useRef(0)
  const candidatesRef = useRef<LeadListItem[]>([])
  const paginationRef = useRef({ page: 1, totalPages: 1 })
  const loadingMoreRef = useRef(false)
  const [candidates, setCandidates] = useState<LeadListItem[]>([])
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1 })
  const [period, setPeriod] = useState<ProjectDiscoveryPeriod>('today')
  const [industry, setIndustry] = useState('')
  const [region, setRegion] = useState('')
  const [sort, setSort] = useState<ProjectDiscoverySort>('latest')
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [action, setAction] = useState<'refresh' | 'upload' | ''>('')
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [saiUploadOpen, setSaiUploadOpen] = useState(false)
  const setDiscoverySnapshot = useSaiPageContext((state) => state.setDiscoverySnapshot)

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('saiUpload') !== '1') return
    setSaiUploadOpen(true)
    params.delete('saiUpload')
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params}` : '' }, { replace: true })
  }, [location.pathname, location.search, navigate])

  useEffect(() => {
    const timer = window.setTimeout(() => setSubmittedQuery(query.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  const fetchProjectDiscoveryPage = useCallback((page: number) => {
    const params = new URLSearchParams({ page: String(page), pageSize: '50' })
    params.set('period', period)
    params.set('sort', sort)
    params.set('leadType', 'company')
    if (industry) params.set('industry', industry)
    if (region) params.set('region', region)
    if (submittedQuery) params.set('keyword', submittedQuery)
    return apiGet<LeadListResponse>(`/project-discovery/leads?${params.toString()}`)
  }, [period, sort, industry, region, submittedQuery])

  const loadCandidates = useCallback(async (background = false) => {
    const serial = ++requestSerial.current
    moreRequestSerial.current += 1
    loadingMoreRef.current = false
    setLoadingMore(false)
    if (!background) {
      setLoading(true)
      candidatesRef.current = []
      setCandidates([])
      paginationRef.current = { page: 1, totalPages: 1 }
      setPagination({ page: 1, totalPages: 1 })
    }
    setError('')
    try {
      const loaded = await loadProjectDiscoveryPage(fetchProjectDiscoveryPage, 1, [], (items) => {
        if (serial !== requestSerial.current) return
        candidatesRef.current = items
        setCandidates(items)
      })
      if (!loaded || serial !== requestSerial.current) return false
      const nextPagination = { page: loaded.page, totalPages: loaded.totalPages }
      paginationRef.current = nextPagination
      setPagination(nextPagination)
      return true
    } catch (cause) {
      if (serial === requestSerial.current) setError(cause instanceof Error ? cause.message : '新项目读取失败')
      return false
    } finally {
      if (serial === requestSerial.current) {
        setLoading(false)
      }
    }
  }, [fetchProjectDiscoveryPage])

  const loadRemainingCandidates = useCallback(async () => {
    if (loadingMoreRef.current || paginationRef.current.page >= paginationRef.current.totalPages) return true
    const serial = requestSerial.current
    const moreSerial = ++moreRequestSerial.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const loaded = await loadProjectDiscoveryPage(
        fetchProjectDiscoveryPage,
        paginationRef.current.page + 1,
        candidatesRef.current,
        (nextItems) => {
          if (serial !== requestSerial.current) return
          candidatesRef.current = nextItems
          setCandidates(nextItems)
        },
      )
      if (!loaded || serial !== requestSerial.current) return false
      const nextPagination = { page: loaded.page, totalPages: loaded.totalPages }
      paginationRef.current = nextPagination
      setPagination(nextPagination)
      return true
    } catch (cause) {
      if (serial === requestSerial.current) {
        setNotice({ tone: 'error', text: cause instanceof Error ? cause.message : '其余项目读取失败，请稍后重试。' })
      }
      return false
    } finally {
      if (moreSerial === moreRequestSerial.current) {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    }
  }, [fetchProjectDiscoveryPage])

  useEffect(() => { void loadCandidates() }, [loadCandidates])
  useEffect(() => {
    setDiscoverySnapshot(buildSaiDiscoverySnapshot(candidates, loading, error))
    return () => setDiscoverySnapshot('')
  }, [candidates, loading, error, setDiscoverySnapshot])

  const openLead = (lead: LeadListItem) => {
    navigate(`/sourcing/${lead.id}`, { state: { from: `${location.pathname}${location.search}` } })
  }

  const updateCandidateKeywords = (leadId: string, keywords: ProjectDiscoveryKeyword[]) => {
    const next = candidatesRef.current.map((lead) => lead.id !== leadId ? lead : ({
      ...lead,
      radarProfile: {
        ...lead.radarProfile,
        profile: { ...lead.radarProfile?.profile, discoveryKeywords: keywords },
      },
    }))
    candidatesRef.current = next
    setCandidates(next)
  }

  const updateCandidateCard = (leadId: string, card: ProjectDiscoveryCardEdits) => {
    const next = candidatesRef.current.map((lead) => lead.id !== leadId ? lead : ({
      ...lead,
      radarProfile: {
        ...lead.radarProfile,
        profile: { ...lead.radarProfile?.profile, discoveryCardEdits: card },
      },
    }))
    candidatesRef.current = next
    setCandidates(next)
  }

  const removeCandidate = (leadId: string, message: string) => {
    const next = candidatesRef.current.filter((lead) => lead.id !== leadId)
    candidatesRef.current = next
    setCandidates(next)
    setNotice({ tone: 'success', text: message })
  }

  const refreshFromDatabase = async () => {
    if (action) return
    setAction('refresh')
    setNotice(null)
    try {
      const refreshed = await loadCandidates(true)
      setNotice(refreshed
        ? { tone: 'success', text: '已从数据库读取最新项目数据。' }
        : { tone: 'error', text: '数据库读取失败，请稍后重试。' })
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
      if (uploaded.status === 'dead_letter') {
        uploaded = await apiPost<BpUploadResult>(`/leads/bp-uploads/${uploaded.id}/retry`)
        uploaded = await waitForBpUpload(uploaded.id)
      }
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
    <Modal open={saiUploadOpen} title="上传项目材料" onClose={() => setSaiUploadOpen(false)}>
      <p className="mb-4 text-sm text-slate-600">选择项目 BP 或其他资料，解析后会加入新项目发现；需要核对的材料会进入人工复核。</p>
      <input type="file" disabled={Boolean(action)} accept=".pdf,.docx,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.bmp,.webp,.txt,.md,.markdown" aria-label="选择项目材料" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) { setSaiUploadOpen(false); void uploadBp(file) } }} />
    </Modal>
    <header className="project-discovery-hero">
      <div className="project-discovery-title">
        <span><Sparkles aria-hidden="true" /></span>
        <h1>新项目发现</h1>
      </div>
      <div className="project-discovery-action-buttons" aria-label="项目发现操作">
        <button type="button" disabled={Boolean(action)} aria-busy={action === 'refresh'} onClick={() => void refreshFromDatabase()}>
          {action === 'refresh' ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Radar aria-hidden="true" />}
          {action === 'refresh' ? '开始更新' : '检查更新'}
        </button>
        <label className={action ? 'is-disabled' : ''}>
          {action === 'upload' ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <FileUp aria-hidden="true" />}
          {action === 'upload' ? '上传中' : '人工上传项目'}
          <input type="file" disabled={Boolean(action)} accept=".pdf,.docx,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.bmp,.webp,.txt,.md,.markdown" aria-label="人工上传项目资料" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void uploadBp(file) }} />
        </label>
      </div>
    </header>
    {notice && <p className={`project-discovery-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}

    <DiscoveryMonitoringPanel />

    <section className="project-discovery-toolbar" aria-label="项目发现筛选">
      <div className="project-discovery-periods" role="group" aria-label="发现时间范围">
        {periods.map((item) => <button key={item.value} type="button" aria-pressed={period === item.value} onClick={() => setPeriod(item.value)}>{item.label}</button>)}
      </div>
      <label className="project-discovery-kind">
        <span className="sr-only">行业筛选</span>
        <select value={industry} aria-label="行业筛选" onChange={(event) => setIndustry(event.target.value)}>
          <option value="">全部行业</option>
          {LEAD_POOL_INDUSTRIES.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </label>
      <label className="project-discovery-kind">
        <span className="sr-only">地区筛选</span>
        <select value={region} aria-label="地区筛选" onChange={(event) => setRegion(event.target.value)}>
          <option value="">全部地区</option>
          {LEAD_POOL_REGIONS.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </label>
      <label className="project-discovery-kind">
        <span className="sr-only">项目排序</span>
        <select value={sort} aria-label="项目排序" onChange={(event) => setSort(event.target.value as ProjectDiscoverySort)}>
          {sorts.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label className="project-discovery-search">
        <Search aria-hidden="true" />
        <input value={query} maxLength={100} onChange={(event) => setQuery(event.target.value.slice(0, 100))} placeholder="搜索项目、赛道、产品或机构" aria-label="搜索新发现项目" />
        {query && <button type="button" onClick={() => setQuery('')} aria-label="清空发现搜索"><X aria-hidden="true" /></button>}
      </label>
    </section>

    <section className="project-discovery-results" aria-label="待查看项目" aria-busy={loading || loadingMore}>
      {loading ? <div className="project-discovery-state"><LoaderCircle className="is-spinning" aria-hidden="true" /><strong>正在整理最新项目信号</strong><p>读取已收录的公开信源与结构化画像。</p></div>
        : error ? <div className="project-discovery-state project-discovery-error"><strong>新项目读取失败</strong><p>{error}</p><button type="button" onClick={() => void loadCandidates()}>重新加载</button></div>
          : candidates.length === 0 ? <EmptyState title="当前范围没有新项目" description="试试切换到近 7 天、全部项目，或调整搜索关键词。" />
            : <div className="project-discovery-grid">{candidates.map((lead) => <DiscoveryCard
              key={lead.id}
              lead={lead}
              onOpen={() => openLead(lead)}
              onKeywordsUpdated={(keywords) => updateCandidateKeywords(lead.id, keywords)}
              onCardUpdated={(card) => updateCandidateCard(lead.id, card)}
              onRemoved={(message) => removeCandidate(lead.id, message)}
            />)}</div>}
      {!loading && !error && pagination.page < pagination.totalPages && <div className="project-discovery-load-more">
        <button type="button" disabled={loadingMore} onClick={() => void loadRemainingCandidates()}>{loadingMore ? '加载中…' : '加载更多项目'}</button>
      </div>}
    </section>
  </div>
}

function DiscoveryCard({ lead, onOpen, onKeywordsUpdated, onCardUpdated, onRemoved }: {
  lead: LeadListItem
  onOpen: () => void
  onKeywordsUpdated: (keywords: ProjectDiscoveryKeyword[]) => void
  onCardUpdated: (card: ProjectDiscoveryCardEdits) => void
  onRemoved: (message: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [keywordText, setKeywordText] = useState(() => formatProjectDiscoveryKeywordText(buildProjectDiscoveryKeywords(lead)))
  const [assignmentOpen, setAssignmentOpen] = useState(false)
  const [assignmentOptions, setAssignmentOptions] = useState<ProjectDiscoveryAssignmentOptions | null>(null)
  const [selectedDepartment, setSelectedDepartment] = useState('')
  const [selectedOwnerId, setSelectedOwnerId] = useState('')
  const [confirmDefer, setConfirmDefer] = useState(false)
  const [cardAction, setCardAction] = useState<'keywords' | 'card' | 'options' | 'defer' | 'convert' | ''>('')
  const [cardError, setCardError] = useState('')
  const [cardNotice, setCardNotice] = useState('')
  const kind = discoveryCandidateKind(lead)
  const investment = lead.investmentProfile
  const research = lead.researchProfile
  const name = projectDiscoveryDisplayName(lead)
  const brief = buildProjectDiscoveryBrief(lead)
  const keywords = buildProjectDiscoveryKeywords(lead)
  const persistedKeywordText = formatProjectDiscoveryKeywordText(keywords)
  const primaryDate = projectDiscoveryPrimaryDate(lead)
  const dataStatus = kind === 'research' ? research?.dataStatus?.status : investment?.dataStatus?.status
  const profile = projectDiscoveryProfile(lead)
  const persistedCard = buildProjectDiscoveryCardDraft(lead, brief, profile)
  const [cardDraft, setCardDraft] = useState<ProjectDiscoveryCardEdits>(() => persistedCard)
  const missingFields = projectDiscoveryMissingFields(lead).filter((field) => !(
    cardDraft.briefFacts[field]?.trim() || cardDraft.profileFacts[field]?.trim()
  ))
  const latestUpdate = lead.latestUpdates?.find((update) => safeExternalUrl(update.sourceUrl)) ?? lead.latestUpdates?.[0]
  const reportedSourceUrl = safeExternalUrl(latestUpdate?.sourceUrl)
  const sourceUrl = reportedSourceUrl ?? safeExternalUrl(lead.radarProfile?.link)
  const discoveryScore = lead.discoveryScore
  const scoreCoverage = discoveryScore?.coverage ?? discoveryScore?.dimensions.filter((dimension) => dimension.status === 'ready').length ?? 0
  const displayScore = discoveryScore?.overall ?? discoveryScore?.referenceScore ?? null
  const scoreLabel = discoveryScore?.overall != null
    ? scoreCoverage < 4 ? `参考分（${scoreCoverage}/4维）` : '综合评分'
    : discoveryScore?.referenceScore != null ? `初筛参考分（${scoreCoverage}/4维）` : `待评分（${scoreCoverage}/4维）`
  const verifiedDimensions = kind === 'research' ? research?.dataStatus?.verifiedDimensions : investment?.dataStatus?.verifiedDimensions
  const applicableDimensions = kind === 'research' ? research?.dataStatus?.applicableDimensions : investment?.dataStatus?.applicableDimensions
  const primaryDateTime = /^\d{4}-\d{2}-\d{2}/u.exec(cardDraft.primaryDate)?.[0]
  const eligiblePeople = assignmentOptions?.people.filter((person) => person.department === selectedDepartment) ?? []
  const cardDirty = JSON.stringify(cardDraft) !== JSON.stringify(persistedCard)
  const investorNames = [...new Set((cardDraft.briefFacts['投资方'] ?? '').split(/[、,，;；\n]+/u)
    .map((value) => value.trim())
    .filter((value) => value && !['未披露', '待补充', '待核验'].includes(value)))]
  const persistedCardKey = JSON.stringify(readProjectDiscoveryCardEdits(lead) ?? null)

  useEffect(() => setKeywordText(persistedKeywordText), [persistedKeywordText])
  useEffect(() => setCardDraft(persistedCard), [persistedCardKey])

  const updateCardDraft = <Key extends keyof ProjectDiscoveryCardEdits>(key: Key, value: ProjectDiscoveryCardEdits[Key]) => {
    setCardDraft((current) => ({ ...current, [key]: value }))
    setCardError('')
    setCardNotice('')
  }

  const updateCardFact = (group: 'briefFacts' | 'profileFacts', label: string, value: string) => {
    setCardDraft((current) => ({ ...current, [group]: { ...current[group], [label]: value } }))
    setCardError('')
    setCardNotice('')
  }

  const saveCard = async () => {
    if (!cardDirty || cardAction) return
    if (!cardDraft.name.trim()) {
      setCardError('项目名称不能为空。')
      return
    }
    setCardAction('card')
    setCardError('')
    setCardNotice('')
    try {
      const result = await apiPatch<{ leadId: string; card: ProjectDiscoveryCardEdits }>(
        `/project-discovery/leads/${lead.id}/card`,
        cardDraft,
      )
      setCardDraft(result.card)
      onCardUpdated(result.card)
      setCardNotice('卡片内容已保存。')
    } catch (cause) {
      setCardError(cause instanceof Error ? cause.message : '卡片内容保存失败，请重试。')
    } finally {
      setCardAction('')
    }
  }

  const saveKeywords = async () => {
    if (cardAction || keywordText.trim() === persistedKeywordText) return
    let normalized: ProjectDiscoveryKeyword[]
    try {
      normalized = parseProjectDiscoveryKeywordText(keywordText, keywords)
    } catch (cause) {
      setCardError(cause instanceof Error ? cause.message : '关键词格式不正确。')
      return
    }
    setCardAction('keywords')
    setCardError('')
    try {
      const result = await apiPatch<{ leadId: string; keywords: ProjectDiscoveryKeyword[] }>(
        `/project-discovery/leads/${lead.id}/keywords`,
        { keywords: normalized },
      )
      setKeywordText(formatProjectDiscoveryKeywordText(result.keywords))
      onKeywordsUpdated(result.keywords)
    } catch (cause) {
      setCardError(cause instanceof Error ? cause.message : '关键词保存失败，请重试。')
    } finally {
      setCardAction('')
    }
  }

  const openAssignment = async () => {
    setAssignmentOpen(true)
    setConfirmDefer(false)
    setCardError('')
    if (assignmentOptions || cardAction === 'options') return
    setCardAction('options')
    try {
      const options = await apiGet<ProjectDiscoveryAssignmentOptions>('/project-discovery/assignment-options')
      setAssignmentOptions(options)
      const department = options.departments[0] ?? ''
      setSelectedDepartment(department)
      setSelectedOwnerId(options.people.find((person) => person.department === department)?.id ?? '')
    } catch (cause) {
      setCardError(cause instanceof Error ? cause.message : '部门与人员读取失败，请重试。')
    } finally {
      setCardAction('')
    }
  }

  const convertProject = async () => {
    if (!selectedDepartment || !selectedOwnerId) {
      setCardError('请选择归属部门和项目负责人。')
      return
    }
    setCardAction('convert')
    setCardError('')
    try {
      await apiPost(`/leads/${lead.id}/convert`, {
        ownerUserId: selectedOwnerId,
        department: selectedDepartment,
      })
      const owner = assignmentOptions?.people.find((person) => person.id === selectedOwnerId)
      onRemoved(`${name} 已入库并分配给${owner?.name ? ` ${owner.name}` : '所选负责人'}。`)
    } catch (cause) {
      setCardError(cause instanceof Error ? cause.message : '项目入库失败，请重试。')
    } finally {
      setCardAction('')
    }
  }

  const deferProject = async () => {
    setCardAction('defer')
    setCardError('')
    try {
      await apiPost(`/project-discovery/leads/${lead.id}/defer`)
      onRemoved(`${name} 已标记为暂不跟进。`)
    } catch (cause) {
      setCardError(cause instanceof Error ? cause.message : '暂不跟进操作失败，请重试。')
      setCardAction('')
    }
  }

  return <article id={`discovery-${lead.id}`} className={`project-discovery-card${expanded ? ' is-expanded' : ''}`}>
    <header className="project-discovery-card-header">
      <h3><input
        className="project-discovery-title-input"
        value={cardDraft.name}
        maxLength={160}
        disabled={cardAction === 'card'}
        aria-label={`编辑${name}项目名称`}
        onChange={(event) => updateCardDraft('name', event.target.value)}
      /></h3>
      <div className="project-discovery-card-header-meta">
        <time className="project-discovery-card-date" dateTime={primaryDateTime}>
          <CalendarDays aria-hidden="true" />
          <span>{primaryDate.label}</span>
          <input
            className="project-discovery-date-input"
            value={cardDraft.primaryDate}
            maxLength={40}
            disabled={cardAction === 'card'}
            aria-label={`编辑${name}${primaryDate.label}`}
            onChange={(event) => updateCardDraft('primaryDate', event.target.value)}
          />
        </time>
        <div className="project-discovery-card-score" aria-label={`${name}${scoreLabel}${displayScore == null ? '' : `${displayScore}分`}`}>
          <span>{scoreLabel}</span><strong>{displayScore == null ? '待评分' : `${displayScore} 分`}</strong>
        </div>
      </div>
    </header>
    <DiscoveryInvestmentBrief
      leadId={lead.id}
      name={name}
      brief={brief}
      factValues={cardDraft.briefFacts}
      keywordText={keywordText}
      saving={cardAction === 'keywords' || cardAction === 'card'}
      onFactChange={(label, value) => updateCardFact('briefFacts', label, value)}
      onKeywordChange={(value) => { setKeywordText(value); setCardError(''); setCardNotice('') }}
      onKeywordBlur={() => void saveKeywords()}
    />
    {!expanded && <CardDetailsToggle expanded={false} name={name} onToggle={() => setExpanded(true)} />}
    {expanded && <>
      <section className="project-discovery-card-details" aria-label={`${name}详细信息`}>
        <div className="project-discovery-detail-panel project-discovery-detail-summary">
          <label htmlFor={`discovery-summary-${lead.id}`}>{kind === 'company' ? '项目摘要' : '情报摘要'}</label>
          <textarea
            id={`discovery-summary-${lead.id}`}
            className="project-discovery-summary-input"
            value={cardDraft.summary}
            rows={3}
            maxLength={2_000}
            disabled={cardAction === 'card'}
            placeholder="摘要待补充"
            onChange={(event) => updateCardDraft('summary', event.target.value)}
          />
        </div>
        <dl className="project-discovery-detail-metadata">
          <div><dt><label htmlFor={`discovery-region-${lead.id}`}>地区</label></dt><dd><input id={`discovery-region-${lead.id}`} value={cardDraft.region} maxLength={100} disabled={cardAction === 'card'} onChange={(event) => updateCardDraft('region', event.target.value)} /></dd></div>
          <div><dt><label htmlFor={`discovery-source-${lead.id}`}>来源渠道</label></dt><dd><input id={`discovery-source-${lead.id}`} value={cardDraft.sourceChannel} maxLength={100} disabled={cardAction === 'card'} onChange={(event) => updateCardDraft('sourceChannel', event.target.value)} /></dd></div>
          <div><dt>主体类型</dt><dd>{kind === 'company' ? '公司' : '技术'}</dd></div>
          <div><dt>完整度</dt><dd>{projectDiscoveryCompleteness(dataStatus, verifiedDimensions, applicableDimensions)}</dd></div>
        </dl>
        <div className="project-discovery-detail-panel project-discovery-profile">
          <h4>{kind === 'company' ? '公司画像' : '技术画像'}</h4>
          <dl>{profile.map((fact) => <div key={fact.label}><dt><label htmlFor={`discovery-profile-${lead.id}-${fact.label}`}>{fact.label}</label></dt><dd><textarea
            id={`discovery-profile-${lead.id}-${fact.label}`}
            className="project-discovery-profile-input"
            value={cardDraft.profileFacts[fact.label] ?? ''}
            rows={2}
            maxLength={1_000}
            disabled={cardAction === 'card'}
            onChange={(event) => updateCardFact('profileFacts', fact.label, event.target.value)}
          /></dd></div>)}</dl>
        </div>
        <div className="project-discovery-detail-panel project-discovery-score-details">
          <h4>项目发现评分</h4>
          <p>投资机构 20% · 融资金额 20% · 产业前沿度 25% · 技术含量 35%。机构按 2025 年投中榜 TOP30/50/100 分别计 90/80/70 分，领投加 5 分，未上榜但有机构记录计 50 分。融资金额按轮次临时参考档比较，并非同赛道分位数；产业与技术沿用已有研究评级。四维资料不足时不补造完整评级。</p>
          {discoveryScore?.overall == null && discoveryScore?.referenceScore != null && <div className="project-discovery-reference-note">
            <strong>公开资料初筛参考分：{discoveryScore.referenceScore} 分</strong>
            <p>仅用于初步研判，不是四维综合评级；以有摘要和原始链接为 50 分基准，明确赛道、技术、团队、机构和金额线索可小幅加分，最高 75 分。所有候选信息均待人工核验。</p>
            <ul>{discoveryScore.referenceEvidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul>
            {safeExternalUrl(discoveryScore.referenceSourceUrl ?? undefined) && <a href={safeExternalUrl(discoveryScore.referenceSourceUrl ?? undefined)!} target="_blank" rel="noopener noreferrer">查看初筛来源</a>}
          </div>}
          {discoveryScore?.dimensions?.length ? <dl>{discoveryScore.dimensions.map((dimension) => <div key={dimension.key}>
            <dt>{dimension.label}</dt>
            <dd><strong>{dimension.score == null || dimension.status === 'insufficient' ? '信息不足' : `${dimension.score} 分`}</strong><span>{dimension.evidence || '暂无可核验依据'}{safeExternalUrl(dimension.sourceUrl) ? <> · <a href={safeExternalUrl(dimension.sourceUrl)!} target="_blank" rel="noopener noreferrer">查看榜单来源</a></> : null}</span></dd>
          </div>)}</dl> : <p>信息不足，待评分</p>}
        </div>
        <div className="project-discovery-detail-sources">
          <strong>信息来源</strong>
          <div>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer">{reportedSourceUrl ? latestUpdate?.title || '查看原始公开信源' : '查看原始公开信源'}</a> : <span>暂无可核验报道</span>}
            <p>{lead.radarProfile?.channel || '公开资料'}{projectDiscoveryCandidateDay(lead) ? ` · ${projectDiscoveryCandidateDay(lead)}` : ''}</p>
          </div>
        </div>
        {missingFields.length > 0 && <div className="project-discovery-detail-questions">
          <strong>关键待核问题</strong>
          <ul>{missingFields.map((field) => <li key={field}>补充并核验{field}</li>)}</ul>
          <div>{missingFields.map((field) => <span key={field}>待补：{field}</span>)}</div>
        </div>}
        {cardDirty
          ? <p className="project-discovery-institution-hint">保存后将自动关联至机构追踪</p>
          : investorNames.length > 0 && <div className="project-discovery-institution-links" aria-label="关联投资机构">
            {investorNames.map((investor) => <Link
              key={investor}
              className="project-discovery-institution-link"
              to={`/institutions/${encodeInstitutionTrackingKey(investor)}`}
            >查看{investor}最近投资项目<ArrowRight aria-hidden="true" /></Link>)}
          </div>}
      </section>
    </>}
    {cardDirty && <div className="project-discovery-card-save" role="status">
      <span>{cardAction === 'card' ? '正在保存卡片内容…' : '卡片内容已修改'}</span>
      <div>
        <button type="button" disabled={cardAction === 'card'} onClick={() => { setCardDraft(persistedCard); setCardError(''); setCardNotice('') }}>取消修改</button>
        <button type="button" disabled={cardAction === 'card'} onClick={() => void saveCard()}>{cardAction === 'card' ? '保存中' : '保存卡片'}</button>
      </div>
    </div>}
    {assignmentOpen && <section className="project-discovery-assignment-form" aria-label={`${name}项目入库分配`}>
      <div className="project-discovery-inline-heading"><strong>项目入库分配</strong><span>入库后进入立项阶段</span></div>
      {cardAction === 'options' ? <p className="project-discovery-inline-loading"><LoaderCircle className="is-spinning" aria-hidden="true" />正在读取部门和人员</p> : <div className="project-discovery-assignment-fields">
        <label>归属部门
          <select value={selectedDepartment} onChange={(event) => {
            const department = event.target.value
            setSelectedDepartment(department)
            setSelectedOwnerId(assignmentOptions?.people.find((person) => person.department === department)?.id ?? '')
          }}>
            <option value="">请选择部门</option>
            {assignmentOptions?.departments.map((department) => <option key={department} value={department}>{department}</option>)}
          </select>
        </label>
        <label>项目负责人
          <select value={selectedOwnerId} onChange={(event) => setSelectedOwnerId(event.target.value)}>
            <option value="">请选择负责人</option>
            {eligiblePeople.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        </label>
      </div>}
      <div className="project-discovery-inline-actions">
        <span />
        <button type="button" className="text-button" disabled={Boolean(cardAction)} onClick={() => setAssignmentOpen(false)}>取消</button>
        <button type="button" className="primary-button" disabled={Boolean(cardAction) || !selectedOwnerId} onClick={() => void convertProject()}>{cardAction === 'convert' ? '入库中' : '确认入库'}</button>
      </div>
    </section>}
    {confirmDefer && <section className="project-discovery-defer-confirm" aria-label={`${name}暂不跟进确认`}>
      <p>确认将该项目标记为“暂不跟进”？它将从当前发现列表移出。</p>
      <div><button type="button" disabled={cardAction === 'defer'} onClick={() => setConfirmDefer(false)}>取消</button><button type="button" disabled={cardAction === 'defer'} onClick={() => void deferProject()}>{cardAction === 'defer' ? '处理中' : '确认暂不跟进'}</button></div>
    </section>}
    {cardError && <p className="project-discovery-card-error" role="alert">{cardError}</p>}
    {cardNotice && <p className="project-discovery-card-notice" role="status">{cardNotice}</p>}
    <footer className="project-discovery-card-actions">
      <div className="project-discovery-card-links">
        <button type="button" className="detail-button" onClick={onOpen}>查看完整线索<ArrowRight aria-hidden="true" /></button>
        {sourceUrl ? <a className="project-discovery-news-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">查看新闻/公开来源<ArrowRight aria-hidden="true" /></a>
          : <span className="project-discovery-news-missing">暂无可核验报道</span>}
      </div>
      <span />
      <button type="button" className="defer-button" disabled={Boolean(cardAction)} onClick={() => { setConfirmDefer(true); setAssignmentOpen(false); setCardError('') }}>暂不跟进</button>
      <button type="button" className="convert-button" disabled={Boolean(cardAction)} onClick={() => void openAssignment()}>项目入库</button>
    </footer>
    {expanded && <CardDetailsToggle expanded name={name} onToggle={() => setExpanded(false)} />}
  </article>
}

function CardDetailsToggle({ expanded, name, onToggle }: { expanded: boolean; name: string; onToggle: () => void }) {
  return <button type="button" className="project-discovery-card-toggle" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '查看'}${name}项目详情`} onClick={onToggle}>
    {expanded ? '收起详细信息' : '展开详细信息'}
    <ChevronDown className={expanded ? 'is-expanded' : ''} aria-hidden="true" />
  </button>
}

function DiscoveryInvestmentBrief({ leadId, name, brief, factValues, keywordText, saving, onFactChange, onKeywordChange, onKeywordBlur }: {
  leadId: string
  name: string
  brief: ReturnType<typeof buildProjectDiscoveryBrief>
  factValues: Record<string, string>
  keywordText: string
  saving: boolean
  onFactChange: (label: string, value: string) => void
  onKeywordChange: (value: string) => void
  onKeywordBlur: () => void
}) {
  const facts = brief.facts.filter((item) => item.label !== '最新融资日期' && item.label !== '公开日期')
  return <section aria-label={`${name}投资速览`} className="project-discovery-investment-brief">
    <dl>{facts.map((item, index) => <Fragment key={item.label}>
        <div className={item.wide ? 'wide' : ''}>
          <dt><label htmlFor={`discovery-fact-${leadId}-${item.label}`}>{item.label}</label></dt>
          <dd><textarea
            id={`discovery-fact-${leadId}-${item.label}`}
            className="project-discovery-fact-input"
            value={factValues[item.label] ?? ''}
            rows={item.wide ? 2 : 1}
            maxLength={1_000}
            disabled={saving}
            onChange={(event) => onFactChange(item.label, event.target.value)}
          /></dd>
        </div>
        {index === 0 && <div className="project-discovery-keywords">
          <dt>重点关键词</dt>
          <dd>
            <textarea
              className="project-discovery-keyword-input"
              value={keywordText}
              rows={2}
              maxLength={655}
              disabled={saving}
              aria-busy={saving}
              aria-label={`编辑${name}重点关键词`}
              placeholder="输入关键词，用顿号、逗号或换行分隔"
              onChange={(event) => onKeywordChange(event.target.value)}
              onBlur={onKeywordBlur}
            />
          </dd>
        </div>}
      </Fragment>)}</dl>
  </section>
}

type ProjectDiscoveryProfileFact = { label: string; value: string }

function buildProjectDiscoveryCardDraft(
  lead: LeadListItem,
  brief: ReturnType<typeof buildProjectDiscoveryBrief>,
  profile: ProjectDiscoveryProfileFact[],
): ProjectDiscoveryCardEdits {
  return {
    name: projectDiscoveryDisplayName(lead),
    primaryDate: projectDiscoveryPrimaryDate(lead).value,
    summary: brief.summary,
    region: projectDiscoveryDisplayRegion(lead),
    sourceChannel: projectDiscoveryDisplaySourceChannel(lead),
    briefFacts: Object.fromEntries(brief.facts
      .filter((fact) => fact.label !== '最新融资日期' && fact.label !== '公开日期')
      .map((fact) => [fact.label, fact.value])),
    profileFacts: Object.fromEntries(profile.map((fact) => [fact.label, fact.value])),
  }
}

function projectDiscoveryProfile(lead: LeadListItem): ProjectDiscoveryProfileFact[] {
  const edits = readProjectDiscoveryCardEdits(lead)
  if (discoveryCandidateKind(lead) === 'research') {
    const research = lead.researchProfile
    return applyProfileEdits(compactProfileFacts([
      profileFact('研究问题', research?.direction?.researchProblem),
      profileFact('研究方法', research?.direction?.methods?.slice(0, 3).join('、')),
      profileFact('应用场景', research?.valueAndTransfer?.applicationScenarios?.slice(0, 3).join('、')),
      profileFact('技术成熟度', research?.valueAndTransfer?.trl || research?.valueAndTransfer?.prototype),
      profileFact('论文/专利', [research?.progress?.venue, ...(research?.rights?.patents ?? [])].filter(Boolean).slice(0, 3).join('、')),
      profileFact('数据更新', research?.dataStatus?.updatedAt || lead.dataUpdatedAt?.slice(0, 10)),
    ]), edits)
  }
  const investment = lead.investmentProfile
  const candidate = lead.availableData
  const profile = lead.radarProfile?.profile
  const products = investment?.products?.length ? investment.products : candidate?.products ?? []
  const institutions = investment?.institutions?.length ? investment.institutions : candidate?.institutions ?? []
  const financing = investment?.financing.latestRound
    || investment?.financing.latestAmount
    || investment?.financing.latestRoundDate
    ? investment.financing
    : candidate?.financing ?? investment?.financing
  return applyProfileEdits(compactProfileFacts([
    profileFact('核心产品', products.slice(0, 3).map((product) => product.name).filter(Boolean).join('、') || profile?.products?.slice(0, 3).join('、')),
    profileFact('核心技术', products.slice(0, 3).map((product) => product.technologyRoute || product.productRoute).filter(Boolean).join('；') || profile?.coreTechnologies?.slice(0, 3).join('；')),
    profileFact('产业链位置', investment?.industry.chainPosition),
    profileFact('融资与投资机构', [financing?.latestRound, financing?.latestAmount, institutions.slice(0, 3).map((item) => item.name).join('、')].filter(Boolean).join(' · ')),
    profileFact('客户进展', investment?.customers.highestStage || (investment?.customers.verifiedCount ? `已核验 ${investment.customers.verifiedCount} 家` : undefined)),
    profileFact('工商主体', investment?.subject?.legalEntityName || profile?.companyName || lead.companyName),
    profileFact('经营范围', profile?.businessScope),
  ]), edits)
}

function applyProfileEdits(facts: ProjectDiscoveryProfileFact[], edits?: ProjectDiscoveryCardEdits): ProjectDiscoveryProfileFact[] {
  if (!edits) return facts
  return facts.map((fact) => ({
    ...fact,
    value: Object.prototype.hasOwnProperty.call(edits.profileFacts, fact.label)
      ? edits.profileFacts[fact.label]
      : fact.value,
  }))
}

function projectDiscoveryMissingFields(lead: LeadListItem): string[] {
  if (discoveryCandidateKind(lead) === 'research') {
    const research = lead.researchProfile
    return [
      !research?.team?.authors?.length && '核心团队背景',
      !research?.team?.affiliations?.length && '所属机构',
      !research?.direction?.methods?.length && '研究方法',
    ].filter((value): value is string => Boolean(value))
  }
  const investment = lead.investmentProfile
  const candidate = lead.availableData
  const profile = lead.radarProfile?.profile
  return [
    !investment?.products?.length && !candidate?.products.length && !profile?.products?.length && '核心产品',
    !investment?.financing.latestAmount && !candidate?.financing?.latestAmount && '融资金额',
    !investment?.institutions?.length && !candidate?.institutions.length && '投资方',
    !investment?.academicLinks?.some((link) => link.person) && !profile?.teamComposition && '核心团队背景',
  ].filter((value): value is string => Boolean(value))
}

function projectDiscoveryCompleteness(status: string | undefined, verified?: number, applicable?: number): string {
  const ratio = typeof verified === 'number' && typeof applicable === 'number' && applicable > 0 ? ` · ${verified}/${applicable}` : ''
  const label = status === 'verified' ? '已核验' : status === 'partial' ? '部分核验' : status === 'conflicted' ? '存在冲突' : '待补充'
  return `${label}${ratio}`
}

function profileFact(label: string, value?: string): ProjectDiscoveryProfileFact | null {
  return { label, value: value?.trim() ?? '' }
}

function compactProfileFacts(facts: Array<ProjectDiscoveryProfileFact | null>): ProjectDiscoveryProfileFact[] {
  const compact = facts.filter((fact): fact is ProjectDiscoveryProfileFact => Boolean(fact))
  return compact.length ? compact : [{ label: '画像状态', value: '信息待进一步补充' }]
}

function safeExternalUrl(value?: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}
