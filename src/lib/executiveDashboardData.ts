import type { Project, RiskAlert, WorkflowLog } from '../types'
import type { CollaborationTask } from './fdeCollaborationView'
import { shanghaiDateKey } from './dateTime'
import { shiftDate, weekStartFor } from '../../server/src/contracts/fdeWeeklyPlanContract'
import { typeRuntimeEffectiveDeadline, type TypeRuntimeView } from '../../server/src/contracts/fdeTypeRuntimeContract'

export type ExecutivePerson = { id: string; name: string; department: string }
export type ExecutiveTask = Omit<CollaborationTask, 'feedbacks'> & {
  feedbacks: Array<{ result: string; blocker: string; submittedAt: string; submittedBy: string }>
}
export type ExecutiveDirective = {
  id: string; issuerId: string; content: string; withdrawnAt: string | null; createdAt: string
  task: { id: string; title: string; owner: string; ownerUserId: string; dueDate: string | null; status: string; progress: number }
}
export type ExecutiveWorkflow = {
  timeline: Array<{ stage: string; date: string; basis: string; actualDate?: string | null }>
  members: Array<{ id: string; name: string }>
}
export type ExecutiveProjectDetail = {
  project: Project
  tasks?: ExecutiveTask[]
  directives?: ExecutiveDirective[]
  workflow?: ExecutiveWorkflow
  workflowNeedsConfiguration?: boolean
  errors: string[]
}
export type ExecutiveCalendarItem = {
  key: string; id: string | null; source: string; title: string; projectId?: string | null
  projectName?: string | null; startsAt: string; endsAt?: string | null; allDay?: boolean; target: string | null; ownerName: string
}
export type ExecutiveRead = <T>(path: string) => Promise<T>
export const isOpenTask = (status: string) => !['已完成', '已关闭', '已取消', '已归档'].includes(status)
export const isActiveProject = (p: Project) => (p.lifecycle ?? 'active') === 'active' && p.classification !== 'pool' && !['放弃', '退出', '已 Close'].includes(p.stage)

export function executiveTypeWorkflow(runtime: TypeRuntimeView): ExecutiveWorkflow {
  const instance = runtime.instance
  // Unapproved plan drafts must never appear as committed milestones.
  if (!instance || !['active', 'stage_review'].includes(instance.status)) return { timeline: [], members: runtime.people }
  const stages = instance.plan.configuration.stages
  const currentIndex = stages.findIndex(stage => stage.key === instance.stageKey)
  const timeline = stages.flatMap((stage, index) => {
    if (currentIndex < 0 || index < currentIndex) return []
    const dates = instance.plan.actions.filter(action => action.stageKey === stage.key)
      .map(action => typeRuntimeEffectiveDeadline(action, runtime.tasks.find(task => task.actionKey === action.key)).dueDate)
      .filter((date): date is string => Boolean(date)).sort()
    return dates.length ? [{ stage: stage.name, date: dates.at(-1)!, basis: 'approved' }] : []
  })
  return { timeline, members: runtime.people }
}

export function executiveDate(value?: string | null): string {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  try { return shanghaiDateKey(value) } catch { return '' }
}
export function isInExecutiveWeek(value: string, today: string) {
  const date = executiveDate(value), start = weekStartFor(today)
  return Boolean(date) && date >= start && date < shiftDate(start, 7)
}

