import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { formatShanghaiDate } from '../lib/dateTime'
import { workbenchTargetLabel, workbenchTone, type WorkbenchAttention, type WorkbenchData, type WorkbenchTone } from '../../server/src/contracts/fdeWorkbenchContract'
import './DashboardPage.css'

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
function ProjectMatrix({ data }: { data: WorkbenchData }) {
  if (!data.projects.length) return <Empty title="暂无授权重点项目" note="项目明确标记为重点后在此展示，不按 AI 分数代替重点分类" />
  return <div className="table-scroll"><table className="action-matrix"><thead><tr>{['重点项目', '本周关键动作', '推进状态', '领导参与', '项目目标日'].map(text => <th key={text} scope="col">{text}</th>)}</tr></thead><tbody>{data.projects.map(project => <tr key={project.id}>
    <td><Link className="project-cell" to={`/projects/${project.id}`}><span className={`project-logo ${project.priority === 'P0' ? 'gold' : ''}`}>{project.name.slice(0, 1)}</span><div><strong>{project.name}</strong><small>{project.owner} · {project.secretary}</small></div></Link></td>
    <td><div className="micro-action-list">{project.actions.length ? project.actions.map(action => <Link className={`micro-action ${action.status === '已完成' ? 'done' : ''}`} key={action.id} to={action.to}><i />{action.title}</Link>) : <span className="muted">本周暂无授权行动</span>}</div></td>
    <td><Badge tone={workbenchTone(project.health)}>{project.health}</Badge><small className="matrix-progress" title="仅计入当前账号有权访问的本周行动及未完成逾期行动">{project.done} / {project.total} 已完成</small></td>
    <td>{project.leaderParticipation && project.leaderParticipation !== '无需参与' ? <Badge tone={project.leaderParticipation.startsWith('今日') ? 'warning' : 'info'}>{project.leaderParticipation}</Badge> : <span className="muted">{project.leaderParticipation ?? '待核对'}</span>}</td>
    <td><strong>{project.targetDate ? `${Number(project.targetDate.slice(5, 7))}月${Number(project.targetDate.slice(8, 10))}日` : '—'}</strong><small className="matrix-progress" title="由项目目标日按 Asia/Shanghai 动态计算">{workbenchTargetLabel(project.targetDate, data.today)}</small></td>
  </tr>)}</tbody></table></div>
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
  const current = data?.actorId === userId ? data : null
  if (!current) return <div className="fde-dashboard page-wrap role-workbench"><div className="workbench-heading"><div><h1>工作台</h1></div></div><section className="card" aria-busy={!error}>{error ? <div className="workbench-error" role="alert"><strong>工作台暂时无法加载</strong><p>{error}</p><button className="button" onClick={() => setRevision(n => n + 1)}>重新加载</button></div> : <Empty title="正在核对当前角色与工作台数据…" note="统计和待办以服务端当前授权为准" />}</section></div>
  const action = primaryAction(current)
  const projectRows: WorkbenchAttention[] = current.projects.map(p => ({ id: p.id, title: p.name, detail: `${p.done}/${p.total} 本周授权行动已完成`, icon: p.name.slice(0, 1), to: `/projects/${p.id}`, status: p.health }))
  return <div className="fde-dashboard page-wrap role-workbench" data-view={current.view}>
    {current.view === 'admin' ? <div className="page-heading"><div><h1>系统工作台</h1></div><div className="page-actions"><span className="view-chip secure">配置权限视角</span><Link className="button primary" to="/system">进入系统管理</Link></div></div> : <div className="workbench-heading"><div><div className="eyebrow-row"><span className="view-chip">{current.perspective}</span><span>{formatShanghaiDate(`${current.today}T12:00:00+08:00`, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })}</span></div><h1>{roleHeading(current)}</h1></div><div className="page-actions"><span className="update-note">更新于 {formatShanghaiDate(current.asOf, { hour: '2-digit', minute: '2-digit' })}</span>{action.length > 0 && <Link className="button primary" to={action[1]}>{action[0]}</Link>}</div></div>}
    {current.warnings.length > 0 && <div className="workbench-warning" role="alert"><span>{current.warnings.join(' ')}</span><button className="button small" onClick={() => setRevision(n => n + 1)}>重新核对</button></div>}
    <section className="metric-grid compact" aria-label="工作台统计">{current.metrics.map(metric => <Link className="metric-card compact-metric" data-nav={metric.to} key={metric.label} to={metric.to} title={metric.note} aria-label={`${metric.label}：${metric.value ?? '待核对'}。${metric.note}`}><div className="metric-label"><span>{metric.label}</span><span className={`metric-dot ${metric.tone}`} /></div><div className={`metric-value ${metric.value === null ? 'unknown' : ''}`}>{metric.value ?? '—'}</div><div className="metric-note">{metric.note}</div></Link>)}</section>
    <div className={`workspace-grid ${current.view === 'admin' ? 'two' : ''}`}>
      {['leader', 'lead'].includes(current.view) ? <><Panel title="重点项目 × 本周行动" className="table-card" to="/projects"><ProjectMatrix data={current} /></Panel><Panel title={current.view === 'leader' ? '需要我处理' : '待我确认'} count={current.attention.length}><FocusList rows={current.attention} showStatus={false} /></Panel></> :
        current.view === 'coordinator' ? <><Panel title="待处理时间需求" to="/collaboration?view=time" action="进入排期 →"><FocusList rows={current.attention} /></Panel><Panel title="冲突与容量"><div className="capacity-card">{[['总申请', current.capacity ? `${(current.capacity.requested / 60).toFixed(1)}h` : '—'], ['已确认', current.capacity ? `${(current.capacity.confirmed / 60).toFixed(1)}h` : '—'], ['待配置', current.capacity ? `${current.capacity.pending} 项` : '—'], ['机动预留', '—']].map(([label, value]) => <div key={label}><span>{label}</span><strong title={value === '—' ? '待核对：未取得可靠数据' : undefined}>{value}</strong></div>)}</div>{Boolean(current.capacity?.conflicts) && <div className="conflict-note"><strong>{current.capacity!.conflicts} 项需求存在冲突</strong><p>请进入排期核对可用时段与项目目标日。</p></div>}</Panel></> :
        current.view === 'admin' ? <><Panel title="系统与集成状态"><div className="compact-status-grid">{['企业微信同步', '审批消息队列', '文件安全扫描', '审计日志完整率'].map(label => <div key={label}><span>{label}</span><strong title="尚未接入可靠运行统计，不宣称正常">待核对</strong></div>)}</div></Panel><Panel title="权限待办"><FocusList rows={[{ id: 'settings', title: '进入权限与配置管理', detail: '仅展示配置事项，不读取项目商业资料', icon: '权', to: '/system' }]} /></Panel></> :
        current.view === 'specialist' ? <><Panel title={`待处理${current.specialty}事项`} to="/workflow?view=pending"><FocusList rows={current.attention} /></Panel><Panel title="我的项目行动"><ActionList data={current} /></Panel></> :
        current.view === 'unassigned' ? <Panel title="角色待核对"><Empty title="请先绑定业务角色" note="不根据姓名或展示职称推断项目权限" /></Panel> :
          <><Panel title={current.view === 'secretary' ? '今日催办与推进' : '今日待办与催办'} to="/collaboration" action="进入本周工作 →"><ActionList data={current} /></Panel><Panel title="项目状态"><FocusList rows={projectRows} /></Panel></>}
    </div>
    <details className="workbench-notes"><summary>统计口径与更多工作入口</summary><p>“—”表示待核对，不代表 0；指标按当前账号权限汇总，日期采用上海时区。项目表只展示重点分类，行动完成数只计入有权查看的本周及未完成逾期行动。</p><div>{current.metrics.map(metric => <Link key={metric.label} to={metric.to}>{metric.label}：{metric.value ?? '待核对'}</Link>)}</div>{current.view !== 'admin' && current.view !== 'unassigned' && <div><Link to="/workflow?view=pending">完整审批待办</Link><Link to="/responsibility?view=mine">我的职责</Link><Link to="/knowledge">数据与知识</Link><Link to="/risks">风险提醒</Link></div>}<button className="button small" onClick={() => setRevision(n => n + 1)}>刷新工作台</button></details>
  </div>
}
