import { openTaskAction } from '../lib/taskWorkspace'
import { subscribeWorkspaceRefresh } from '../lib/workspaceRefresh'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiGet } from '../lib/api'
import type { Project } from '../types'
import {
  collaborationDeadlineGroups, mapCollaborationProjects, taskDeadlineGroup, weeklyActions,
  type CollaborationAction, type CollaborationTask,
} from '../lib/fdeCollaborationView'
import { Button } from './ui'
import { normalizeTaskStatus, taskPrimaryAction, type UnifiedTaskPrimaryAction } from '../../server/src/contracts/unifiedTaskContract'
import { MoreActions, PrimaryAction, StatusBadge, TaskDrawer, TaskSourceBadge } from './task/TaskSystem'
import { useAuthStore } from '../store/useAuthStore'

type PlanBoard = { canDraft: boolean; canPublish: boolean; plans: Array<{ revision: number; status: string; items: Array<{ taskId: string | null; needLeader: boolean; leaderTimeSource: unknown }> }> }

export function FdeCollaborationWeekly({ projects, week, onPlan }: { projects: Project[]; week: string; onPlan: (projectId: string) => void }) {
  const navigate = useNavigate()
  const userId = useAuthStore(state => state.user?.id ?? '')
  const [data, setData] = useState<{ actions: CollaborationAction[]; managers: Project[] } | null>(null)
  const [error, setError] = useState(''), [revision, setRevision] = useState(0)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    setData(null); setError('')
    void mapCollaborationProjects(projects, async project => {
      const [tasks, plans] = await Promise.all([apiGet<{ tasks: CollaborationTask[] }>(`/projects/${project.id}/fde-tasks`), apiGet<PlanBoard>(`/projects/${project.id}/weekly-plans?weekStart=${week}`)])
      const published = plans.plans.filter(plan => plan.status === 'published').sort((a, b) => b.revision - a.revision)[0]
      return { project, manage: plans.canDraft || plans.canPublish, actions: tasks.tasks.filter(task => task.ownerUserId === userId || task.participantUserIds.includes(userId)).map(task => {
        const source = published?.items.find(item => item.taskId === task.id)
        return { ...task, projectId: project.id, projectName: project.name, projectType: project.projectType || '投资项目', needLeader: Boolean(task.timelineSource?.needLeader || source?.needLeader), leaderLinked: Boolean(source?.leaderTimeSource) }
      }) }
    }).then(results => { if (current) setData({ actions: results.flatMap(result => result.actions), managers: results.filter(result => result.manage).map(result => result.project) }) }).catch(cause => { if (current) setError((cause as Error).message) })
    return () => { current = false }
  }, [projects, week, revision, userId])

  useEffect(() => subscribeWorkspaceRefresh(() => setRevision(value => value + 1)), [])
  const items = weeklyActions(data?.actions ?? [], week, 'date')
  const taskLink = (item: CollaborationAction, action = 'view') => openTaskAction(item.projectId, item.id, action)
  const primaryFor = async (item: CollaborationAction, action: UnifiedTaskPrimaryAction) => {
    if (action === 'not_started') {
      taskLink(item, 'start')
      return
    }
    if (action === 'in_progress' || action === 'returned') taskLink(item, 'submission')
    else if (action === 'pending_acceptance') taskLink(item, 'accept')
    else if (action === 'approval') taskLink(item)
    else setSelectedTaskId(item.id)
  }
  const moreFor = (item: CollaborationAction, action: string) => {
    if (action === 'feedback') taskLink(item, 'progress')
    else if (action === 'extension') taskLink(item, 'extension')
    else if (action === 'cancel') taskLink(item, 'cancel')
    else if (action === 'project') navigate(`/projects/${item.projectId}`)
  }

  return <div className="fde-collab-execution">
    <section className="fde-collab-card fde-my-task-board">
      <div className="fde-collab-card-head"><h2>我的任务</h2><span>{items.length} 项</span></div>
      {error ? <div className="fde-collab-state" role="alert">{error}<Button variant="secondary" onClick={() => setRevision(value => value + 1)}>重试</Button></div> : !data ? <div className="fde-collab-state" role="status">正在读取我的任务…</div> : <div className="fde-task-deadline-groups">{collaborationDeadlineGroups.map(([groupId, label]) => {
        const rows = items.filter(item => taskDeadlineGroup(item) === groupId)
        if (!rows.length) return null
        return <section key={groupId} className="fde-task-deadline-group" data-group={groupId}><header><h3>{label}</h3><span>{rows.length}</span></header><div className="fde-task-table-wrap"><table className="fde-task-table"><thead><tr><th>任务</th><th>项目</th><th>截止时间</th><th>状态</th><th>当前操作</th></tr></thead><tbody>{rows.map(item => {
          const status = normalizeTaskStatus(item.status)
          const primary = taskPrimaryAction(status, item.executionModel === 'approval')
          const capabilities = item.capabilities ?? { canFeedback: false, canAccept: false, canExtend: false, canCancel: false }
          const enabled = primary.key === 'not_started' || primary.key === 'in_progress' || primary.key === 'returned' ? capabilities.canFeedback : primary.key === 'pending_acceptance' ? capabilities.canAccept : true
          const source = item.executionModel === 'approval' ? 'approval' : item.directiveId ? 'directive' : item.timelineSource ? 'workflow' : item.planActionId ? 'plan' : 'project'
          const more = [...(capabilities.canFeedback && status !== 'not_started' && status !== 'pending_acceptance' ? [{ key: 'feedback', label: '更新进度' }] : []), ...(capabilities.canExtend ? [{ key: 'extension', label: '申请延期' }] : []), { key: 'project', label: '打开项目' }, ...(capabilities.canCancel ? [{ key: 'cancel', label: '取消任务', danger: true }] : [])]
          return <tr key={`${item.projectId}:${item.id}`} onClick={() => setSelectedTaskId(item.id)}><td><button type="button" className="fde-task-name" onClick={() => setSelectedTaskId(item.id)}><strong>{item.title}</strong><TaskSourceBadge source={source} /></button></td><td>{item.projectName}</td><td><time>{item.dueDate}{item.dueTime ? ` ${item.dueTime}` : ''}</time></td><td><StatusBadge status={status} /></td><td onClick={event => event.stopPropagation()}><div className="fde-task-current-action"><PrimaryAction action={primary.key} label={primary.label} disabled={!enabled} onClick={() => enabled ? void primaryFor(item, primary.key) : setSelectedTaskId(item.id)} /><MoreActions actions={more} onAction={action => moreFor(item, action)} /></div></td></tr>
        })}</tbody></table></div></section>
      })}{!items.length && <div className="fde-collab-state"><strong>本周暂无任务</strong></div>}</div>}
    </section>
    <TaskDrawer taskId={selectedTaskId} open={Boolean(selectedTaskId)} onClose={() => setSelectedTaskId(null)} onAction={(action, task) => { const item = data?.actions.find(value => value.id === task.id); if (!item) return; setSelectedTaskId(null); if (['feedback', 'extension', 'cancel', 'project'].includes(action)) moreFor(item, action); else void primaryFor(item, action as UnifiedTaskPrimaryAction) }} />
    <details className="fde-collab-tools"><summary>计划维护</summary><div><Button variant="secondary" onClick={() => setRevision(value => value + 1)}>刷新任务</Button>{data?.managers.map(project => <Button key={project.id} variant="secondary" onClick={() => onPlan(project.id)}>维护周计划 · {project.name}</Button>)}</div></details>
  </div>
}
