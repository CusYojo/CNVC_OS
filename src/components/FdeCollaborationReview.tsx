import { useEffect, useState } from 'react'
import { apiGet } from '../lib/api'
import { mapCollaborationProjects } from '../lib/fdeCollaborationView'
import type { Project } from '../types'
import type { WeeklyReportFacts } from '../../server/src/contracts/fdeWeeklyReportContract'
import { timeLocal } from '../../server/src/contracts/fdeTimeContract'
import { Button } from './ui'

type Report = { id: string; own: boolean; restricted: boolean; status: string; body: string; facts: WeeklyReportFacts | null }
type Meeting = { id: string; title: string; host: string; startedAt: string; workflowStatus: string; plans: Array<{ status: string }> }
export function FdeCollaborationReview({ projects, week, onReports, onMeeting }: { projects: Project[]; week: string; onReports: () => void; onMeeting: (projectId: string) => void }) {
  const [report, setReport] = useState<Report | null>(null), [reportError, setReportError] = useState(''), [reportLoaded, setReportLoaded] = useState(false)
  const [meetings, setMeetings] = useState<Array<Meeting & { project: Project }> | null>(null), [managers, setManagers] = useState<Project[]>([]), [meetingError, setMeetingError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    setReport(null); setReportError(''); setReportLoaded(false); setMeetings(null); setManagers([]); setMeetingError('')
    void apiGet<{ reports: Report[] }>(`/weekly-reports?weekStart=${week}`).then(data => { if (current) setReport(data.reports.find(item => item.own && !['withdrawn', 'discarded'].includes(item.status)) ?? null) }).catch(cause => { if (current) setReportError((cause as Error).message) }).finally(() => { if (current) setReportLoaded(true) })
    void mapCollaborationProjects(projects, async project => ({ project, data: await apiGet<{ list: Meeting[]; canManage: boolean }>(`/projects/${project.id}/friday-meetings`) })).then(results => {
      if (!current) return
      setManagers(results.filter(result => result.data.canManage).map(result => result.project))
      setMeetings(results.flatMap(({ project, data }) => data.list.filter(item => item.workflowStatus !== 'cancelled').map(item => ({ ...item, project }))))
    }).catch(cause => { if (current) setMeetingError((cause as Error).message) })
    return () => { current = false }
  }, [projects, week, revision])
  const facts = report?.restricted ? null : report?.facts
  return <div className="fde-collab-review">
    <section className="fde-collab-card fde-collab-report"><div className="fde-collab-card-head"><h2>自动周报</h2><button className="fde-collab-button" onClick={onReports}>{report ? '查看与维护周报' : '生成本周草稿'}</button></div>
      {reportError ? <div className="fde-collab-state" role="alert">{reportError}<button onClick={() => setRevision(value => value + 1)}>重试</button></div> : !reportLoaded ? <div className="fde-collab-state" role="status">正在读取周报…</div> : !report ? <div className="fde-collab-state"><strong>尚未生成周报草稿</strong><small>系统会从已有工作记录汇总，不要求员工重复填写同一内容。</small></div> : report.restricted ? <div className="fde-collab-state" role="status">来源权限已变化，正文与来源已隐藏。请进入周报处理。</div> : <>
        {facts && <div className="fde-collab-report-summary">{[['已完成', facts.metrics.completedInWeek], ['待推进', facts.tasks.filter(task => !['已完成', '已关闭', '已取消'].includes(task.status)).length], ['逾期未结束', facts.metrics.overdueOpen]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>}
        <p>{report.body}</p><small>{facts ? new Date(facts.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '来源快照未记录'} · {report.status === 'published' ? '已发布' : '待确认'}</small>
      </>}
    </section>
    <section className="fde-collab-card"><div className="fde-collab-card-head"><h2>周五项目例会</h2>{managers.length > 0 && <Button onClick={() => onMeeting(managers[0].id)}>记录周五例会</Button>}</div>
      {meetingError ? <div className="fde-collab-state" role="alert">{meetingError}<button onClick={() => setRevision(value => value + 1)}>重试</button></div> : !meetings ? <div className="fde-collab-state" role="status">正在读取例会…</div> : !meetings.length ? <div className="fde-collab-state"><strong>本周尚未记录例会</strong><small>项目负责人或推进秘书可复盘本周并生成下周工作草稿。</small></div> : <div className="fde-collab-meeting-list">{meetings.map(meeting => <button key={meeting.id} className="fde-collab-meeting" onClick={() => onMeeting(meeting.project.id)}><span className="fde-collab-date-tile"><strong>{['日', '一', '二', '三', '四', '五', '六'][new Date(`${timeLocal(new Date(meeting.startedAt)).slice(0, 10)}T00:00:00Z`).getUTCDay()]}</strong><small>{timeLocal(new Date(meeting.startedAt)).slice(5, 10)}</small></span><span className="fde-collab-meeting-copy"><strong>{meeting.title}</strong><small>{meeting.project.name} · {timeLocal(new Date(meeting.startedAt)).replace('T', ' ')} · 主持 {meeting.host}</small></span><span className="fde-collab-meeting-result"><span>{meeting.workflowStatus === 'completed' ? '纪要已确认' : meeting.workflowStatus === 'scheduled' ? '待召开' : '会前草稿'}</span><span className="fde-collab-badge">{meeting.plans.some(plan => plan.status === 'published') ? '下周计划已发布' : meeting.plans.some(plan => plan.status !== 'discarded') ? '下周草稿待确认' : '下周工作待确认'}</span></span></button>)}</div>}
    </section>
  </div>
}
