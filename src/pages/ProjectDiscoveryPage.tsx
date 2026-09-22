import {
  ArrowRight, CalendarDays, ChevronDown, FileUp, LoaderCircle, Radar, Search, Sparkles, X,
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { EmptyState } from '../components/ui'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import {
  buildProjectDiscoveryKeywords,
  buildProjectDiscoveryBrief,
  discoveryCandidateKind,
  filterProjectDiscoveryCandidates,
  formatProjectDiscoveryKeywordText,
  loadProjectDiscoveryPage,
  parseProjectDiscoveryKeywordText,
  projectDiscoveryCandidateDay,
  projectDiscoveryPrimaryDate,
  type ProjectDiscoveryKeyword,
  type ProjectDiscoveryKind,
  type ProjectDiscoveryPeriod,
} from '../lib/projectDiscovery'
import type { LeadListResponse } from '../store/useAppStore'
import type { LeadListItem } from '../types'
import './ProjectDiscoveryPage.css'

const periods: Array<{ value: ProjectDiscoveryPeriod; label: string }> = [
  { value: 'today', label: '今天新发现' },
  { value: 'week', label: '近 7 天' },
  { value: 'all', label: '全部项目' },
]

const kinds: Array<{ value: ProjectDiscoveryKind; label: string }> = [
  { value: 'all', label: '全部类型' },
  { value: 'company', label: '企业项目' },
  { value: 'research', label: '科研成果' },
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

const fetchProjectDiscoveryPage = (page: number) => apiGet<LeadListResponse>(
  `/project-discovery/leads?page=${page}&pageSize=50&sort=latest`,
)

export function ProjectDiscoveryPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const requestSerial = useRef(0)
  const candidatesRef = useRef<LeadListItem[]>([])
  const paginationRef = useRef({ page: 1, totalPages: 1 })
  const loadingMoreRef = useRef(false)
  const [candidates, setCandidates] = useState<LeadListItem[]>([])
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1 })
  const [period, setPeriod] = useState<ProjectDiscoveryPeriod>('week')
  const [kind, setKind] = useState<ProjectDiscoveryKind>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [action, setAction] = useState<'refresh' | 'upload' | ''>('')
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const loadCandidates = useCallback(async (background = false) => {
    const serial = ++requestSerial.current
    if (!background) setLoading(true)
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
  }, [])

  const loadRemainingCandidates = useCallback(async () => {
    if (loadingMoreRef.current || paginationRef.current.page >= paginationRef.current.totalPages) return true
    const serial = ++requestSerial.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      let items = candidatesRef.current
      while (paginationRef.current.page < paginationRef.current.totalPages) {
        if (serial !== requestSerial.current) return false
        const loaded = await loadProjectDiscoveryPage(
          fetchProjectDiscoveryPage,
          paginationRef.current.page + 1,
          items,
          (nextItems) => {
            if (serial !== requestSerial.current) return
            candidatesRef.current = nextItems
            setCandidates(nextItems)
          },
        )
        if (!loaded || serial !== requestSerial.current) return false
        items = loaded.items
        const nextPagination = { page: loaded.page, totalPages: loaded.totalPages }
        paginationRef.current = nextPagination
        setPagination(nextPagination)
      }
      return true
    } catch (cause) {
      if (serial === requestSerial.current) {
        setNotice({ tone: 'error', text: cause instanceof Error ? cause.message : '其余项目读取失败，请稍后重试。' })
      }
      return false
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => { void loadCandidates() }, [loadCandidates])
  useEffect(() => {
    if (period === 'all' && !loading && pagination.page < pagination.totalPages) {
      void loadRemainingCandidates()
    }
  }, [loadRemainingCandidates, loading, pagination.page, pagination.totalPages, period])

  const visible = useMemo(() => filterProjectDiscoveryCandidates(candidates, {
    period, query, kind,
  }), [candidates, kind, period, query])

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

    <section className="project-discovery-results" aria-label="待查看项目" aria-busy={loading || loadingMore}>
      {loading ? <div className="project-discovery-state"><LoaderCircle className="is-spinning" aria-hidden="true" /><strong>正在整理最新项目信号</strong><p>读取已收录的公开信源与结构化画像。</p></div>
        : error ? <div className="project-discovery-state project-discovery-error"><strong>新项目读取失败</strong><p>{error}</p><button type="button" onClick={() => void loadCandidates()}>重新加载</button></div>
          : visible.length === 0 ? <EmptyState title="当前范围没有新项目" description="试试切换到近 7 天、全部类型，或调整搜索关键词。" />
            : <div className="project-discovery-grid">{visible.map((lead) => <DiscoveryCard
              key={lead.id}
              lead={lead}
              onOpen={() => openLead(lead)}
              onKeywordsUpdated={(keywords) => updateCandidateKeywords(lead.id, keywords)}
              onRemoved={(message) => removeCandidate(lead.id, message)}
            />)}</div>}
    </section>
  </div>
}

