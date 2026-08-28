import { z } from 'zod'
import { agentDate, agentDayOffset, projectedAgentStageDate } from './fdeProjectAgentContract.js'

export const agentScheduleSubmit = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), requestedDate: agentDate, reason: z.string().trim().min(6).max(600) }).strict()
export const agentScheduleAction = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), action: z.enum(['approve', 'reject', 'withdraw']), reason: z.string().trim().min(6).max(600) }).strict()
export const agentScheduleStages = ['入库', '立项', '尽调计划制定', '尽调计划审核', '启动尽调', '内核', '投决', '打款'] as const
export type AgentStageDate = { stage: string; date: string; basis: 'cycle_projection' | 'approved'; version: number; approvalId: string | null; actualDate: string | null }
export function buildAgentTimeline(targetDate: string | null, cycleDays: number, overrides: Array<{ stage: string; plannedDate: string; version: number; approvalId: string }>, actualDates: Record<string, string> = {}): AgentStageDate[] {
  return agentScheduleStages.flatMap(stage => {
    const override = overrides.find(item => item.stage === stage), date = override?.plannedDate ?? projectedAgentStageDate(stage, targetDate, cycleDays)
    return date ? [{ stage, date: agentDate.parse(date), basis: override ? 'approved' as const : 'cycle_projection' as const, version: override?.version ?? 0, approvalId: override?.approvalId ?? null, actualDate: actualDates[stage] ?? null }] : []
  })
}
export function agentScheduleWindow(timeline: AgentStageDate[], stage: string, targetDate: string | null, today: string) {
  const index = timeline.findIndex(item => item.stage === stage), current = timeline[index]
  if (!current || !targetDate || timeline.length !== 8) return null
  const previous = timeline[index - 1], next = timeline[index + 1]
  const lower = previous ? agentDayOffset(previous.actualDate ?? previous.date, 1) : today
  const minimum = lower > today ? lower : today
  const maximum = next ? agentDayOffset(next.date, -1) : targetDate
  return { currentDate: current.date, minimum, maximum, available: minimum <= maximum }
}
export type AgentScheduleDashboard = {
  timeline: AgentStageDate[]; window: ReturnType<typeof agentScheduleWindow>;
  submissions: Array<{ recommendationId: string; version: number; date: string }>;
  approvals: Array<{ id: string; recommendationId: string; stage: string; previousDate: string; requestedDate: string; status: string; version: number; reason: string; currentNodeName: string;
    canApprove: boolean; canWithdraw: boolean; stale: boolean;
    nodes: Array<{ name: string; status: string; approverNames: string[] }>;
    history: Array<{ action: string; actor: string; reason: string; at: string }> }>;
}
