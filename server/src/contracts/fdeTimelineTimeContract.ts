import { fdeDate, fdeDueTime } from './fdeTaskContract.js'

// FDE participation is not the approval matrix: both executive duties participate in DD.
export function timelineLeaderDuties(stage: string): Array<'concerned_leader' | 'chairman' | 'president'> {
  if (stage === '立项') return ['concerned_leader']
  return ['启动尽调', '内核', '投决', '打款'].includes(stage) ? ['chairman', 'president'] : []
}

// Preserve the reference's 45-minute deterministic preferred/alternative proposals, not its fixed week.
export function timelineLeaderSlots(projectId: string, taskId: string, leaderId: string, date: string, dueTime: string) {
  fdeDate.parse(date); fdeDueTime.parse(dueTime)
  const seed = [...`${projectId}${taskId}${leaderId}`].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  const hours = [9, 10, 11, 14, 15, 16], minute = seed % 2 ? '30' : '00'
  return { preferredStart: `${date}T${hours[seed % hours.length].toString().padStart(2, '0')}:${minute}`, alternativeStart: `${date}T${hours[(seed + 2) % hours.length].toString().padStart(2, '0')}:${minute}`, latestFinish: `${date}T${dueTime}`, durationMinutes: 45 }
}

export type TimelineTimeSourceView = { needed: boolean; changed: boolean; reason: string; deadline: string | null; kind?: 'weekly' | 'type_execution' }
export const timeSourceLabel = (kind?: TimelineTimeSourceView['kind']) => kind === 'type_execution' ? '非投资计划行动' : kind === 'weekly' ? '周计划行动' : '流程行动'
