import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { shanghaiToday, shiftDate } from '../../server/src/contracts/fdeWeeklyPlanContract'
import { timeInstant, timeLocal } from '../../server/src/contracts/fdeTimeContract'
import { calendarHourPixels, calendarMinuteAt, calendarPixelDelta, calendarTimeRange } from '../lib/calendarScale'

export type TimeGridItem = { key: string; id: string | null; source?: string; title: string; projectName?: string | null; startsAt: string; endsAt: string | null; editable: boolean; allDay?: boolean; warning?: boolean }
export type TimeProposal = { id: string; startsAt: string; durationMinutes: number; method: 'drag' | 'resize' | 'keyboard' }

type Props = {
  weekStart: string
  items: TimeGridItem[]
  onPropose: (proposal: TimeProposal) => void
  onOpen?: (key: string) => void
  onCreateAt?: (startsAt: string) => void
  showWeekends?: boolean
  overview?: boolean
  fitToHeight?: boolean
}

export function FdeTimeGrid({ weekStart, items, onPropose, onOpen, onCreateAt, showWeekends = false, overview = false, fitToHeight = false }: Props) {
  const viewport = useRef<HTMLDivElement>(null), heading = useRef<HTMLDivElement>(null)
  const [availableHeight, setAvailableHeight] = useState(0)
  type Gesture = { pointerId:number; row:TimeGridItem; mode:'drag'|'resize'; startX:number; startY:number; day:string; start:number; duration:number; gridLeft:number; trackWidth:number; hourPx:number }
  type Preview = { key:string; day:string; sourceDay:string; start:number; duration:number; mode:'drag'|'resize'; offsetX:number }
  const gesture = useRef<Gesture | null>(null)
  const suppressClick = useRef(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const days = Array.from({ length: showWeekends ? 7 : 5 }, (_, i) => shiftDate(weekStart, i))
  const gridColumns = `48px repeat(${days.length}, minmax(0, 1fr))`
  const normalizedItems = useMemo(() => items.map(item => item.allDay || item.endsAt ? item : {
    ...item,
    endsAt: new Date(new Date(item.startsAt).getTime() + 60 * 60000).toISOString(),
  }), [items])
  const range = useMemo(() => overview ? calendarTimeRange(normalizedItems, weekStart, showWeekends ? 7 : 5) : { start: 420, end: 1200 }, [normalizedItems, weekStart, showWeekends, overview])
  const hourPx = calendarHourPixels(availableHeight, range, fitToHeight)
  const hourCount = (range.end - range.start) / 60
  const isDateMarker = (item: TimeGridItem) => Boolean(item.allDay || (overview && item.endsAt && timeLocal(new Date(item.startsAt)).slice(0, 10) !== timeLocal(new Date(item.endsAt)).slice(0, 10)))
  const onDay = (item: TimeGridItem, day: string) => item.allDay
    ? timeLocal(new Date(item.startsAt)).slice(0, 10) === day
    : timeLocal(new Date(item.startsAt)) < `${shiftDate(day, 1)}T00:00` && Boolean(item.endsAt && timeLocal(new Date(item.endsAt)) > `${day}T00:00`)
  const markers = normalizedItems.filter(item => isDateMarker(item) && days.some(day => onDay(item, day)))
  useLayoutEffect(() => {
    if (!overview || !viewport.current || !heading.current) return
    const measure = () => {
      if (viewport.current!.clientHeight > 0) setAvailableHeight(Math.max(0, viewport.current!.clientHeight - heading.current!.offsetHeight - 16))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport.current); observer.observe(heading.current)
    measure()
    return () => observer.disconnect()
  }, [overview])
  function minute(value: string) {
    const local = timeLocal(new Date(value))
    return Number(local.slice(11, 13)) * 60 + Number(local.slice(14))
  }
  function localTime(day: string, minutes: number) {
    const value = Math.min(1439, Math.max(0, minutes))
    return `${day}T${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
  }
  const displayedItems = useMemo(() => normalizedItems.map(row => {
    if (!preview || row.key !== preview.key) return row
    const startsAt = timeInstant(localTime(preview.sourceDay, preview.start))
    return { ...row, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + preview.duration * 60000).toISOString() }
  }), [normalizedItems, preview])
  const placements = useMemo(() => {
    const result = new Map<string, { lane: number; count: number; conflict: boolean }>()
    for (const day of days) {
      const rows = displayedItems.filter(value => !isDateMarker(value) && timeLocal(new Date(value.startsAt)).slice(0, 10) === day && value.endsAt).sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      const visualEnd = (row: TimeGridItem) => Math.max(Date.parse(row.endsAt!), Date.parse(row.startsAt) + 24 / hourPx * 60 * 60000)
      const clusters: TimeGridItem[][] = []
      let cluster: TimeGridItem[] = []
      let clusterEnd = 0
      for (const row of rows) {
        const start = Date.parse(row.startsAt)
        if (cluster.length && start >= clusterEnd) {
          clusters.push(cluster)
          cluster = []
          clusterEnd = 0
        }
        cluster.push(row)
        clusterEnd = Math.max(clusterEnd, visualEnd(row))
      }
      if (cluster.length) clusters.push(cluster)
      for (const rowsInCluster of clusters) {
        const endByLane: number[] = []
        for (const row of rowsInCluster) {
          const start = Date.parse(row.startsAt), end = Date.parse(row.endsAt!)
          let lane = endByLane.findIndex(value => value <= start)
          if (lane < 0) lane = endByLane.length
          endByLane[lane] = visualEnd(row)
          const conflict = rowsInCluster.some(other => other.key !== row.key && Date.parse(other.startsAt) < end && Date.parse(other.endsAt!) > start)
          result.set(row.key, { lane, count: 1, conflict })
        }
        for (const row of rowsInCluster) result.get(row.key)!.count = Math.max(1, endByLane.length)
      }
    }
    return result
  }, [weekStart, displayedItems, showWeekends, hourPx, overview])
  function propose(row: TimeGridItem, day: string, start: number, durationMinutes: number, method: TimeProposal['method']) {
    if (!row.editable || !row.id) return
    const duration = Math.round(durationMinutes / 15) * 15
    if (duration < 15 || duration > range.end - range.start) return
    const normalizedStart = Math.max(range.start, Math.min(range.end - duration, Math.round(start / 15) * 15))
    onPropose({ id: row.id, startsAt: localTime(day, normalizedStart), durationMinutes: duration, method })
  }
  function beginPointer(event:ReactPointerEvent<HTMLElement>,row:TimeGridItem,mode:'drag'|'resize',day:string,start:number,duration:number){
    if(!row.editable||event.button!==0)return
    if(mode==='resize')event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const track=event.currentTarget.closest<HTMLElement>('[data-time-day]')
    const trackRect=track?.getBoundingClientRect()
    const trackWidth=trackRect?.width??0
    const dayIndex=Math.max(0,days.indexOf(day))
    const gridLeft=(trackRect?.left??event.clientX)-dayIndex*trackWidth
    gesture.current={pointerId:event.pointerId,row,mode,startX:event.clientX,startY:event.clientY,day,start,duration,gridLeft,trackWidth,hourPx}
  }
  function pointerPreview(active:Gesture, clientX:number, clientY:number):Preview {
    const delta=calendarPixelDelta(clientY-active.startY,active.hourPx)
    const targetIndex=active.trackWidth>0?Math.max(0,Math.min(days.length-1,Math.floor((clientX-active.gridLeft)/active.trackWidth))):Math.max(0,days.indexOf(active.day))
    const target=days[targetIndex]??active.day
    const duration=active.mode==='resize'?Math.max(15,Math.min(range.end-active.start,active.duration+delta)):active.duration
    const start=active.mode==='drag'?Math.max(range.start,Math.min(range.end-duration,active.start+delta)):active.start
    const targetDay=active.mode==='resize'?active.day:target
    const dayDelta=Math.max(0,days.indexOf(targetDay))-Math.max(0,days.indexOf(active.day))
    return {key:active.row.key,day:targetDay,sourceDay:active.day,start,duration,mode:active.mode,offsetX:active.mode==='drag'?dayDelta*active.trackWidth:0}
  }
  function movePointer(event:ReactPointerEvent<HTMLElement>){
    const active=gesture.current
    if(!active||active.pointerId!==event.pointerId)return
    if(Math.abs(event.clientX-active.startX)<=4&&Math.abs(event.clientY-active.startY)<=4)return
    event.preventDefault();event.stopPropagation()
    setPreview(pointerPreview(active,event.clientX,event.clientY))
  }
  function finishPointer(event:ReactPointerEvent<HTMLElement>){
    const active=gesture.current
    if(!active||active.pointerId!==event.pointerId)return
    gesture.current=null
    const moved=Math.abs(event.clientX-active.startX)>4||Math.abs(event.clientY-active.startY)>4
    if(!moved){setPreview(null);return}
    event.preventDefault();event.stopPropagation();suppressClick.current=true
    window.setTimeout(()=>{suppressClick.current=false},0)
    const next=pointerPreview(active,event.clientX,event.clientY)
    setPreview(null)
    propose(active.row,next.day,next.start,next.duration,active.mode)
  }
  function cancelPointer(){gesture.current=null;setPreview(null)}

  return <>
    <div ref={viewport} className="fde-collab-time-grid mt-4 overflow-x-auto rounded-xl border border-slate-200" data-days={days.length} data-overview={overview || undefined} data-scale={fitToHeight ? 'fit' : 'detail'} style={{ '--time-hour-px': `${hourPx}px`, '--time-quarter-px': `${hourPx / 4}px` } as CSSProperties}>
      <div className="fde-time-grid-frame">
        <div ref={heading} className="fde-time-grid-heading">
        <div className="grid border-b text-center text-xs" style={{ gridTemplateColumns: gridColumns }}>
          <div>时间</div>
          {days.map((day, i) => <div className="border-l p-2" data-today={day === shanghaiToday() || undefined} key={day}>{['周一', '周二', '周三', '周四', '周五', '周六', '周日'][i]}<br /><small>{Number(day.slice(8))}</small></div>)}
        </div>
        {markers.length > 0 && <div className="grid border-b bg-slate-50" style={{ gridTemplateColumns: gridColumns }} aria-label="全天事项">
          <div className="grid place-items-center p-1 text-xs text-slate-500">全天</div>
          {days.map(day => <div key={day} className="min-w-0 space-y-1 border-l p-1">{markers.filter(item => onDay(item, day)).map(item => <button type="button" key={item.key} onClick={() => onOpen?.(item.key)} title={item.title} className="w-full truncate rounded border border-[#a8c5c3] bg-[#e7f1ef] p-1 text-left text-xs text-[#315f68]">{!item.allDay && '跨日 · '}{item.title}</button>)}</div>)}
        </div>}
        </div>
        <div className="grid" style={{ gridTemplateColumns: gridColumns }}>
          <div className="relative text-xs text-slate-400" style={{ height: hourCount * hourPx }}>{Array.from({ length: hourCount + 1 }, (_, i) => <span key={i} className="absolute right-1" style={{ top: i * hourPx }}>{String(i + range.start / 60).padStart(2, '0')}:00</span>)}</div>
          {days.map(day => <div
            key={day}
            data-time-day={day}
            className="fde-collab-time-track relative border-l"
            style={{ height: hourCount * hourPx }}
            onClick={event => {
              if (!onCreateAt || event.target !== event.currentTarget) return
              const minutes = calendarMinuteAt(event.clientY - event.currentTarget.getBoundingClientRect().top, hourPx, range)
              onCreateAt(localTime(day, minutes))
            }}
            onDragOver={event => event.preventDefault()}
            onDrop={event => {
              event.preventDefault()
              let data: { key: string; resize: boolean }
              try { data = JSON.parse(event.dataTransfer.getData('application/x-fde-time')) } catch { return }
              const row = normalizedItems.find(value => value.key === data.key)
              if (!row?.editable || !row.endsAt) return
              const target = calendarMinuteAt(event.clientY - event.currentTarget.getBoundingClientRect().top, hourPx, range)
              const duration = (Date.parse(row.endsAt) - Date.parse(row.startsAt)) / 60000
              propose(row, day, data.resize ? minute(row.startsAt) : target, data.resize ? target - minute(row.startsAt) : duration, data.resize ? 'resize' : 'drag')
            }}
          >
            {displayedItems.filter(row => !isDateMarker(row) && row.endsAt && timeLocal(new Date(row.startsAt)).slice(0, 10) === day && minute(row.startsAt) >= range.start && minute(row.startsAt) + (Date.parse(row.endsAt!) - Date.parse(row.startsAt)) / 60000 <= range.end).map(row => {
              const start = minute(row.startsAt), duration = (Date.parse(row.endsAt!) - Date.parse(row.startsAt)) / 60000, placement = placements.get(row.key) ?? { lane: 0, count: 1, conflict: false }
              const active = preview?.key === row.key
              return <div key={row.key} data-editable={row.editable} data-compact={overview && duration * hourPx / 60 < 62 || undefined} data-dragging={active || undefined} data-conflict={placement.conflict || undefined} className={`fde-collab-time-block absolute overflow-hidden rounded-md border p-1 text-xs ${row.warning ? 'border-amber-300 bg-amber-50' : 'border-[#a8c5c3] bg-[#e7f1ef]'}`} style={{ top: (start - range.start) * hourPx / 60, height: Math.min((range.end - start) * hourPx / 60, Math.max(24, duration * hourPx / 60)), left: `${placement.lane * 100 / placement.count}%`, width: `${100 / placement.count}%`, transform: active&&preview.offsetX?`translateX(${preview.offsetX}px)`:undefined }}>
                <button type="button" title={`${row.title} · ${duration} 分钟${row.editable?'；拖动可移动，点击可编辑':''}`} aria-label={`${row.title} ${timeLocal(new Date(row.startsAt)).slice(11)}，${duration} 分钟`} className={`w-full text-left ${row.editable ? 'cursor-move' : 'cursor-default'}`} style={row.editable?{touchAction:'none'}:undefined} onPointerDown={event=>beginPointer(event,row,'drag',day,start,duration)} onPointerMove={movePointer} onPointerUp={finishPointer} onPointerCancel={cancelPointer} onLostPointerCapture={()=>{if(gesture.current)cancelPointer()}} onDoubleClick={event => event.stopPropagation()} onClick={event => {if(suppressClick.current){event.preventDefault();return}onOpen?.(row.key)}} onKeyDown={event => { if (!row.editable || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); const delta = event.key === 'ArrowUp' ? -15 : event.key === 'ArrowDown' ? 15 : 0; propose(row, shiftDate(day, event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0), event.shiftKey ? start : start + delta, event.shiftKey ? duration + delta : duration, 'keyboard') }}>
                  <span className="fde-collab-time-block-head"><strong>{timeLocal(new Date(row.startsAt)).slice(11)}</strong>{placement.conflict && <span className="fde-time-conflict">冲突</span>}</span><strong className="fde-collab-time-title block truncate">{row.title}</strong>{row.source === 'task' && <small className="block truncate text-xs leading-4 text-[#52736f]">{row.projectName || '个人任务'}</small>}
                </button>
                {row.editable && <span role="button" aria-label={`拉伸 ${row.title}`} title="上下拖动调整时长" className="fde-time-resize-handle absolute inset-x-0 bottom-0 cursor-ns-resize" style={{touchAction:'none'}} onPointerDown={event=>beginPointer(event,row,'resize',day,start,duration)} onPointerMove={movePointer} onPointerUp={finishPointer} onPointerCancel={cancelPointer} onLostPointerCapture={()=>{if(gesture.current)cancelPointer()}}><i/></span>}
              </div>
            })}
          </div>)}
        </div>
      </div>
    </div>
    <div className="fde-collab-time-mobile">{days.map((day, index) => {
      const rows = normalizedItems.filter(item => { const start = timeLocal(new Date(item.startsAt)); return item.endsAt ? start.slice(0, 10) <= day && timeLocal(new Date(item.endsAt)) > `${day}T00:00` : start.slice(0, 10) === day })
      return <section key={day}><header><strong>{['周一', '周二', '周三', '周四', '周五', '周六', '周日'][index]} · {Number(day.slice(8))}</strong><span><small>{rows.length} 项</small>{onCreateAt&&<button type="button" aria-label={`在${day}新增任务`} onClick={()=>onCreateAt(`${day}T09:00`)}>＋ 新增</button>}</span></header><div>{rows.length ? rows.map(row => <button key={row.key} onClick={() => onOpen?.(row.key)}><time>{row.allDay ? '全天' : timeLocal(new Date(row.startsAt)).slice(11)}</time><span><strong>{row.title}</strong><small>{row.source === 'task' ? row.projectName || '个人任务' : row.allDay ? '全天事项' : row.editable ? '可调整任务' : '业务事项'}</small></span></button>) : <p>暂无安排</p>}</div></section>
    })}</div>
  </>
}
