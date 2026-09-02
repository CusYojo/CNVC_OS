import { useEffect, useState } from 'react'
import { apiGet } from '../lib/api'
import { mapCollaborationProjects } from '../lib/fdeCollaborationView'
import type { Project } from '../types'
import type { WeeklyReportFacts } from '../../server/src/contracts/fdeWeeklyReportContract'
import { Button } from './ui'

type Report = { id: string; own: boolean; restricted: boolean; status: string; body: string; facts: WeeklyReportFacts | null }
type Meeting = { id: string; title: string; meetingTime: string; participants: string[]; type: string; status: string }
export function FdeCollaborationReview({ projects, week, onReports, onMeeting }: { projects: Project[]; week: string; onReports: () => void; onMeeting: (projectId: string) => void }) {
  const [report, setReport] = useState<Report | null>(null), [reportError, setReportError] = useState(''), [reportLoaded, setReportLoaded] = useState(false)
  const [meetings, setMeetings] = useState<Array<Meeting & { project: Project }> | null>(null), [meetingError, setMeetingError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    setReport(null); setReportError(''); setReportLoaded(false); setMeetings(null); setMeetingError('')
    void apiGet<{ reports: Report[] }>(`/weekly-reports?weekStart=${week}`).then(data => { if (current) setReport(data.reports.find(item => item.own && !['withdrawn', 'discarded'].includes(item.status)) ?? null) }).catch(cause => { if (current) setReportError((cause as Error).message) }).finally(() => { if (current) setReportLoaded(true) })
    void mapCollaborationProjects(projects, async project => ({ project, data: await apiGet<{ list: Meeting[] }>(`/meetings?projectId=${project.id}`) })).then(results => {
      if (!current) return
      setMeetings(results.flatMap(({ project, data }) => data.list.map(item => ({ ...item, project }))).sort((left, right) => right.meetingTime.localeCompare(left.meetingTime)))
    }).catch(cause => { if (current) setMeetingError((cause as Error).message) })
    return () => { current = false }
  }, [projects, week, revision])
  const facts = report?.restricted ? null : report?.facts
  return <div className="fde-collab-review">
    <section className="fde-collab-card fde-collab-report"><div className="fde-collab-card-head"><h2>自动周报</h2><button className="fde-collab-button" onClick={onReports}>{report ? '查看与维护周报' : '生成本周草稿'}</button></div>
      {reportError ? <div className="fde-collab-state" role="alert">{reportError}<button onClick={() => setRevision(value => value + 1)}>重试</button></div> : !reportLoaded ? <div className="fde-collab-state" role="status">正在读取周报…</div> : !report ? <div className="fde-collab-state"><strong>尚未生成周报草稿</strong></div> : report.restricted ? <div className="fde-collab-state" role="status">来源权限已变化，正文与来源已隐藏。请进入周报处理。</div> : <>
        {facts && <div className="fde-collab-report-summary">{[['已完成', facts.metrics.completedInWeek], ['待推进', facts.tasks.filter(task => !['已完成', '已关闭', '已取消'].includes(task.status)).length], ['逾期未结束', facts.metrics.overdueOpen]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>}
        <p>{report.body}</p><small>{facts ? new Date(facts.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '生成时间未知'} · {report.status === 'published' ? '已发布' : '待确认'}</small>
      </>}
    </section>
    <section className="fde-collab-card"><div className="fde-collab-card-head"><h2>项目会议</h2>{projects.length > 0 && <Button onClick={() => onMeeting(projects[0].id)}>发起会议</Button>}</div>
      {meetingError ? <div className="fde-collab-state" role="alert">{meetingError}<button onClick={() => setRevision(value => value + 1)}>重试</button></div> : !meetings ? <div className="fde-collab-state" role="status">正在读取项目会议…</div> : !meetings.length ? <div className="fde-collab-state"><strong>暂无已记录的项目会议</strong><p>项目组成员可直接选择项目并发起会议。</p></div> : <div className="fde-collab-meeting-list">{meetings.map(meeting => { const date = new Date(meeting.meetingTime); return <button key={meeting.id} className="fde-collab-meeting" onClick={() => onMeeting(meeting.project.id)}><span className="fde-collab-date-tile"><strong>{['日', '一', '二', '三', '四', '五', '六'][date.getDay()]}</strong><small>{date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' })}</small></span><span className="fde-collab-meeting-copy"><strong>{meeting.title}</strong><small>{meeting.project.name} · {date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · {meeting.type}</small></span><span className="fde-collab-meeting-result"><span>{meeting.status}</span></span></button> })}</div>}
    </section>
  </div>
}
