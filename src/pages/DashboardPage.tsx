import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Check, Eye, NotebookPen, Pencil, Plus, Trash2, X } from 'lucide-react'
import { api, apiDelete, apiGet, apiPatch, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { formatShanghaiDate } from '../lib/dateTime'
import { workbenchTone, type WorkbenchAttention, type WorkbenchData, type WorkbenchTone } from '../../server/src/contracts/fdeWorkbenchContract'
import { FdeCalendarPanel } from '../components/FdeCalendarPanel'
import './DashboardPage.css'
import './CollaborationPage.css'
import { TaskDrawer } from '../components/task/TaskSystem'

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: WorkbenchTone }) {
  return <span className={`badge ${tone}`}>{children}</span>
}
function Empty({ title = '当前没有待处理事项', note = '新的授权事项会自动出现在这里' }: { title?: string; note?: string }) {
  return <div className="state-inline"><strong>{title}</strong><small>{note}</small></div>
}
function Panel({ title, children, to, action = '查看全部 →', count, className = '' }: { title: string; children: ReactNode; to?: string; action?: string; count?: number; className?: string }) {
  return <section className={`card ${className}`}><div className="card-head"><div><h2>{title}</h2></div>{to ? <Link className="button link" to={to}>{action}</Link> : count !== undefined ? <Badge tone={count ? 'warning' : 'neutral'}>{count} 项</Badge> : null}</div>{children}</section>
}
function FocusList({ rows, showStatus = true }: { rows: WorkbenchAttention[]; showStatus?: boolean }) {
  return <div className="focus-list">{rows.length ? rows.map(row => <Link className="focus-row" to={row.to} key={row.id}><span className="focus-icon">{row.icon}</span><div><strong>{row.title}</strong><small>{row.detail}</small></div>{showStatus && row.status ? <Badge tone={workbenchTone(row.status)}>{row.status}</Badge> : <span aria-hidden="true">→</span>}</Link>) : <Empty />}</div>
}
function ActionList({ rows, today, onOpen }: { rows: WorkbenchData['actions']; today: string; onOpen: (id: string) => void }) {
  return <div className="action-list">{rows.length ? rows.map(action => <button type="button" className="action-row future-task-row" key={action.id} onClick={() => onOpen(action.id)}><span className={`action-state ${workbenchTone(action.status)}`} /><div className="action-main"><div className="action-title-row"><strong>{action.title}</strong></div><small>{action.projectName}</small></div><time>{todoDateLabel(action.dueDate!, today)} · {action.dueDate}</time><Badge tone={workbenchTone(action.status)}>{action.status}</Badge></button>) : <Empty title="未来三天没有任务" note="" />}</div>
}
type PersonalTodo = {
  id: string
  title: string
  projectId: string | null
  projectName: string | null
  owner: string
  ownerUserId: string | null
  dueDate: string | null
  priority: '高' | '中' | '低'
  status: string
  type: string
  approvalRequestId: string | null
  version: number
}

const hiddenTodoStatuses = new Set(['已关闭', '已取消', '已归档'])
function shiftDashboardDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
}
function todoDateLabel(date: string, today: string) {
  if (date === today) return '今天'
  if (date < today) {
    const days = Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000))
    return days === 1 ? '昨日' : `逾期 ${days} 天`
  }
  if (date === shiftDashboardDate(today, 1)) return '明天'
  if (date === shiftDashboardDate(today, 2)) return '后天'
  return '三天后'
}