export function rankExecutiveProjects(projects: Project[]) {
  const priorities = { 高: 0, 中: 1, 低: 2 }
  return projects.filter(isActiveProject).sort((a, b) =>
    Number(b.classification === 'key') - Number(a.classification === 'key')
    || (priorities[a.leaderPriority ?? '中'] - priorities[b.leaderPriority ?? '中'])
    || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
}

// Fetch every page before publishing totals; a failed page must not look like zero projects.
export async function loadExecutiveProjects(read: ExecutiveRead) {
  const rows = new Map<string, Project>()
  let expectedTotal: number | undefined
  for (let page = 1; ; page++) {
    const data = await read<{ list: Project[]; total: number; pageSize: number }>(`/projects?scope=all&page=${page}&pageSize=100`)
    if (expectedTotal !== undefined && expectedTotal !== data.total) throw new Error('项目列表发生变化，请刷新重试')
    expectedTotal = data.total
    data.list.forEach(p => rows.set(p.id, p))
    if (page * data.pageSize >= data.total) break
    if (!data.list.length) throw new Error('项目列表发生变化，请刷新重试')
  }
  if (rows.size !== expectedTotal) throw new Error('项目列表发生变化，请刷新重试')
  return [...rows.values()].filter(p => p.lifecycle !== 'deleted' && p.classification !== 'pool')
}

// Four requests at most, including requests from different projects. Publish partial results
// as they arrive so the approval inbox and project overview never wait for the slowest project.
export async function loadExecutiveDetails(projects: Project[], read: ExecutiveRead, update: (rows: ExecutiveProjectDetail[]) => void, signal: AbortSignal) {
  const rows: ExecutiveProjectDetail[] = rankExecutiveProjects(projects).filter(p => p.workflowModel === 'fde-v1').map(project => ({ project, errors: [] }))
  const jobs = rows.flatMap(row => [
    async () => { row.tasks = (await read<{ tasks: ExecutiveTask[] }>(`/projects/${row.project.id}/fde-tasks`)).tasks },
    async () => { row.directives = (await read<{ list: ExecutiveDirective[] }>(`/projects/${row.project.id}/directives`)).list },
    async () => {
      row.workflow = row.project.projectType && row.project.projectType !== '投资项目'
        ? executiveTypeWorkflow(await read<TypeRuntimeView>(`/projects/${row.project.id}/type-execution`))
        : await read<ExecutiveWorkflow>(`/projects/${row.project.id}/fde-workflow`)
    },
  ].map((run, index) => ({ row, run, label: ['任务', '督办', '节点'][index] })))
  let index = 0
  update(rows.map(row => ({ ...row })))
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
    while (index < jobs.length && !signal.aborted) {
      const job = jobs[index++]
      try { await job.run() } catch (error) {
        if (!signal.aborted) {
          job.row.errors.push(job.label)
          const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
          if (job.label === '节点' && ['TYPE_RUNTIME_POLICY_INVALID', 'FDE_POLICY_NOT_BOUND', 'FDE_POLICY_NOT_PUBLISHED'].includes(String(code))) {
            job.row.workflowNeedsConfiguration = true
          }
        }
      }
      if (!signal.aborted) update(rows.map(row => ({ ...row, errors: [...row.errors] })))
    }
  }))
  return rows
}

