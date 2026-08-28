import { useEffect, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { apiGet } from '../lib/api'
import { projectCountdown, shortProjectDate } from '../lib/projectDetailPresentation'
import { useAuthStore } from '../store/useAuthStore'
import type { Project, Todo } from '../types'
import type { FdeDutyAssignment } from '../../server/src/contracts/fdeGovernanceContract'
import { Badge, Button, Card } from './ui'

type Governance = { assignments: FdeDutyAssignment[]; effectiveLeadership: FdeDutyAssignment[]; roster: Array<{ id: string; name: string }> }
type Access = { governance?: Governance; upload?: boolean; directive?: boolean; draft?: boolean; publish?: boolean; error?: boolean }

export function ProjectDetailHero({ project, todos, onUpload, onWorkspace, onArchive }: {
  project: Project; todos: Todo[]; onUpload: () => void;
  onWorkspace: (value: 'directives' | 'weekly') => void; onArchive: () => void
}) {
  const userId = useAuthStore(state => state.user?.id)
  const [access, setAccess] = useState<Access>({})
  useEffect(() => {
    let cancelled = false
    setAccess({})
    if (project.workflowModel !== 'fde-v1') return
    const root = `/projects/${project.id}`
    void Promise.allSettled([
      apiGet<Governance>(`${root}/governance`),
      apiGet<{ canUpload: boolean }>(`${root}/file-workspace?pageSize=1`),
      apiGet<{ canCreate: boolean }>(`${root}/directives`),
      apiGet<{ canDraft: boolean; canPublish: boolean }>(`${root}/weekly-plans`),
    ]).then(([governance, files, directives, weekly]) => {
      if (cancelled) return
      setAccess({
        governance: governance.status === 'fulfilled' ? governance.value : undefined,
        upload: files.status === 'fulfilled' && files.value.canUpload,
        directive: directives.status === 'fulfilled' && directives.value.canCreate,
        draft: weekly.status === 'fulfilled' && weekly.value.canDraft,
        publish: weekly.status === 'fulfilled' && weekly.value.canPublish,
        error: [governance, files, directives, weekly].some(result => result.status === 'rejected'),
      })
    })
    return () => { cancelled = true }
  }, [project.id, project.version, project.workflowModel, userId])
  const name = (id: string) => access.governance?.roster.find(person => person.id === id)?.name ?? '未配置'
  const secretary = access.governance?.assignments.filter(item => item.duty === 'secretary').map(item => name(item.userId)).join('、')
  const leadership = access.governance?.effectiveLeadership ?? []
  const leaders = [...new Set(leadership.map(item => name(item.userId)))].join('、')
  const active = (project.lifecycle ?? 'active') === 'active'
  const openTodos = todos.filter(todo => !['已完成', '已关闭', '已取消', '已归档'].includes(todo.status)).length
  return <Card className="fde-detail-hero">
    <div className="fde-detail-identity">
      <div className={`fde-detail-logo ${project.leaderPriority === '高' ? 'gold' : ''}`}>{project.name.slice(0, 1)}</div>
      <div><div className="fde-detail-eyebrow"><span>{project.projectType || '投资项目'}</span><span className="subtle">{{ pool: '项目池', normal: '普通项目', key: '重点项目' }[project.classification ?? 'normal']}</span><small>{project.confidentiality || '未设置密级'}</small></div>
        <h1 title={project.name}>{project.name}</h1>
        <p className="fde-detail-objective">{project.requirements || project.summary || project.companyName || '尚未填写项目要求'}</p>
        <div className="fde-detail-meta"><span>编号 {project.id}</span><span>组长 {project.owner || '未配置'}</span><span>推进 {secretary || '未配置'}</span><span>关注领导 {leaders || '未配置'}</span></div>
      </div>
    </div>
    <div className="fde-detail-states">
      <div><span>当前阶段</span><Badge tone="blue">{project.stage}</Badge></div>
      <div><span>执行状态</span><Badge tone={project.healthStatus === '正常' ? 'green' : project.healthStatus === '存在风险' ? 'red' : project.healthStatus === '需关注' ? 'amber' : 'slate'}>{project.healthStatus || '待评估'}</Badge></div>
      <div><span>项目目标日</span><strong>{shortProjectDate(project.targetDate)}</strong><small>{active ? projectCountdown(project.targetDate) : project.lifecycle === 'archived' ? '已归档' : '已结案'}</small></div>
      <div><span>待办</span><strong>{openTodos} 项</strong></div>
    </div>
    <div className="fde-detail-actions">
      <Button variant="secondary" onClick={onArchive} aria-label="项目档案与历史" title="项目档案、评分与历史"><MoreHorizontal className="h-4 w-4" /></Button>
      {active && (access.upload || project.workflowModel !== 'fde-v1') && <Button variant="secondary" onClick={onUpload}>上传材料</Button>}
      {active && (access.directive ? <Button onClick={() => onWorkspace('directives')}>领导批示</Button> : access.publish ? <Button onClick={() => onWorkspace('weekly')}>确认周计划</Button> : access.draft ? <Button onClick={() => onWorkspace('weekly')}>维护周计划</Button> : null)}
      {access.error && <small role="status">部分职责或操作权限暂未加载，请刷新重试</small>}
    </div>
  </Card>
}
