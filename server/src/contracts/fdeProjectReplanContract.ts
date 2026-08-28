import { z } from 'zod'
import { agentDate, agentDayOffset } from './fdeProjectAgentContract.js'
import { agentScheduleStages } from './fdeAgentScheduleContract.js'
import { timelineTaskProtection } from './fdeTimelineTaskContract.js'

// No default policy: these are supported engineering semantics, not approved
// business rules. The adapter loads a separately approved, enabled DB version.
export const projectReplanPolicy = z.object({
  schemaVersion: z.literal(1), timezone: z.literal('Asia/Shanghai'),  calendarBasis: z.enum(['calendar', 'working']),
  strategy: z.literal('shift_remaining'),
  requesterDuties: z.array(z.enum(['owner', 'secretary'])).min(1).max(2),
  approvals: z.array(z.object({ duty: z.enum(['chairman', 'president', 'concerned_leader']), name: z.string().trim().min(1).max(100), mode: z.enum(['会签', '或签']) }).strict()).min(1).max(12),
  protectedConflict: z.literal('block'),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.requesterDuties).size !== v.requesterDuties.length) ctx.addIssue({ code: 'custom', message: '发起职责不可重复' })
})
export type ProjectReplanPolicy = z.infer<typeof projectReplanPolicy>
const reason = z.string().trim().min(6).max(1000)
export const projectReplanPreviewInput = z.object({ targetDate: agentDate }).strict()
export const projectReplanSubmit = projectReplanPreviewInput.extend({ clientRequestId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), reason }).strict()
export const projectReplanAction = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), action: z.enum(['approve', 'reject', 'withdraw']), reason }).strict()
export type ReplanStage = { stage: string; date: string; actualDate: string | null; version: number; approvalId: string | null; independent: boolean }
export type ReplanTask = { id: string; stage: string | null; title: string; status: string; version: number; dueDate: string | null; dueTime: string | null; ownerUserId: string | null;
  baseline: { dueDate: string; dueTime: string; ownerUserId: string } | null; retired: boolean; pendingExtension: boolean; planActionId: string | null }
export type ReplanLeader = { id: string; taskId: string | null; status: string; version: number; sourceVersion: number | null; automatic: boolean }
export type ReplanChange = { kind: 'stage' | 'task' | 'leader'; id: string; label: string; before: string | null; after: string | null; action: 'move' | 'keep'; reason: string }
export type ReplanIssue = { code: string; message: string }
export type ReplanImpact = { targetDate: string; previousTargetDate: string | null; stages: ReplanChange[]; tasks: ReplanChange[]; leaders: ReplanChange[]; blockers: ReplanIssue[] }
export type ReplanPreview = ReplanImpact & { fingerprint: string; projectVersion: number; policyVersion: number | null; canSubmit: boolean }
const terminal = new Set(['已完成', '已关闭', '已取消', '已归档', '待验收', '待确认'])