export function executiveWeekLogs(logs: WorkflowLog[], today: string) {
  return [...new Map(logs.filter(log => log.source === 'OA审批' && log.fromStage !== log.toStage && isInExecutiveWeek(log.createdAt, today))
    .map(log => [log.requestId || log.id, log])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function executiveProjectStatus(project: Project, risks: RiskAlert[], today: string) {
  // Severity comes from existing risk/health fields, never an invented overdue threshold.
  if (['已停滞', '紧急抢救', '存在风险'].includes(project.healthStatus ?? '')) return { label: project.healthStatus!, tone: 'red' as const }
  if (project.riskLevel === '高' || risks.some(r => r.projectId === project.id && r.level === '高' && !['已关闭', '误报'].includes(r.status))) return { label: '高风险', tone: 'red' as const }
  // A historic investment/closing target is not an overdue post-investment obligation.
  if (!['投后', '已 Close', '退出', '放弃'].includes(project.stage) && project.targetDate && project.targetDate < today) return { label: '已逾期', tone: 'red' as const }
  if (project.healthStatus === '需关注' || project.riskLevel === '中' || risks.some(r => r.projectId === project.id && r.level === '中' && !['已关闭', '误报'].includes(r.status))) return { label: '需关注', tone: 'amber' as const }
  return { label: '正常', tone: 'green' as const }
}

export function executivePortfolio(projects: Project[], risks: RiskAlert[], today: string) {
  const order = { red: 0, amber: 1, green: 2 }
  return rankExecutiveProjects(projects).map(project => ({ project, status: executiveProjectStatus(project, risks, today) }))
    .sort((a, b) => order[a.status.tone] - order[b.status.tone])
}

export function executiveOwnDirectives(details: ExecutiveProjectDetail[], userId: string, today: string) {
  return details.flatMap(detail => (detail.directives ?? [])
    .filter(item => item.issuerId === userId && !item.withdrawnAt && !['已取消', '已关闭', '已归档'].includes(item.task.status))
    .map(item => ({ ...item, project: detail.project, overdue: Boolean(item.task.dueDate && item.task.dueDate < today && isOpenTask(item.task.status)) })))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(isOpenTask(b.task.status)) - Number(isOpenTask(a.task.status))
      || (a.task.dueDate ?? '9999').localeCompare(b.task.dueDate ?? '9999') || b.createdAt.localeCompare(a.createdAt))
}

export function executiveProjectUpdate(projectId: string, details: ExecutiveProjectDetail[], logs: WorkflowLog[], today: string) {
  const stage = executiveWeekLogs(logs, today).find(log => log.projectId === projectId)
  const feedback = (details.find(d => d.project.id === projectId)?.tasks ?? [])
    .flatMap(task => task.feedbacks.filter(f => isInExecutiveWeek(f.submittedAt, today) && f.result.trim()).map(f => ({ text: f.result, date: f.submittedAt })))
    .sort((a, b) => b.date.localeCompare(a.date))[0]
  if (feedback && (!stage || new Date(feedback.date).getTime() > new Date(stage.createdAt).getTime())) return feedback.text
  if (stage) return `推进至${stage.toStage === '已 Close' ? '完成交割' : stage.toStage}`
  return ''
}

export function executiveKeyNodes(details: ExecutiveProjectDetail[], calendar: ExecutiveCalendarItem[], today: string, view: 'company' | 'personal' = 'company') {
  const nodes: Array<{ id: string; title: string; project: string; time: string; to: string; kindLabel?: string }> = []
  // A member's agenda comes from the server's personal projection, not all tasks
  // in projects they may read. This also includes their standalone arrangements.
  if (view === 'personal') {
    const start = Date.parse(`${today}T00:00:00+08:00`), end = start + 86400000
    const labels: Record<string, string> = { personal: '个人安排', task: '任务', meeting: '会议', office: '办公安排', leader: '时间安排', milestone: '节点' }
    for (const item of calendar) {
      const starts = Date.parse(item.startsAt), ends = item.endsAt ? Date.parse(item.endsAt) : starts
      if (!item.id || !labels[item.source] || !Number.isFinite(starts) || starts >= end || (starts < start && !(ends > start))) continue
      const target = item.target?.startsWith('/') && !item.target.startsWith('//') ? item.target : '/?view=personal'
      nodes.push({
        id: `${item.source}:${item.id}`, title: item.title, project: item.projectName || labels[item.source],
        time: item.allDay || starts < start ? '全天' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(starts)),
        to: item.source === 'meeting' && !target.startsWith('/committee') ? `/meetings?meeting=${item.id}` : target === '/' ? '/?view=personal' : target,
        kindLabel: labels[item.source],
      })
    }
    return [...new Map(nodes.map(node => [node.id, node])).values()].sort((a, b) => Number(b.time === '全天') - Number(a.time === '全天') || a.time.localeCompare(b.time) || a.id.localeCompare(b.id))
  }
  for (const { project, workflow, tasks } of details) {
    for (const node of workflow?.timeline ?? []) if (node.date === today && !node.actualDate) nodes.push({
      id: `stage:${project.id}:${node.stage}`, title: `${node.stage}节点`, project: project.name,
      time: '今日到期', to: `/projects/${project.id}?tab=workflow`,
    })
    for (const task of tasks ?? []) if (task.dueDate === today && isOpenTask(task.status) && task.executionModel !== 'approval' && (task.planActionId || task.timelineSource)) nodes.push({
      id: `task:${task.id}`, title: task.title, project: project.name,
      time: task.dueTime || '今日到期', to: `/projects/${project.id}?tab=tasks&task=${task.id}`,
    })
  }
  for (const item of calendar) if (item.source === 'meeting' && item.id && item.target && executiveDate(item.startsAt) === today) nodes.push({
    id: `meeting:${item.id}`, title: item.title, project: item.projectName || '项目会议',
    time: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(item.startsAt)),
    to: item.target.startsWith('/committee') ? item.target : `/meetings?meeting=${item.id}`,
  })
  return [...new Map(nodes.map(node => [node.id, node])).values()].sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id))
}

export function executiveTeam(projects: Project[], details: ExecutiveProjectDetail[], people: ExecutivePerson[], today: string) {
  return people.map(person => {
    const owned = rankExecutiveProjects(projects).filter(p => p.ownerUserId === person.id)
    const tasks = details.flatMap(d => (d.tasks ?? []).filter(task => task.ownerUserId === person.id && task.executionModel !== 'approval').map(task => ({ ...task, project: d.project })))
    const related = [...new Map([...owned, ...tasks.map(task => task.project), ...details.filter(d => d.workflow?.members.some(m => m.id === person.id)).map(d => d.project)].map(p => [p.id, p])).values()]
    const feedback = tasks.flatMap(task => task.feedbacks.filter(f => f.submittedBy === person.id && isInExecutiveWeek(f.submittedAt, today) && f.result.trim()).map(f => ({ ...f, title: task.title })))
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0]
    const weekly = tasks.filter(t => t.dueDate && isInExecutiveWeek(t.dueDate, today))
    const incomplete = details.some(d => related.some(p => p.id === d.project.id) && d.errors.includes('任务'))
    return { ...person, owned, related, tasks, summary: feedback ? feedback.result : incomplete ? '部分工作暂未加载' : weekly.length ? `本周安排 ${weekly.length} 项 · 已完成 ${weekly.filter(t => t.status === '已完成').length} 项` : '本周暂无工作更新' }
  }).filter(person => person.related.length).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}
