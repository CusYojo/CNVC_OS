import { officeDefinition, type OfficeDefinition } from './fdeOfficeContract.js'
import { timeInstant } from './fdeTimeContract.js'
import { shiftDate } from './fdeWeeklyPlanContract.js'

// Dates describe an approved itinerary, not a fabricated 24-hour reservation.
// Only leave has an explicit time interval; neither is proof of execution.
export function officeCalendarWindow(raw: unknown, applicantId: string) {
  const parsed = officeDefinition.safeParse(raw)
  if (!parsed.success) return null
  const d: OfficeDefinition['details'] = parsed.data.details
  if (d.kind === '出差' && d.startDate && d.endDate && d.endDate >= d.startDate && d.travelerIds.length) {
    return { ownerIds: [...d.travelerIds].sort(), startsAt: timeInstant(`${d.startDate}T00:00`), endsAt: timeInstant(`${shiftDate(d.endDate, 1)}T00:00`), allDay: true }
  }
  if (d.kind === '请假' && d.startAt && d.endAt && d.endAt > d.startAt) {
    return { ownerIds: [applicantId], startsAt: timeInstant(d.startAt), endsAt: timeInstant(d.endAt), allDay: false }
  }
  return null
}

export const officeSourceActionLabels: Record<string, string> = { submit: '提交', approve: '同意', return: '退回', reject: '拒绝', withdraw: '撤回', transfer: '转交' }
export type OfficeReportSource = {
  id: string; projectId: string | null; title: string; kind: string; status: string;
  version: number; revision: number; accessUserIds: string[];
  actions: Array<{ id: string; action: string; occurredAt: string }>
}
