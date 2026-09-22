import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { APPROVAL_CHANGED, APPROVAL_OPEN, approvalTarget, approvalTargetFromPath, nextApproval, type ApprovalTarget } from '../lib/approvalWorkspace'
import type { ApprovalCenterResult } from '../../server/src/contracts/fdeApprovalCenterContract'
import type { ApprovalRequest, Project } from '../types'
import { Badge, Button, Drawer, EmptyState, LoadingState } from './ui'

const ProjectApproval = lazy(() => import('../pages/WorkflowPage').then(m => ({ default: m.ProjectWorkflowPage })))
const OfficeApproval = lazy(() => import('./FdeOfficePanel').then(m => ({ default: m.FdeOfficePanel })))
const TypeApproval = lazy(() => import('./FdeTypeRuntimePanel').then(m => ({ default: m.FdeTypeRuntimePanel })))
const ReplanApproval = lazy(() => import('./FdeProjectReplanPanel').then(m => ({ default: m.FdeProjectReplanPanel })))
const ScheduleApproval = lazy(() => import('./ScheduleApprovalReview').then(m => ({ default: m.ScheduleApprovalReview })))

export function ApprovalWorkspaceHost() {
  const userId = useAuthStore(s => s.user?.id ?? '')
  return userId ? <ApprovalWorkspaceForAccount key={userId} /> : null
}

