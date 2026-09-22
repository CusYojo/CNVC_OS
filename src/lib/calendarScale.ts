import { timeLocal } from '../../server/src/contracts/fdeTimeContract'
import { shiftDate } from '../../server/src/contracts/fdeWeeklyPlanContract'

export type CalendarTimeRange = { start: number; end: number }
type ScheduledItem = { startsAt: string; endsAt: string | null; allDay?: boolean }

export function calendarTimeRange(items: ScheduledItem[], weekStart: string, dayCount: number): CalendarTimeRange {
  let start = 420, end = 1200
  const weekEnd = shiftDate(weekStart, dayCount)
  for (const item of items) {
    if (item.allDay || !item.endsAt || !Number.isFinite(Date.parse(item.startsAt)) || !Number.isFinite(Date.parse(item.endsAt))) continue
    const from = timeLocal(new Date(item.startsAt)), to = timeLocal(new Date(item.endsAt))
    const day = from.slice(0, 10)
    // Multi-day arrangements live in the date strip rather than stretching every hour column.
    if (day < weekStart || day >= weekEnd || day !== to.slice(0, 10) || to <= from) continue
    start = Math.min(start, Number(from.slice(11, 13)) * 60)
    end = Math.max(end, Math.ceil((Number(to.slice(11, 13)) * 60 + Number(to.slice(14, 16))) / 60) * 60)
  }
  return { start, end }
}

export function calendarHourPixels(availableHeight: number, range: CalendarTimeRange, fit: boolean): number {
  if (!fit) return 52
  if (availableHeight <= 0) return 36
  // Never shrink text/hit areas indefinitely on a short screen: allow scrolling below this limit.
  return Math.max(24, Math.min(64, Math.floor(availableHeight / ((range.end - range.start) / 60) * 10) / 10))
}

export function calendarPixelDelta(pixels: number, hourPixels: number): number {
  return Math.round(pixels / (hourPixels / 4)) * 15
}

export function calendarMinuteAt(pixels: number, hourPixels: number, range: CalendarTimeRange): number {
  return Math.max(range.start, Math.min(range.end - 15, range.start + calendarPixelDelta(pixels, hourPixels)))
}
