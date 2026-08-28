import { intervalsOverlap, timeEnd, timeInstant, timeLocal, validLeaderSlot } from './fdeTimeContract.js'
import { shiftDate } from './fdeWeeklyPlanContract.js'

export type ScheduleCandidate = { id: string; leaderId: string; priority: string; latestFinish: string | null; preferredStart: string; alternativeStart: string | null; durationMinutes: number }
export type BusyInterval = { startsAt: string; endsAt: string }

// Pure deterministic planner: never changes an approved time, a requested duration, or a project date.
export function planLeadershipTimes(candidates: ScheduleCandidate[], occupied: Record<string, BusyInterval[]>, weekStart: string, now: Date) {
  const days = Array.from({ length: 7 }, (_, index) => shiftDate(weekStart, index))
  const busy = new Map(Object.entries(occupied).map(([id, rows]) => [id, rows.map(row => ({ start: new Date(row.startsAt), end: new Date(row.endsAt) }))]))
  const order: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }
  // FDE latest is a ranking deadline, not an unapproved hard cut-off. Unknown legacy values sort last.
  const sorted = [...candidates].sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9)
    || (a.latestFinish ?? '9999-12-31T23:59:59.999Z').localeCompare(b.latestFinish ?? '9999-12-31T23:59:59.999Z') || a.id.localeCompare(b.id))
  return sorted.map(row => {
    const intervals = busy.get(row.leaderId) ?? []
    const free = (local: string) => days.includes(local.slice(0, 10)) && validLeaderSlot(local, row.durationMinutes) && timeInstant(local) >= now
      && !intervals.some(slot => intervalsOverlap(timeInstant(local), timeEnd(timeInstant(local), row.durationMinutes), slot.start, slot.end))
    const preferred = timeLocal(new Date(row.preferredStart)), alternative = row.alternativeStart ? timeLocal(new Date(row.alternativeStart)) : null
    let chosen: string | null = [preferred, alternative].find((value): value is string => Boolean(value && free(value))) ?? null
    const preferredIndex = Math.max(0, days.indexOf(preferred.slice(0, 10)))
    const dateOrder = [...days.slice(preferredIndex), ...days.slice(0, preferredIndex)]
    for (const date of dateOrder) {
      if (chosen) break
      const start = date === preferred.slice(0, 10) ? Math.max(420, Number(preferred.slice(11, 13)) * 60 + Number(preferred.slice(14, 16))) : 540
      const slots = [...Array.from({ length: Math.max(0, Math.ceil((1200 - start) / 15)) }, (_, i) => start + i * 15), ...Array.from({ length: Math.max(0, Math.ceil((start - 420) / 15)) }, (_, i) => 420 + i * 15)]
      for (const minute of slots) {
        const local = `${date}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
        if (free(local)) { chosen = local; break }
      }
    }
    if (chosen) { intervals.push({ start: timeInstant(chosen), end: timeEnd(timeInstant(chosen), row.durationMinutes) }); busy.set(row.leaderId, intervals) }
    return { id: row.id, scheduledStart: chosen ? timeInstant(chosen).toISOString() : null }
  })
}
