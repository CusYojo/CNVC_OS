import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore'
import { FdeWeeklyPlanPanel } from '../components/FdeWeeklyPlanPanel'
import { FdeWeeklyReportPanel } from '../components/FdeWeeklyReportPanel'
import { FdeFridayMeetingPanel } from '../components/FdeFridayMeetingPanel'
import { FdeCalendarPanel } from '../components/FdeCalendarPanel'
import { fdeWeekStart, shanghaiToday, weekStartFor } from '../../server/src/contracts/fdeWeeklyPlanContract'
import { Modal } from '../components/ui'
import { useAuthStore } from '../store/useAuthStore'
import { collaborationTabs, collaborationView } from '../lib/fdeCollaborationView'
import { FdeCollaborationWeekly } from '../components/FdeCollaborationWeekly'
import { FdeCollaborationReview } from '../components/FdeCollaborationReview'
import { MeetingsPage } from './MeetingsPage'
import { CommitteePage } from './CommitteePage'
import '../components/fde-workspace.css'
import './CollaborationPage.css'
import { apiGet } from '../lib/api'
import type { Project } from '../types'

export function CollaborationPage() {
  const [params, setParams] = useSearchParams()
  const userId = useAuthStore(state => state.user?.id ?? '')
  const [context, setContext] = useState<{ actorId: string; view: string; projects: Project[] } | null>(null)
  const [contextError, setContextError] = useState('')
  const currentContext = context?.actorId === userId ? context : null
  const projects = useMemo(() => currentContext?.projects.filter(project => project.workflowModel === 'fde-v1' && project.lifecycle !== 'deleted') ?? [], [currentContext])
  const hydrate = useAppStore((state) => state.hydrateFromServer)
  const calendarOnly = currentContext && ['admin', 'coordinator'].includes(currentContext.view)
  const view = calendarOnly ? 'calendar' : collaborationView(params.get('view'))
  const selectedWeek = fdeWeekStart.safeParse(params.get('week'))
  const projectId = params.get('project') ?? projects[0]?.id ?? ''
  const week = selectedWeek.success ? selectedWeek.data : weekStartFor(shanghaiToday())
  const [tool, setTool] = useState<string | null>(null), [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let current = true
    setContext(null); setContextError(''); setTool(null)
    void apiGet<{ actorId: string; view: string }>('/workbench').then(async workbench => {
      if (workbench.actorId !== userId) throw new Error('账号已变化，请刷新会话')
      const result = ['admin', 'coordinator'].includes(workbench.view) ? { list: [] } : await apiGet<{ list: Project[] }>('/projects')
      if (current) setContext({ ...workbench, projects: result.list })
    }).catch(cause => { if (current) setContextError((cause as Error).message) })
    return () => { current = false }
  }, [userId, refresh])
  const activeTool = tool ?? (['committee', 'meetings', 'reports', 'friday'].includes(params.get('view') ?? '') ? params.get('view') : params.has('project') && view === 'weekly' ? 'weekly' : null)
  function change(key: string, value: string) { const next = new URLSearchParams(params); next.set(key, value); setParams(next) }
  function openProjectTool(value: string, id: string) { const next = new URLSearchParams(params); next.set('project', id); next.set('view', value); setParams(next); setTool(value) }
  function closeTool() { setTool(null); const next = new URLSearchParams(params); next.set('view', view); next.delete('project'); setParams(next); setRefresh(value => value + 1) }
  return <div className="fde-collaboration-page" key={userId}>
    <header className="fde-page-heading"><div><h1>任务与日历</h1></div></header>
    {!currentContext ? <div className="fde-collab-state" role={contextError ? 'alert' : 'status'}>{contextError || '正在读取协同职责与项目范围…'}{contextError && <button onClick={() => setRefresh(value => value + 1)}>重试</button>}</div> : <><div className="fde-collab-tabs" role="tablist" aria-label="协同工作区">{collaborationTabs.filter(([id]) => !calendarOnly || id === 'calendar').map(([id, title]) => <button type="button" key={id} role="tab" aria-selected={view === id} onClick={() => { setTool(null); const next = new URLSearchParams(params); next.set('view', id); next.delete('project'); setParams(next) }}>{title}</button>)}</div>
    {view === 'calendar' ? <FdeCalendarPanel initialWeek={week} companyOnly={currentContext.view === 'admin'} allowLeader={['leader', 'coordinator', 'lead', 'secretary'].includes(currentContext.view) || params.get('view') === 'time'} initialLayer={params.get('view') === 'time' || currentContext.view === 'coordinator' ? 'leader' : 'personal'} /> : view === 'review' ? <FdeCollaborationReview key={`${userId}:${refresh}`} projects={projects} week={week} onReports={() => setTool('reports')} onMeeting={id => openProjectTool('meetings', id)} /> : <FdeCollaborationWeekly key={`${userId}:${refresh}`} projects={projects} week={week} onPlan={id => openProjectTool('weekly', id)} />}</>}
    <details className="fde-collab-tools"><summary>更多工具</summary><div><button onClick={() => setTool('committee')}>投决会</button><button onClick={() => setTool('meetings')}>项目会议</button><button onClick={() => setTool('reports')}>个人周报与发布历史</button><label>选择周 <input type="date" aria-label="任务与日历周日期" value={week} onChange={event => { if (event.target.value) change('week', weekStartFor(event.target.value)) }} /></label></div></details>
    <Modal open={Boolean(currentContext && activeTool)} title={activeTool === 'weekly' ? '维护周计划' : activeTool === 'friday' ? '周五项目例会' : activeTool === 'reports' ? '个人周报' : activeTool === 'committee' ? '投决会' : '项目会议'} width="max-w-6xl" onClose={closeTool}>
      {currentContext && activeTool && <div className="fde-collab-detail">{['weekly', 'friday'].includes(activeTool) && <label className="fde-project-picker">项目 <select className="input" value={projectId} onChange={event => change('project', event.target.value)}>{!projects.length && <option value="">暂无有权访问的 FDE 项目</option>}{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
        {activeTool === 'committee' ? <CommitteePage embedded /> : activeTool === 'meetings' ? <MeetingsPage /> : activeTool === 'reports' ? <FdeWeeklyReportPanel initialWeek={week} /> : projects.some(project => project.id === projectId) ? activeTool === 'friday' ? <FdeFridayMeetingPanel key={projectId} projectId={projectId} /> : <FdeWeeklyPlanPanel key={`${projectId}:${week}`} projectId={projectId} initialWeek={week} onChanged={hydrate} /> : <p role="status">暂无可访问项目，请刷新后重试。</p>}
      </div>}
    </Modal>
  </div>
}
