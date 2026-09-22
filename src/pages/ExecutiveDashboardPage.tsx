import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight, CalendarDays, ChevronRight, ClipboardCheck, FolderKanban, RefreshCw } from 'lucide-react'
import { Badge, Button, Card, Drawer, EmptyState, LoadingState, ProgressBar, SearchInput, StageBadge, StatusBadge, Tabs } from '../components/ui'
import { api } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { isExecutiveRole, executiveViewFromLocation } from '../lib/executiveDashboard'
import { executiveVisibleRows } from '../lib/executiveScreen'
import { ExecutiveScreenLayout, ExecutiveScreenSection, ExecutiveExpand, ExecutiveDeferredSection } from '../components/ExecutiveScreenLayout'
import { scrollToExecutiveScreen } from '../lib/executiveScreenNavigation'
import { executiveAgendaAction, executiveFocusProjects } from '../lib/executiveOverview'
import { ExecutiveMeetingPreview } from '../components/ExecutiveMeetingPreview'
import {
  executiveKeyNodes, executivePortfolio, executiveOwnDirectives, executiveProjectUpdate, executiveTeam, executiveWeekLogs,
  isInExecutiveWeek, isOpenTask, loadExecutiveDetails, loadExecutiveProjects,
  type ExecutiveCalendarItem, type ExecutivePerson, type ExecutiveProjectDetail, type ExecutiveRead,
} from '../lib/executiveDashboardData'
import { formatShanghaiDateTime, shanghaiDateKey } from '../lib/dateTime'
import { approvalCenterDetailPath, type ApprovalCenterResult } from '../../server/src/contracts/fdeApprovalCenterContract'
import { weekStartFor } from '../../server/src/contracts/fdeWeeklyPlanContract'
import type { RiskAlert, WorkflowLog } from '../types'
import { DashboardPage } from './DashboardPage'
import { APPROVAL_CHANGED, approvalTarget, openApproval } from '../lib/approvalWorkspace'
import { TASK_CHANGED } from '../lib/taskWorkspace'
import './ExecutiveDashboardPage.css'

type Resource<T> = { data: T | null; loading: boolean; error: string; key: string }
const readWithSignal = (signal: AbortSignal): ExecutiveRead => <T,>(path: string) => api<T>(path, {
  signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
})

function useResource<T>(key: string, load: (read: ExecutiveRead) => Promise<T>) {
  const [state, setState] = useState<Resource<T>>({ key, data: null, loading: true, error: '' })
  useEffect(() => {
    const controller = new AbortController()
    // Retain this account's last read while refreshing; never flash an empty inbox.
    setState(previous => ({ ...previous, loading: true, error: '' }))
    void load(readWithSignal(controller.signal)).then(data => {
      if (!controller.signal.aborted) setState({ key, data, loading: false, error: '' })
    }).catch(() => {
      if (!controller.signal.aborted) setState(previous => ({ ...previous, key, loading: false, error: '暂时无法更新，请重试' }))
    })
    return () => controller.abort()
    // Key includes the account, Shanghai date and explicit refresh revision.
  }, [key])
  return { ...state, loading: state.loading || state.key !== key }
}

