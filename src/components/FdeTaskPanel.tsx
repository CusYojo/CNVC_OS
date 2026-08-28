import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ClipboardCheck, Clock3, MessageSquareText, Plus, RefreshCw } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import type { Project, ProjectFile } from '../types'
import { Badge, Button, Card, Modal } from './ui'
import { useToast } from './Toast'
import { taskDeadlineKey } from '../../server/src/contracts/fdeTaskContract'
import './fde-workspace.css'
import { FdeTimelineSyncPanel } from './FdeTimelineSyncPanel'
import { timelineSourceLabels, type TimelinePending } from '../../server/src/contracts/fdeTimelineTaskContract'
import { shanghaiToday, shiftDate, weekStartFor } from '../../server/src/contracts/fdeWeeklyPlanContract'

type Feedback = { id: string; kind: string; progress: number; result: string; blocker: string; estimatedDate: string | null; submittedAt: string; evidence: Array<{ fileId: string; version: number }>; acceptance: { decision: string; reason: string } | null }
type Task = { timelineSource: { stage: string; needLeader: boolean } | null; id: string; title: string; owner: string; ownerUserId: string; dueDate: string; dueTime: string | null; directiveId: string | null; deliverable: string | null; version: number; progress: number; status: string; executionModel: string; planActionId: string | null; closureReason: string | null; feedbacks: Feedback[]; extensions: Array<{ id: string; status: string; reason: string; payload: { originalDueDate: string; originalDueTime?: string | null; requestedDueDate: string; requestedDueTime?: string | null }; lockVersion: number; applicantUserId: string }>; capabilities: { canFeedback: boolean; canAccept: boolean; canExtend: boolean; canCancel: boolean } }
type Data = { tasks: Task[]; members: Array<{ id: string; name: string }>; reviewers: Array<{ id: string; name: string }>; canAssign: boolean; canSyncPlan: boolean; canSyncTimeline: boolean; timelinePending: TimelinePending }
type Mode = 'progress' | 'submission' | 'accept' | 'return' | 'extension' | 'cancel' | 'create'

