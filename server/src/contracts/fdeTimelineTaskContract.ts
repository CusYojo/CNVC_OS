import { z } from 'zod'
import { agentDayOffset } from './fdeProjectAgentContract.js'

export const timelineSyncInput = z.object({ clientRequestId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type TimelineSyncSource = 'manual' | 'classification' | 'stage' | 'material' | 'plan' | 'governance' | 'task' | 'weekly' | 'type_execution' | 'replan'
export const timelineSourceLabels: Record<TimelineSyncSource, string> = { manual: '人工对账', classification: '初筛入库', stage: '阶段审批', material: '材料变更', plan: '计划修订', governance: '职责变更', task: '行动执行变更', weekly: '人工周计划领导需求', type_execution: '非投资计划领导需求', replan: '整体重排独立批准' }
export type TimelinePending = { count: number; items: Array<{ id: string; source: TimelineSyncSource; issues: string[] }> }
export type TimelineProposal = { key: string; stage: string; title: string; duty: 'owner' | 'secretary' | 'finance' | 'legal'; dueDate: string; dueTime: string; deliverable: string; critical: boolean; needLeader: boolean }
export function timelineTaskProposals(stage: string, date: string, missing: Array<{ key: string; label: string }>, leadership: boolean): TimelineProposal[] {
  const make = (key: string, title: string, duty: TimelineProposal['duty'], days: number, dueTime: string, deliverable: string, critical = false, needLeader = false): TimelineProposal => ({ key, stage, title, duty, dueDate: agentDayOffset(date, -days), dueTime, deliverable, critical, needLeader })
  if (stage === '入库') return [make('intake', '完成项目初筛并发起立项', 'owner', 0, '18:00', '确认是否进入立项、保持普通跟进或暂不推进', true)]
  if (stage === '尽调计划审核') return [] // The approval itself is the system-generated action.
  const materials = missing.map((item, index) => make(`material:${item.key}`, `补齐${item.label}`, /财务/.test(item.label) ? 'finance' : /法律|法务|合规|条款/.test(item.label) ? 'legal' : index ? 'owner' : 'secretary', Math.max(1, missing.length - index), '18:00', `上传并关联“${item.label}”，完成${stage}准入核验`))
  const conclusion = make('conclusion', `提交${stage}阶段结论`, 'secretary', 0, '12:00', `完成${stage}材料核验并提交阶段结论`, true)
  const meetings = stage === '启动尽调' ? [make('team_formal', '核心团队正式会面', 'secretary', 5, '16:00', '两位领导参与核心团队交流，形成团队判断纪要', true, true), make('team_informal', '核心团队非正式交流', 'secretary', 3, '19:00', '结合深度交流补充团队韧性与价值观判断', true, true)]
    : leadership ? [make('leadership_review', `完成${stage}阶段领导复核`, 'secretary', 0, '16:00', '取得本阶段有效领导职责的意见并形成可追溯结论', true, true)] : []
  return [...materials, conclusion, ...meetings]
}

export type TimelineChange = { taskId: string | null; stage: string; key: string; title: string; action: 'add' | 'update' | 'retire' | 'restore' | 'keep'; reason: string; ownerUserId: string | null; ownerName: string; dueDate: string | null; dueTime: string | null; previousDate: string | null; previousTime: string | null; proposal: TimelineProposal | null }
export type TimelinePreview = { fingerprint: string; canSync: boolean; changes: TimelineChange[]; issues: string[]; stage: string; date: string }

// Completed/submitted facts and independently extended deadlines are not template data.
export function timelineTaskProtection(task: { status: string; dueDate: string | null; dueTime: string | null; ownerUserId: string | null }, baseline: { dueDate: string; dueTime: string; ownerUserId: string }, pendingExtension: boolean, automaticRetirement: boolean) {
  if (pendingExtension) return '存在未决延期，保留原期限'
  if (['已完成', '已关闭', '待验收', '待确认', '已归档'].includes(task.status) || (task.status === '已取消' && !automaticRetirement)) return '已终结或待验收事实不由时间线改写'
  if (task.dueDate !== baseline.dueDate || task.dueTime !== baseline.dueTime) return '已有独立期限变更，保留当前有效期限'
  if (task.ownerUserId !== baseline.ownerUserId) return '负责人已独立变更，请人工核对'
  return null
}