function DiscoveryCard({ lead, onOpen, onKeywordsUpdated, onRemoved }: {
  lead: LeadListItem
  onOpen: () => void
  onKeywordsUpdated: (keywords: ProjectDiscoveryKeyword[]) => void
  onRemoved: (message: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [keywordText, setKeywordText] = useState(() => formatProjectDiscoveryKeywordText(buildProjectDiscoveryKeywords(lead)))
  const [assignmentOpen, setAssignmentOpen] = useState(false)
  const [assignmentOptions, setAssignmentOptions] = useState<ProjectDiscoveryAssignmentOptions | null>(null)
  const [selectedDepartment, setSelectedDepartment] = useState('')
  const [selectedOwnerId, setSelectedOwnerId] = useState('')
  const [confirmDefer, setConfirmDefer] = useState(false)
  const [cardAction, setCardAction] = useState<'keywords' | 'options' | 'defer' | 'convert' | ''>('')
  const [cardError, setCardError] = useState('')
  const kind = discoveryCandidateKind(lead)
  const investment = lead.investmentProfile
  const research = lead.researchProfile
  const name = lead.name || lead.companyName || '未命名项目'
  const brief = buildProjectDiscoveryBrief(lead)
  const keywords = buildProjectDiscoveryKeywords(lead)
  const persistedKeywordText = formatProjectDiscoveryKeywordText(keywords)
  const primaryDate = projectDiscoveryPrimaryDate(lead)
  const dataStatus = kind === 'research' ? research?.dataStatus?.status : investment?.dataStatus?.status
  const profile = projectDiscoveryProfile(lead)
  const missingFields = projectDiscoveryMissingFields(lead)
  const sourceUrl = safeExternalUrl(lead.radarProfile?.link)
  const latestUpdate = lead.latestUpdates?.[0]
  const verifiedDimensions = kind === 'research' ? research?.dataStatus?.verifiedDimensions : investment?.dataStatus?.verifiedDimensions
  const applicableDimensions = kind === 'research' ? research?.dataStatus?.applicableDimensions : investment?.dataStatus?.applicableDimensions
  const primaryDateTime = /^\d{4}-\d{2}-\d{2}/u.exec(primaryDate.value)?.[0]
  const eligiblePeople = assignmentOptions?.people.filter((person) => person.department === selectedDepartment) ?? []

  useEffect(() => setKeywordText(persistedKeywordText), [persistedKeywordText])

  const saveKeywords = async () => {
    if (cardAction === 'keywords' || keywordText.trim() === persistedKeywordText) return
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
      <h3>{name}</h3>
      <time className="project-discovery-card-date" dateTime={primaryDateTime}>
        <CalendarDays aria-hidden="true" />
        <span>{primaryDate.label}</span>
        <strong>{primaryDate.value}</strong>
      </time>
    </header>
    <DiscoveryInvestmentBrief
      name={name}
      brief={brief}
      keywordText={keywordText}
      savingKeywords={cardAction === 'keywords'}
      onChange={(value) => { setKeywordText(value); setCardError('') }}
      onBlur={() => void saveKeywords()}
    />
    <button type="button" className="project-discovery-card-toggle" aria-expanded={expanded} aria-label={`查看${name}项目详情`} onClick={() => setExpanded((current) => !current)}>
      {expanded ? '收起详细信息' : '展开详细信息'}
      <ChevronDown className={expanded ? 'is-expanded' : ''} aria-hidden="true" />
    </button>
    {expanded && <>
      <section className="project-discovery-card-details" aria-label={`${name}详细信息`}>
        <div className="project-discovery-detail-panel project-discovery-detail-summary">
          <strong>{kind === 'company' ? '项目摘要' : '情报摘要'}</strong>
          <p>{brief.summary || '摘要待补充。'}</p>
        </div>
        <dl className="project-discovery-detail-metadata">
          <div><dt>地区</dt><dd>{lead.region || '待核'}</dd></div>
          <div><dt>来源渠道</dt><dd>{lead.radarProfile?.channel || '公开信源'}</dd></div>
          <div><dt>主体类型</dt><dd>{kind === 'company' ? '公司' : '技术'}</dd></div>
          <div><dt>完整度</dt><dd>{projectDiscoveryCompleteness(dataStatus, verifiedDimensions, applicableDimensions)}</dd></div>
        </dl>
        <div className="project-discovery-detail-panel project-discovery-profile">
          <h4>{kind === 'company' ? '公司画像' : '技术画像'}</h4>
          <dl>{profile.map((fact) => <div key={`${fact.label}:${fact.value}`}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
        </div>
        {(latestUpdate || sourceUrl) && <div className="project-discovery-detail-sources">
          <strong>信息来源</strong>
          <div>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">{latestUpdate?.title || '查看原始公开信源'}</a> : <span>{latestUpdate?.title}</span>}
            <p>{lead.radarProfile?.channel || '公开资料'}{projectDiscoveryCandidateDay(lead) ? ` · ${projectDiscoveryCandidateDay(lead)}` : ''}</p>
          </div>
        </div>}
        {missingFields.length > 0 && <div className="project-discovery-detail-questions">
          <strong>关键待核问题</strong>
          <ul>{missingFields.map((field) => <li key={field}>补充并核验{field}</li>)}</ul>
          <div>{missingFields.map((field) => <span key={field}>待补：{field}</span>)}</div>
        </div>}
      </section>
    </>}
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
    <footer className="project-discovery-card-actions">
      <button type="button" className="detail-button" onClick={onOpen}>查看完整线索<ArrowRight aria-hidden="true" /></button>
      <span />
      <button type="button" className="defer-button" disabled={Boolean(cardAction)} onClick={() => { setConfirmDefer(true); setAssignmentOpen(false); setCardError('') }}>暂不跟进</button>
      <button type="button" className="convert-button" disabled={Boolean(cardAction)} onClick={() => void openAssignment()}>项目入库</button>
    </footer>
  </article>
}

function DiscoveryInvestmentBrief({ name, brief, keywordText, savingKeywords, onChange, onBlur }: {
  name: string
  brief: ReturnType<typeof buildProjectDiscoveryBrief>
  keywordText: string
  savingKeywords: boolean
  onChange: (value: string) => void
  onBlur: () => void
}) {
  const facts = brief.facts.filter((item) => item.label !== '最新融资日期' && item.label !== '公开日期')
  return <section aria-label={`${name}投资速览`} className="project-discovery-investment-brief">
    <dl>{facts.map((item, index) => {
      const [track, ...productParts] = item.label === '行业分类' ? item.value.split(/\s*\/\s*/u) : []
      const product = productParts.join(' / ')
      return <Fragment key={`${item.label}:${item.value}`}>
        <div className={item.wide ? 'wide' : ''}>
          <dt>{item.label}</dt>
          {product ? <dd className="industry"><span>{track}</span><i aria-hidden="true">/</i><strong>{product}</strong></dd> : <dd>{item.value}</dd>}
        </div>
        {index === 0 && <div className="project-discovery-keywords">
          <dt>重点关键词</dt>
          <dd>
            <textarea
              className="project-discovery-keyword-input"
              value={keywordText}
              rows={2}
              maxLength={655}
              disabled={savingKeywords}
              aria-busy={savingKeywords}
              aria-label={`编辑${name}重点关键词`}
              placeholder="输入关键词，用顿号、逗号或换行分隔"
              onChange={(event) => onChange(event.target.value)}
              onBlur={onBlur}
            />
          </dd>
        </div>}
      </Fragment>
    })}</dl>
  </section>
}

type ProjectDiscoveryProfileFact = { label: string; value: string }

function projectDiscoveryProfile(lead: LeadListItem): ProjectDiscoveryProfileFact[] {
  if (discoveryCandidateKind(lead) === 'research') {
    const research = lead.researchProfile
    return compactProfileFacts([
      profileFact('研究问题', research?.direction?.researchProblem),
      profileFact('研究方法', research?.direction?.methods?.slice(0, 3).join('、')),
      profileFact('应用场景', research?.valueAndTransfer?.applicationScenarios?.slice(0, 3).join('、')),
      profileFact('技术成熟度', research?.valueAndTransfer?.trl || research?.valueAndTransfer?.prototype),
      profileFact('论文/专利', [research?.progress?.venue, ...(research?.rights?.patents ?? [])].filter(Boolean).slice(0, 3).join('、')),
      profileFact('数据更新', research?.dataStatus?.updatedAt || lead.dataUpdatedAt?.slice(0, 10)),
    ])
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
  return compactProfileFacts([
    profileFact('核心产品', products.slice(0, 3).map((product) => product.name).filter(Boolean).join('、') || profile?.products?.slice(0, 3).join('、')),
    profileFact('核心技术', products.slice(0, 3).map((product) => product.technologyRoute || product.productRoute).filter(Boolean).join('；') || profile?.coreTechnologies?.slice(0, 3).join('；')),
    profileFact('产业链位置', investment?.industry.chainPosition),
    profileFact('融资与投资机构', [financing?.latestRound, financing?.latestAmount, institutions.slice(0, 3).map((item) => item.name).join('、')].filter(Boolean).join(' · ')),
    profileFact('客户进展', investment?.customers.highestStage || (investment?.customers.verifiedCount ? `已核验 ${investment.customers.verifiedCount} 家` : undefined)),
    profileFact('工商主体', investment?.subject?.legalEntityName || profile?.companyName || lead.companyName),
    profileFact('经营范围', profile?.businessScope),
  ])
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
  return value?.trim() ? { label, value: value.trim() } : null
}

function compactProfileFacts(facts: Array<ProjectDiscoveryProfileFact | null>): ProjectDiscoveryProfileFact[] {
  const compact = facts.filter((fact): fact is ProjectDiscoveryProfileFact => Boolean(fact))
  return compact.length ? compact : [{ label: '画像状态', value: '信息待进一步补充' }]
}

function safeExternalUrl(value?: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}
