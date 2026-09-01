import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Check, Eye, Pencil, Plus, Trash2, X } from 'lucide-react'
import { api, apiDelete, apiGet, apiPatch, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { formatShanghaiDate } from '../lib/dateTime'
import { workbenchTone, type WorkbenchAttention, type WorkbenchData, type WorkbenchTone } from '../../server/src/contracts/fdeWorkbenchContract'
import { FdeCalendarPanel } from '../components/FdeCalendarPanel'
import './DashboardPage.css'
import './CollaborationPage.css'

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
function ActionList({ data }: { data: WorkbenchData }) {
  return <div className="action-list">{data.actions.length ? data.actions.map(action => <div className="action-row" key={action.id}><span className={`action-state ${workbenchTone(action.status)}`} /><div className="action-main"><div className="action-title-row"><strong>{action.title}</strong></div><small>{action.projectName} · {action.dueDate ?? '未配置截止日'}</small></div><Badge tone={workbenchTone(action.status)}>{action.status}</Badge><Link className="button small" to={action.to}>查看行动</Link></div>) : <Empty title="当前没有待处理行动" note="新的项目任务会自动出现在这里" />}</div>
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

const terminalTodoStatuses = new Set(['已完成', '已关闭', '已取消', '已归档'])
function shiftDashboardDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
}
function todoDateLabel(date: string, today: string) {
  if (date === today) return '今天'
  if (date === shiftDashboardDate(today, 1)) return '明天'
  return '后天'
}

function PersonalTodoPanel({ data }: { data: WorkbenchData }) {
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
    void apiGet<{ list: PersonalTodo[] }>(`/todos?personal=true&dateFrom=${data.today}&dateTo=${lastDay}`).then(response => {
      if (active) setTodos(response.list)
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : '个人待办加载失败')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [data.actorId, data.today, lastDay])

  const visibleTodos = todos.filter(todo => !todo.projectId
    && todo.ownerUserId === data.actorId
    && !todo.approvalRequestId
    && todo.type !== '流程'
    && !terminalTodoStatuses.has(todo.status)
    && Boolean(todo.dueDate)
    && todo.dueDate === data.today)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || ({ 高: 0, 中: 1, 低: 2 }[a.priority] - { 高: 0, 中: 1, 低: 2 }[b.priority]) || a.id.localeCompare(b.id))

  const createTodo = async () => {
    const title = draft.title.trim()
    if (!title || busy) return
    setBusy('create'); setError('')
    try {
      const created = await apiPost<PersonalTodo>('/todos', {
        projectId: null,
        projectName: '个人待办',
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
        dueDate: data.today,
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

  const todayProjectActions = data.actions.filter(action => action.dueDate === data.today)
  return <section className="card personal-todo-card work-todo-card">
    <div className="card-head"><div><h2>工作待办</h2></div><Badge tone={visibleTodos.length + todayProjectActions.length ? 'info' : 'neutral'}>{visibleTodos.length + todayProjectActions.length} 项</Badge></div>
    <form className="personal-todo-create" onSubmit={event => { event.preventDefault(); void createTodo() }}>
      <label className="todo-title-field"><span className="sr-only">待办内容</span><input className="input" maxLength={255} placeholder="输入待办内容" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      <span className="todo-today-label">今天</span>
      <label><span className="sr-only">优先级</span><select className="input" value={draft.priority} onChange={event => setDraft({ ...draft, priority: event.target.value as PersonalTodo['priority'] })}><option value="高">高优先级</option><option value="中">中优先级</option><option value="低">低优先级</option></select></label>
      <button className="button primary" type="submit" disabled={!draft.title.trim() || Boolean(busy)}><Plus size={16} />新增任务</button>
    </form>
    {error && <div className="personal-todo-error" role="alert">{error}</div>}
    <div className="personal-todo-list" aria-busy={loading}>
      {todayProjectActions.map(action => <div className="personal-todo-row project-work-todo" key={`project-${action.id}`}>
        <Link className="todo-complete-button" aria-label={`完成项目任务：${action.title}`} title="进入任务完成流程" to={`${action.to}&action=submission`}><Check size={15} /></Link>
        <div className="personal-todo-main"><strong>{action.title}</strong><small>{action.projectName} · 今日任务</small></div>
        <Link className="button small" to={action.to}>查看任务</Link>
      </div>)}
      {visibleTodos.map(todo => editing?.id === todo.id ? <form className="personal-todo-row editing" key={todo.id} onSubmit={event => { event.preventDefault(); void saveTodo() }}>
        <input className="input todo-edit-title" aria-label="待办内容" maxLength={255} value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} autoFocus />
        <select className="input" aria-label="优先级" value={editing.priority} onChange={event => setEditing({ ...editing, priority: event.target.value as PersonalTodo['priority'] })}><option value="高">高</option><option value="中">中</option><option value="低">低</option></select>
        <div className="todo-row-actions"><button className="todo-icon-button confirm" type="submit" aria-label="保存待办" title="保存" disabled={busy === todo.id || !editing.title.trim()}><Check size={16} /></button><button className="todo-icon-button" type="button" aria-label="取消编辑" title="取消" disabled={busy === todo.id} onClick={() => setEditing(null)}><X size={16} /></button></div>
      </form> : <div className="personal-todo-row" key={todo.id}>
        <button className="todo-complete-button" type="button" aria-label={`完成待办：${todo.title}`} title="标记完成" disabled={busy === todo.id} onClick={() => void completeTodo(todo)}><Check size={15} /></button>
        <div className="personal-todo-main"><strong>{todo.title}</strong><small>{todoDateLabel(todo.dueDate!, data.today)} · {todo.priority}优先级</small></div>
        <div className="todo-row-actions"><button className="todo-icon-button" type="button" aria-label={`编辑待办：${todo.title}`} title="编辑" disabled={Boolean(busy)} onClick={() => setEditing({ id: todo.id, title: todo.title, priority: todo.priority })}><Pencil size={15} /></button><button className="todo-icon-button danger" type="button" aria-label={`删除待办：${todo.title}`} title="删除" disabled={Boolean(busy)} onClick={() => void removeTodo(todo)}><Trash2 size={15} /></button></div>
      </div>)}
      {!loading && !visibleTodos.length && !todayProjectActions.length && <Empty title="今天没有待办" note="" />}
      {loading && <Empty title="正在加载个人待办…" note="" />}
    </div>
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
    member: ['查看我的行动', '/collaboration'], coordinator: ['处理时间冲突', '/collaboration?view=time'],
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
  if (!current) return <div className="fde-dashboard page-wrap role-workbench"><div className="workbench-heading"><div><h1>工作台</h1></div></div><section className="card" aria-busy={!error}>{error ? <div className="workbench-error" role="alert"><strong>工作台暂时无法加载</strong><p>{error}</p><button className="button" onClick={() => setRevision(n => n + 1)}>重新加载</button></div> : <Empty title="正在核对当前角色与工作台数据…" note="统计和待办以服务端当前授权为准" />}</section></div>
  const action = primaryAction(current)
  const projectRows: WorkbenchAttention[] = current.projects.map(p => ({ id: p.id, title: p.name, detail: `${p.total} 项三日内任务待完成`, icon: p.name.slice(0, 1), to: `/projects/${p.id}`, status: p.health }))
  return <div className="fde-dashboard page-wrap role-workbench" data-view={current.view}>
    {current.view === 'admin' ? <div className="page-heading"><div><h1>系统工作台</h1></div><div className="page-actions"><span className="view-chip secure">配置权限视角</span><Link className="button primary" to="/system">进入系统管理</Link></div></div> : <div className="workbench-heading"><div><div className="eyebrow-row"><span className="view-chip">{current.perspective}</span><span>{formatShanghaiDate(`${current.today}T12:00:00+08:00`, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })}</span></div><h1>{roleHeading(current)}</h1></div><div className="page-actions"><span className="update-note">更新于 {formatShanghaiDate(current.asOf, { hour: '2-digit', minute: '2-digit' })}</span>{action.length > 0 && <Link className="button primary" to={action[1]}>{action[0]}</Link>}</div></div>}
    {current.warnings.length > 0 && <div className="workbench-warning" role="alert"><span>{current.warnings.join(' ')}</span><button className="button small" onClick={() => setRevision(n => n + 1)}>重新核对</button></div>}
    <section className="metric-grid compact" aria-label="工作台统计">{current.metrics.map(metric => <Link className="metric-card compact-metric" data-nav={metric.to} key={metric.label} to={metric.to} title={metric.note} aria-label={`${metric.label}：${metric.value ?? '待核对'}。${metric.note}`}><div className="metric-label"><span>{metric.label}</span><span className={`metric-dot ${metric.tone}`} /></div><div className={`metric-value ${metric.value === null ? 'unknown' : ''}`}>{metric.value ?? '—'}</div><div className="metric-note">{metric.note}</div></Link>)}</section>
    {current.view !== 'admin' && current.view !== 'unassigned' && (calendarHidden
      ? <button type="button" className="dashboard-calendar-reveal" onClick={showCalendar}><Eye size={16}/><span>显示任务时间轴</span></button>
      : <section className="dashboard-calendar-shell fde-collaboration-page" aria-label="任务时间轴"><FdeCalendarPanel compact allowLeader={false} onHide={hideCalendar}/></section>)}
    <div className={`workspace-grid ${current.view === 'admin' ? 'two' : ''}`}>
      {current.view === 'admin' ? <><Panel title="系统与集成状态"><div className="compact-status-grid">{['企业微信同步', '审批消息队列', '文件安全扫描', '审计日志完整率'].map(label => <div key={label}><span>{label}</span><strong title="尚未接入可靠运行统计，不宣称正常">待核对</strong></div>)}</div></Panel><Panel title="权限待办"><FocusList rows={[{ id: 'settings', title: '进入权限与配置管理', detail: '仅展示配置事项，不读取项目商业资料', icon: '权', to: '/system' }]} /></Panel></> :
        current.view === 'unassigned' ? <Panel title="角色待核对"><Empty title="请先绑定业务角色" note="" /></Panel> : <>
          <PersonalTodoPanel data={current} />
          <Panel title="最近三天任务" to="/collaboration" action="进入任务中心 →"><ActionList data={current} /></Panel>
          <Panel title="项目状态" to="/projects"><FocusList rows={projectRows} /></Panel>
        </>}
    </div>
    <details className="workbench-notes"><summary>更多工作入口</summary><div>{current.metrics.map(metric => <Link key={metric.label} to={metric.to}>{metric.label}：{metric.value ?? '待核对'}</Link>)}</div>{current.view !== 'admin' && current.view !== 'unassigned' && <div><Link to="/workflow?view=pending">完整审批待办</Link><Link to="/responsibility?view=mine">我的职责</Link><Link to="/knowledge">数据与知识</Link><Link to="/risks">风险提醒</Link></div>}<button className="button small" onClick={() => setRevision(n => n + 1)}>刷新工作台</button></details>
  </div>
}