export function calculateProjectReplan(input: { targetDate: string; previousTargetDate: string | null; today: string; currentStage: string; stages: ReplanStage[]; tasks: ReplanTask[]; leaders: ReplanLeader[]; policy: ProjectReplanPolicy | null }): ReplanImpact {
  agentDate.parse(input.targetDate); agentDate.parse(input.today)
  const result: ReplanImpact = { targetDate: input.targetDate, previousTargetDate: input.previousTargetDate, stages: [], tasks: [], leaders: [], blockers: [] }
  const block = (code: string, message: string) => result.blockers.push({ code, message })
  const policy = input.policy ? projectReplanPolicy.parse(input.policy) : null
  if (!policy) block('REPLAN_POLICY_REQUIRED', '整体重排日历、发起和独立审批规则尚未正式配置')
  if (policy?.calendarBasis === 'working') block('REPLAN_CALENDAR_UNSUPPORTED', '工作日及节假日重排尚未支持，不能按自然日替代')
  if (!agentDate.safeParse(input.previousTargetDate).success) block('REPLAN_TARGET_REQUIRED', '原目标日期未确定')
  if (input.targetDate <= input.today) block('REPLAN_TARGET_INVALID', '新目标日期必须晚于当前业务日期')
  if (input.targetDate === input.previousTargetDate) block('REPLAN_NO_CHANGE', '目标日期没有变化')
  const currentIndex = agentScheduleStages.indexOf(input.currentStage as typeof agentScheduleStages[number])
  if (currentIndex < 0 || input.stages.length !== agentScheduleStages.length || input.stages.some((s, i) => s.stage !== agentScheduleStages[i] || !agentDate.safeParse(s.date).success)) block('REPLAN_TIMELINE_INVALID', '当前投资阶段及完整八节点日期必须有效')
  if (!policy || policy.calendarBasis !== 'calendar' || !agentDate.safeParse(input.previousTargetDate).success || currentIndex < 0) return result
  const delta = Math.round((Date.parse(`${input.targetDate}T00:00:00Z`) - Date.parse(`${input.previousTargetDate}T00:00:00Z`)) / 86400000)
  for (const [i, stage] of input.stages.entries()) {
    const historical = i < currentIndex || Boolean(stage.actualDate), proposed = agentDayOffset(stage.date, delta)
    const keep = historical || stage.independent
    if (!historical && stage.independent && proposed !== stage.date) block('REPLAN_INDEPENDENT_STAGE', `${stage.stage}有独立批准日期，必须先裁决冲突，不能覆盖`)
    result.stages.push({ kind: 'stage', id: stage.stage, label: stage.stage, before: stage.date, after: keep ? stage.date : proposed, action: keep || delta === 0 ? 'keep' : 'move', reason: historical ? '保留已发生阶段及原计划事实' : stage.independent ? '保留独立批准日期' : '按显式自然日规则平移剩余节点' })
    if (!historical && !keep && proposed < input.today) block('REPLAN_STAGE_PAST', `${stage.stage}重排后早于当前业务日期`)
  }
  for (let i = 1; i < result.stages.length; i++) {
    const lower = input.stages[i - 1].actualDate ?? result.stages[i - 1].after!
    if (result.stages[i].action === 'move' && result.stages[i].after! <= lower) block('REPLAN_STAGE_ORDER', `${result.stages[i].label}与前一阶段实际/计划日期冲突`)
  }
  if (result.stages.at(-1)?.after !== input.targetDate) block('REPLAN_TARGET_INCONSISTENT', '保留事实或原日期基准与新目标日不一致，不能只修改项目目标字段')
  for (const task of input.tasks) {
    const stage = result.stages.find(s => s.id === task.stage), historical = terminal.has(task.status) || task.retired || stage?.action === 'keep' && input.stages.find(s => s.stage === task.stage)?.actualDate
    const protection = task.baseline ? timelineTaskProtection(task, task.baseline, task.pendingExtension, false) : '没有可安全重排的时间线来源'
    const move = !historical && !protection && stage?.action === 'move' && Boolean(task.dueDate)
    if (!historical && stage?.action === 'move' && protection) block('REPLAN_PROTECTED_TASK', `${task.title}：${protection}`)
    // Locked plan actions have their own immutable approval history. An explicit
    // plan-action mapping/exception policy is required before touching them.
    if (!historical && task.planActionId) block('REPLAN_PLAN_ACTION_UNSUPPORTED', `${task.title}属于独立批准倒排计划，尚缺整体重排映射政策`)
    const after = move ? agentDayOffset(task.dueDate!, delta) : task.dueDate
    if (move && after! < input.today) block('REPLAN_TASK_PAST', `${task.title}重排后早于当前业务日期`)
    if (!historical && after && after > input.targetDate) block('REPLAN_TASK_AFTER_TARGET', `${task.title}有效期限晚于新项目目标日`)
    result.tasks.push({ kind: 'task', id: task.id, label: task.title, before: task.dueDate, after, action: move ? 'move' : 'keep', reason: historical ? '保留已完成、已提交或已收起事实' : move ? '保留原行动 ID、责任人和相对节点间隔' : protection ?? '不属于本次剩余节点' })
  }
  for (const row of input.leaders) {
    const task = result.tasks.find(t => t.id === row.taskId), changed = task?.action === 'move'
    const protectedRow = !row.automatic || row.status !== 'requested' || row.version !== row.sourceVersion
    if (changed && protectedRow) block('REPLAN_PROTECTED_LEADER', `领导需求 ${row.id} 已人工处理或不属于自动来源，不能覆盖；请先按原权限处理`)
    result.leaders.push({ kind: 'leader', id: row.id, label: '关联领导时间需求', before: task?.before ?? null, after: changed && !protectedRow ? task.after : task?.before ?? null,
      action: changed && !protectedRow ? 'move' : 'keep', reason: protectedRow ? '保留人工协调、确认及终态安排' : changed ? '同步未经人工办理的来源需求；不代表领导确认' : '来源不受本次重排影响' })
  }
  return result
}

export type ReplanDashboard = { targetDate: string | null; canPreview: boolean; policyConfigured: boolean; policyIssue: string | null;
  requests: Array<{ id: string; revision: number; version: number; status: string; reason: string; currentNodeName: string; impact: ReplanImpact; canAct: boolean; canWithdraw: boolean;
    history: Array<{ action: string; actor: string; reason: string; at: string }> }> }
