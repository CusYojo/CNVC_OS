import { AlertCircle, CalendarDays, CheckCircle2, ChevronDown, CircleHelp, Clock3, FileText, FolderKanban, History, MessageSquareText, MoreHorizontal, Users } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { apiGet } from '../../lib/api'
import {
  TASK_SOURCE_LABELS, TASK_STATUS_LABELS, normalizeTaskStatus, taskPrimaryAction,
  type UnifiedTask, type UnifiedTaskPrimaryAction, type UnifiedTaskSource, type UnifiedTaskStatus,
} from '../../../server/src/contracts/unifiedTaskContract'
import { Button, Drawer } from '../ui'
import './task-system.css'

export type TaskPreview = {
  id: string; title: string; projectId?: string | null; projectName?: string | null
  owner: string; ownerUserId?: string | null; participants?: Array<{ id: string; name: string; role?: string | null }>
  dueDate?: string | null; dueTime?: string | null; status: string; progress?: number
  deliverable?: string | null; source?: UnifiedTaskSource; directiveId?: string | null
  planActionId?: string | null; timelineSource?: { stage?: string } | null; executionModel?: string
  capabilities?: { canFeedback?: boolean; canAccept?: boolean; canExtend?: boolean; canCancel?: boolean }
}

function sourceOf(task: TaskPreview): UnifiedTaskSource {
  if (task.source) return task.source
  if (task.executionModel === 'approval') return 'approval'
  if (task.directiveId) return 'directive'
  if (task.timelineSource) return 'workflow'
  if (task.planActionId) return 'plan'
  if (!task.projectId) return 'personal'
  return 'project'
}

const statusTone: Record<UnifiedTaskStatus, string> = {
  not_started: 'neutral', in_progress: 'active', pending_acceptance: 'pending', returned: 'danger', completed: 'success', cancelled: 'neutral',
}

export function StatusBadge({ status, label }: { status: UnifiedTaskStatus | string; label?: string }) {
  const normalized = status in TASK_STATUS_LABELS ? status as UnifiedTaskStatus : normalizeTaskStatus(status)
  return <span className="task-status-badge" data-tone={statusTone[normalized]}>{label ?? TASK_STATUS_LABELS[normalized]}</span>
}

export function TaskSourceBadge({ source }: { source: UnifiedTaskSource }) {
  return <span className="task-source-badge">{TASK_SOURCE_LABELS[source]}</span>
}

export function PrimaryAction({ action, label, disabled, loading, onClick }: { action: UnifiedTaskPrimaryAction; label?: string; disabled?: boolean; loading?: boolean; onClick: () => void }) {
  const resolved = label ?? (action === 'approval' ? '处理审批' : taskPrimaryAction(action).label)
  return <Button className="task-primary-action" disabled={disabled} loading={loading} onClick={onClick}>{resolved}</Button>
}

