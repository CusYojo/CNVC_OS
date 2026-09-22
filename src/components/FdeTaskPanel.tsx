import { useEffect, useRef, useState } from 'react'
import { APPROVAL_CHANGED, openApproval } from '../lib/approvalWorkspace'
import { TASK_CHANGED, notifyTaskChanged } from '../lib/taskWorkspace'
import { canPerformTaskAction, taskDecisionRequest, taskRecovery, taskRequiresReview } from '../lib/taskInteraction'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, RefreshCw } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import type { Project, ProjectFile } from '../types'
import { Button, Card, Modal } from './ui'
import { useToast } from './Toast'
import { taskDeadlineKey } from '../../server/src/contracts/fdeTaskContract'
import './fde-workspace.css'
import { FdeTimelineSyncPanel } from './FdeTimelineSyncPanel'
import type { TimelinePending } from '../../server/src/contracts/fdeTimelineTaskContract'
import { shanghaiToday } from '../../server/src/contracts/fdeWeeklyPlanContract'
import type { UnifiedTaskPrimaryAction } from '../../server/src/contracts/unifiedTaskContract'
import { EmptyState as TaskEmptyState, ErrorState as TaskErrorState, TaskCard, TaskDrawer, TaskEvidenceButton } from './task/TaskSystem'

type Feedback = { id: string; kind: string; progress: number; result: string; blocker: string; estimatedDate: string | null; submittedAt: string; evidence: Array<{ fileId: string; version: number }>; acceptance: { decision: string; reason: string } | null }
type Task = { approvalRequestId?: string | null; timelineSource: { stage: string; needLeader: boolean } | null; id: string; title: string; owner: string; ownerUserId: string; participantUserIds: string[]; participants: Array<{ id: string; name: string }>; dueDate: string; dueTime: string | null; directiveId: string | null; deliverable: string | null; version: number; progress: number; status: string; executionModel: string; planActionId: string | null; closureReason: string | null; feedbacks: Feedback[]; extensions: Array<{ id: string; status: string; reason: string; payload: { originalDueDate: string; originalDueTime?: string | null; requestedDueDate: string; requestedDueTime?: string | null }; lockVersion: number; applicantUserId: string }>; capabilities: { canFeedback: boolean; canAccept: boolean; canExtend: boolean; canCancel: boolean } }
type Data = { tasks: Task[]; members: Array<{ id: string; name: string }>; reviewers: Array<{ id: string; name: string }>; canAssign: boolean; canSyncPlan: boolean; planSyncIssue: { count: number; items: Array<{ actionId: string; title: string; issue: string }> }; canSyncTimeline: boolean; timelinePending: TimelinePending }
type Mode = 'progress' | 'submission' | 'accept' | 'return' | 'extension' | 'cancel' | 'create'

