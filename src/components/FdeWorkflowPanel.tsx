import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, Circle, FileCheck2, LockKeyhole, Save } from 'lucide-react'
import { apiGet, apiPut } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { useToast } from './Toast'
import { Badge, Button, Card, Modal } from './ui'
import type { Project, ProjectFile } from '../types'
import './fde-workspace.css'
import { materialIsSatisfied, shortProjectDate } from '../lib/projectDetailPresentation'
import { useAppStore } from '../store/useAppStore'

type PlanAction = { id: string; actionKey: string; title: string; ownerUserId: string; dueDate: string; effectiveDueDate: string; taskId: string | null; deliverable: string; status: string; version: number }
type Workflow = {
  timeline: Array<{ stage: string; date: string; basis: string; version: number; actualDate?: string | null }>
  stages: Array<{ stage: string; allowWaiver: boolean; materials: Array<{ key: string; label: string }> }>
  policy: { id: string; revision: number; cycleDays: number[] }
  materials: Array<{ id: string; stage: string; requirementKey: string; fileId: string | null; fileVersion: number | null; waiverReason: string | null; version: number }>
  plan: { id: string; revision: number; version: number; status: string; cycleDays: number; targetDate: string; actions: PlanAction[] } | null
  planHistory: Array<{ id: string; revision: number; status: string; targetDate: string }>
  members: Array<{ id: string; name: string; role: string }>
}