function ApprovalWorkspaceForAccount() {
  const location = useLocation()
  const [open, setOpen] = useState(false), [target, setTarget] = useState<ApprovalTarget | null>(null)
  const [queue, setQueue] = useState<ApprovalCenterResult | null>(null), [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [queueError, setQueueError] = useState(''), [message, setMessage] = useState('')
  const [continueNext, setContinueNext] = useState(true)
  const [resolved, setResolved] = useState(false), [project, setProject] = useState<Project | null>(null)
  const [busy, setBusy] = useState(false), busyRef = useRef(false), dirtyRef = useRef(false)
  const onBusyChange = useCallback((value: boolean) => { busyRef.current = value; setBusy(value) }, [])
  const onDirtyChange = useCallback((value: boolean) => { dirtyRef.current = value }, [])
  const generation = useRef(0), returnFocus = useRef<HTMLElement | null>(null)
  const readQueue = useCallback(async (pageNumber = 1) => {
    const token = ++generation.current
    setLoading(true); setQueueError('')
    try {
      const data = await api<ApprovalCenterResult>(`/oa/center?view=pending&page=${pageNumber}&pageSize=20`)
      if (token !== generation.current) return null
      setQueue(data); setPage(data.page); return data
    } catch { if (token === generation.current) { setQueue(null); setQueueError('待审批事项读取失败，请重试') }; return null }
    finally { if (token === generation.current) setLoading(false) }
  }, [])
  const mayLeave = () => !busyRef.current && (!dirtyRef.current || window.confirm('尚有未提交的意见，确定放弃并离开？'))
  const close = () => { if (!mayLeave()) return; generation.current++; setOpen(false); setTarget(null); returnFocus.current?.focus({ preventScroll: true }) }
  useEffect(() => { onBusyChange(false); onDirtyChange(false) }, [target, onBusyChange, onDirtyChange])
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [open])
  useEffect(() => {
    const show = (value: ApprovalTarget | 'inbox') => {
      if (busyRef.current || (dirtyRef.current && !window.confirm('尚有未提交的意见，确定放弃并查看另一项？'))) return
      returnFocus.current = document.activeElement as HTMLElement
      setOpen(true); setTarget(value === 'inbox' ? null : value); setMessage(''); setError(''); void readQueue()
    }
    const receive = (event: Event) => show((event as CustomEvent<ApprovalTarget | 'inbox'>).detail)
    const intercept = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const anchor = (event.target as Element).closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return
      const value = approvalTargetFromPath(anchor.href, window.location.origin)
      if (!value) return
      event.preventDefault(); event.stopPropagation(); show(value)
    }
    window.addEventListener(APPROVAL_OPEN, receive); document.addEventListener('click', intercept, true)
    return () => { generation.current++; window.removeEventListener(APPROVAL_OPEN, receive); document.removeEventListener('click', intercept, true) }
  }, [readQueue])
  useEffect(() => { setOpen(false); setTarget(null); generation.current++ }, [location.key])
  useEffect(() => {
    if (!target) return
    const controller = new AbortController()
    setResolved(false); setProject(null); setError('')
    void (async () => {
      if (target.kind === 'project') {
        const value = await api<{ list: ApprovalRequest[] }>('/oa/requests', { signal: controller.signal })
        const row = value.list.find(r => r.id === target.id)
        if (!row) throw new Error('该审批已不可访问，请返回待办列表核对')
        if (!controller.signal.aborted && ['agent_schedule', 'project_replan'].includes(row.businessType ?? '')) {
          setTarget({ id: row.id, kind: row.businessType as ApprovalTarget['kind'], projectId: row.projectId }); return
        }
      }
      if (['type_execution', 'project_replan', 'agent_schedule'].includes(target.kind) && !target.projectId) throw new Error('未找到关联项目，请返回待办列表核对')
      if (target.kind === 'type_execution') {
        if (!target.projectId) throw new Error('未找到关联项目')
        const value = await api<Project>(`/projects/${target.projectId}`, { signal: controller.signal })
        if (!controller.signal.aborted) setProject(value)
      }
      if (!controller.signal.aborted) setResolved(true)
    })().catch(cause => { if (!controller.signal.aborted) setError((cause as Error).message) })
    return () => controller.abort()
  }, [target])
  const back = () => { if (!mayLeave()) return; setTarget(null); setError(''); void readQueue(page) }
  const handled = async () => {
    if (!target) return
    const previous = target
    setTarget(null); setMessage('处理已保存')
    window.dispatchEvent(new Event(APPROVAL_CHANGED))
    window.dispatchEvent(new Event('fde-calendar-refresh'))
    const current = await readQueue()
    const next = current && nextApproval(current.list, previous)
    if (continueNext && next) { setTarget(approvalTarget(next)); setMessage('上一项已处理，正在查看下一项') }
    else if (current && !current.total) setMessage('当前待审批事项已全部处理')
  }
  const navigation = <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
    <Button variant="ghost" size="sm" disabled={busy} onClick={back}>待审批列表{queue ? ` · ${queue.total}` : ''}</Button>
    <label className="flex items-center gap-2 text-xs text-slate-500"><input type="checkbox" disabled={busy} checked={continueNext} onChange={e => setContinueNext(e.target.checked)} />处理后继续下一项</label>
    {message && <p role="status" className="w-full text-xs text-brand-700">{message}</p>}
  </div>
  if (!open) return null
  const session = target ? { requestId: target.id, navigation, onClose: close, onHandled: handled, onBusyChange, onDirtyChange } : null
  const embedded = target && resolved && !error && (target.kind === 'project' || target.kind === 'office')
  return <Suspense fallback={<Drawer open title="审批详情" onClose={close}><LoadingState /></Drawer>}>
    {embedded && session ? target.kind === 'office' ? <OfficeApproval key={target.id} session={session} /> : <ProjectApproval key={target.id} session={session} /> :
      <Drawer open title={target ? '审批详情' : '待我审批'} width="w-[860px]" onClose={close}>
        {target && navigation}
        {!target && message && <p role="status" className="mb-4 text-sm text-brand-700">{message}</p>}
        {!target && queueError && <div role="alert" className="flex items-center justify-between gap-3 py-4 text-sm text-red-700">{queueError}<Button variant="secondary" onClick={() => void readQueue(page)}>重新读取</Button></div>}
        {error && <div role="alert" className="flex items-center justify-between gap-3 py-4 text-sm text-red-700">{error}<Button variant="secondary" onClick={target ? back : () => void readQueue(page)}>重新读取</Button></div>}
        {!target ? <>
          {loading ? <LoadingState /> : queue && <>
            <div className="divide-y divide-slate-100">{queue.list.map(row => <button key={row.id} className="flex w-full items-center justify-between gap-3 py-4 text-left" onClick={() => { setTarget(approvalTarget(row)); setMessage('') }}><div className="min-w-0"><p className="break-words text-sm font-semibold">{row.title}</p><p className="mt-2 text-xs text-slate-500">{row.applicantName} · {row.currentNodeName}</p></div><Badge>{row.kind}</Badge></button>)}</div>
            {!queue.total && <EmptyState title="暂无待审批事项" description="" />}
            <div className="mt-5 flex items-center justify-between text-xs text-slate-500"><span>共 {queue.total} 项</span><div className="flex gap-2"><Button variant="secondary" disabled={page <= 1} onClick={() => void readQueue(page - 1)}>上一页</Button><Button variant="secondary" disabled={page * queue.pageSize >= queue.total} onClick={() => void readQueue(page + 1)}>下一页</Button></div></div>
          </>}
        </> : !resolved && !error ? <LoadingState /> : !error && <>
          {target.kind === 'type_execution' && project && <TypeApproval key={target.id} project={project} files={[]} approvalId={target.id} onChanged={() => {}} onHandled={handled} onBusyChange={onBusyChange} onDirtyChange={onDirtyChange} />}
          {target.kind === 'project_replan' && target.projectId && <ReplanApproval key={target.id} projectId={target.projectId} approvalId={target.id} onHandled={handled} onBusyChange={onBusyChange} onDirtyChange={onDirtyChange} />}
          {target.kind === 'agent_schedule' && target.projectId && <ScheduleApproval key={target.id} projectId={target.projectId} requestId={target.id} onHandled={handled} onBusyChange={onBusyChange} onDirtyChange={onDirtyChange} />}
        </>}
      </Drawer>}
  </Suspense>
}
