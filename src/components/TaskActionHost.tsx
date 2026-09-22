import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, apiPost } from '../lib/api'
import type { Project, ProjectFile } from '../types'
import { TASK_ACTION_OPEN, notifyTaskChanged, taskTargetFromPath, type TaskActionTarget } from '../lib/taskWorkspace'
import { canPerformTaskAction } from '../lib/taskInteraction'
import type { UnifiedTask } from '../../server/src/contracts/unifiedTaskContract'
import { openApproval } from '../lib/approvalWorkspace'
import { TaskDrawer } from './task/TaskSystem'
import { useToast } from './Toast'
import { FdeTaskPanel } from './FdeTaskPanel'
import { LoadingState, Modal } from './ui'
import { useAuthStore } from '../store/useAuthStore'

export function TaskActionHost() {
  const userId = useAuthStore(s => s.user?.id)
  return userId ? <TaskActionForAccount key={userId} /> : null
}

function TaskActionForAccount() {
  const navigate = useNavigate(), { showToast } = useToast(), busy = useRef(false)
  const userId = useAuthStore(s => s.user?.id)
  const [target, setTarget] = useState<TaskActionTarget | null>(null)
  const [data, setData] = useState<{ project: Project; files: ProjectFile[] } | null>(null), [error, setError] = useState('')
  const [working, setWorking] = useState(false), [revision, setRevision] = useState(0)
  const session = useRef(0)
  const changed = () => { setTarget(null); notifyTaskChanged() }
  const startTask = async (value: TaskActionTarget, snapshot?: UnifiedTask) => {
    if (busy.current) return
    busy.current = true; setWorking(true)
    const currentSession = session.current
    try {
      const task = snapshot ?? await api<UnifiedTask>(`/tasks/${value.taskId}`)
      if (session.current !== currentSession) return
      if (task.project?.id !== value.projectId || !canPerformTaskAction('not_started', task)) throw new Error('任务状态或权限已变化，请查看最新任务')
      await apiPost(`/projects/${value.projectId}/fde-tasks/${task.id}/start`, { expectedVersion: task.version })
      if (session.current === currentSession) { changed(); showToast('任务已开始') }
    } catch (cause) {
      if (session.current === currentSession) {
        const message = (cause as Error).message
        setError(message); showToast(message, 'error'); setTarget({ ...value, action: 'view' }); setRevision(value => value + 1)
      }
    } finally { busy.current = false; if (session.current === currentSession) setWorking(false) }
  }
  useEffect(() => {
    const openTarget = (value: TaskActionTarget) => {
      if (busy.current) return
      ++session.current; setData(null); setError(''); setTarget(value)
      if (value.action === 'start') void startTask(value)
    }
    const open = (event: Event) => { openTarget((event as CustomEvent<TaskActionTarget>).detail) }
    const intercept = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const anchor = (event.target as Element).closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return
      const value = taskTargetFromPath(anchor.href, window.location.origin)
      if (!value) return
      event.preventDefault(); event.stopPropagation(); openTarget(value)
    }
    window.addEventListener(TASK_ACTION_OPEN, open)
    document.addEventListener('click', intercept, true)
    return () => { ++session.current; window.removeEventListener(TASK_ACTION_OPEN, open); document.removeEventListener('click', intercept, true) }
  }, [])
  useEffect(() => { setTarget(null); setData(null) }, [userId])
  useEffect(() => {
    if (!target) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [Boolean(target)])
  useEffect(() => {
    if (!target || target.action === 'view' || target.action === 'start') return
    const controller = new AbortController()
    void Promise.all([api<Project>(`/projects/${target.projectId}`, { signal: controller.signal }), api<{ list: ProjectFile[] }>(`/projects/${target.projectId}/files`, { signal: controller.signal })])
      .then(([project, files]) => { if (!controller.signal.aborted) setData({ project, files: files.list }) })
      .catch(() => { if (!controller.signal.aborted) setError('任务材料读取失败，请关闭后重试') })
    return () => controller.abort()
  }, [target])
  if (!target) return null
  if (target.action === 'start') return <Modal open title="开始任务" onClose={() => { if (!busy.current) setTarget(null) }}><LoadingState /></Modal>
  if (target.action === 'view') return <TaskDrawer taskId={target.taskId} open busy={working} refreshKey={revision} notice={error} onClose={() => { if (!busy.current) setTarget(null) }} onAction={(action, task) => {
    if (busy.current || !task.project) return
    if (!canPerformTaskAction(action, task)) return
    if (action === 'project') { setTarget(null); navigate(`/projects/${task.project.id}?tab=tasks`); return }
    if (action === 'approval') { setTarget(null); openApproval(task.approvalRequestId ? { id: task.approvalRequestId, kind: 'project', projectId: task.project.id } : 'inbox'); return }
    if (action === 'not_started') {
      setError(''); void startTask(target, task)
      return
    }
    const mode = action === 'in_progress' || action === 'returned' ? 'submission' : action === 'pending_acceptance' ? 'accept' : action === 'feedback' ? 'progress' : ['extension', 'cancel'].includes(action) ? action : null
    if (mode) { setData(null); setTarget({ ...target, action: mode }) }
  }} />
  return data ? <FdeTaskPanel key={`${userId}:${target.taskId}:${target.action}`} project={data.project} files={data.files} actionRequest={{ ...target, onClose: () => setTarget(null) }} onChanged={async () => {
    changed()
  }} /> : <Modal open title="处理任务" onClose={() => setTarget(null)}>{error ? <p role="alert" className="text-sm text-red-700">{error}</p> : <LoadingState />}</Modal>
}
