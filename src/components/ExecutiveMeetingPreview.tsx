import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { api } from '../lib/api'
import { formatShanghaiDateTime } from '../lib/dateTime'
import type { Meeting } from '../types'
import { Button, Drawer, LoadingState, StatusBadge } from './ui'

export function ExecutiveMeetingPreview({ id, onClose }: { id: string; onClose: () => void }) {
  const navigate = useNavigate()
  const root = useRef<HTMLDivElement>(null)
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [error, setError] = useState(''), [revision, setRevision] = useState(0)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    root.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    return () => { document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setMeeting(null); setError('')
    void api<Meeting>(`/meetings/${id}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) })
      .then(value => { if (!controller.signal.aborted) setMeeting(value) })
      .catch(() => { if (!controller.signal.aborted) setError('会议暂时无法读取，请重试或确认您仍有访问权限。') })
    return () => controller.abort()
  }, [id, revision])
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])
  return <div ref={root} onKeyDown={event => {
    if (event.key !== 'Tab') return
    const buttons = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])
    const first = buttons[0], last = buttons.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}><Drawer open title={meeting?.title || '会议详情'} onClose={onClose} footer={meeting && <>
    <Button variant="secondary" onClick={onClose}>返回工作屏</Button>
    <Button onClick={() => navigate(`/meetings?meeting=${id}`)}>进入会议<ArrowRight size={15} /></Button>
  </>}>
    {error ? <div role="alert" className="space-y-4"><p className="text-sm text-slate-500">{error}</p><Button variant="secondary" onClick={() => setRevision(value => value + 1)}>重试</Button></div> : !meeting ? <LoadingState rows={3} /> : <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2"><StatusBadge status={meeting.status} /><span className="text-sm text-slate-500">{meeting.type}</span></div>
      <dl className="grid grid-cols-1 gap-5 text-sm sm:grid-cols-2">
        <div className="sm:col-span-2"><dt className="mb-1 text-xs text-slate-400">会议时间</dt><dd>{formatShanghaiDateTime(meeting.meetingTime)}{meeting.meetingEndTime && ` — ${formatShanghaiDateTime(meeting.meetingEndTime, { hour: '2-digit', minute: '2-digit' })}`}</dd></div>
        <div><dt className="mb-1 text-xs text-slate-400">所属项目</dt><dd>{meeting.projectName || '未关联项目'}</dd></div>
        <div><dt className="mb-1 text-xs text-slate-400">参会人员</dt><dd>{meeting.participants.join('、') || '待确认'}</dd></div>
      </dl>
      {[['会议目的', meeting.purpose], ['会前准备', meeting.requirements], ['会议纪要', meeting.summary], ['会议结论', meeting.conclusions.join('\n')]].filter(([, text]) => text).map(([title, text]) => <section key={title} className="border-t border-slate-100 pt-5"><h3 className="mb-2 text-sm font-semibold">{title}</h3><p className="whitespace-pre-wrap text-sm leading-7 text-slate-600">{text}</p></section>)}
    </div>}
  </Drawer></div>
}