export type TaskMoreAction = { key: string; label: string; danger?: boolean; disabled?: boolean }
export function MoreActions({ actions, onAction }: { actions: TaskMoreAction[]; onAction: (action: string) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  if (!actions.length) return null
  return <div className="task-more" ref={root}>
    <button type="button" className="task-more-button" aria-label="更多操作" aria-expanded={open} onClick={(event) => { event.stopPropagation(); setOpen(value => !value) }}><MoreHorizontal /></button>
    {open && <div className="task-more-menu" role="menu">{actions.map(action => <button type="button" role="menuitem" key={action.key} disabled={action.disabled} data-danger={action.danger || undefined} onClick={(event) => { event.stopPropagation(); setOpen(false); onAction(action.key) }}>{action.label}</button>)}</div>}
  </div>
}

export function TaskCard({ task, onOpen, onPrimaryAction, onMoreAction, busy, compact = false, hideProject = false }: {
  task: TaskPreview; onOpen: () => void; onPrimaryAction: (action: UnifiedTaskPrimaryAction) => void
  onMoreAction: (action: string) => void; busy?: boolean; compact?: boolean; hideProject?: boolean
}) {
  const status = normalizeTaskStatus(task.status), source = sourceOf(task)
  const primary = taskPrimaryAction(status, source === 'approval')
  const capabilities = task.capabilities ?? {}
  const enabled = primary.key === 'not_started' ? capabilities.canFeedback
    : primary.key === 'in_progress' || primary.key === 'returned' ? capabilities.canFeedback
      : primary.key === 'pending_acceptance' ? capabilities.canAccept : true
  const more: TaskMoreAction[] = [
    ...(capabilities.canFeedback && status !== 'not_started' && status !== 'pending_acceptance' ? [{ key: 'feedback', label: '更新进度' }] : []),
    ...(capabilities.canExtend ? [{ key: 'extension', label: '申请延期' }] : []),
    ...(task.projectId ? [{ key: 'project', label: '打开项目' }] : []),
    ...(capabilities.canCancel ? [{ key: 'cancel', label: '取消任务', danger: true }] : []),
  ]
  return <article id={`fde-task-${task.id}`} className={`task-card${compact ? ' compact' : ''}`} onClick={onOpen} tabIndex={0} onKeyDown={event => { if (event.key === 'Enter') onOpen() }}>
    <div className="task-card-main">
      <div className="task-card-badges"><StatusBadge status={status} /><TaskSourceBadge source={source} /></div>
      <h3>{task.title}</h3>
      <div className="task-card-meta">
        {task.projectName && !hideProject && <span><FolderKanban />{task.projectName}</span>}
        <span><Users />{task.owner || '待绑定'}</span>
        <span><CalendarDays />{task.dueDate ? `${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ''}` : '未设置期限'}</span>
      </div>
      {task.deliverable && !compact && <p className="task-card-deliverable"><FileText />{task.deliverable}</p>}
    </div>
    <div className="task-card-actions" onClick={event => event.stopPropagation()}>
      <PrimaryAction action={primary.key} label={primary.label} disabled={!enabled || busy} loading={busy} onClick={() => enabled ? onPrimaryAction(primary.key) : onOpen()} />
      <MoreActions actions={more} onAction={onMoreAction} />
    </div>
  </article>
}

export function EmptyState({ title = '暂无任务', description = '新任务会在这里统一展示。', action }: { title?: string; description?: string; action?: ReactNode }) {
  return <div className="task-state"><CheckCircle2 /><strong>{title}</strong><span>{description}</span>{action}</div>
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="task-state task-error" role="alert"><AlertCircle /><strong>任务暂时无法显示</strong><span>{message}</span>{onRetry && <Button variant="secondary" onClick={onRetry}>重新加载</Button>}</div>
}

export function HelpPopover({ children }: { children: ReactNode }) {
  return <details className="task-help"><summary aria-label="查看帮助"><CircleHelp /></summary><div>{children}</div></details>
}

export function AuditDetails({ task }: { task: UnifiedTask }) {
  return <details className="task-audit"><summary><History />版本与操作记录 <span>V{task.version}</span><ChevronDown /></summary><ol>{task.history.map(item => <li key={item.id}><i /><div><strong>{item.title}</strong><time>{new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</time>{item.detail && <p>{item.detail}</p>}</div></li>)}</ol>{!task.history.length && <p className="task-muted">暂无操作记录</p>}</details>
}

export function TaskDrawer({ taskId, open, onClose, onAction }: { taskId: string | null; open: boolean; onClose: () => void; onAction?: (action: string, task: UnifiedTask) => void }) {
  const [task, setTask] = useState<UnifiedTask | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!open || !taskId) return
    let current = true
    setTask(null); setError('')
    void apiGet<UnifiedTask>(`/tasks/${taskId}`).then(value => { if (current) setTask(value) }).catch(cause => { if (current) setError((cause as Error).message) })
    return () => { current = false }
  }, [open, taskId, revision])
  const more: TaskMoreAction[] = task ? [
    ...(task.capabilities.canFeedback && task.status !== 'not_started' && task.status !== 'pending_acceptance' ? [{ key: 'feedback', label: '更新进度' }] : []),
    ...(task.capabilities.canExtend ? [{ key: 'extension', label: '申请延期' }] : []),
    ...(task.project ? [{ key: 'project', label: '打开项目' }] : []),
    ...(task.capabilities.canCancel ? [{ key: 'cancel', label: '取消任务', danger: true }] : []),
  ] : []
  return <Drawer open={open} onClose={onClose} title="任务详情" width="w-[min(620px,100vw)]" footer={task ? <><MoreActions actions={more} onAction={action => onAction?.(action, task)} /><PrimaryAction action={task.primaryAction} label={task.primaryActionLabel} onClick={() => onAction?.(task.primaryAction, task)} /></> : undefined}>
    {error && <ErrorState message={error} onRetry={() => setRevision(value => value + 1)} />}
    {!task && !error && <div className="task-drawer-loading"><span />正在读取任务…</div>}
    {task && <div className="task-drawer-content">
      <header><div className="task-card-badges"><StatusBadge status={task.status} /><TaskSourceBadge source={task.source} /></div><h2>{task.title}</h2>{task.project && <Link to={`/projects/${task.project.id}?tab=tasks`} onClick={onClose}><FolderKanban />{task.project.name}</Link>}</header>
      <section className="task-detail-grid"><div><span>负责人</span><strong>{task.owner.name}</strong></div><div><span>截止时间</span><strong>{task.dueDate ? `${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ''}` : '未设置'}</strong></div><div className="wide"><span>参与人员</span><strong>{task.participants.map(person => person.name).join('、') || '仅负责人'}</strong></div>{task.calendar && !task.calendar.hidden && <div className="wide"><span>日历安排</span><strong>{new Date(task.calendar.startsAt).toLocaleString('zh-CN')} — {new Date(task.calendar.endsAt).toLocaleString('zh-CN')}</strong></div>}</section>
      <section className="task-detail-section"><h3><FileText />交付要求</h3><p>{task.deliverable || '未设置交付要求'}</p></section>
      <section className="task-detail-section"><h3><MessageSquareText />反馈与成果</h3>{task.feedbacks.map(item => <article key={item.id}><div><strong>{item.kind === 'submission' ? '成果提交' : '进度更新'} · {item.progress}%</strong><time>{new Date(item.submittedAt).toLocaleString('zh-CN')}</time></div><p>{item.result}</p>{item.blocker && <p className="task-blocker">阻塞：{item.blocker}</p>}{item.evidence.length > 0 && <ul>{item.evidence.map(file => <li key={`${file.fileId}:${file.version}`}><FileText />{file.name} V{file.version}</li>)}</ul>}{item.acceptance && <p className="task-acceptance">{item.acceptance.decision === 'accept' ? '验收通过' : '验收退回'}：{item.acceptance.reason}</p>}</article>)}{!task.feedbacks.length && <p className="task-muted">尚无反馈或成果</p>}</section>
      <AuditDetails task={task} />
    </div>}
  </Drawer>
}