export function FdeTaskPanel({ project, files, onChanged, onWeeklyPlan, actionRequest }: { project: Project; files: ProjectFile[]; onChanged: () => Promise<void>; onWeeklyPlan?: () => void; actionRequest?: { taskId: string; action: string; onClose: () => void } }) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const openedShortcut = useRef('')
  const user = useAuthStore((state) => state.user)
  const { showToast } = useToast()
  const [data, setData] = useState<Data | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  useEffect(() => {
    const refresh = () => setRefreshVersion(value => value + 1)
    window.addEventListener(APPROVAL_CHANGED, refresh); window.addEventListener(TASK_CHANGED, refresh)
    return () => { window.removeEventListener(APPROVAL_CHANGED, refresh); window.removeEventListener(TASK_CHANGED, refresh) }
  }, [])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [scope, setScope] = useState('active')
  const [syncDetailsOpen, setSyncDetailsOpen] = useState(false)
  const [clientRequestId, setClientRequestId] = useState('')
  const [dialog, setDialog] = useState<{ mode: Mode; task?: Task } | null>(null)
  const [review, setReview] = useState<{ message: string; latest: Task | null; canContinue: boolean } | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [form, setForm] = useState({ title: '', ownerUserId: '', dueDate: '', dueTime: '', deliverable: '', progress: 0, result: '', blocker: '', estimatedDate: '', reason: '', reviewerUserId: '', files: [] as string[] })
  const endpoint = `/projects/${project.id}/fde-tasks`
  const reload = async () => { const next = await apiGet<Data>(endpoint); setData(next); setError(''); return next }
  useEffect(() => {
    let cancelled = false
    setData(null)
    void apiGet<Data>(endpoint).then((next) => { if (!cancelled) { setData(next); setError('') } }).catch((cause) => { if (!cancelled) setError((cause as Error).message) })
    return () => { cancelled = true }
  }, [endpoint, user?.id, refreshVersion])
  const run = async (operation: () => Promise<Data>, message: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      setData(await operation()); setDialog(null); showToast(message)
      await onChanged().catch(() => showToast('操作已保存，但工作台概览刷新失败，请稍后刷新页面。', 'error'))
      if (!actionRequest) notifyTaskChanged()
    }
    catch (cause) {
      showToast((cause as Error).message, 'error')
      if (dialog?.task && taskRequiresReview(cause)) {
        setReview({ message: '任务状态或权限已变化。填写的内容已保留，请重新核对后再提交。', latest: null, canContinue: false })
        const next = await reload().catch(() => null)
        if (next) {
          const recovery = taskRecovery(dialog.mode, dialog.task.id, next.tasks)
          setReview({ message: recovery.task ? '已读取最新任务，请核对状态、负责人、期限与成果。' : '任务已不可访问，不能继续提交。', latest: recovery.task, canContinue: recovery.canContinue })
        }
      } else await reload().catch(() => {})
    }
    finally { busyRef.current = false; setBusy(false) }
  }
  const open = (mode: Mode, task?: Task) => {
    if (busyRef.current) return
    if (task && !canPerformTaskAction(mode, task)) { showToast('当前任务不能进行此操作，请重新查看任务', 'error'); return }
    setReview(null)
    setClientRequestId(crypto.randomUUID())
    setForm({ title: '', ownerUserId: user?.id ?? '', dueDate: task?.dueDate ?? '', dueTime: task?.dueTime ?? '', deliverable: '', progress: mode === 'submission' ? 100 : Math.min(task?.progress ?? 0, 99), result: '', blocker: '', estimatedDate: '', reason: '', reviewerUserId: data?.reviewers[0]?.id ?? '', files: [] })
    setDialog({ mode, task })
  }
  const submit = () => {
    if (!dialog || review || reviewing || busyRef.current) return
    const { mode, task } = dialog
    if (mode === 'create') { void run(() => apiPost<Data>(endpoint, { clientRequestId, title: form.title, ownerUserId: form.ownerUserId, dueDate: form.dueDate, dueTime: form.dueTime || null, deliverable: form.deliverable }), '项目任务已创建'); return }
    if (!task) return
    if (!canPerformTaskAction(mode, task)) { showToast('任务状态或权限已变化，请重新查看任务', 'error'); return }
    const target = `${endpoint}/${task.id}`
    const expectedVersion = task.version
    if (mode === 'progress' || mode === 'submission') {
      void run(() => apiPost<Data>(`${target}/feedback`, { expectedVersion, kind: mode, progress: form.progress, result: form.result, blocker: form.blocker, estimatedDate: form.estimatedDate || null, evidence: form.files.map((fileId) => ({ fileId, version: files.find((file) => file.id === fileId)?.version })) }), mode === 'submission' ? '成果已提交，等待异人验收' : '执行反馈已保存')
    } else if (mode === 'accept' || mode === 'return') {
      void run(() => apiPost<Data>(`${target}/acceptance`, taskDecisionRequest(task, mode, form.reason)), mode === 'accept' ? '成果验收通过' : '成果已退回，原记录保留')
    } else if (mode === 'extension') {
      void run(() => apiPost<Data>(`${target}/extension`, { expectedVersion, requestedDueDate: form.dueDate, requestedDueTime: form.dueTime || null, reason: form.reason, reviewerUserId: form.reviewerUserId }), '延期已送入 OA，批准前原期限继续有效')
    } else { void run(() => apiPost<Data>(`${target}/cancel`, { expectedVersion, reason: form.reason }), '任务已删除，必要的操作记录已保留') }
  }
  const titles: Record<Mode, string> = { create: '新建项目任务', progress: '执行反馈', submission: '提交成果待验收', accept: '验收成果', return: '退回成果', extension: '申请延期', cancel: '删除任务' }
  const mode = dialog?.mode
  const closeAction = () => {
    if (busyRef.current) return
    if (actionRequest && (form.result.trim() || form.reason.trim() || form.files.length) && !window.confirm('尚有未提交内容，确定放弃并关闭？')) return
    setDialog(null); setReview(null); actionRequest?.onClose()
  }
  useEffect(() => {
    const taskId = actionRequest?.taskId ?? searchParams.get('task'), action = actionRequest?.action ?? searchParams.get('action')
    const shortcut = `${project.id}:${taskId}:${action}`
    if (!data || !taskId || openedShortcut.current === shortcut) return
    const task = data.tasks.find(item => item.id === taskId)
    if (!task) { if (actionRequest) setError('任务已不可访问，请关闭后重新查看'); return }
    openedShortcut.current = shortcut
    if (!actionRequest) document.getElementById(`fde-task-${task.id}`)?.scrollIntoView({ block: 'center' })
    const allowed = Boolean(action && ['progress', 'submission', 'accept', 'extension', 'cancel'].includes(action) && canPerformTaskAction(action, task))
    if (allowed) open(action as Mode, task)
    else if (actionRequest) setError('任务状态或权限已变化，请关闭后重新查看任务')
  }, [data, project.id, searchParams, actionRequest?.taskId, actionRequest?.action])
  const canSubmit = mode === 'create' ? Boolean(form.title.trim() && form.ownerUserId && form.dueDate && form.deliverable.trim().length >= 2)
    : mode === 'progress' || mode === 'submission' ? form.result.trim().length >= 2 && (mode !== 'submission' || form.files.length > 0)
      : mode === 'extension' ? Boolean(form.reviewerUserId && taskDeadlineKey(form.dueDate, form.dueTime || null) > taskDeadlineKey(dialog?.task?.dueDate ?? '', dialog?.task?.dueTime) && form.reason.trim().length >= 5)
        : form.reason.trim().length >= (mode === 'cancel' ? 5 : 2)

  if (error) return actionRequest ? <Modal open title="处理任务" onClose={actionRequest.onClose}><TaskErrorState message={error} onRetry={() => { openedShortcut.current = ''; void reload().catch(cause => setError((cause as Error).message)) }} /></Modal> : <Card><TaskErrorState message={error} onRetry={() => { void reload().catch((cause) => setError((cause as Error).message)) }} /></Card>
  if (!data) return actionRequest ? <Modal open title="处理任务" onClose={actionRequest.onClose}><p className="text-sm text-slate-500">正在读取任务…</p></Modal> : <Card className="p-5 text-sm text-slate-500">正在读取项目任务、成果证据与验收记录…</Card>
  const today = shanghaiToday()
  const visibleTasks = data.tasks.filter(task => scope === 'all' || !['已取消', '已归档', '已关闭'].includes(task.status)).sort((left, right) => (left.dueDate || '9999-12-31').localeCompare(right.dueDate || '9999-12-31') || left.title.localeCompare(right.title, 'zh-CN'))
  const completedTasks = visibleTasks.filter(task => ['已完成', '已关闭', '已取消', '已归档'].includes(task.status))
  const acceptanceTasks = visibleTasks.filter(task => task.status === '待验收')
  const pendingTasks = visibleTasks.filter(task => !['待验收', '已完成', '已关闭', '已取消', '已归档'].includes(task.status))
  const incompleteCount = data.tasks.filter(task => !['已完成', '已关闭', '已取消', '已归档'].includes(task.status)).length
  const relatedCount = data.tasks.filter(task => task.ownerUserId === user?.id || task.participantUserIds.includes(user?.id ?? '')).length
  const overdueCount = data.tasks.filter(task => !['已完成', '已关闭', '已取消', '已归档'].includes(task.status) && Boolean(task.dueDate) && task.dueDate < today).length
  const primaryFor = (task: Task, action: UnifiedTaskPrimaryAction) => {
    if (busyRef.current || !canPerformTaskAction(action, task)) return
    if (action === 'approval') { openApproval(task.approvalRequestId ? { id: task.approvalRequestId, kind: 'project', projectId: project.id } : 'inbox'); return }
    if (action === 'not_started') { void run(() => apiPost<Data>(`${endpoint}/${task.id}/start`, { expectedVersion: task.version }), '任务已开始'); return }
    if (action === 'in_progress' || action === 'returned') { open('submission', task); return }
    if (action === 'pending_acceptance') { open('accept', task); return }
    setSelectedTaskId(task.id)
  }
  const moreFor = (task: Task, action: string) => {
    if (action === 'feedback') open('progress', task)
    else if (action === 'extension') open('extension', task)
    else if (action === 'cancel') open('cancel', task)
    else if (action === 'project') navigate(`/projects/${project.id}`)
  }
  const renderTask = (task: Task) => <TaskCard key={task.id} task={{ ...task, projectId: project.id, projectName: project.name }} compact hideProject busy={busy} onOpen={() => setSelectedTaskId(task.id)} onPrimaryAction={(action) => primaryFor(task, action)} onMoreAction={(action) => moreFor(task, action)} />
  const rereadForReview = async () => {
    if (!dialog?.task || reviewing) return
    setReviewing(true)
    try {
      const next = await reload(), recovery = taskRecovery(dialog.mode, dialog.task.id, next.tasks)
      setReview({ message: recovery.task ? '已读取最新任务，请核对后继续编辑。' : '任务已不可访问，不能继续提交。', latest: recovery.task, canContinue: recovery.canContinue })
    } catch (cause) { showToast((cause as Error).message, 'error') }
    finally { setReviewing(false) }
  }
  const reviewedTask = review?.latest ?? dialog?.task
  const submission = reviewedTask?.feedbacks.find(feedback => feedback.kind === 'submission')
  return <div className="fde-workspace fde-detail-tasks">{!actionRequest && <Card className="fde-panel p-5">
    <div className="fde-detail-task-head"><div className="fde-detail-task-heading-row"><h2>项目任务</h2><div className="fde-detail-task-toolbar"><select className="input" aria-label="任务范围" value={scope} onChange={event => setScope(event.target.value)}><option value="active">进行中的任务</option><option value="all">全部任务</option></select><Button variant="secondary" disabled={busy} onClick={() => { void reload().catch((cause) => showToast((cause as Error).message, 'error')) }}><RefreshCw className="h-4 w-4" />刷新</Button>{onWeeklyPlan && <Button variant="secondary" onClick={onWeeklyPlan}>本周计划</Button>}{project.lifecycle === 'active' && <Button onClick={() => open('create')}><Plus className="h-4 w-4" />新建任务</Button>}</div></div><div className="fde-detail-task-counts"><span><strong>{incompleteCount}</strong>未完成</span><span><strong>{relatedCount}</strong>与我相关</span><span><strong>{acceptanceTasks.length}</strong>待验收</span><span className={overdueCount ? 'danger' : ''}><strong>{overdueCount}</strong>已逾期</span></div></div>
    {data.canSyncPlan && data.planSyncIssue.count > 0 && <section className="fde-plan-sync-warning" role="status"><button type="button" onClick={() => setSyncDetailsOpen(value => !value)}><span>同步异常</span><strong>{data.planSyncIssue.count} 项计划任务需要修复</strong></button>{syncDetailsOpen && <div><ul>{data.planSyncIssue.items.map(item => <li key={item.actionId}>{item.title} · {item.issue}</li>)}</ul><Button variant="secondary" loading={busy} onClick={() => { void run(() => apiPost<Data>(`${endpoint}/sync-plan`, {}), '计划与项目任务已重新同步') }}>修复同步</Button></div>}</section>}
    {data.canSyncTimeline && user?.id && <div className="mt-3"><FdeTimelineSyncPanel key={`${project.id}:${user.id}`} projectId={project.id} onChanged={async () => { await reload(); await onChanged() }} /></div>}
    {!visibleTasks.length && <TaskEmptyState title="暂无项目任务" description="可以新建任务，或从项目计划生成。" />}
    {pendingTasks.length > 0 && <section className="fde-detail-task-section"><header><div><strong>待推进任务</strong><span>{pendingTasks.length} 项</span></div></header><div className="fde-detail-task-list">{pendingTasks.map(renderTask)}</div></section>}
    {acceptanceTasks.length > 0 && <section className="fde-detail-task-section fde-detail-task-acceptance"><header><div><strong>待验收任务</strong><span>{acceptanceTasks.length} 项</span></div></header><div className="fde-detail-task-list">{acceptanceTasks.map(renderTask)}</div></section>}
    {completedTasks.length > 0 && <details className="fde-detail-task-section fde-detail-task-completed" open={scope === 'all'}><summary><div><strong>已完成</strong><span>{completedTasks.length} 项</span></div></summary><div className="fde-detail-task-list">{completedTasks.map(renderTask)}</div></details>}
  </Card>}
    <TaskDrawer taskId={selectedTaskId} busy={busy} open={Boolean(selectedTaskId)} onClose={() => setSelectedTaskId(null)} onAction={(action, unified) => { const task = data.tasks.find(item => item.id === unified.id); if (!task) return; setSelectedTaskId(null); if (['feedback', 'extension', 'cancel', 'project'].includes(action)) moreFor(task, action); else primaryFor(task, action as UnifiedTaskPrimaryAction) }} />
    <Modal open={Boolean(dialog)} title={mode ? titles[mode] : ''} onClose={closeAction} footer={<><Button variant="secondary" disabled={busy || reviewing} onClick={closeAction}>取消</Button><Button loading={busy} disabled={busy || reviewing || Boolean(review) || !canSubmit} onClick={submit}>{mode === 'accept' ? '确认通过' : mode === 'return' ? '确认退回' : '确认提交'}</Button></>}>
      <div className="space-y-4">{dialog?.task && <p className="text-sm font-medium">{dialog.task.title}</p>}
        {review && <section role="alert" className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p>{review.message}</p>{review.latest && <p>{review.latest.status} · {review.latest.owner} · 截止 {review.latest.dueDate}{review.latest.dueTime ? ` ${review.latest.dueTime}` : ''}</p>}<div className="flex flex-wrap gap-2"><Button variant="secondary" loading={reviewing} onClick={() => { void rereadForReview() }}>重新读取任务</Button>{review.canContinue && review.latest && <Button variant="secondary" disabled={reviewing} onClick={() => { setDialog(current => current ? { ...current, task: review.latest! } : current); setReview(null) }}>已核对，继续编辑</Button>}</div>{!review.canContinue && review.latest && <p>当前状态或权限不允许继续此操作，请关闭并查看最新任务。</p>}</section>}
        {(mode === 'accept' || mode === 'return') && <><section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm"><h3 className="font-semibold">本次提交成果</h3>{submission ? <><p className="whitespace-pre-wrap break-words">{submission.result}</p>{submission.blocker && <p className="whitespace-pre-wrap text-amber-800">待协调：{submission.blocker}</p>}<ul className="space-y-2">{submission.evidence.map(file => <li key={`${file.fileId}:${file.version}`}><TaskEvidenceButton {...file} name={files.find(item => item.id === file.fileId)?.name ?? '成果附件'} disabled={busy} /></li>)}</ul></> : <p>尚无可验收的成果提交。</p>}</section><fieldset disabled={busy || Boolean(review)}><legend className="label">验收决定</legend><div className="flex gap-5 text-sm">{(['accept', 'return'] as const).map(decision => <label className="flex items-center gap-2" key={decision}><input type="radio" name="task-acceptance-decision" checked={mode === decision} onChange={() => setDialog(current => current ? { ...current, mode: decision } : current)} />{decision === 'accept' ? '通过验收' : '退回修改'}</label>)}</div></fieldset></>}
        {mode === 'create' && <><label className="block"><span className="label">任务名称</span><input className="input w-full" maxLength={255} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label><label className="block"><span className="label">负责人（系统账号）</span><select className="input w-full" value={form.ownerUserId} onChange={(e) => setForm({ ...form, ownerUserId: e.target.value })}>{data.members.filter((person) => data.canAssign || person.id === user?.id).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><label className="block"><span className="label">交付物要求</span><textarea className="textarea w-full" value={form.deliverable} onChange={(e) => setForm({ ...form, deliverable: e.target.value })} /></label></>}
        {(mode === 'create' || mode === 'extension') && <><label className="block"><span className="label">{mode === 'extension' ? '申请的新截止日期' : '截止日期'}</span><input className="input" type="date" max={project.targetDate ?? undefined} value={form.dueDate} onInput={(e) => { const dueDate = e.currentTarget.value; setForm((previous) => ({ ...previous, dueDate })) }} onChange={(e) => { const dueDate = e.target.value; setForm((previous) => ({ ...previous, dueDate })) }} /></label><label className="block"><span className="label">截止时刻（不填表示当日结束）</span><input className="input" type="time" value={form.dueTime} onInput={(e) => { const value = e.currentTarget.value; setForm((previous) => ({ ...previous, dueTime: value })) }} onChange={(e) => { const value = e.target.value; setForm((previous) => ({ ...previous, dueTime: value })) }} /></label></>}
        {(mode === 'progress' || mode === 'submission') && <><label className="block"><span className="label">进度 %（100% 进入待验收）</span><input className="input" type="number" min={0} max={mode === 'submission' ? 100 : 99} disabled={mode === 'submission'} value={form.progress} onChange={(e) => setForm({ ...form, progress: Number(e.target.value) })} /></label><label className="block"><span className="label">成果 / 执行情况</span><textarea className="textarea min-h-24 w-full" value={form.result} onChange={(e) => setForm({ ...form, result: e.target.value })} /></label><label className="block"><span className="label">阻塞与需协调事项</span><textarea className="textarea w-full" value={form.blocker} onChange={(e) => setForm({ ...form, blocker: e.target.value })} /></label><label className="block"><span className="label">预计完成日期（不改变期限）</span><input type="date" className="input" value={form.estimatedDate} onChange={(e) => setForm({ ...form, estimatedDate: e.target.value })} /></label><fieldset><legend className="label">真实文件证据（成果提交必选）</legend>{files.length ? files.map((file) => <label key={file.id} className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={form.files.includes(file.id)} onChange={(e) => setForm({ ...form, files: e.target.checked ? [...form.files, file.id] : form.files.filter((id) => id !== file.id) })} />{file.name} · V{file.version}</label>) : <p className="text-sm text-amber-700">请先在材料文件工作区上传证据。</p>}</fieldset></>}
        {mode === 'extension' && <><p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">批准前仍按 {dialog?.task?.dueDate} {dialog?.task?.dueTime ?? ''} 执行。超过项目最终日期需先调整正式计划。</p><label className="block"><span className="label">非本人上级审批人</span><select className="input w-full" value={form.reviewerUserId} onChange={(e) => setForm({ ...form, reviewerUserId: e.target.value })}>{data.reviewers.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label></>}
        {mode === 'cancel' && <p className="rounded-lg bg-rose-50 p-3 text-sm leading-6 text-rose-700">删除后任务将从进行中列表、工作台和日历中移除，操作记录仍会保留。</p>}
        {mode && !['create', 'progress', 'submission'].includes(mode) && <label className="block"><span className="label">{mode === 'accept' ? '验收结论' : mode === 'return' ? '退回意见（必填）' : mode === 'cancel' ? '删除原因' : '原因与说明'}</span><textarea className="textarea min-h-24 w-full" required maxLength={mode === 'cancel' ? 2000 : 4000} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>}
      </div>
    </Modal>
  </div>
}
