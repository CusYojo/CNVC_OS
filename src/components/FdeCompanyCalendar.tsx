import { Fragment } from 'react'
import { shiftDate } from '../../server/src/contracts/fdeWeeklyPlanContract'
import { timeLocal, timeInstant } from '../../server/src/contracts/fdeTimeContract'

export type CompanyCalendarItem = { key: string; ownerId: string; ownerName: string; source: string; title: string; startsAt: string; endsAt: string | null; allDay: boolean }
export function calendarItemOnDay(item: CompanyCalendarItem, day: string) {
  const start = timeInstant(`${day}T00:00`).getTime(), end = timeInstant(`${shiftDate(day, 1)}T00:00`).getTime()
  return item.endsAt ? Date.parse(item.startsAt) < end && Date.parse(item.endsAt) > start : Date.parse(item.startsAt) >= start && Date.parse(item.startsAt) < end
}
export function FdeCompanyCalendar({ week, items }: { week: string; items: CompanyCalendarItem[] }) {
  const days = Array.from({ length: 5 }, (_, index) => shiftDate(week, index))
  // Identity comes only from the redacted server calendar, never from title/name guesses.
  const people = Array.from(new Map(items.map(item => [item.ownerId, { id: item.ownerId, name: item.ownerName }])).values())
  const event = (item: CompanyCalendarItem) => <div key={item.key} className="fde-collab-company-event" data-source={item.source}><time>{item.allDay ? '全天' : timeLocal(new Date(item.startsAt)).slice(11)}</time><span title={item.title}>{item.title}{!item.endsAt && ' · 截止'}</span></div>
  return <>
    <div className="fde-collab-company-scroll"><div className="fde-collab-company-grid"><div>成员</div>{days.map((day, index) => <div key={day} className="fde-collab-company-day"><strong>{['周一', '周二', '周三', '周四', '周五'][index]}</strong><small>{day.slice(5)} 日</small></div>)}{people.map(person => <Fragment key={person.id}><div className="fde-collab-company-person"><span className="fde-collab-avatar">{person.name.slice(0, 1)}</span><strong>{person.name}</strong></div>{days.map(day => <div key={day} className="fde-collab-company-cell">{items.filter(item => item.ownerId === person.id && calendarItemOnDay(item, day)).map(event)}{!items.some(item => item.ownerId === person.id && calendarItemOnDay(item, day)) && <span>—</span>}</div>)}</Fragment>)}</div></div>
    <div className="fde-collab-company-mobile">{days.map((day, index) => <section key={day}><h3>{['周一', '周二', '周三', '周四', '周五'][index]} · {day.slice(5)}</h3>{people.map(person => { const events = items.filter(item => item.ownerId === person.id && calendarItemOnDay(item, day)); return events.length > 0 && <article key={person.id}><strong>{person.name}</strong>{events.map(event)}</article> })}{!items.some(item => calendarItemOnDay(item, day)) && <p>暂无公司安排</p>}</section>)}</div>
    {!people.length && <div className="fde-collab-state">本周暂无可展示的公司安排。</div>}
  </>
}