export function FdeTaskPanel({ project, files, onChanged, onWeeklyPlan }: { project: Project; files: ProjectFile[]; onChanged: () => Promise<void>; onWeeklyPlan?: () => void }) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const openedShortcut = useRef('')
  const user = useAuthStore((state) => state.user)
  const { showToast } = useToast()
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = useState('week')
  const [clientRequestId, setClientRequestId] = useState('')
  const [dialog, setDialog] = useState<{ mode: Mode; task?: Task } | null>(null)
  const [form, setForm] = useState({ title: '', ownerUserId: '', dueDate: '', dueTime: '', deliverable: '', progress: 0, result: '', blocker: '', estimatedDate: '', reason: '', reviewerUserId: '', files: [] as string[] })
  const endpoint = `/projects/${project.id}/fde-tasks`
  const reload = async () => { const next = await apiGet<Data>(endpoint); setData(next); setError('') }
  useEffect(() => {
    let cancelled = false
    setData(null)
    void apiGet<Data>(endpoint).then((next) => { if (!cancelled) { setData(next); setError('') } }).catch((cause) => { if (!cancelled) setError((cause as Error).message) })
    return () => { cancelled = true }
  }, [endpoint, user?.id])
  const run = async (operation: () => Promise<Data>, message: string) => {
    setBusy(true)
    try {
      setData(await operation()); setDialog(null); showToast(message)
      await onChanged().catch(() => showToast('操作已保存，但工作台概览刷新失败，请稍后刷新页面。', 'error'))
    }
    catch (cause) { showToast((cause as Error).message, 'error'); await reload().catch(() => {}) }
    finally { setBusy(false) }
  }
  const open = (mode: Mode, task?: Task) => {
    setClientRequestId(crypto.randomUUID())
    setForm({ title: '', ownerUserId: user?.id ?? '', dueDate: task?.dueDate ?? '', dueTime: task?.dueTime ?? '', deliverable: '', progress: mode === 'submission' ? 100 : Math.min(task?.progress ?? 0, 99), result: '', blocker: '', estimatedDate: '', reason: '', reviewerUserId: data?.reviewers[0]?.id ?? '', files: [] })
    setDialog({ mode, task })
  }
  const submit = () => {
    if (!dialog) return
    const { mode, task } = dialog
    if (mode === 'create') { void run(() => apiPost<Data>(endpoint, { clientRequestId, title: form.title, ownerUserId: form.ownerUserId, dueDate: form.dueDate, dueTime: form.dueTime || null, deliverable: form.deliverable }), '项目任务已创建'); return }
    if (!task) return
    const target = `${endpoint}/${task.id}`
    const expectedVersion = task.version
    if (mode === 'progress' || mode === 'submission') {
      void run(() => apiPost<Data>(`${target}/feedback`, { expectedVersion, kind: mode, progress: form.progress, result: form.result, blocker: form.blocker, estimatedDate: form.estimatedDate || null, evidence: form.files.map((fileId) => ({ fileId, version: files.find((file) => file.id === fileId)?.version })) }), mode === 'submission' ? '成果已提交，等待异人验收' : '执行反馈已保存')
    } else if (mode === 'accept' || mode === 'return') {
      void run(() => apiPost<Data>(`${target}/acceptance`, { expectedVersion, feedbackId: task.feedbacks.find((feedback) => feedback.kind === 'submission')?.id, action: mode, reason: form.reason }), mode === 'accept' ? '成果验收通过' : '成果已退回，原记录保留')
    } else if (mode === 'extension') {
      void run(() => apiPost<Data>(`${target}/extension`, { expectedVersion, requestedDueDate: form.dueDate, requestedDueTime: form.dueTime || null, reason: form.reason, reviewerUserId: form.reviewerUserId }), '延期已送入 OA，批准前原期限继续有效')
    } else { void run(() => apiPost<Data>(`${target}/cancel`, { expectedVersion, reason: form.reason }), '任务已取消，历史记录保留') }
  }
  const titles: Record<Mode, string> = { create: '新建项目任务', progress: '执行反馈', submission: '提交成果待验收', accept: '验收成果', return: '退回成果', extension: '申请延期', cancel: '取消任务' }
  const mode = dialog?.mode
  useEffect(() => {
    const taskId = searchParams.get('task'), action = searchParams.get('action')
    const shortcut = `${project.id}:${taskId}:${action}`
    if (!data || !taskId || openedShortcut.current === shortcut) return
    const task = data.tasks.find(item => item.id === taskId)
    if (!task) return
    openedShortcut.current = shortcut
    document.getElementById(`fde-task-${task.id}`)?.scrollIntoView({ block: 'center' })
    const allowed = action === 'progress' || action === 'submission' ? task.capabilities.canFeedback : action === 'accept' ? task.capabilities.canAccept : action === 'extension' ? task.capabilities.canExtend && !task.extensions.some(item => item.status === '审批中') : action === 'cancel' ? task.capabilities.canCancel : false
    if (allowed) open(action as Mode, task)
  }, [data, project.id, searchParams])
  const canSubmit = mode === 'create' ? Boolean(form.title.trim() && form.ownerUserId && form.dueDate && form.deliverable.trim().length >= 2)
    : mode === 'progress' || mode === 'submission' ? form.result.trim().length >= 2 && (mode !== 'submission' || form.files.length > 0)
      : mode === 'extension' ? Boolean(form.reviewerUserId && taskDeadlineKey(form.dueDate, form.dueTime || null) > taskDeadlineKey(dialog?.task?.dueDate ?? '', dialog?.task?.dueTime) && form.reason.trim().length >= 5)
        : form.reason.trim().length >= (mode === 'cancel' ? 5 : 2)

  if (error) return <Card className="p-5"><p className="text-sm text-red-600">任务加载失败：{error}</p><Button variant="secondary" onClick={() => { void reload().catch((cause) => setError((cause as Error).message)) }}>重试</Button></Card>
  if (!data) return <Card className="p-5 text-sm text-slate-500">正在读取项目任务、成果证据与验收记录…</Card>
  const weekStart = weekStartFor(shanghaiToday()), weekEnd = shiftDate(weekStart, 6)
  const visibleTasks = data.tasks.filter(task => scope === 'all' || !['已取消', '已归档', '已关闭'].includes(task.status) && (!task.dueDate || task.dueDate <= weekEnd && (task.dueDate >= weekStart || task.status !== '已完成')))
  return <div className="fde-workspace fde-detail-tasks"><Card className="fde-panel p-5">
    <div className="fde-detail-task-head flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">项目待办</h2><div className="fde-detail-task-counts"><span>全部 {visibleTasks.length}</span><span>与我相关 {visibleTasks.filter(task => task.ownerUserId === user?.id).length}</span><span>待验收 {visibleTasks.filter(task => task.status === '待验收').length}</span></div></div><div className="flex flex-wrap gap-2"><select className="input" aria-label="待办范围" value={scope} onChange={event => setScope(event.target.value)}><option value="week">本周待办</option><option value="all">全部任务与历史</option></select><Button variant="secondary" disabled={busy} onClick={() => { void reload().catch((cause) => showToast((cause as Error).message, 'error')) }}><RefreshCw className="h-4 w-4" />刷新</Button>{data.canSyncPlan && <Button variant="secondary" loading={busy} onClick={() => { void run(() => apiPost<Data>(`${endpoint}/sync-plan`, {}), '已批准计划任务对账完成') }}>对账计划任务</Button>}{onWeeklyPlan && <Button variant="secondary" onClick={onWeeklyPlan}>本周计划</Button>}{project.lifecycle === 'active' && <Button onClick={() => open('create')}><Plus className="h-4 w-4" />新建任务</Button>}</div></div>
    {data.canSyncTimeline && user?.id && <div className="mt-3"><FdeTimelineSyncPanel key={`${project.id}:${user.id}`} projectId={project.id} onChanged={async () => { await reload(); await onChanged() }} /></div>}
    {data.timelinePending?.count > 0 && <section role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
      <p className="font-medium">流程行动待联动 · {data.timelinePending.count} 项</p>
      <p className="mt-1 text-xs">源业务操作已保存，部分流程行动或领导时间仍待联动。请按下列原因补齐日期或有效职责，再点击“同步流程行动”核对；不会自动授予权限或重复生成任务。</p>
      <ul className="mt-2 list-inside list-disc space-y-1 text-xs">{data.timelinePending.items.map(item => <li key={item.id}>{timelineSourceLabels[item.source]}：{item.issues.join('；')}</li>)}</ul>
      {data.timelinePending.count > data.timelinePending.items.length && <p className="mt-2 text-xs">仅展示最近 {data.timelinePending.items.length} 项；同步按当前完整来源对账，成功后关联处理全部待联动记录。</p>}
    </section>}
    <div className="fde-detail-task-list">{!visibleTasks.length && <p className="rounded-lg bg-slate-50 p-5 text-sm text-slate-500">尚无项目任务。已批准的倒排计划会生成执行任务，也可由负责人分配任务。</p>}{visibleTasks.map((task) => {
      const pending = task.extensions.find((extension) => extension.status === '审批中')
      return <section id={`fde-task-${task.id}`} key={task.id} className="rounded-xl border border-slate-200 p-4">
        <div className="fde-detail-task-summary flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">{task.title}</h3><p className="mt-1 text-xs text-slate-500">{task.owner} · 有效截止 {task.dueDate || '未设置'} {task.dueTime ?? ''} · {task.timelineSource ? `${task.timelineSource.stage}流程行动` : task.directiveId ? '领导批示' : task.planActionId ? '倒排计划' : task.executionModel === 'approval' ? '审批投影' : '项目任务'}</p>{task.deliverable && <p className="mt-2 text-sm text-slate-600">交付物：{task.deliverable}</p>}</div><Badge tone={task.status === '已完成' ? 'green' : task.status === '待验收' || task.status === '待确认' ? 'amber' : 'slate'}>{task.status} · {task.progress}%</Badge></div>
        {pending && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">延期至 {pending.payload.requestedDueDate} {pending.payload.requestedDueTime ?? ''} 审批中；当前仍按 {task.dueDate} {task.dueTime ?? ''} 执行。</p>}
        {task.closureReason && <p className="mt-2 text-xs text-slate-500">关闭说明：{task.closureReason}</p>}
        <div className="fde-detail-task-controls mt-3 flex flex-wrap gap-2">{task.directiveId && <Button variant="secondary" onClick={() => navigate(`/projects/${project.id}?tab=collaboration`)}>查看批示 / 回执</Button>}{task.executionModel === 'approval' ? <Button variant="secondary" onClick={() => navigate(`/workflow?project=${project.id}`)}>进入审批</Button> : <>
          {task.capabilities.canFeedback && <><Button variant="secondary" disabled={busy} onClick={() => open('progress', task)}><MessageSquareText className="h-4 w-4" />反馈</Button><Button disabled={busy} onClick={() => open('submission', task)}>提交成果</Button></>}
          {task.capabilities.canAccept && <><Button disabled={busy} onClick={() => open('accept', task)}><ClipboardCheck className="h-4 w-4" />验收通过</Button><Button variant="secondary" disabled={busy} onClick={() => open('return', task)}>退回补充</Button></>}
          {task.capabilities.canExtend && !pending && <Button variant="secondary" disabled={busy || !data.reviewers.length} onClick={() => open('extension', task)}><Clock3 className="h-4 w-4" />申请延期</Button>}
          {task.capabilities.canCancel && <Button variant="secondary" disabled={busy} onClick={() => open('cancel', task)}>取消任务</Button>}
        </>}</div>
        {(task.feedbacks.length > 0 || task.extensions.length > 0) && <details className="mt-4 border-t border-slate-100 pt-3" open={task.status === '待验收'}><summary className="cursor-pointer text-xs font-medium text-slate-600">成果、反馈与延期历史</summary><div className="mt-3 space-y-3">{task.feedbacks.map((feedback) => <div key={feedback.id} className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600"><p className="font-medium">{feedback.kind === 'submission' ? '成果提交' : '执行反馈'} · {feedback.progress}% · {new Date(feedback.submittedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p><p className="mt-1 whitespace-pre-wrap">{feedback.result}</p>{feedback.blocker && <p className="mt-1">阻塞：{feedback.blocker}</p>}{feedback.estimatedDate && <p className="mt-1">预计完成：{feedback.estimatedDate}（不改变正式期限）</p>}<p className="mt-1">证据：{feedback.evidence.map((ref) => `${files.find((file) => file.id === ref.fileId)?.name ?? ref.fileId} V${ref.version}`).join('、') || '无附件'}</p>{feedback.acceptance && <p className="mt-2 font-medium">{feedback.acceptance.decision === 'accept' ? '验收通过' : '验收退回'}：{feedback.acceptance.reason}</p>}</div>)}{task.extensions.map((extension) => <div key={extension.id} className="rounded-lg bg-amber-50/60 p-3 text-xs text-slate-600"><p>延期 {extension.payload.originalDueDate} {extension.payload.originalDueTime ?? ''} → {extension.payload.requestedDueDate} {extension.payload.requestedDueTime ?? ''} · {extension.status}</p><p className="mt-1">{extension.reason}</p><button className="mt-2 text-brand-700 underline" onClick={() => navigate(`/workflow?project=${project.id}`)}>查看 OA 审批记录</button></div>)}</div></details>}
      </section>
    })}</div>
  </Card>
    <Modal open={Boolean(dialog)} title={mode ? titles[mode] : ''} onClose={() => { if (!busy) setDialog(null) }} footer={<><Button variant="secondary" disabled={busy} onClick={() => setDialog(null)}>取消</Button><Button loading={busy} disabled={!canSubmit} onClick={submit}>确认提交</Button></>}>
      <div className="space-y-4">{dialog?.task && <p className="text-sm font-medium">{dialog.task.title}</p>}
        {mode === 'create' && <><label className="block"><span className="label">任务名称</span><input className="input w-full" maxLength={255} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label><label className="block"><span className="label">负责人（系统账号）</span><select className="input w-full" value={form.ownerUserId} onChange={(e) => setForm({ ...form, ownerUserId: e.target.value })}>{data.members.filter((person) => data.canAssign || person.id === user?.id).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><label className="block"><span className="label">交付物要求</span><textarea className="textarea w-full" value={form.deliverable} onChange={(e) => setForm({ ...form, deliverable: e.target.value })} /></label></>}
        {(mode === 'create' || mode === 'extension') && <><label className="block"><span className="label">{mode === 'extension' ? '申请的新截止日期' : '截止日期'}</span><input className="input" type="date" max={project.targetDate ?? undefined} value={form.dueDate} onInput={(e) => { const dueDate = e.currentTarget.value; setForm((previous) => ({ ...previous, dueDate })) }} onChange={(e) => { const dueDate = e.target.value; setForm((previous) => ({ ...previous, dueDate })) }} /></label><label className="block"><span className="label">截止时刻（不填表示当日结束）</span><input className="input" type="time" value={form.dueTime} onInput={(e) => { const value = e.currentTarget.value; setForm((previous) => ({ ...previous, dueTime: value })) }} onChange={(e) => { const value = e.target.value; setForm((previous) => ({ ...previous, dueTime: value })) }} /></label></>}
        {(mode === 'progress' || mode === 'submission') && <><label className="block"><span className="label">进度 %（100% 进入待验收）</span><input className="input" type="number" min={0} max={mode === 'submission' ? 100 : 99} disabled={mode === 'submission'} value={form.progress} onChange={(e) => setForm({ ...form, progress: Number(e.target.value) })} /></label><label className="block"><span className="label">成果 / 执行情况</span><textarea className="textarea min-h-24 w-full" value={form.result} onChange={(e) => setForm({ ...form, result: e.target.value })} /></label><label className="block"><span className="label">阻塞与需协调事项</span><textarea className="textarea w-full" value={form.blocker} onChange={(e) => setForm({ ...form, blocker: e.target.value })} /></label><label className="block"><span className="label">预计完成日期（不改变期限）</span><input type="date" className="input" value={form.estimatedDate} onChange={(e) => setForm({ ...form, estimatedDate: e.target.value })} /></label><fieldset><legend className="label">真实文件证据（成果提交必选）</legend>{files.length ? files.map((file) => <label key={file.id} className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={form.files.includes(file.id)} onChange={(e) => setForm({ ...form, files: e.target.checked ? [...form.files, file.id] : form.files.filter((id) => id !== file.id) })} />{file.name} · V{file.version}</label>) : <p className="text-sm text-amber-700">请先在材料文件工作区上传证据。</p>}</fieldset></>}
        {mode === 'extension' && <><p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">批准前仍按 {dialog?.task?.dueDate} {dialog?.task?.dueTime ?? ''} 执行。超过项目最终日期需先调整正式计划。</p><label className="block"><span className="label">非本人上级审批人</span><select className="input w-full" value={form.reviewerUserId} onChange={(e) => setForm({ ...form, reviewerUserId: e.target.value })}>{data.reviewers.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label></>}
        {mode && !['create', 'progress', 'submission'].includes(mode) && <label className="block"><span className="label">{mode === 'accept' ? '验收结论' : '原因与说明'}</span><textarea className="textarea min-h-24 w-full" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>}
      </div>
    </Modal>
  </div>
}
