import { and, asc, count, eq, gte, inArray, isNull, lte, ne, notInArray, or } from 'drizzle-orm'
import { db } from '../db/client.js'
import { permissions, projectDutyAssignments, projectMembers, projectPlanActions, projectPlans, projects, projectWeeklyPlans, rolePermissions, roles, todos, userRoles, users } from '../db/schema.js'
import { projectAccessCondition } from './projectAccessService.js'
import { todoAccessCondition } from './meetingService.js'
import { listApprovalCenter } from './fdeApprovalCenterService.js'
import { listLeaderTimes } from './fdeLeaderTimeService.js'
import { listMaterialInbox } from './fdeMaterialService.js'
import { approvalCenterDetailPath } from '../contracts/fdeApprovalCenterContract.js'
import { shanghaiToday, shiftDate, weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'
import { timeLocal } from '../contracts/fdeTimeContract.js'
import { FDE_PROJECT_DUTIES } from '../contracts/fdeGovernanceContract.js'
import { workbenchActionCounts, workbenchActions, workbenchProjectRank, workbenchView, type WorkbenchData, type WorkbenchMetric, type WorkbenchProject, type WorkbenchTone } from '../contracts/fdeWorkbenchContract.js'
import { participantTaskId } from './fdeTaskService.js'

const execution = '/collaboration', approvalsPath = '/workflow?view=pending'
function fail(code: string, message: string, status = 503): never { throw Object.assign(new Error(message), { code, status }) }

export async function getWorkbench(userId: string): Promise<WorkbenchData> {
  const now = new Date(), today = shanghaiToday(now), week = weekStartFor(today)
  const [actor] = await db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
  if (!actor) return fail('WORKBENCH_ACTOR_INACTIVE', '当前账号不可用', 403)
  const bindings = await db.select({ category: roles.fdeCategory, primary: userRoles.isPrimary, name: roles.name }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(userRoles.userId, userId), eq(roles.status, '启用'))).orderBy(asc(roles.code))
  const view = workbenchView(bindings), specialty = bindings.some(b => b.category === 'specialist' && b.name.includes('法务')) ? '法务' : bindings.some(b => b.category === 'specialist' && /风控|风险/.test(b.name)) ? '风控' : '财务'
  const labels = { leader: '机构领导', lead: '项目负责人', secretary: '推进秘书', member: '项目成员', coordinator: '时间协调', specialist: specialty, admin: '配置权限', unassigned: '未绑定业务角色' }
  const result: WorkbenchData = { actorId: userId, name: actor.name, view, perspective: `${labels[view]}视角`, specialty, asOf: now.toISOString(), today, weekStart: week, metrics: [], projects: [], actions: [], attention: [], capacity: null, warnings: [] }
  // 工作台额外保留昨日未完成任务；未来预览仍只展示今天之后的三天。
  const previousDay = shiftDate(today, -1)
  const threeDayEnd = shiftDate(today, 3)
  const metric = (label: string, value: WorkbenchMetric['value'], tone: WorkbenchTone, to = execution, note = '当前账号授权范围；今天至后天待完成事项') => result.metrics.push({ label, value, tone, to, note: value === null ? '尚无完整、可靠的统计来源，待核对；不按 0 处理' : note })
  if (view === 'unassigned') { result.warnings.push('尚未绑定有效 FDE 角色，请联系管理员核对角色映射。'); return result }
  // A configuration-only account must not query business projects, tasks or inboxes.
  if (view === 'admin') {
    const allowed = await db.select({ code: permissions.code }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id)).innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId)).where(and(eq(userRoles.userId, userId), eq(roles.status, '启用'), eq(permissions.code, 'system.manage'))).limit(1)
    const memberCount = allowed.length ? (await db.select({ value: count() }).from(users).where(eq(users.status, '启用')))[0].value : null
    metric('在职成员', memberCount, 'success', '/system', '当前启用账号数')
    metric('权限策略', null, 'success', '/system'); metric('临时授权', null, 'warning', '/system'); metric('安全事件', null, 'danger', '/system')
    return result
  }
  let scoped: WorkbenchProject[] = [], pendingPlans: { id: string; projectId: string }[] = []
  let own = { own: result.actions, count: 0, dueToday: 0, dueSoon: 0 }, acceptance = 0
  if (view !== 'coordinator') {
    const core = await db.transaction(async tx => {
      const visible = await tx.select({ id: projects.id, name: projects.name, owner: projects.owner, ownerUserId: projects.ownerUserId, classification: projects.classification, health: projects.healthStatus, priority: projects.leaderPriority, targetDate: projects.targetDate, stage: projects.stage, stageSource: projects.stageSource, updatedAt: projects.updatedAt }).from(projects).where(and(projectAccessCondition({ uid: userId, name: actor.name, role: actor.role }), eq(projects.lifecycle, 'active'), inArray(projects.classification, ['normal', 'key']), notInArray(projects.stage, ['放弃', '退出']))).limit(5001)
      if (visible.length > 5000) return fail('WORKBENCH_PROJECT_LIMIT', '授权项目超过工作台统计容量，请使用项目中心；未返回截断统计')
      const ids = visible.map(p => p.id)
      const taskRows = await tx.select({ id: todos.id, projectId: todos.projectId, title: todos.title, ownerUserId: todos.ownerUserId, dueDate: todos.dueDate, status: todos.status, planActionId: todos.planActionId }).from(todos).where(and(todoAccessCondition({ uid: userId, name: actor.name, role: actor.role }), isNull(todos.approvalRequestId), notInArray(todos.type, ['流程', '审批', '通知']), gte(todos.dueDate, previousDay), lte(todos.dueDate, threeDayEnd), notInArray(todos.status, ['已完成', '已关闭', '已取消', '已归档']), or(inArray(todos.projectId, ids.length ? ids : ['']), and(isNull(todos.projectId), eq(todos.ownerUserId, userId))))).limit(10001)
      const planActions = ids.length ? await tx.select({ id: projectPlanActions.id, ownerUserId: projectPlanActions.ownerUserId, participantUserIds: projectPlanActions.participantUserIds }).from(projectPlanActions).innerJoin(projectPlans, eq(projectPlanActions.planId, projectPlans.id)).where(inArray(projectPlans.projectId, ids)) : []
      const actionById = new Map(planActions.map(action => [action.id, action]))
      const legacyParticipantIds = new Set(planActions.flatMap(action => action.participantUserIds.filter(id => id !== action.ownerUserId).map(id => participantTaskId(action.id, id))))
      const projectOwners = new Map(visible.map(project => [project.id, project.ownerUserId]))
      const tasks = taskRows.filter(task => {
        if (legacyParticipantIds.has(task.id)) return false
        if (!task.projectId) return task.ownerUserId === userId
        const action = task.planActionId ? actionById.get(task.planActionId) : undefined
        return task.ownerUserId === userId || Boolean(action?.participantUserIds.includes(userId)) || task.status === '待验收' && projectOwners.get(task.projectId) === userId
      })
      if (tasks.length > 10000) return fail('WORKBENCH_TASK_LIMIT', '授权行动超过工作台统计容量，请使用行动列表；未返回截断统计')
      const members = ids.length ? await tx.select({ projectId: projectMembers.projectId }).from(projectMembers).where(and(inArray(projectMembers.projectId, ids), eq(projectMembers.userId, userId))) : []
      const myDuties = ids.length ? await tx.select({ projectId: projectDutyAssignments.projectId, duty: projectDutyAssignments.duty }).from(projectDutyAssignments).where(and(inArray(projectDutyAssignments.projectId, ids), eq(projectDutyAssignments.userId, userId), ne(projectDutyAssignments.duty, 'coordinator'))) : []
      const relatedDuties = myDuties.filter(d => {
        const eligible: readonly string[] = FDE_PROJECT_DUTIES.find(rule => rule.code === d.duty)?.eligible ?? []
        return bindings.some(b => eligible.includes(b.category ?? ''))
      })
      const secretaries = ids.length ? await tx.selectDistinct({ projectId: projectDutyAssignments.projectId, id: users.id, name: users.name }).from(projectDutyAssignments).innerJoin(users, eq(users.id, projectDutyAssignments.userId)).innerJoin(userRoles, eq(userRoles.userId, users.id)).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(inArray(projectDutyAssignments.projectId, ids), eq(projectDutyAssignments.duty, 'secretary'), eq(users.status, '启用'), eq(roles.status, '启用'), inArray(roles.fdeCategory, ['secretary', 'project_lead', 'member']))) : []
      const ownedIds = visible.filter(p => p.ownerUserId === userId).map(p => p.id)
      const plans = ownedIds.length ? await tx.select({ id: projectWeeklyPlans.id, projectId: projectWeeklyPlans.projectId }).from(projectWeeklyPlans).where(and(inArray(projectWeeklyPlans.projectId, ownedIds), eq(projectWeeklyPlans.weekStart, week), eq(projectWeeklyPlans.status, 'submitted'))) : []
      return { visible, tasks, members, secretaries, plans, relatedDuties }
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
    const names = new Map(core.visible.map(p => [p.id, p.name]))
    const actions = workbenchActions(core.tasks.map(t => ({ ...t, projectName: t.projectId ? names.get(t.projectId) ?? '授权项目' : '个人行动', to: t.projectId ? `/projects/${t.projectId}?tab=tasks&task=${t.id}` : '/collaboration' })), today)
    own = workbenchActionCounts(actions, userId, today)
    const keyProjectIds = new Set(core.visible.filter(project => project.classification === 'key').map(project => project.id))
    result.actions = own.own.filter(action => action.projectId && keyProjectIds.has(action.projectId)).slice(0, 12)
    scoped = core.visible.map(p => {
      const projectActions = actions.filter(t => t.projectId === p.id), secretaries = core.secretaries.filter(s => s.projectId === p.id).sort((a, b) => a.id.localeCompare(b.id))
      const secretary = secretaries.find(s => s.id === userId) ?? secretaries[0]
      return { ...p, updatedAt: p.updatedAt.toISOString(), secretary: secretaries.map(s => s.name).join('、') || '未配置推进秘书', secretaryId: secretary?.id ?? null, related: p.ownerUserId === userId || core.members.some(m => m.projectId === p.id) || core.relatedDuties.some(d => d.projectId === p.id), actions: projectActions.slice(0, 3), done: projectActions.filter(t => t.status === '已完成').length, total: projectActions.length, leaderParticipation: null }
    })
    acceptance = actions.filter(t => t.status === '待验收' && scoped.some(p => p.id === t.projectId && p.ownerUserId === userId)).length
    pendingPlans = core.plans
  }
  const safe = async <T>(label: string, read: () => Promise<T>): Promise<T | null> => {
    try { return await read() } catch { result.warnings.push(`${label}暂不可用，相关统计未按 0 处理。`); return null }
  }
  const [approval, time, materials] = await Promise.all([
    view !== 'coordinator' ? safe('审批待办', () => listApprovalCenter(userId, { view: 'pending', page: 1, pageSize: 5 })) : null,
    ['leader', 'lead', 'secretary', 'coordinator'].includes(view) ? safe('领导时间', () => listLeaderTimes(userId, week)) : null,
    view === 'leader' ? safe('材料通知', () => listMaterialInbox(userId, { page: 1, pageSize: 5 })) : null,
  ])
  const dateOf = (t: NonNullable<typeof time>['list'][number]) => timeLocal(t.scheduledStart ?? t.preferredStart).slice(0, 10)
  const times = time?.list.filter(t => {
    const date = timeLocal(t.scheduledStart ?? t.preferredStart).slice(0, 10)
    return !['draft', 'rejected', 'withdrawn', 'cancelled'].includes(t.status) && date >= today && date <= threeDayEnd && (view !== 'leader' || t.leaderId === userId)
  }) ?? []
  const pendingTime = times.filter(t => t.status !== 'confirmed')
  const todayTimes = times.filter(t => dateOf(t) === today)
  if (time) result.capacity = { requested: times.reduce((s, t) => s + t.durationMinutes, 0), confirmed: times.filter(t => t.status === 'confirmed').reduce((s, t) => s + t.durationMinutes, 0), pending: pendingTime.length, conflicts: times.filter(t => t.conflicts.length > 0).length }
  for (const p of scoped) {
    const related = times.filter(t => t.projectId === p.id), todayCount = related.filter(t => dateOf(t) === today).length
    p.leaderParticipation = time ? todayCount ? `今日 ${todayCount} 项` : related.length ? `本周 ${related.length} 项` : '无需参与' : null
  }
  const approvalItems = (approval?.list ?? []).map(a => ({ id: a.id, title: a.title, detail: `${a.projectName || '机构事项'} · ${a.currentNodeName || a.kind}`, icon: view === 'specialist' ? specialty.slice(0, 1) : '审', status: a.status, to: approvalCenterDetailPath(a) }))
  const timeItems = (view === 'leader' ? [...todayTimes, ...times.filter(t => !todayTimes.includes(t))] : pendingTime).map(t => ({ id: t.id, title: t.title, detail: `${t.projectName} · ${timeLocal(t.scheduledStart ?? t.preferredStart).replace('T', ' ')} · ${t.durationMinutes} 分钟`, icon: '时', status: ({ confirmed: '已确认', requested: '待确认', pending: '待配置', supplement: '需补信息' } as Record<string, string>)[t.status] ?? t.status, to: `/collaboration?view=time&request=${t.id}&week=${week}` }))
  const owned = scoped.filter(p => p.ownerUserId === userId), related = scoped.filter(p => p.related)
  if (view === 'leader') {
    metric('风险项目', scoped.filter(p => ['存在风险', '已停滞', '紧急抢救'].includes(p.health)).length, 'danger', '/projects', '当前授权有效项目中的风险健康度数量')
    metric('今日需出场', time ? todayTimes.length : null, 'success', `${execution}?view=time`)
    metric('待配置时间', time ? pendingTime.length : null, 'warning', `${execution}?view=time`)
    metric('待我审批', approval?.total ?? null, 'info', approvalsPath, '当前本人审批节点，服务端完整总数')
    metric('待反馈材料', null, 'purple')
    result.attention = [...approvalItems, ...(materials?.list ?? []).map(m => ({ id: m.id, title: m.title, detail: '材料站内通知', icon: '材', to: `/projects/${m.projectId}?tab=files&material=${m.submissionId}` })), ...timeItems].slice(0, 5)
  } else if (view === 'lead') {
    metric('负责项目', owned.length, 'warning', '/projects', '按当前账号稳定 ID 绑定的有效项目')
    metric('待确认计划', pendingPlans.length, 'info', `${execution}?view=weekly`)
    metric('待验收成果', acceptance, 'danger'); metric('资源冲突', null, 'warning'); metric('待升级问题', null, 'purple')
    result.attention = [...pendingPlans.map(p => ({ id: p.id, title: '确认本周计划', detail: scoped.find(s => s.id === p.projectId)!.name, icon: '计', to: `/collaboration?view=weekly&project=${p.projectId}&week=${week}` })), ...approvalItems].slice(0, 5)
  } else if (view === 'coordinator') {
    metric('时间需求', time ? times.length : null, 'info', `${execution}?view=time`, '本周及未处理历史需求；不含草稿和已结束需求')
    metric('待汇总', time ? pendingTime.length : null, 'warning', `${execution}?view=time`)
    metric('日程冲突', result.capacity?.conflicts ?? null, 'danger', `${execution}?view=time`, '存在冲突的需求数，不是冲突对数')
    metric('已确认时长', result.capacity ? `${(result.capacity.confirmed / 60).toFixed(1)}h` : null, 'success', `${execution}?view=time`)
    metric('待补信息', time ? times.filter(t => t.status === 'supplement').length : null, 'warning', `${execution}?view=time`)
    result.attention = timeItems.slice(0, 6)
  } else if (view === 'secretary') {
    metric('推进项目', scoped.filter(p => p.secretaryId === userId).length, 'info', '/projects')
    metric('今日催办', null, 'danger'); metric('成员未反馈', null, 'warning'); metric('周五例会', null, 'info')
    metric('时间需求', time ? pendingTime.filter(t => t.submittedBy === userId).length : null, 'purple', `${execution}?view=time`)
  } else if (view === 'specialist') {
    metric(`待${specialty}审核`, approval?.total ?? null, 'warning', approvalsPath, '当前账号待审批总数，包含其承担的其他审核职责')
    metric(`${specialty}行动`, own.count, 'info'); metric('相关项目', related.length, 'success', '/projects')
    metric(specialty === '法务' ? '合同风险' : specialty === '风控' ? '风险复核' : '票据异常', null, 'danger', approvalsPath)
    metric(specialty === '法务' ? '待归档协议' : specialty === '风控' ? '待内核事项' : '待归档合同', null, 'info', approvalsPath)
    result.attention = approvalItems
  } else {
    metric('我的行动', own.count, 'info'); metric('待反馈', null, 'warning'); metric('参与项目', related.length, 'success', '/projects')
    metric('当前阻塞', null, 'danger'); metric('即将到期', own.dueSoon, 'warning', execution, '本人本周未完成行动中，今天至后天到期的数量')
  }
  const statusProjects = view === 'leader' ? scoped : view === 'lead' ? owned : related.filter(p => view !== 'secretary' || p.secretaryId === userId)
  result.projects = statusProjects.sort((a, b) => Number(b.classification === 'key') - Number(a.classification === 'key') || a.name.localeCompare(b.name, 'zh-CN')).slice(0, 8)
  return result
}
