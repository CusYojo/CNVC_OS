import { useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { shiftDate } from '../../server/src/contracts/fdeWeeklyPlanContract'
import { timeLocal } from '../../server/src/contracts/fdeTimeContract'

export type TimeGridItem = { key: string; id: string | null; source?: string; title: string; projectName?: string | null; startsAt: string; endsAt: string | null; editable: boolean; allDay?: boolean; warning?: boolean }
export type TimeProposal = { id: string; startsAt: string; durationMinutes: number; method: 'drag' | 'resize' | 'keyboard' }

type Props = {
  weekStart: string
  items: TimeGridItem[]
  onPropose: (proposal: TimeProposal) => void
  onOpen?: (key: string) => void
  onCreateAt?: (startsAt: string) => void
}

export function FdeTimeGrid({ weekStart, items, onPropose, onOpen, onCreateAt }: Props) {
  const hourPx = 52
  const gesture = useRef<{ pointerId:number; row:TimeGridItem; mode:'drag'|'resize'; startX:number; startY:number; day:string; start:number; duration:number } | null>(null)
  const suppressClick = useRef(false)
  const days = Array.from({ length: 7 }, (_, i) => shiftDate(weekStart, i))
  const markers = items.filter(item => (item.allDay || !item.endsAt) && days.includes(timeLocal(new Date(item.startsAt)).slice(0, 10)))
  const placements = useMemo(() => {
    const result = new Map<string, { lane: number; count: number }>()
    for (const day of days) {
      const endByLane: number[] = []
      const rows = items.filter(value => timeLocal(new Date(value.startsAt)).slice(0, 10) === day && value.endsAt).sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      for (const row of rows) {
        const start = Date.parse(row.startsAt), end = Date.parse(row.endsAt!)
        let lane = endByLane.findIndex(value => value <= start)
        if (lane < 0) lane = endByLane.length
        endByLane[lane] = end
        result.set(row.key, { lane, count: 1 })
      }
      for (const row of rows) result.get(row.key)!.count = Math.max(1, endByLane.length)
    }
    return result
  }, [weekStart, items])

  function minute(value: string) {
    const local = timeLocal(new Date(value))
    return Number(local.slice(11, 13)) * 60 + Number(local.slice(14))
  }
  function localTime(day: string, minutes: number) {
    const value = Math.min(1185, Math.max(420, minutes))
    return `${day}T${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
  }
  function propose(row: TimeGridItem, day: string, start: number, durationMinutes: number, method: TimeProposal['method']) {
    if (!row.editable || !row.id) return
    const duration = Math.round(durationMinutes / 15) * 15
    if (duration < 15 || duration > 780) return
    const normalizedStart = Math.max(420, Math.min(1200 - duration, Math.round(start / 15) * 15))
    onPropose({ id: row.id, startsAt: localTime(day, normalizedStart), durationMinutes: duration, method })
  }
  function beginPointer(event:ReactPointerEvent<HTMLElement>,row:TimeGridItem,mode:'drag'|'resize',day:string,start:number,duration:number){
    if(!row.editable||event.button!==0)return
    if(mode==='resize')event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current={pointerId:event.pointerId,row,mode,startX:event.clientX,startY:event.clientY,day,start,duration}
  }
  function finishPointer(event:ReactPointerEvent<HTMLElement>){
    const active=gesture.current
    if(!active||active.pointerId!==event.pointerId)return
    gesture.current=null
    const delta=Math.round((event.clientY-active.startY)/(hourPx/4))*15
    const moved=Math.abs(event.clientX-active.startX)>4||Math.abs(event.clientY-active.startY)>4
    if(!moved)return
    event.preventDefault();event.stopPropagation();suppressClick.current=true
    window.setTimeout(()=>{suppressClick.current=false},0)
    const target=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-time-day]')?.dataset.timeDay??active.day
    propose(active.row,active.mode==='resize'?active.day:target,active.start+(active.mode==='drag'?delta:0),active.duration+(active.mode==='resize'?delta:0),active.mode)
  }

  return <>
    <div className="fde-collab-time-grid mt-4 overflow-x-auto rounded-xl border border-slate-200">
      <p className="border-b bg-slate-50 px-3 py-2 text-xs text-slate-500">双击空白时间新建任务 · 拖动任务改时间 · 拉动底部改时长</p>
      <div className="min-w-[840px]">
        <div className="grid grid-cols-[48px_repeat(7,minmax(0,1fr))] border-b text-center text-xs">
          <div>时间</div>
          {days.map((day, i) => <div className="border-l p-2" key={day}>{['周一', '周二', '周三', '周四', '周五', '周六', '周日'][i]}<br /><small>{Number(day.slice(8))}</small></div>)}
        </div>
        {markers.length > 0 && <div className="grid grid-cols-[48px_repeat(7,minmax(0,1fr))] border-b bg-slate-50" aria-label="日期与截止标记">
          <div className="p-1 text-[10px] text-slate-500">日期/<br />截止</div>
          {days.map(day => <div key={day} className="min-w-0 space-y-1 border-l p-1">{markers.filter(item => timeLocal(new Date(item.startsAt)).slice(0, 10) === day).map(item => <p key={item.key} className="break-words rounded border border-[#a8c5c3] bg-[#e7f1ef] p-1 text-[10px] text-[#315f68]">{item.title}{!item.allDay && ` · ${timeLocal(new Date(item.startsAt)).slice(11)}`}</p>)}</div>)}
        </div>}
        <div className="grid grid-cols-[48px_repeat(7,minmax(0,1fr))]">
          <div className="relative text-[10px] text-slate-400" style={{ height: 13 * hourPx }}>{Array.from({ length: 14 }, (_, i) => <span key={i} className="absolute right-1" style={{ top: i * hourPx }}>{String(i + 7).padStart(2, '0')}:00</span>)}</div>
          {days.map(day => <div
            key={day}
            data-time-day={day}
            className="fde-collab-time-track relative border-l"
            style={{ height: 13 * hourPx, backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0, transparent 51px, #e2e8f0 51px, #e2e8f0 52px)' }}
            onDoubleClick={event => {
              if (!onCreateAt || event.target !== event.currentTarget) return
              const minutes = 420 + Math.round((event.clientY - event.currentTarget.getBoundingClientRect().top) / (hourPx / 4)) * 15
              onCreateAt(localTime(day, minutes))
            }}
            onDragOver={event => event.preventDefault()}
            onDrop={event => {
              event.preventDefault()
              let data: { key: string; resize: boolean }
              try { data = JSON.parse(event.dataTransfer.getData('application/x-fde-time')) } catch { return }
              const row = items.find(value => value.key === data.key)
              if (!row?.editable || !row.endsAt) return
              const target = 420 + Math.round((event.clientY - event.currentTarget.getBoundingClientRect().top) / (hourPx / 4)) * 15
              const duration = (Date.parse(row.endsAt) - Date.parse(row.startsAt)) / 60000
              propose(row, day, data.resize ? minute(row.startsAt) : target, data.resize ? target - minute(row.startsAt) : duration, data.resize ? 'resize' : 'drag')
            }}
          >
            {items.filter(row => !row.allDay && row.endsAt && timeLocal(new Date(row.startsAt)).slice(0, 10) === day && minute(row.startsAt) >= 420 && minute(row.startsAt) + (Date.parse(row.endsAt!) - Date.parse(row.startsAt)) / 60000 <= 1200).map(row => {
              const start = minute(row.startsAt), duration = (Date.parse(row.endsAt!) - Date.parse(row.startsAt)) / 60000, placement = placements.get(row.key) ?? { lane: 0, count: 1 }
              return <div key={row.key} data-editable={row.editable} className={`fde-collab-time-block absolute overflow-hidden rounded-md border p-1 text-[10px] ${row.warning ? 'border-amber-300 bg-amber-50' : 'border-[#a8c5c3] bg-[#e7f1ef]'}`} style={{ top: (start - 420) * hourPx / 60, height: Math.max(24, duration * hourPx / 60), left: `${placement.lane * 100 / placement.count}%`, width: `${100 / placement.count}%` }}>
                <button type="button" aria-label={`${row.title} ${timeLocal(new Date(row.startsAt)).slice(11)}`} className={`w-full text-left ${row.editable ? 'cursor-move' : 'cursor-default'}`} style={row.editable?{touchAction:'none'}:undefined} onPointerDown={event=>beginPointer(event,row,'drag',day,start,duration)} onPointerUp={finishPointer} onPointerCancel={()=>{gesture.current=null}} onDoubleClick={event => event.stopPropagation()} onClick={event => {if(suppressClick.current){event.preventDefault();return}onOpen?.(row.key)}} onKeyDown={event => { if (!row.editable || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); const delta = event.key === 'ArrowUp' ? -15 : event.key === 'ArrowDown' ? 15 : 0; propose(row, shiftDate(day, event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0), event.shiftKey ? start : start + delta, event.shiftKey ? duration + delta : duration, 'keyboard') }}>
                  <span className="fde-collab-time-block-head"><strong>{timeLocal(new Date(row.startsAt)).slice(11)}</strong><span>{duration}m</span></span><strong className="fde-collab-time-title block truncate">{row.title}</strong>{row.source === 'task' && <small className="block truncate text-[9px] leading-3 text-[#52736f]">{row.projectName || '个人任务'}</small>}
                </button>
                {row.editable && <span role="button" aria-label={`拉伸 ${row.title}`} className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize bg-[#315f68]/20" style={{touchAction:'none'}} onPointerDown={event=>beginPointer(event,row,'resize',day,start,duration)} onPointerUp={finishPointer} onPointerCancel={()=>{gesture.current=null}} />}
              </div>
            })}
          </div>)}
        </div>
      </div>
    </div>
    <div className="fde-collab-time-mobile">{days.map((day, index) => {
      const rows = items.filter(item => { const start = timeLocal(new Date(item.startsAt)); return item.endsAt ? start.slice(0, 10) <= day && timeLocal(new Date(item.endsAt)) > `${day}T00:00` : start.slice(0, 10) === day })
      return <section key={day}><header><strong>{['周一', '周二', '周三', '周四', '周五', '周六', '周日'][index]} · {Number(day.slice(8))}</strong><small>{rows.length} 项</small></header><div>{rows.length ? rows.map(row => <button key={row.key} onClick={() => onOpen?.(row.key)}><time>{row.allDay ? '全天' : timeLocal(new Date(row.startsAt)).slice(11)}</time><span><strong>{row.title}</strong><small>{row.source === 'task' ? row.projectName || '个人任务' : !row.endsAt ? '日期 / 截止' : row.editable ? '可调整任务' : '业务任务'}</small></span></button>) : <p>暂无安排</p>}</div></section>
    })}</div>
  </>
}