function Notice({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-xs text-amber-700">
    <span>{children}</span>{onRetry && <Button variant="ghost" size="sm" onClick={onRetry}>重试</Button>}
  </div>
}

function State({ loading, error, hasData, empty, children, onRetry }: {
  loading: boolean; error: string; hasData: boolean; empty?: string | false; children: ReactNode; onRetry: () => void
}) {
  if (loading && !hasData) return <div role="status" aria-label="正在加载"><LoadingState rows={3} /></div>
  if (error && !hasData) return <div className="py-8"><Notice onRetry={onRetry}>暂时无法加载本区内容</Notice></div>
  return <>{error && <Notice onRetry={onRetry}>更新失败，当前显示上次读取的内容</Notice>}{empty ? <EmptyState title={empty} description="" /> : children}</>
}

function OverviewColumn({ title, count, icon, footer, children }: { title: string; count?: number; icon: ReactNode; footer: ReactNode; children: ReactNode }) {
  return <section className="executive-overview-column" aria-label={title}><Card className="executive-overview-card">
    <header className="executive-overview-column-head"><span className="executive-overview-icon" aria-hidden="true">{icon}</span><h3>{title}</h3>{count !== undefined && <span className="executive-overview-count">{count}</span>}</header>
    <div className="executive-overview-column-body" tabIndex={0} aria-label={`${title}列表`}>{children}</div>
    <footer className="executive-overview-column-footer">{footer}</footer>
  </Card></section>
}

function timestamp(value: string) {
  try { return formatShanghaiDateTime(value, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) } catch { return '时间待补充' }
}

export function ExecutiveDashboardPage() {
  const user = useAuthStore(state => state.user)
  if (!user) return <Navigate to="/login" replace />
  return <ExecutiveDashboardForAccount key={`${user.id}:${user.role}`} userId={user.id} userRole={user.role} />
}

function ExecutiveDashboardForAccount({ userId, userRole }: { userId: string; userRole: string }) {
  const navigate = useNavigate(), location = useLocation()
  const initialScreen = executiveViewFromLocation(location.search, location.hash)
  const [revision, setRevision] = useState(0)
  const [today, setToday] = useState(() => shanghaiDateKey())
  const reload = () => { setToday(shanghaiDateKey()); setRevision(value => value + 1) }
  useEffect(() => {
    const update = () => setRevision(value => value + 1)
    window.addEventListener(APPROVAL_CHANGED, update)
    window.addEventListener(TASK_CHANGED, update)
    return () => { window.removeEventListener(APPROVAL_CHANGED, update); window.removeEventListener(TASK_CHANGED, update) }
  }, [])
  const key = `${userId}:${today}:${revision}`, week = weekStartFor(today)
  const projects = useResource(key, loadExecutiveProjects)
  const approvals = useResource(key, read => read<ApprovalCenterResult>('/oa/center?view=pending&page=1&pageSize=5'))
  const risks = useResource(key, async read => (await read<{ list: RiskAlert[] }>('/risks')).list)
  const logs = useResource(key, async read => (await read<{ list: WorkflowLog[] }>('/oa/workflow-logs')).list)
  const calendarView = isExecutiveRole(userRole) ? 'company' : 'personal'
  const personalAgenda = calendarView === 'personal'
  const calendar = useResource(key, async read => (await read<{ items: ExecutiveCalendarItem[] }>(`/calendar?view=${calendarView}&weekStart=${week}`)).items)
  const people = useResource(key, async read => (await read<{ people: ExecutivePerson[] }>('/projects/creation-roster')).people)
  const [detailState, setDetailState] = useState<{ key: string; rows: ExecutiveProjectDetail[]; loading: boolean }>({ key, rows: [], loading: true })
  const details = detailState.rows
  const detailLoading = !projects.error && (projects.loading || detailState.key !== key || detailState.loading)
  const nodeError = details.some(d => d.errors.includes('任务') || d.errors.includes('节点'))
  const nodeReadError = details.some(d => d.errors.includes('任务') || d.errors.includes('节点') && !d.workflowNeedsConfiguration)
  const workflowConfigurationCount = details.filter(d => d.workflowNeedsConfiguration).length
  const directiveError = details.some(d => d.errors.includes('督办'))
  const teamError = details.some(d => d.errors.includes('任务') || d.errors.includes('节点'))
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null)
  const [selectedRisk, setSelectedRisk] = useState<string | null>(null)
  const [showAgenda, setShowAgenda] = useState(false)
  const [selectedMeeting, setSelectedMeeting] = useState<string | null>(null)
  const [projectFilter, setProjectFilter] = useState('all')
  const [directiveFilter, setDirectiveFilter] = useState('open')
  const [riskFilter, setRiskFilter] = useState('all')
  const [teamView, setTeamView] = useState('department')
  type Collection = 'projects' | 'directives' | 'risks' | 'team'
  const [queries, setQueries] = useState<Record<Collection, string>>({ projects: '', directives: '', risks: '', team: '' })
  const [expanded, setExpanded] = useState<Record<Collection, boolean>>({ projects: false, directives: false, risks: false, team: false })

  useEffect(() => {
    if (!projects.data || projects.key !== key || projects.loading || projects.error) return
    const controller = new AbortController()
    setDetailState(previous => ({ ...previous, key, loading: true }))
    void loadExecutiveDetails(projects.data, readWithSignal(controller.signal), rows => {
      if (!controller.signal.aborted) setDetailState({ key, rows, loading: true })
    }, controller.signal).then(rows => {
      if (!controller.signal.aborted) setDetailState({ key, rows, loading: false })
    })
    return () => controller.abort()
  }, [projects.data, projects.key, projects.loading, projects.error, key])
  useEffect(() => {
    const timer = window.setInterval(() => setToday(shanghaiDateKey()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!selectedProject && !selectedPerson && !selectedRisk && !showAgenda) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.querySelectorAll('[aria-modal="true"]').length <= 1) { setSelectedProject(null); setSelectedPerson(null); setSelectedRisk(null); setShowAgenda(false) }
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [selectedProject, selectedPerson, selectedRisk, showAgenda])

  const matches = (scope: Collection, ...values: string[]) => values.join(' ').toLocaleLowerCase().includes(queries[scope].trim().toLocaleLowerCase())
  const expand = (scope: Collection) => setExpanded(previous => ({ ...previous, [scope]: true }))
  const activeRisks = useMemo(() => (risks.data ?? []).filter(r => !['已关闭', '误报'].includes(r.status)), [risks.data])
  const portfolio = useMemo(() => executivePortfolio(projects.data ?? [], activeRisks, today), [projects.data, activeRisks, today])
  const focusProjects = useMemo(() => executiveFocusProjects(portfolio), [portfolio])
  const directives = useMemo(() => executiveOwnDirectives(details, userId, today), [details, userId, today])
  const keyNodes = useMemo(() => executiveKeyNodes(details, calendar.data ?? [], today, calendarView), [details, calendar.data, today, calendarView])
  const team = useMemo(() => executiveTeam(projects.data ?? [], details, people.data ?? [], today), [projects.data, details, people.data, today])
  const weekLogs = useMemo(() => executiveWeekLogs(logs.data ?? [], today), [logs.data, today])
  const highRisks = activeRisks.filter(risk => risk.level === '高')
  const overdueDirectives = directives.filter(item => item.overdue)
  const filteredProjects = portfolio.filter(({ project, status }) => (projectFilter === 'all' || projectFilter === 'key' && project.classification === 'key' || projectFilter === 'attention' && status.tone !== 'green') && matches('projects', project.name, project.owner, project.companyName))
  const filteredDirectives = directives.filter(item => (directiveFilter === 'all' || directiveFilter === 'overdue' && item.overdue || directiveFilter === 'open' && isOpenTask(item.task.status) || directiveFilter === 'done' && item.task.status === '已完成') && matches('directives', item.task.title, item.task.owner, item.project.name))
  const filteredRisks = activeRisks.filter(risk => (riskFilter === 'all' || risk.level === riskFilter) && matches('risks', risk.description, risk.projectName, risk.owner)).sort((a, b) => ['高', '中', '低'].indexOf(a.level) - ['高', '中', '低'].indexOf(b.level) || b.occurredAt.localeCompare(a.occurredAt))
  const groups = teamView === 'department'
    ? [...new Set(team.map(item => item.department || '其他团队'))].sort((a, b) => Number(b.includes('投资')) - Number(a.includes('投资')) || a.localeCompare(b, 'zh-CN')).map(name => ({ id: name, name, members: team.filter(item => (item.department || '其他团队') === name && matches('team', item.name, ...item.related.map(p => p.name))) }))
    : portfolio.map(({ project }) => ({ id: project.id, name: project.name, members: executiveTeam([project], details.filter(d => d.project.id === project.id), people.data ?? [], today).filter(item => matches('team', item.name, project.name)) }))
  const visibleGroups = groups.filter(group => group.members.length)
  const projectRow = portfolio.find(row => row.project.id === selectedProject)
  const projectDetail = details.find(row => row.project.id === selectedProject)
  const person = team.find(item => item.id === selectedPerson)
  const riskDetail = activeRisks.find(item => item.id === selectedRisk)
  const hasProjectData = projects.data !== null
  const hasDetails = hasProjectData && (!detailLoading || details.some(d => d.tasks || d.directives || d.workflow))
  const agendaLoading = calendar.loading || !personalAgenda && detailLoading
  const agendaError = calendar.error || (!personalAgenda ? projects.error : '')
  const agendaHasData = calendar.data !== null || !personalAgenda && hasDetails
  const agendaEmpty = !agendaLoading && !agendaError && (personalAgenda || !nodeError) && !keyNodes.length && '今天暂无安排'
  const projectUpdate = (id: string) => executiveProjectUpdate(id, details, logs.data ?? [], today)
    || (logs.loading || detailLoading ? '正在更新本周进展…' : logs.error || details.find(d => d.project.id === id)?.errors.includes('任务') ? '本周进展暂未加载' : '本周暂无进展更新')
  const pickProject = (id: string) => { setSelectedPerson(null); setSelectedRisk(null); setSelectedProject(id) }
  const nodeNotices = <>
    {details.filter(d => d.workflowNeedsConfiguration).map(d => <Notice key={d.project.id}><Link to={`/projects/${d.project.id}?tab=workflow`} className="hover:underline">{d.project.name} · 流程待配置 →</Link></Notice>)}
    {details.some(d => d.errors.includes('任务') || d.errors.includes('节点') && !d.workflowNeedsConfiguration) && <Notice onRetry={reload}>部分节点未能加载</Notice>}
  </>

  const projectRows = (rows: typeof portfolio) => <div className="divide-y divide-slate-100">
    <div className="hidden grid-cols-12 gap-5 bg-slate-50 px-5 py-3 text-xs text-slate-500 lg:grid"><span className="col-span-4">项目 / 负责人</span><span className="col-span-5">本周进展</span><span className="col-span-3">推进状态</span></div>
    {rows.map(({ project, status }) => <button key={project.id} onClick={() => pickProject(project.id)} aria-label={`查看${project.name}概览`} className="executive-project-row group grid w-full grid-cols-1 items-center gap-3 px-5 py-4 text-left transition hover:bg-slate-50 lg:grid-cols-12 lg:gap-5">
      <div className="min-w-0 lg:col-span-4"><div className="flex items-start justify-between gap-2"><span className="break-words text-sm font-semibold text-ink">{project.name}</span><ChevronRight className="h-4 w-4 shrink-0 text-slate-400 lg:hidden" /></div><div className="mt-2 flex flex-wrap items-center gap-2"><span className="text-xs text-slate-500">{project.owner || '负责人待配置'}</span><span className="text-xs text-slate-300">·</span><span className="text-xs text-slate-500">{project.stage === '已 Close' ? '完成交割' : project.stage}</span>{project.classification === 'key' && <span className="text-xs text-brand-700">重点</span>}</div></div>
      <p className="line-clamp-2 text-sm leading-6 text-slate-500 lg:col-span-5">{projectUpdate(project.id)}</p>
      <div className="flex items-center gap-3 lg:col-span-3"><div className="min-w-0 flex-1"><div className="mb-2 flex items-center justify-between gap-2"><Badge tone={status.tone}>{status.label}</Badge><span className="text-xs tabular-nums text-slate-400">{Math.round(project.progress)}%</span></div><ProgressBar value={project.progress} tone={status.tone === 'green' ? 'green' : 'amber'} /></div><ChevronRight className="hidden h-4 w-4 shrink-0 text-slate-300 group-hover:text-brand-700 lg:block" /></div>
    </button>)}
  </div>

  const agendaRows = () => <div className="executive-agenda-list">{keyNodes.map(item => {
    const target = executiveAgendaAction(item)
    const preview = target.kind === 'project' || target.kind === 'meeting'
    return <Link key={item.id} to={item.to} className="executive-agenda-row" onClick={event => {
      if (!preview || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
      event.preventDefault(); setShowAgenda(false)
      if (target.kind === 'project') pickProject(target.id)
      if (target.kind === 'meeting') setSelectedMeeting(target.id)
    }}>
      <div className="executive-agenda-time"><time>{item.time}</time><span>{item.kindLabel || (target.kind === 'meeting' ? '会议' : target.kind === 'task' ? '任务' : '节点')}</span></div>
      <div className="executive-agenda-copy"><strong>{item.title}</strong><span>{item.project}</span><small>{target.kind === 'task' ? '查看任务' : target.kind === 'meeting' ? '查看会议' : target.kind === 'project' ? '查看进展' : '查看安排'}<ArrowRight size={12} aria-hidden="true" /></small></div>
    </Link>
  })}</div>

  const filteredToolbar = (scope: Collection, tabs: { id: string; label: string }[], value: string, onChange: (value: string) => void, placeholder: string) => <div className="executive-filter-toolbar flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
    <Tabs tabs={tabs} value={value} onChange={onChange} />
    <SearchInput aria-label={placeholder} placeholder={placeholder} value={queries[scope]} onChange={event => setQueries(previous => ({ ...previous, [scope]: event.target.value }))} className="w-full sm:w-64" />
  </div>

  return <div className="executive-workbench">
    <h1 className="sr-only">工作台</h1>
    <ExecutiveScreenLayout userId={userId} initialScreen={new URLSearchParams(location.search).has('view') || location.hash ? initialScreen : undefined} locationKey={location.key} actions={<><span className="executive-screen-date">{today.replaceAll('-', '.')}</span><Link to="/knowledge?view=notes">个人笔记</Link><Button variant="ghost" size="sm" aria-label="刷新工作台" title="刷新工作台" onClick={reload} disabled={projects.loading}><RefreshCw className={`h-4 w-4${projects.loading ? ' animate-spin' : ''}`} /></Button></>}>
    <ExecutiveScreenSection id="overview" action={<div className="executive-overview-signals">
      {!risks.error && highRisks.length > 0 && <button onClick={() => { setRiskFilter('高'); scrollToExecutiveScreen('risks') }} className="is-risk">高风险 <strong>{highRisks.length}</strong><ChevronRight size={13} /></button>}
      {!projects.error && !directiveError && overdueDirectives.length > 0 && <button onClick={() => { setDirectiveFilter('overdue'); scrollToExecutiveScreen('directives') }}>逾期督办 <strong>{overdueDirectives.length}</strong><ChevronRight size={13} /></button>}
    </div>}>
      <div className="executive-overview-board">
        <OverviewColumn title="审批事项" icon={<ClipboardCheck size={17} />} count={approvals.data?.total} footer={<>
          <Button size="sm" disabled={!approvals.data?.list.length || approvals.loading} onClick={() => { const first = approvals.data?.list[0]; if (first) openApproval(approvalTarget(first)) }}>连续办理<ArrowRight size={14} /></Button>
          <Button variant="ghost" size="sm" onClick={() => openApproval()}>全部审批</Button>
        </>}>
          <State loading={approvals.loading} error={approvals.error} hasData={approvals.data !== null} empty={approvals.data?.total === 0 && '当前没有待审批事项'} onRetry={reload}>
            <div className="executive-overview-list">{approvals.data?.list.map(row => <Link key={row.id} to={approvalCenterDetailPath(row)} className="executive-overview-approval" data-urgent={row.priority === '紧急'}>
              <div className="executive-overview-approval-title"><strong>{row.title}</strong>{row.priority === '紧急' && <span className="executive-overview-urgent">紧急</span>}</div>
              <div className="executive-overview-row-meta"><span>{row.applicantName}</span><time>{timestamp(row.submittedAt)}</time></div>
              <div className="executive-overview-row-meta"><span>{row.kind}</span><span className="executive-overview-row-action">审阅处理<ArrowRight size={13} aria-hidden="true" /></span></div>
            </Link>)}</div>
            {approvals.data && approvals.data.total > approvals.data.list.length && <button className="executive-overview-more" onClick={() => openApproval()}>还有 {approvals.data.total - approvals.data.list.length} 项待审批<ChevronRight size={14} /></button>}
          </State>
        </OverviewColumn>
        <OverviewColumn title="今日安排" icon={<CalendarDays size={17} />} count={!agendaLoading && !agendaError && (personalAgenda || !nodeError) ? keyNodes.length : undefined} footer={<>
          <Button variant="secondary" size="sm" onClick={() => setShowAgenda(true)}>全部安排<ArrowRight size={14} /></Button>
          <Button variant="ghost" size="sm" onClick={() => scrollToExecutiveScreen('personal')}>我的日历</Button>
        </>}>
          <State loading={agendaLoading} error={agendaError} hasData={agendaHasData} empty={agendaEmpty} onRetry={reload}>{agendaRows()}</State>
          {!personalAgenda && nodeReadError && <Notice onRetry={reload}>部分项目节点暂未加载</Notice>}
          {!personalAgenda && workflowConfigurationCount > 0 && <button className="executive-overview-more" onClick={() => setShowAgenda(true)}>{workflowConfigurationCount} 个项目待配置流程<ChevronRight size={14} /></button>}
        </OverviewColumn>
        <OverviewColumn title="重点项目进展" icon={<FolderKanban size={17} />} count={hasProjectData ? focusProjects.length : undefined} footer={<>
          <Button variant="secondary" size="sm" onClick={() => { setProjectFilter('key'); setQueries(previous => ({ ...previous, projects: '' })); scrollToExecutiveScreen('projects') }}>全部重点项目<ArrowRight size={14} /></Button>
        </>}>
          <State loading={projects.loading} error={projects.error} hasData={hasProjectData} empty={hasProjectData && !focusProjects.length && '暂无在途重点项目'} onRetry={reload}>
            <div className="executive-overview-list">{focusProjects.map(({ project, status }) => <button key={project.id} className="executive-overview-project" onClick={() => pickProject(project.id)} aria-label={`查看${project.name}概览`}>
              <div className="executive-overview-project-title"><strong>{project.name}</strong><ChevronRight size={15} aria-hidden="true" /></div>
              <div className="executive-overview-row-meta"><span>{project.owner || '负责人待配置'} · {project.stage}</span><span className={`executive-overview-health is-${status.tone}`}>{status.label}</span></div>
              <p>{projectUpdate(project.id)}</p>
              <div className="executive-overview-project-progress"><ProgressBar value={project.progress} tone={status.tone === 'green' ? 'green' : 'amber'} /><span>{Math.round(project.progress)}%</span></div>
            </button>)}</div>
          </State>
          {hasProjectData && risks.error && <Notice onRetry={reload}>风险信息暂未更新</Notice>}
        </OverviewColumn>
      </div>
    </ExecutiveScreenSection>

    <ExecutiveScreenSection id="projects" summary={<div className="executive-project-metrics">
        {projects.data && <><span>在途项目 <strong className="ml-1 font-semibold text-ink">{portfolio.length}</strong></span><span>本周新增 <strong className="ml-1 font-semibold text-ink">{projects.data.filter(p => isInExecutiveWeek(p.createdAt, today)).length}</strong></span></>}
        {logs.data && <span>本周完成节点 <strong className="ml-1 font-semibold text-ink">{weekLogs.length}</strong></span>}
      </div>} action={<Button variant="secondary" size="sm" onClick={() => navigate('/projects')}>项目中心<ArrowRight className="h-3.5 w-3.5" /></Button>}>
      <Card className="min-w-0 overflow-hidden">
        {filteredToolbar('projects', [{ id: 'all', label: '全部在途' }, { id: 'attention', label: '需要关注' }, { id: 'key', label: '重点项目' }], projectFilter, setProjectFilter, '搜索项目或负责人')}
        <State loading={projects.loading} error={projects.error} hasData={hasProjectData} empty={hasProjectData && !filteredProjects.length && '没有符合条件的项目'} onRetry={reload}>{projectRows(executiveVisibleRows(filteredProjects, expanded.projects))}</State>
        <ExecutiveExpand total={filteredProjects.length} expanded={expanded.projects} onExpand={() => expand('projects')} />
      </Card>
    </ExecutiveScreenSection>

    <ExecutiveScreenSection id="directives" summary="跟进您发起的任务" action={<Button variant="secondary" size="sm" onClick={() => navigate('/collaboration')}>任务与日历<ArrowRight className="h-3.5 w-3.5" /></Button>}>
    <Card className="min-w-0 overflow-hidden">
      {filteredToolbar('directives', [{ id: 'open', label: '待推进' }, { id: 'overdue', label: '已逾期' }, { id: 'done', label: '已完成' }, { id: 'all', label: '全部' }], directiveFilter, setDirectiveFilter, '搜索督办、项目或负责人')}
      <State loading={detailLoading} error={projects.error} hasData={hasDetails} empty={!detailLoading && !directiveError && !filteredDirectives.length && '没有符合条件的督办'} onRetry={reload}>
        <div className="divide-y divide-slate-100">{executiveVisibleRows(filteredDirectives, expanded.directives).map(item => <Link key={item.id} to={`/projects/${item.project.id}?tab=tasks&task=${item.task.id}`} className="executive-directive-row group grid grid-cols-1 items-center gap-4 px-5 py-5 transition hover:bg-slate-50 lg:grid-cols-3">
          <div className="min-w-0 lg:col-span-2"><p className="break-words text-sm font-semibold text-ink">{item.task.title || item.content}</p><div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500"><span>{item.project.name}</span><span>{item.task.owner || '负责人待配置'}</span>{item.task.dueDate && <span className={item.overdue ? 'text-rose-600' : ''}>{item.task.dueDate}{item.overdue ? ' · 已逾期' : ' 截止'}</span>}</div></div>
          <div className="flex items-center gap-4"><div className="min-w-0 flex-1"><div className="mb-2 flex items-center justify-between gap-2"><StatusBadge status={item.task.status} /><span className="text-xs tabular-nums text-slate-500">{item.task.progress}%</span></div><ProgressBar value={item.task.progress} tone={item.overdue ? 'amber' : item.task.status === '已完成' ? 'green' : 'blue'} /></div><ChevronRight className="h-4 w-4 shrink-0 text-slate-400" /></div>
        </Link>)}</div>
      </State>
      {directiveError && <Notice onRetry={reload}>部分督办未能加载，当前列表可能不完整</Notice>}
      <ExecutiveExpand total={filteredDirectives.length} expanded={expanded.directives} onExpand={() => expand('directives')} />
    </Card>
    </ExecutiveScreenSection>

    <ExecutiveScreenSection id="risks" summary="需要您介入的问题" action={<Button variant="secondary" size="sm" onClick={() => navigate('/risks')}>全部风险<ArrowRight className="h-3.5 w-3.5" /></Button>}>
    <Card className="min-w-0 overflow-hidden">
      {filteredToolbar('risks', [{ id: 'all', label: '全部未关闭' }, { id: '高', label: '高风险' }, { id: '中', label: '中风险' }, { id: '低', label: '低风险' }], riskFilter, setRiskFilter, '搜索风险、项目或负责人')}
      <State loading={risks.loading} error={risks.error} hasData={risks.data !== null} empty={risks.data !== null && !filteredRisks.length && '没有符合条件的风险'} onRetry={reload}>
        <div className="divide-y divide-slate-100">{executiveVisibleRows(filteredRisks, expanded.risks).map(risk => <button key={risk.id} onClick={() => setSelectedRisk(risk.id)} className="executive-risk-row group flex w-full items-start gap-4 px-5 py-5 text-left transition hover:bg-slate-50">
          <Badge tone={risk.level === '高' ? 'red' : risk.level === '中' ? 'amber' : 'slate'}>{risk.level}风险</Badge><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium leading-6 text-ink">{risk.description || risk.type}</p><p className="mt-2 text-xs text-slate-500">{risk.projectName} · {risk.owner || '负责人待配置'} · {risk.status}</p></div><ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
        </button>)}</div>
      </State>
      <ExecutiveExpand total={filteredRisks.length} expanded={expanded.risks} onExpand={() => expand('risks')} />
    </Card>
    </ExecutiveScreenSection>

    <ExecutiveScreenSection id="team" summary="负责人 · 当前项目 · 最新反馈">
    <Card className="min-w-0 overflow-hidden">
      {filteredToolbar('team', [{ id: 'department', label: '按部门' }, { id: 'project', label: '按项目' }], teamView, setTeamView, '搜索姓名或项目')}
      <State loading={people.loading || projects.loading || detailLoading} error={people.error || projects.error} hasData={people.data !== null && hasDetails} empty={!detailLoading && !teamError && !visibleGroups.length && '没有符合条件的团队动态'} onRetry={reload}>
        <div className="executive-team-groups">{executiveVisibleRows(visibleGroups, expanded.team).map(group => <div key={`${teamView}:${group.id}`} className="executive-team-group"><h3 className="text-sm font-semibold text-ink">{group.name}<span className="ml-2 text-xs font-normal text-slate-400">{group.members.length} 人</span></h3>
          <div className="executive-team-members">{group.members.map(member => <div key={member.id} className="executive-team-member">
            <button className="flex items-center gap-3 text-left text-sm font-medium text-brand-700 hover:underline" onClick={() => setSelectedPerson(member.id)}><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-50 text-xs text-brand-700" aria-hidden="true">{member.name.slice(0, 1)}</span>{member.name}</button>
            <div className="space-y-1">{(member.owned.length ? member.owned : member.related).slice(0, 2).map(project => <button key={project.id} onClick={() => pickProject(project.id)} className="block text-left text-sm text-slate-600 hover:text-brand-700">{project.name}</button>)}</div>
            <p className="executive-team-summary line-clamp-2 text-sm leading-6 text-slate-500" title={member.summary}>{member.summary === '本周暂无工作更新' && detailLoading ? '正在读取本周工作…' : member.summary}</p>
          </div>)}</div>
        </div>)}</div>
      </State>
      {teamError && <Notice onRetry={reload}>部分项目工作未能加载</Notice>}
      <ExecutiveExpand total={visibleGroups.length} expanded={expanded.team} onExpand={() => expand('team')} />
    </Card>
    </ExecutiveScreenSection>
    <ExecutiveScreenSection id="personal" summary="日历与个人待办">
      <ExecutiveDeferredSection><DashboardPage embedded /></ExecutiveDeferredSection>
    </ExecutiveScreenSection>
    </ExecutiveScreenLayout>

    <Drawer open={showAgenda} title="今日安排" onClose={() => setShowAgenda(false)} footer={<Button variant="secondary" onClick={() => navigate('/collaboration?view=time')}>打开日历</Button>}>
      <State loading={agendaLoading} error={agendaError} hasData={agendaHasData} empty={agendaEmpty} onRetry={reload}>{agendaRows()}</State>
      {!personalAgenda && nodeNotices}
    </Drawer>
    {selectedMeeting && <ExecutiveMeetingPreview key={selectedMeeting} id={selectedMeeting} onClose={() => setSelectedMeeting(null)} />}
    <Drawer open={Boolean(projectRow)} title={projectRow?.project.name ?? '项目概览'} onClose={() => setSelectedProject(null)} footer={projectRow && <><Button variant="secondary" onClick={() => navigate(`/projects/${selectedProject}?tab=tasks`)}>查看任务</Button><Button onClick={() => navigate(`/projects/${selectedProject}`)}>进入项目<ArrowRight className="h-4 w-4" /></Button></>}>
      {projectRow && <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2"><StageBadge stage={projectRow.project.stage} /><Badge tone={projectRow.status.tone}>{projectRow.status.label}</Badge></div>
        <dl className="grid grid-cols-2 gap-4 text-sm"><div><dt className="mb-1 text-xs text-slate-400">项目负责人</dt><dd>{projectRow.project.owner || '待配置'}</dd></div><div><dt className="mb-1 text-xs text-slate-400">目标日期</dt><dd>{projectRow.project.targetDate || '待确认'}</dd></div></dl>
        <div><div className="mb-2 flex items-center justify-between text-xs text-slate-500"><span>项目进度</span><span>{Math.round(projectRow.project.progress)}%</span></div><ProgressBar value={projectRow.project.progress} /></div>
        <div className="border-t border-slate-100 pt-5"><h3 className="mb-3 text-sm font-semibold">本周进展</h3><p className="whitespace-pre-wrap text-sm leading-7 text-slate-600">{projectUpdate(projectRow.project.id)}</p></div>
        <div className="border-t border-slate-100 pt-5"><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">待处理风险</h3><Button variant="ghost" size="sm" onClick={() => navigate(`/projects/${selectedProject}?tab=risks`)}>查看详情</Button></div>
          {risks.error ? <Notice onRetry={reload}>风险暂未加载</Notice> : risks.loading ? <LoadingState rows={1} /> : activeRisks.filter(r => r.projectId === selectedProject).length ? <div className="space-y-4">{activeRisks.filter(r => r.projectId === selectedProject).map(r => <div key={r.id}><Badge tone={r.level === '高' ? 'red' : r.level === '中' ? 'amber' : 'slate'}>{r.level}风险</Badge><p className="mt-2 text-sm leading-6 text-slate-600">{r.description || r.type}</p></div>)}</div> : <p className="text-sm text-slate-400">暂无未关闭风险</p>}
        </div>
        <div className="border-t border-slate-100 pt-5"><h3 className="mb-3 text-sm font-semibold">项目待推进</h3>{projectDetail?.errors.includes('任务') ? <Notice onRetry={reload}>任务暂未加载</Notice> : detailLoading && !projectDetail?.tasks ? <LoadingState rows={2} /> : <div className="divide-y divide-slate-100">{(projectDetail?.tasks ?? []).filter(t => isOpenTask(t.status) && t.executionModel !== 'approval').slice(0, 5).map(t => <Link key={t.id} to={`/projects/${selectedProject}?tab=tasks&task=${t.id}`} className="block py-3"><p className="text-sm font-medium">{t.title}</p><p className="mt-1 text-xs text-slate-500">{t.owner} · {t.dueDate || '日期待确认'} · {t.status}</p></Link>)}{!projectDetail?.tasks?.some(t => isOpenTask(t.status) && t.executionModel !== 'approval') && <p className="text-sm text-slate-400">暂无待推进任务</p>}</div>}</div>
      </div>}
    </Drawer>
    <Drawer open={Boolean(person)} title={person ? `${person.name} · 工作概览` : '工作概览'} onClose={() => setSelectedPerson(null)}>
      {person && <div className="space-y-5"><Badge>{person.department || '项目团队'}</Badge><p className="whitespace-pre-wrap text-sm leading-7 text-slate-600">{person.summary}</p><h3 className="text-sm font-semibold">负责与参与的项目</h3><div className="divide-y divide-slate-100">{person.related.map(project => <button key={project.id} onClick={() => pickProject(project.id)} className="flex w-full items-center justify-between gap-2 py-4 text-left"><span className="text-sm font-medium">{project.name}</span><ChevronRight className="h-4 w-4 text-slate-400" /></button>)}</div><h3 className="text-sm font-semibold">本周任务</h3><div className="divide-y divide-slate-100">{person.tasks.filter(task => task.dueDate && isInExecutiveWeek(task.dueDate, today)).map(task => <Link key={task.id} to={`/projects/${task.project.id}?tab=tasks&task=${task.id}`} className="block space-y-2 py-4"><p className="text-sm font-medium">{task.title}</p><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-slate-500">{task.project.name} · {task.dueDate}</span><StatusBadge status={task.status} /></div></Link>)}</div></div>}
    </Drawer>
    <Drawer open={Boolean(riskDetail)} title="风险详情" onClose={() => setSelectedRisk(null)} footer={riskDetail && <Button variant="secondary" onClick={() => portfolio.some(row => row.project.id === riskDetail.projectId) ? pickProject(riskDetail.projectId) : navigate(`/projects/${riskDetail.projectId}?tab=risks`)}>查看项目概览<ArrowRight className="h-4 w-4" /></Button>}>
      {riskDetail && <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2"><Badge tone={riskDetail.level === '高' ? 'red' : riskDetail.level === '中' ? 'amber' : 'slate'}>{riskDetail.level}风险</Badge><StatusBadge status={riskDetail.status} /></div>
        <p className="whitespace-pre-wrap text-sm leading-7 text-ink">{riskDetail.description || riskDetail.type}</p>
        <dl className="grid grid-cols-2 gap-5 text-sm"><div><dt className="mb-1 text-xs text-slate-400">所属项目</dt><dd>{riskDetail.projectName}</dd></div><div><dt className="mb-1 text-xs text-slate-400">责任人</dt><dd>{riskDetail.owner || '待配置'}</dd></div><div><dt className="mb-1 text-xs text-slate-400">发现时间</dt><dd>{timestamp(riskDetail.occurredAt)}</dd></div></dl>
      </div>}
    </Drawer>
  </div>
}