export function FdeWorkflowPanel({ project, files, mode = 'workflow', onChanged, afterStage, onUpload }: {
  project: Project; files: ProjectFile[]; mode?: 'workflow' | 'materials' | 'tasks'; onChanged: () => Promise<void>;
  afterStage?: ReactNode; onUpload?: () => void
}) {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const currentUser = useAuthStore((state) => state.user)
  const approvals = useAppStore(state => state.approvalRequests)
  const [data, setData] = useState<Workflow | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState(project.stage as string)
  const [fileChoices, setFileChoices] = useState<Record<string, string>>({})
  const [waiver, setWaiver] = useState<{ key: string; label: string } | null>(null)
  const [waiverReason, setWaiverReason] = useState('')
  const [cycleDays, setCycleDays] = useState(40)
  const [targetDate, setTargetDate] = useState(project.targetDate ?? '')
  const [actions, setActions] = useState<PlanAction[]>([])
  const [materialsOpen, setMaterialsOpen] = useState(false)
  const [planEditing, setPlanEditing] = useState(false)
  const isOwner = currentUser?.id === project.ownerUserId
  const isActive = (project.lifecycle ?? 'active') === 'active'

  const applyData = (next: Workflow) => {
    setData(next)
    setActions(next.plan?.actions ?? [])
    if (next.plan) { setCycleDays(next.plan.cycleDays); setTargetDate(next.plan.targetDate) }
    else setCycleDays(next.policy.cycleDays.includes(project.cycleDays ?? 40) ? (project.cycleDays ?? 40) : next.policy.cycleDays[0])
    setError('')
  }
  useEffect(() => {
    let cancelled = false
    const load = () => { void apiGet<Workflow>(`/projects/${project.id}/fde-workflow`).then((next) => { if (!cancelled) applyData(next) }).catch((cause) => { if (!cancelled) setError((cause as Error).message) }) }
    const changed = (event: Event) => { if ((event as CustomEvent).detail === project.id) load() }
    load(); window.addEventListener('fde-timeline-updated', changed)
    return () => { cancelled = true; window.removeEventListener('fde-timeline-updated', changed) }
  }, [project.id])
  useEffect(() => { setStage(project.stage) }, [project.stage])

  const run = async (operation: () => Promise<Workflow>, message: string) => {
    setBusy(true)
    try { applyData(await operation()); await onChanged(); showToast(message) }
    catch (cause) { showToast((cause as Error).message, 'error') }
    finally { setBusy(false) }
  }
  const bind = (key: string, fileId?: string, reason?: string) => {
    const existing = data?.materials.find((item) => item.stage === stage && item.requirementKey === key)
    return run(() => apiPut<Workflow>(`/projects/${project.id}/fde-materials`, {
      stage, requirementKey: key, fileId, waiverReason: reason, expectedVersion: existing?.version,
    }), fileId ? '已绑定真实项目材料与文件版本' : '免传说明已记录并进入审批证据')
  }
  const savePlan = (regenerate: boolean) => run(() => apiPut<Workflow>(`/projects/${project.id}/fde-plan`, {
    cycleDays, targetDate, expectedVersion: data?.plan?.version,
    ...(regenerate ? {} : { actions: actions.map(({ actionKey, title, ownerUserId, dueDate, deliverable }) => ({ actionKey, title, ownerUserId, dueDate, deliverable })) }),
  }), '倒排计划新版本已保存')

  if (error) return <Card className="p-5 text-sm text-red-600"><p role="alert">FDE 流程加载失败：{error}</p></Card>
  if (!data) return <Card className="p-5 text-sm text-slate-500">正在读取项目流程、材料与计划…</Card>
  const selectedStage = data.stages.find((item) => item.stage === stage)
  const currentIndex = data.stages.findIndex((item) => item.stage === project.stage)
  const planLocked = data.plan?.status === 'locked'
  const canEditPlan = isOwner && isActive && !planLocked && data.plan?.status !== 'review'
  const stageRequirements = selectedStage?.materials ?? []
  const missing = stageRequirements.filter(requirement => !materialIsSatisfied(data.materials.find(item => item.stage === stage && item.requirementKey === requirement.key), files))
  const approval = approvals.filter(item => item.projectId === project.id && item.fromStage === stage).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0]
  const stageDate = data.timeline.find(item => item.stage === stage)
  const selectedIndex = data.stages.findIndex(item => item.stage === stage)
  const nextStage = data.stages[selectedIndex + 1]?.stage ?? 'Close'
  const materialStages = data.stages.filter(item => item.materials.length)
  const totalRequired = materialStages.reduce((sum, item) => sum + item.materials.length, 0)
  const totalSatisfied = materialStages.reduce((sum, item) => sum + item.materials.filter(requirement => materialIsSatisfied(data.materials.find(binding => binding.stage === item.stage && binding.requirementKey === requirement.key), files)).length, 0)

  return <div className="fde-workspace fde-detail-flow">
    {mode === 'workflow' && <><Card className="fde-detail-stage-card">
      <div className="fde-detail-card-head"><h2>流程推进</h2><div className="fde-detail-inline-actions"><Badge>{data.plan?.cycleDays ?? project.cycleDays ?? cycleDays} 天周期</Badge><span>目标日 <strong>{shortProjectDate(project.targetDate)}</strong></span></div></div>
      <div className="fde-detail-timeline" aria-label="项目流程" style={{ '--stage-count': data.stages.length } as CSSProperties}>{data.stages.map((item, index) => {
        const completed = index < currentIndex || project.stage === '已 Close'
        const current = item.stage === project.stage && !completed
        const date = data.timeline.find(value => value.stage === item.stage)
        return <button type="button" key={item.stage} aria-pressed={stage === item.stage} className={`fde-detail-stage ${completed ? 'completed' : current ? 'current' : ''}`} onClick={() => setStage(item.stage)}>
          <span className="fde-detail-stage-rail"><span>{completed ? '✓' : index + 1}</span></span>
          <span className="fde-detail-stage-copy"><strong>{item.stage}</strong><small>{date?.actualDate ? `已于 ${shortProjectDate(date.actualDate)} 通过` : `计划 ${shortProjectDate(date?.date)}`}</small></span>
          <span className="fde-detail-stage-state"><Badge tone={completed ? 'green' : current ? 'blue' : 'slate'}>{completed ? '已通过' : current ? '进行中' : '待开始'}</Badge></span>
        </button>
      })}</div>
      {project.classification === 'pool' && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">当前仍在项目池。请由负责人完成入库初筛，进入普通项目后再发起立项审批。</p>}
      {data.timeline?.some(item => item.basis === 'approved') && <p className="mt-3 text-xs text-[#315f68]">已批准节点日期：{data.timeline.filter(item => item.basis === 'approved').map(item => `${item.stage} ${item.date}（V${item.version}）`).join('；')}。最终目标日不变。</p>}
      {project.stage === '已 Close' && <p className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">项目已 Close，流程进度 100%，活动任务已关闭。</p>}
    </Card>
      <Card className="fde-detail-stage-focus">
        <div className="fde-detail-card-head"><h2>{stage === project.stage ? '当前节点' : '节点详情'} · {stage}</h2><div className="fde-detail-inline-actions">
          <Button variant="secondary" onClick={() => setMaterialsOpen(true)}>查看节点材料</Button>
          {isActive && onUpload && <Button variant="secondary" onClick={onUpload}>上传材料</Button>}
          <Button variant="secondary" disabled={!isActive || project.classification === 'pool'} onClick={() => navigate(`/workflow?project=${project.id}${approval ? `&request=${approval.id}` : ''}`)}>{approval ? '查看阶段审批' : '发起阶段审批'}</Button>
        </div></div>
        <div className="fde-detail-focus-layout"><div className="fde-detail-focus-facts">
          <div><span>负责人</span><strong>{project.owner || '未配置'}</strong></div><div><span>计划完成</span><strong>{shortProjectDate(stageDate?.date)}</strong></div>
          <div><span>材料</span><strong>{stageRequirements.length ? `${stageRequirements.length - missing.length} / ${stageRequirements.length}` : '无需材料'}</strong></div>
          <div><span>审批</span><strong>{approval?.status ?? '未发起'}</strong></div>
        </div><aside className={`fde-detail-next-step ${missing.length ? 'warning' : ''}`}><span>进入 {nextStage} 前</span><strong>{approval?.status === '审批中' ? `等待 ${approval.currentNodeName} 处理阶段审批` : missing.length ? `待处理：${missing.slice(0, 2).map(item => item.label).join('、')}${missing.length > 2 ? ` 等 ${missing.length} 项` : ''}` : '材料已处理，提交时校验人员、计划和其他准入条件'}</strong></aside></div>
      </Card>{afterStage}</>}

    {mode === 'materials' && <Card className="fde-detail-material-register"><div className="fde-detail-card-head"><h2>节点材料</h2><div className="fde-detail-inline-actions"><Badge tone={totalRequired === totalSatisfied ? 'green' : 'amber'}>{totalSatisfied} / {totalRequired} 已齐备</Badge>{onUpload && isActive && <Button onClick={onUpload}>上传文件</Button>}</div></div><div>{materialStages.map(item => {
      const remaining = item.materials.filter(requirement => !materialIsSatisfied(data.materials.find(binding => binding.stage === item.stage && binding.requirementKey === requirement.key), files))
      const completed = item.materials.length - remaining.length
      return <button key={item.stage} className={`fde-detail-material-row ${item.stage === project.stage ? 'current' : ''}`} onClick={() => { setStage(item.stage); setMaterialsOpen(true) }}><span className="fde-detail-material-marker">{remaining.length ? '○' : '✓'}</span><span><strong>{item.stage}</strong><small>{remaining.length ? `待处理 ${remaining.slice(0, 2).map(value => value.label).join('、')}${remaining.length > 2 ? ' 等' : ''}` : '准入材料已处理'}</small></span><span className="fde-detail-material-progress"><span><i style={{ width: `${completed / item.materials.length * 100}%` }} /></span><strong>{completed} / {item.materials.length}</strong></span><span>→</span></button>
    })}{!materialStages.length && <p className="fde-detail-empty">当前流程无独立文件要求</p>}</div></Card>}

    <Modal open={materialsOpen} onClose={() => setMaterialsOpen(false)} title={`节点材料 · ${stage}`} width="max-w-3xl"><Card className="fde-panel p-5">
      <div className="flex items-center justify-between"><h2 className="font-semibold">阶段材料 · {stage}</h2>{mode === 'materials' && <select className="input max-w-44" value={stage} onChange={(event) => setStage(event.target.value)}>{data.stages.map((item) => <option key={item.stage}>{item.stage}</option>)}</select>}</div>
      <p className="mt-1 text-xs text-slate-500">必须明确绑定当前项目文件；同名文件不会自动满足要求。更换文件版本后需重新绑定。</p>
      {!selectedStage?.materials.length && <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-500">本阶段无独立文件要求；计划阶段需通过下方倒排计划完整性校验。</p>}
      <div className="mt-4 space-y-3">{selectedStage?.materials.map((requirement) => {
        const binding = data.materials.find((item) => item.stage === stage && item.requirementKey === requirement.key)
        const boundFile = files.find((file) => file.id === binding?.fileId)
        const valid = materialIsSatisfied(binding, files)
        return <div className="rounded-lg border border-slate-200 p-3" key={requirement.key}>
          <div className="flex items-center gap-2">{valid ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Circle className="h-4 w-4 text-amber-600" />}<strong className="text-sm">{requirement.label}</strong><Badge tone={valid ? 'green' : 'amber'}>{valid ? binding?.waiverReason ? '已免传' : `已绑定 V${binding?.fileVersion}` : '待补充'}</Badge></div>
          {binding?.waiverReason && <p className="mt-2 text-xs text-slate-600">免传说明：{binding.waiverReason}</p>}
          {boundFile && <p className="mt-2 text-xs text-slate-500">当前绑定：{boundFile.name}</p>}
          {isActive && <div className="mt-3 flex flex-wrap gap-2"><select className="input min-w-44 flex-1" value={fileChoices[requirement.key] ?? binding?.fileId ?? ''} onChange={(event) => setFileChoices({ ...fileChoices, [requirement.key]: event.target.value })}><option value="">选择项目材料文件</option>{files.map((file) => <option value={file.id} key={file.id}>{file.name} · V{file.version}</option>)}</select><Button variant="secondary" loading={busy} disabled={!(fileChoices[requirement.key] ?? binding?.fileId)} onClick={() => { void bind(requirement.key, fileChoices[requirement.key] ?? binding?.fileId ?? undefined) }}><FileCheck2 className="h-4 w-4" />绑定</Button>{isOwner && data.stages.find((item) => item.stage === stage)?.allowWaiver && <Button variant="secondary" onClick={() => { setWaiver(requirement); setWaiverReason(binding?.waiverReason ?? '') }}>申请免传</Button>}</div>}
        </div>
      })}</div>
    </Card></Modal>

    {mode !== 'materials' && <Card className="fde-detail-reverse-plan">
      <div className="fde-detail-card-head"><h2>投资周期行动计划</h2><div className="fde-detail-inline-actions">{data.plan && <Badge tone={planLocked ? 'green' : 'amber'}>{planLocked && <LockKeyhole className="mr-1 h-3 w-3" />}V{data.plan.revision} · {planLocked ? '已锁定' : data.plan.status === 'review' ? '审核中' : '草稿'}</Badge>}{canEditPlan && <Button variant="secondary" onClick={() => setPlanEditing(value => !value)}>{planEditing ? '收起编辑' : data.plan ? '编辑计划' : '制定计划'}</Button>}</div></div>
      {canEditPlan && planEditing && <div className="p-4"><div className="flex flex-wrap items-end gap-3"><label><span className="label">周期</span><select className="input" value={cycleDays} onChange={(event) => setCycleDays(Number(event.target.value))}>{data.policy.cycleDays.map((days) => <option value={days} key={days}>{days} 天</option>)}</select></label><label><span className="label">最终日期</span><input type="date" className="input" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} /></label><Button disabled={!targetDate} loading={busy} onClick={() => { void savePlan(true) }}>生成倒排计划</Button>{actions.length > 0 && <Button variant="secondary" loading={busy} onClick={() => { void savePlan(false) }}><Save className="h-4 w-4" />保存修订版</Button>}</div></div>}
      {!data.plan && <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-500">尚未制定计划，请由项目负责人选择周期和最终日期生成。</p>}
      {data.plan && !planEditing && <div className="fde-detail-plan-list">{actions.map(action => <div className="fde-detail-plan-row" key={action.id}><button className={`fde-detail-plan-check ${action.status === '已完成' ? 'completed' : ''}`} disabled={!action.taskId} aria-label={`${action.title}：查看反馈与验收`} onClick={() => navigate(`/projects/${project.id}?tab=tasks`)}>{action.status === '已完成' ? '✓' : ''}</button><div><strong>{action.title}</strong><small>{data.members.find(member => member.id === action.ownerUserId)?.name ?? '项目成员'} · {shortProjectDate(action.effectiveDueDate)} · {action.status}</small><span>{action.deliverable || '尚未填写交付物'}</span></div></div>)}</div>}
      {data.plan && planEditing && <div className="mt-4 overflow-x-auto"><table className="fde-plan-table"><thead><tr><th>行动</th><th>负责人</th><th>截止日期</th><th>交付物</th><th>执行状态</th></tr></thead><tbody>{actions.map((action, index) => <tr key={action.id}>
        <td>{action.title}</td><td>{canEditPlan ? <select className="input" value={action.ownerUserId} onChange={(event) => setActions(actions.map((item, i) => i === index ? { ...item, ownerUserId: event.target.value } : item))}>{data.members.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}</select> : data.members.find((member) => member.id === action.ownerUserId)?.name ?? '项目成员'}</td>
        <td>{canEditPlan ? <input className="input" type="date" value={action.dueDate} onChange={(event) => setActions(actions.map((item, i) => i === index ? { ...item, dueDate: event.target.value } : item))} /> : <>{action.effectiveDueDate}{action.effectiveDueDate !== action.dueDate && <small className="block text-slate-400">原计划 {action.dueDate} · 延期已批</small>}</>}</td>
        <td>{canEditPlan ? <input className="input" value={action.deliverable} onChange={(event) => setActions(actions.map((item, i) => i === index ? { ...item, deliverable: event.target.value } : item))} /> : action.deliverable}</td>
        <td><Badge tone={action.status === '已完成' ? 'green' : 'slate'}>{action.status}</Badge>{action.taskId && <button className="mt-1 block text-xs text-brand-700 underline" onClick={() => navigate(`/projects/${project.id}?tab=tasks`)}>反馈 / 验收</button>}</td>
      </tr>)}</tbody></table></div>}
      {data.planHistory.length > 1 && <p className="mt-4 text-xs text-slate-500">历史计划版本：{data.planHistory.map((plan) => `V${plan.revision}（${plan.status === 'archived' ? '已归档' : '当前'}，${plan.targetDate}）`).join(' · ')}</p>}
    </Card>}
    <Modal open={Boolean(waiver)} onClose={() => setWaiver(null)} title={`材料免传：${waiver?.label ?? ''}`} footer={<><Button variant="secondary" onClick={() => setWaiver(null)}>取消</Button><Button loading={busy} disabled={waiverReason.trim().length < 5} onClick={async () => { if (waiver) { await bind(waiver.key, undefined, waiverReason); setWaiver(null) } }}>保存免传说明</Button></>}><p className="mb-3 text-sm text-slate-500">免传不等于材料已存在。说明将与申请一起交给审批人并记录审计。</p><textarea className="textarea min-h-28" value={waiverReason} onChange={(event) => setWaiverReason(event.target.value)} placeholder="填写免传原因、替代证据及责任说明（至少 5 字）" /></Modal>
  </div>
}
