import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiGet } from '../lib/api'
import type { Project } from '../types'
import { weeklyActions, weeklySummary, mapCollaborationProjects, type CollaborationAction, type CollaborationTask, type CollaborationGroup } from '../lib/fdeCollaborationView'
import { Button } from './ui'

type PlanBoard = { canDraft: boolean; canPublish: boolean; plans: Array<{ revision: number; status: string; items: Array<{ taskId: string | null; needLeader: boolean; leaderTimeSource: unknown }> }> }
export function FdeCollaborationWeekly({ projects, week, onPlan }: { projects: Project[]; week: string; onPlan: (projectId: string) => void }) {
  const navigate = useNavigate()
  const [group, setGroup] = useState<CollaborationGroup>('project')
  const [data, setData] = useState<{ actions: CollaborationAction[]; managers: Project[] } | null>(null)
  const [error, setError] = useState(''), [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    setData(null); setError('')
    void mapCollaborationProjects(projects, async project => {
      const [tasks, plans] = await Promise.all([apiGet<{ tasks: CollaborationTask[] }>(`/projects/${project.id}/fde-tasks`), apiGet<PlanBoard>(`/projects/${project.id}/weekly-plans?weekStart=${week}`)])
      const published = plans.plans.filter(plan => plan.status === 'published').sort((a, b) => b.revision - a.revision)[0]
      return { project, manage: plans.canDraft || plans.canPublish, actions: tasks.tasks.map(task => {
        const source = published?.items.find(item => item.taskId === task.id)
        return { ...task, projectId: project.id, projectName: project.name, projectType: project.projectType || '投资项目', needLeader: Boolean(task.timelineSource?.needLeader || source?.needLeader), leaderLinked: Boolean(source?.leaderTimeSource) }
      }) }
    }).then(results => { if (current) setData({ actions: results.flatMap(result => result.actions), managers: results.filter(result => result.manage).map(result => result.project) }) }).catch(cause => { if (current) setError(`工作清单加载失败：${(cause as Error).message}。统计未展示，避免将未读取的数据当作零。`) })
    return () => { current = false }
  }, [projects, week, revision])
  const items = weeklyActions(data?.actions ?? [], week, group), stats = weeklySummary(items)
  const taskLink = (item: CollaborationAction, action?: string) => navigate(`/projects/${item.projectId}?tab=tasks&task=${item.id}${action ? `&action=${action}` : ''}`)
  return <div className="fde-collab-execution">
    <section className="fde-collab-summary" aria-label="本周工作统计">{[
      ['本周工作', stats.total, `${stats.timeline} 项来自阶段时间线或批准计划`], ['已完成', stats.completed, '以原任务的正式验收结果为准'],
      ['今日到期 / 阻塞', stats.urgent, '含未结束的逾期事项，需要优先处理'], ['需领导参与', stats.leaders, `${stats.linked} 项有已发布周计划的领导来源关联`],
    ].map(([label, value, note], index) => <article key={label}><span>{label}</span><strong className={index === 2 ? 'fde-collab-danger' : ''}>{data ? value : '—'}</strong><small>{note}</small></article>)}</section>
    <section className="fde-collab-card"><div className="fde-collab-card-head"><h2>本周工作清单</h2><div className="fde-collab-segmented" aria-label="工作清单分组">{([['project', '按项目'], ['person', '按人员'], ['date', '按日期']] as const).map(([value, title]) => <button type="button" key={value} aria-pressed={group === value} onClick={() => setGroup(value)}>{title}</button>)}</div></div>
      {error ? <div className="fde-collab-state" role="alert">{error}<Button variant="secondary" onClick={() => setRevision(value => value + 1)}>重试</Button></div> : !data ? <div className="fde-collab-state" role="status">正在读取本周工作…</div> : <div className="fde-collab-table-scroll"><table className="fde-collab-table"><thead><tr>{['项目', '具体行动', '负责人', '截止', '状态', '下一步'].map(title => <th key={title}>{title}</th>)}</tr></thead><tbody>{items.map(item => <tr key={`${item.projectId}:${item.id}`}>
        <td><button className="fde-collab-project" onClick={() => navigate(`/projects/${item.projectId}`)}><span className="fde-collab-logo">{item.projectName.slice(0, 1)}</span><span><strong>{item.projectName}</strong><small>{item.projectType}</small></span></button></td>
        <td><div className="fde-collab-work-title">{item.capabilities.canFeedback ? <button className="fde-collab-check" aria-label={`提交成果：${item.title}`} title="提交成果后由异人验收" onClick={() => taskLink(item, 'submission')} /> : <span className={`fde-collab-check ${item.status === '已完成' ? 'is-done' : ''}`} aria-hidden="true">{item.status === '已完成' ? '✓' : ''}</span>}<div><strong>{item.title}</strong><small>{item.timelineSource ? `${item.timelineSource.stage}流程行动` : item.directiveId ? '领导批示' : item.planActionId ? '倒排计划' : '项目任务'}{item.needLeader ? ' · 需领导参与' : ''}{item.extensions.some(extension => extension.status === '审批中') ? ' · 延期审批中' : ''}</small></div></div>{item.feedbacks[0]?.blocker && item.status !== '已完成' && <small className="fde-collab-danger">阻塞：{item.feedbacks[0].blocker}</small>}</td>
        <td>{item.owner || '待绑定'}</td><td>{item.dueDate}<br />{item.dueTime}</td><td><span className="fde-collab-badge" data-tone={item.status === '已完成' ? 'success' : item.status === '待验收' ? 'warning' : 'info'}>{item.status}</span></td>
        <td><div className="fde-collab-row-actions">{item.capabilities.canFeedback && <button onClick={() => taskLink(item, 'progress')}>反馈</button>}{item.capabilities.canExtend && !item.extensions.some(extension => extension.status === '审批中') && <button onClick={() => taskLink(item, 'extension')}>延期</button>}{item.capabilities.canAccept && <button onClick={() => taskLink(item, 'accept')}>验收</button>}{item.capabilities.canCancel && <button className="fde-collab-danger" onClick={() => taskLink(item, 'cancel')}>取消</button>}<button onClick={() => taskLink(item)}>项目</button></div></td>
      </tr>)}</tbody></table>{!items.length && <div className="fde-collab-state"><strong>本周暂无可展示的工作</strong><small>仅展示有权项目的正式任务；周计划草稿不计入已发布工作。</small></div>}</div>}
    </section>
    <details className="fde-collab-tools"><summary>周计划维护与工作清单工具</summary><div><Button variant="secondary" onClick={() => setRevision(value => value + 1)}>刷新工作清单</Button>{data?.managers.map(project => <Button key={project.id} variant="secondary" onClick={() => onPlan(project.id)}>维护周计划 · {project.name}</Button>)}</div></details>
  </div>
}
