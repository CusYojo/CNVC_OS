import { z } from 'zod'
import { fdeWeekStart, shiftDate } from './fdeWeeklyPlanContract.js'
import { agentDate } from './fdeProjectAgentContract.js'

// Optional opt-in preserves existing calendar and report source semantics.
export const milestoneQueryFlag = z.enum(['true', 'false']).optional().transform(value => value === 'true')
export type ApprovedMilestoneFact = {
  id: string; projectId: string; projectName: string; stage: string; date: string; version: number;
  approvalId: string; previousDate: string; approvedAt: string; ownerId: string | null; ownerName: string;
  sourceKind?: 'replan';
}
export function milestoneInWeek(date: string, week: string) {
  agentDate.parse(date); fdeWeekStart.parse(week)
  return date >= week && date < shiftDate(week, 7)
}
export function milestoneSourceTarget(item: Pick<ApprovedMilestoneFact, 'projectId' | 'approvalId' | 'sourceKind'>) {
  if (item.sourceKind === 'replan') return `/projects/${item.projectId}?tab=workflow&replan=${item.approvalId}#project-replan-${item.approvalId}`
  return `/projects/${item.projectId}?tab=workflow&schedule=${item.approvalId}#agent-schedule-${item.approvalId}`
}
export function milestoneReportBody(items: ApprovedMilestoneFact[]) {
  return `已批准节点日期（生成时有效；不计任务完成、不代表阶段通过）\n${items.map(item => `- ${item.projectName} · ${item.stage}：${item.previousDate} → ${item.date}；日期版本 v${item.version}；审批 ${item.approvalId}`).join('\n') || '所选范围无本周节点日期或本周获批的有效改期'}\n\n`
}
