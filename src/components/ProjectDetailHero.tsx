import { ArrowRight, ClipboardList, Info, Target } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { projectCountdown, shortProjectDate } from '../lib/projectDetailPresentation'
import type { Project } from '../types'
import { Badge, Button, Card, StageBadge } from './ui'

export function ProjectDetailHero({ project, incompleteTaskCount, onOverview, onPrimary }: {
  project: Project
  incompleteTaskCount: number | null
  onOverview: () => void
  onPrimary: () => void
}) {
  const navigate = useNavigate()
  const active = (project.lifecycle ?? 'active') === 'active'
  const classification = { pool: '项目池', normal: '普通项目', key: '重点项目' }[project.classification ?? 'normal']
  const riskTone = project.healthStatus === '正常' ? 'green' : project.healthStatus === '存在风险' ? 'red' : project.healthStatus === '需关注' ? 'amber' : 'slate'
  return <Card className="fde-detail-hero">
    <div className="fde-detail-hero-primary">
      <div className={`fde-detail-logo ${project.leaderPriority === '高' ? 'gold' : ''}`}>{project.name.slice(0, 1)}</div>
      <div className="fde-detail-hero-title"><h1 title={project.name}>{project.name}</h1><div className="fde-detail-hero-badges"><Badge tone={project.classification === 'key' ? 'amber' : 'slate'}>{classification}</Badge><StageBadge stage={project.stage} /><Badge tone={riskTone}>{project.healthStatus || '待评估'}</Badge></div></div>
    </div>
    <div className="fde-detail-hero-secondary">
      <dl>
        <div><dt>项目负责人</dt><dd>{project.owner || '未配置'}</dd></div>
        <div><dt>目标日期</dt><dd>{shortProjectDate(project.targetDate)}<small>{active ? projectCountdown(project.targetDate) : project.lifecycle === 'archived' ? '已归档' : '已结案'}</small></dd></div>
        <div><dt>未完成任务</dt><dd>{incompleteTaskCount == null ? '统计中' : `${incompleteTaskCount} 项`}</dd></div>
      </dl>
      <div className="fde-detail-actions">
        <Button variant="secondary" onClick={onOverview}><Info className="h-4 w-4" />项目概况</Button>
        <Button variant="secondary" onClick={() => navigate(`/due-diligence?project=${project.id}`)}><ClipboardList className="h-4 w-4" />尽调工作台</Button>
        <Button onClick={onPrimary}>{active ? <><Target className="h-4 w-4" />推进当前阶段</> : <><ArrowRight className="h-4 w-4" />查看项目档案</>}</Button>
      </div>
    </div>
  </Card>
}