function PersonalTodoPanel({ data, onOpenTask }: { data: WorkbenchData; onOpenTask: (id: string) => void }) {
  const previousDay = shiftDashboardDate(data.today, -1)
  const lastDay = shiftDashboardDate(data.today, 2)
  const [todos, setTodos] = useState<PersonalTodo[]>([])
  const [draft, setDraft] = useState({ title: '', priority: '中' as PersonalTodo['priority'] })
  const [editing, setEditing] = useState<{ id: string; title: string; priority: PersonalTodo['priority'] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    void Promise.all([
      apiGet<{ list: PersonalTodo[] }>(`/todos?personal=true&dateTo=${lastDay}`),
      apiGet<{ list: PersonalTodo[] }>(`/todos?personal=true&includeCompleted=true&dateFrom=${previousDay}&dateTo=${data.today}`),
    ]).then(([open, recent]) => {
      if (active) setTodos([...new Map([...open.list, ...recent.list].map(todo => [todo.id, todo])).values()])
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : '个人事项加载失败')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [data.actorId, data.today, lastDay, previousDay])

  const personalTodos = todos.filter(todo => !todo.projectId
    && todo.ownerUserId === data.actorId
    && !todo.approvalRequestId
    && todo.type !== '流程'
    && !hiddenTodoStatuses.has(todo.status)
    && Boolean(todo.dueDate))
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || ({ 高: 0, 中: 1, 低: 2 }[a.priority] - { 高: 0, 中: 1, 低: 2 }[b.priority]) || a.id.localeCompare(b.id))
  const todayTodos = personalTodos.filter(todo => todo.dueDate === data.today)
  const historicalTodos = personalTodos.filter(todo => todo.dueDate! < data.today)

  const createTodo = async () => {
    const title = draft.title.trim()
    if (!title || busy) return
    setBusy('create'); setError('')
    try {
      const created = await apiPost<PersonalTodo>('/todos', {
        projectId: null,
        projectName: '个人事项',
        title,
        owner: data.name,
        ownerUserId: data.actorId,
        dueDate: data.today,
        priority: draft.priority,
        type: '待办',
        status: '未开始',
      })
      setTodos(current => [created, ...current.filter(todo => todo.id !== created.id)])
      setDraft(current => ({ ...current, title: '' }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新增待办失败')
    } finally { setBusy('') }
  }

  const saveTodo = async () => {
    if (!editing || !editing.title.trim() || busy) return
    const current = todos.find(todo => todo.id === editing.id)
    if (!current) return
    setBusy(editing.id); setError('')
    try {
      const updated = await apiPatch<PersonalTodo>(`/todos/${editing.id}`, {
        expectedVersion: current.version,
        title: editing.title.trim(),
        dueDate: current.dueDate,
        priority: editing.priority,
      })
      setTodos(rows => rows.map(todo => todo.id === updated.id ? updated : todo))
      setEditing(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存待办失败')
    } finally { setBusy('') }
  }

  const completeTodo = async (todo: PersonalTodo) => {
    if (busy) return
    setBusy(todo.id); setError('')
    try {
      const updated = await apiPatch<PersonalTodo>(`/todos/${todo.id}`, { expectedVersion: todo.version, status: '已完成' })
      setTodos(rows => rows.map(row => row.id === updated.id ? updated : row))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '完成待办失败')
    } finally { setBusy('') }
  }

  const removeTodo = async (todo: PersonalTodo) => {
    if (busy || !window.confirm(`确定删除待办“${todo.title}”吗？`)) return
    setBusy(todo.id); setError('')
    try {
      await apiDelete(`/todos/${todo.id}`)
      setTodos(rows => rows.filter(row => row.id !== todo.id))
      if (editing?.id === todo.id) setEditing(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除待办失败')
    } finally { setBusy('') }
  }

  const renderTodo = (todo: PersonalTodo, historical = false) => {
    const completed = todo.status === '已完成'
    if (!completed && editing?.id === todo.id) return <form className={`personal-todo-row editing${historical ? ' is-historical' : ''}`} key={todo.id} onSubmit={event => { event.preventDefault(); void saveTodo() }}>
      <input className="input todo-edit-title" aria-label="待办内容" maxLength={255} value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} autoFocus />
      <select className="input" aria-label="优先级" value={editing.priority} onChange={event => setEditing({ ...editing, priority: event.target.value as PersonalTodo['priority'] })}><option value="高">高</option><option value="中">中</option><option value="低">低</option></select>
      <div className="todo-row-actions"><button className="todo-icon-button confirm" type="submit" aria-label="保存待办" title="保存" disabled={busy === todo.id || !editing.title.trim()}><Check size={16} /></button><button className="todo-icon-button" type="button" aria-label="取消编辑" title="取消" disabled={busy === todo.id} onClick={() => setEditing(null)}><X size={16} /></button></div>
    </form>
    return <div className={`personal-todo-row${historical ? ' is-historical' : ''}${completed ? ' is-completed' : ''}`} key={todo.id}>
      {completed ? <span className="todo-completed-mark" aria-label="已完成"><Check size={15} /></span> : <button className="todo-complete-button" type="button" aria-label={`完成待办：${todo.title}`} title="标记完成" disabled={busy === todo.id} onClick={() => void completeTodo(todo)}><Check size={15} /></button>}
      <div className="personal-todo-main"><strong>{todo.title}</strong><small>{completed ? '已完成' : todoDateLabel(todo.dueDate!, data.today)} · {todo.priority}优先级</small></div>
      <div className="todo-row-actions">{!completed && <button className="todo-icon-button" type="button" aria-label={`编辑待办：${todo.title}`} title="编辑" disabled={Boolean(busy)} onClick={() => setEditing({ id: todo.id, title: todo.title, priority: todo.priority })}><Pencil size={15} /></button>}<button className="todo-icon-button danger" type="button" aria-label={`删除待办：${todo.title}`} title="删除" disabled={Boolean(busy)} onClick={() => void removeTodo(todo)}><Trash2 size={15} /></button></div>
    </div>
  }

  const todayProjectActions = data.actions.filter(action => action.dueDate === data.today)
  const historicalProjectActions = data.actions.filter(action => Boolean(action.dueDate) && action.dueDate! < data.today)
  const openPersonalCount = personalTodos.filter(todo => todo.status !== '已完成' && todo.dueDate! <= data.today).length
  const pendingCount = openPersonalCount + todayProjectActions.length + historicalProjectActions.length
  return <section className="card personal-todo-card work-todo-card">
    <div className="card-head"><div><h2>今日待办</h2></div><Badge tone={pendingCount ? 'info' : 'neutral'}>{pendingCount} 项</Badge></div>
    <form className="personal-todo-create" onSubmit={event => { event.preventDefault(); void createTodo() }}>
      <label className="todo-title-field"><span className="sr-only">待办内容</span><input className="input" maxLength={255} placeholder="输入待办内容" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      <span className="todo-today-label">今天</span>
      <label><span className="sr-only">优先级</span><select className="input" value={draft.priority} onChange={event => setDraft({ ...draft, priority: event.target.value as PersonalTodo['priority'] })}><option value="高">高优先级</option><option value="中">中优先级</option><option value="低">低优先级</option></select></label>
      <button className="button primary" type="submit" disabled={!draft.title.trim() || Boolean(busy)}><Plus size={16} />新增事项</button>
    </form>
    {error && <div className="personal-todo-error" role="alert">{error}</div>}
    <div className="personal-todo-list" aria-busy={loading}>
      {todayProjectActions.map(action => <div className="personal-todo-row project-work-todo" key={`project-${action.id}`}>
        <span className={`todo-project-state ${workbenchTone(action.status)}`} aria-hidden="true" />
        <div className="personal-todo-main"><strong>{action.title}</strong><small>{action.projectName} · 今日任务</small></div>
        <button className="button primary small" type="button" onClick={() => onOpenTask(action.id)}>处理任务</button>
      </div>)}
      {todayTodos.map(todo => renderTodo(todo))}
      {!loading && !todayTodos.length && !todayProjectActions.length && <Empty title="今天没有待办" note="" />}
      {loading && <Empty title="正在加载个人事项…" note="" />}
    </div>
    {!loading && (historicalProjectActions.length > 0 || historicalTodos.length > 0) && <div className="todo-history-section">
      <div className="todo-history-head"><strong>历史待办</strong><span>{historicalProjectActions.length + historicalTodos.filter(todo => todo.status !== '已完成').length} 项未完成</span></div>
      <div className="personal-todo-list">
        {historicalProjectActions.map(action => <div className="personal-todo-row project-work-todo is-historical" key={`project-${action.id}`}>
          <span className={`todo-project-state ${workbenchTone(action.status)}`} aria-hidden="true" />
          <div className="personal-todo-main"><strong>{action.title}</strong><small>{action.projectName} · {todoDateLabel(action.dueDate!, data.today)}</small></div>
          <button className="button primary small" type="button" onClick={() => onOpenTask(action.id)}>处理任务</button>
        </div>)}
        {historicalTodos.map(todo => renderTodo(todo, true))}
      </div>
    </div>}
  </section>
}
function roleHeading(data: WorkbenchData) {
  const headings = {
    leader: `${data.name}，今天先处理需要您出场与反馈的事项`, lead: `${data.name}，先确认本周计划与关键偏差`,
    secretary: `${data.name}，今天的推进动作需要跟进`, member: `${data.name}，先确认今天的行动与反馈`,
    coordinator: `${data.name}，领导时间需求已集中展示`, specialist: `${data.name}，${data.specialty}审核与项目交付已集中展示`,
    admin: '系统工作台', unassigned: `${data.name}，欢迎回来`,
  }
  return headings[data.view]
}
function primaryAction(data: WorkbenchData) {
  const actions = {
    leader: ['配置下周时间', `/collaboration?view=time&week=${new Date(Date.parse(`${data.weekStart}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10)}`],
    lead: ['确认周计划', '/collaboration?view=weekly'], secretary: ['维护周计划', '/collaboration?view=weekly'],
    member: ['查看我的任务', '/collaboration'], coordinator: ['处理时间冲突', '/collaboration?view=time'],
    specialist: ['处理职责审批', '/workflow?view=pending'], admin: ['进入系统管理', '/system'], unassigned: [],
  }
  return actions[data.view]
}

export function DashboardPage() {
  const userId = useAuthStore(state => state.user?.id)
  const calendarKey = `fde-dashboard-calendar-hidden:${userId ?? 'anonymous'}`
  const [calendarHidden, setCalendarHidden] = useState(() => { try { return localStorage.getItem(calendarKey) === '1' } catch { return false } })
  const [data, setData] = useState<WorkbenchData | null>(null), [error, setError] = useState('')
  const [revision, setRevision] = useState(0), generation = useRef(0)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  useEffect(() => {
    let controller: AbortController | undefined
    const refresh = async () => {
      const token = ++generation.current
      controller?.abort(); controller = new AbortController()
      setData(null); setError('')
      if (!userId) return
      const options = { cache: 'no-store' as const, signal: controller.signal }
      try {
        const before = await api<{ user: { id: string } }>('/auth/me', options)
        if (before.user.id !== userId) throw new Error('登录身份已变化，请刷新页面重新登录')
        const value = await api<WorkbenchData>('/workbench', options)
        const after = await api<{ user: { id: string } }>('/auth/me', options)
        if (after.user.id !== userId || value.actorId !== userId) throw new Error('登录身份已变化，请刷新页面重新登录')
        if (token === generation.current) setData(value)
      } catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : '工作台加载失败，请重试') }
    }
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    void refresh()
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', visible)
    return () => { ++generation.current; controller?.abort(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible) }
  }, [userId, revision])
  useEffect(() => { try { setCalendarHidden(localStorage.getItem(calendarKey) === '1') } catch { setCalendarHidden(false) } }, [calendarKey])
  const hideCalendar = () => { setCalendarHidden(true); try { localStorage.setItem(calendarKey, '1') } catch { /* visibility remains valid for this page */ } }
  const showCalendar = () => { setCalendarHidden(false); try { localStorage.removeItem(calendarKey) } catch { /* visibility remains valid for this page */ } }
  const current = data?.actorId === userId ? data : null
  if (!current) return <div className="fde-dashboard page-wrap role-workbench"><div className="workbench-heading"><div><h1>工作台</h1></div></div><section className="card" aria-busy={!error}>{error ? <div className="workbench-error" role="alert"><strong>工作台暂时无法加载</strong><p>{error}</p><button className="button" onClick={() => setRevision(n => n + 1)}>重新加载</button></div> : <Empty title="正在加载工作台…" note="" />}</section></div>
  const action = primaryAction(current)
  const futureActions = current.actions.filter(item => Boolean(item.dueDate) && item.dueDate! > current.today)
  const riskLimit = shiftDashboardDate(current.today, 7)
  const recentlyChangedSince = shiftDashboardDate(current.today, -2)
  const projectRows: WorkbenchAttention[] = current.projects.filter(project => project.classification === 'key' && (
    !['正常', '待评估'].includes(project.health)
    || Boolean(project.targetDate && project.targetDate <= riskLimit)
    || project.actions.some(item => Boolean(item.dueDate) && item.dueDate! <= shiftDashboardDate(current.today, 3))
    || project.stageSource === 'OA审批' && project.updatedAt.slice(0, 10) >= recentlyChangedSince
  )).map(project => {
    const overdue = Boolean(project.targetDate && project.targetDate < current.today)
    const near = Boolean(project.targetDate && project.targetDate >= current.today && project.targetDate <= riskLimit)
    const changed = project.stageSource === 'OA审批' && project.updatedAt.slice(0, 10) >= recentlyChangedSince
    const detail = overdue ? `目标日已逾期 · ${project.stage}` : near ? `目标日临近 · ${project.targetDate}` : changed ? `阶段已更新为 ${project.stage}` : `${project.total} 项任务需要关注`
    return { id: project.id, title: project.name, detail, icon: project.name.slice(0, 1), to: `/projects/${project.id}`, status: overdue ? '已逾期' : project.health }
  })
  return <div className="fde-dashboard page-wrap role-workbench" data-view={current.view}>
    {current.view === 'admin' ? <div className="page-heading"><div><h1>系统工作台</h1></div><div className="page-actions"><Link className="button dashboard-note-shortcut" to="/knowledge?view=notes" title="进入个人笔记"><NotebookPen size={16}/><span>个人笔记</span></Link><span className="view-chip secure">配置权限视角</span><Link className="button primary" to="/system">进入系统管理</Link></div></div> : <div className="workbench-heading"><div><div className="eyebrow-row"><span className="view-chip">{current.perspective}</span><span>{formatShanghaiDate(`${current.today}T12:00:00+08:00`, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })}</span></div><h1>{roleHeading(current)}</h1></div><div className="page-actions"><Link className="button dashboard-note-shortcut" to="/knowledge?view=notes" title="进入个人笔记"><NotebookPen size={16}/><span>个人笔记</span></Link><span className="update-note">更新于 {formatShanghaiDate(current.asOf, { hour: '2-digit', minute: '2-digit' })}</span>{action.length > 0 && <Link className="button primary" to={action[1]}>{action[0]}</Link>}</div></div>}
    {current.warnings.length > 0 && <div className="workbench-warning" role="alert"><span>{current.warnings.join(' ')}</span><button className="button small" onClick={() => setRevision(n => n + 1)}>重新核对</button></div>}
    {current.view !== 'admin' && current.view !== 'unassigned' && (calendarHidden
      ? <button type="button" className="dashboard-calendar-reveal" onClick={showCalendar}><Eye size={16}/><span>显示任务时间轴</span></button>
      : <section className="dashboard-calendar-shell fde-collaboration-page" aria-label="任务时间轴"><FdeCalendarPanel compact allowLeader={false} onHide={hideCalendar}/></section>)}
    <div className={`workspace-grid ${current.view === 'admin' ? 'two' : 'workbench-four-regions'}`}>
      {current.view === 'admin' ? <Panel title="系统管理"><FocusList rows={[{ id: 'settings', title: '组织、权限与系统配置', detail: '进入管理员后台', icon: '管', to: '/system' }]} /></Panel> :
        current.view === 'unassigned' ? <Panel title="角色待核对"><Empty title="请先绑定业务角色" note="" /></Panel> : <>
          <PersonalTodoPanel data={current} onOpenTask={setSelectedTaskId} />
          <Panel title="未来三天" to="/collaboration" action="查看我的任务 →"><ActionList rows={futureActions} today={current.today} onOpen={setSelectedTaskId} /></Panel>
          <Panel title="重点项目风险" to="/projects?view=key"><FocusList rows={projectRows} /></Panel>
        </>}
    </div>
    <TaskDrawer taskId={selectedTaskId} open={Boolean(selectedTaskId)} onClose={() => setSelectedTaskId(null)} onAction={(action, task) => { if (!task.project) return; if (action === 'not_started') { void apiPost(`/projects/${task.project.id}/fde-tasks/${task.id}/start`, { expectedVersion: task.version }).then(() => { setSelectedTaskId(null); setRevision(value => value + 1) }); return } setSelectedTaskId(null); const route = action === 'in_progress' || action === 'returned' ? 'submission' : action === 'pending_acceptance' ? 'accept' : action === 'feedback' ? 'progress' : action === 'extension' || action === 'cancel' ? action : ''; window.location.assign(`/projects/${task.project.id}?tab=tasks&task=${task.id}${route ? `&action=${route}` : ''}`) }} />
    <details className="workbench-notes"><summary>更多工作入口</summary>{current.view !== 'admin' && current.view !== 'unassigned' && <div><Link to="/workflow?view=pending">审批待办</Link><Link to="/responsibility?view=mine">我的职责</Link><Link to="/knowledge">知识库</Link><Link to="/risks">风险提醒</Link></div>}<button className="button small" onClick={() => setRevision(n => n + 1)}>刷新工作台</button></details>
  </div>
}
