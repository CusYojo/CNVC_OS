import { useEffect, useState, type CSSProperties, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, Circle, FileCheck2, GripVertical, Plus, Save, Trash2, Users } from 'lucide-react'
import { apiDelete, apiGet, apiPut } from '../lib/api'
import { useAuthStore } from '../store/useAuthStore'
import { useToast } from './Toast'
import { Badge, Button, Card, Modal } from './ui'
import type { Project, ProjectFile } from '../types'
import './fde-workspace.css'
import { materialIsSatisfied, shortProjectDate } from '../lib/projectDetailPresentation'
import { useAppStore } from '../store/useAppStore'

type PlanAction = { id: string; actionKey: string; title: string; ownerUserId: string; participantUserIds: string[]; dueDate: string; effectiveDueDate: string; taskId: string | null; deliverable: string; status: string; version: number }
type Workflow = {
  timeline: Array<{ stage: string; date: string; basis: string; version: number; actualDate?: string | null }>
  stages: Array<{ stage: string; allowWaiver: boolean; requiresFund?: boolean; materials: Array<{ key: string; label: string }>; approvals: Array<{ duty: string; name: string; mode: string; approverNames: string[] }> }>
  policy: { id: string; revision: number; cycleDays: number[] }
  materials: Array<{ id: string; stage: string; requirementKey: string; fileId: string | null; fileVersion: number | null; waiverReason: string | null; version: number }>
  plan: { id: string; revision: number; version: number; status: string; cycleDays: number; targetDate: string; updatedAt: string; actions: PlanAction[] } | null
  planHistory: Array<{ id: string; revision: number; status: string; targetDate: string }>
  members: Array<{ id: string; name: string; role: string }>
  duties: Array<{ duty: string; userId: string }>
  capabilities: { canEditPlan: boolean }
}

export function FdeWorkflowPanel({ project, files, mode = 'workflow', onChanged, onUpload, onGovernance }: {
  project: Project; files: ProjectFile[]; mode?: 'workflow' | 'materials' | 'tasks'; onChanged: () => Promise<void>;
  onUpload?: () => void; onGovernance?: () => void
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
  const [planExpanded, setPlanExpanded] = useState(false)
  const [draggedAction, setDraggedAction] = useState<number | null>(null)
  const [expandedStage, setExpandedStage] = useState<string | null>(null)
  const isOwner = currentUser?.id === project.ownerUserId
  const isActive = (project.lifecycle ?? 'active') === 'active'

  const applyData = (next: Workflow) => {
    setData(next)
    setActions(next.plan?.actions.map(action => ({ ...action, participantUserIds: action.participantUserIds?.length ? action.participantUserIds : [action.ownerUserId] })) ?? [])
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
    const existing = data?.materials.find((item) => item.stage === stage && item.requirementKey === key && (fileId ? item.fileId === fileId : Boolean(item.waiverReason)))
    return run(() => apiPut<Workflow>(`/projects/${project.id}/fde-materials`, {
      stage, requirementKey: key, fileId, waiverReason: reason, expectedVersion: existing?.version,
    }), fileId ? '已绑定真实项目材料与文件版本' : '免传说明已记录并进入审批证据')
  }
  const removeBinding = (binding: Workflow['materials'][number]) => run(() => apiDelete<Workflow>(`/projects/${project.id}/fde-materials/${binding.id}?expectedVersion=${binding.version}`), binding.fileId ? '已解除该文件的材料绑定' : '已移除材料免传说明')
  const savePlan = (regenerate: boolean) => run(() => apiPut<Workflow>(`/projects/${project.id}/fde-plan`, {
    cycleDays, targetDate, expectedVersion: data?.plan?.version,
    ...(regenerate ? {} : { actions: actions.map(({ actionKey, title, ownerUserId, participantUserIds, dueDate, deliverable }) => ({ actionKey, title, ownerUserId, participantUserIds, dueDate, deliverable })) }),
  }), '倒排计划新版本已保存')

  const updateAction = (index: number, patch: Partial<PlanAction>) => setActions(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item))
  const addAction = (index: number, below: boolean) => {
    const anchor = actions[index]
    const ownerUserId = anchor?.ownerUserId || data?.members[0]?.id || project.ownerUserId || ''
    const action: PlanAction = {
      id: crypto.randomUUID(), actionKey: `custom_${crypto.randomUUID().replace(/-/g, '')}`, title: '新增尽调任务', ownerUserId,
      participantUserIds: anchor?.participantUserIds?.length ? [...anchor.participantUserIds] : ownerUserId ? [ownerUserId] : [], dueDate: anchor?.dueDate || targetDate, effectiveDueDate: anchor?.dueDate || targetDate,
      taskId: null, deliverable: '待补充交付物', status: '未开始', version: 1,
    }
    const position = Math.max(0, index + (below ? 1 : 0))
    setActions(current => [...current.slice(0, position), action, ...current.slice(position)])
  }
  const dropAction = (target: number, event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    if (draggedAction == null || draggedAction === target) return setDraggedAction(null)
    setActions(current => {
      const reordered = [...current], [moved] = reordered.splice(draggedAction, 1)
      reordered.splice(target, 0, moved)
      return reordered
    })
    setDraggedAction(null)
  }

  if (error) return <Card className="p-5 text-sm text-red-600"><p role="alert">FDE 流程加载失败：{error}</p></Card>
  if (!data) return <Card className="p-5 text-sm text-slate-500">正在读取项目流程、材料与计划…</Card>
  const selectedStage = data.stages.find((item) => item.stage === stage)
  const currentIndex = data.stages.findIndex((item) => item.stage === project.stage)
  const planLocked = data.plan?.status === 'locked'
  const canEditPlan = Boolean(data.capabilities?.canEditPlan) && isActive && data.plan?.status !== 'review'
  const stageRequirements = selectedStage?.materials ?? []
  const missing = stageRequirements.filter(requirement => !materialIsSatisfied(data.materials.filter(item => item.stage === stage && item.requirementKey === requirement.key), files))
  const approval = approvals.filter(item => item.projectId === project.id && item.fromStage === stage).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0]
  const stageDate = data.timeline.find(item => item.stage === stage)
  const materialStages = data.stages.filter(item => item.materials.length)
  const totalRequired = materialStages.reduce((sum, item) => sum + item.materials.length, 0)
  const totalSatisfied = materialStages.reduce((sum, item) => sum + item.materials.filter(requirement => materialIsSatisfied(data.materials.filter(binding => binding.stage === item.stage && binding.requirementKey === requirement.key), files)).length, 0)
  const planCompletion = actions.length ? Math.round(actions.filter(action => action.status === '已完成').length / actions.length * 100) : 0
  const requiredDuties = [['concerned_leader', '老板'], ['secretary', '项目经理'], ['legal', '法务'], ['finance', '财务']] as const
  const missingDuties = requiredDuties.filter(([duty]) => !data.duties.some(item => item.duty === duty)).map(([, label]) => label)
  const peopleConfigured = Boolean(project.ownerUserId) && missingDuties.length === 0
  const planRequired = ['尽调计划审核', '尽调', '内核', '投决', '打款'].includes(stage)
  const planConfirmed = data.plan?.status === 'locked'
  const blockers = [
    ...(project.classification === 'pool' ? ['项目尚未入库'] : []),
    ...(missing.length ? [`待补材料 ${missing.length} 项`] : []),
    ...(!peopleConfigured ? [`缺少${missingDuties.join('、') || '项目负责人'}`] : []),
    ...(planRequired && !planConfirmed ? ['项目计划未确认'] : []),
  ]
  const canStartApproval = isActive && blockers.length === 0
  const remainingTasks = actions.filter(action => !['已完成', '已关闭', '已取消', '已归档'].includes(action.status)).length

  return <div className="fde-workspace fde-detail-flow">
    {mode === 'workflow' && <><Card className="fde-detail-stage-card">
      <div className="fde-detail-card-head"><h2>流程推进</h2><div className="fde-detail-inline-actions"><Badge>{data.plan?.cycleDays ?? project.cycleDays ?? cycleDays} 天周期</Badge><span>目标日 <strong>{shortProjectDate(project.targetDate)}</strong></span></div></div>
      <div className="fde-detail-timeline" aria-label="项目流程" style={{ '--stage-count': data.stages.length } as CSSProperties}>{data.stages.map((item, index) => {
        const completed = index < currentIndex || project.stage === '已 Close'
        const current = item.stage === project.stage && !completed
        const date = data.timeline.find(value => value.stage === item.stage)
        return <button type="button" key={item.stage} aria-pressed={stage === item.stage} className={`fde-detail-stage ${completed ? 'completed' : current ? 'current' : ''} ${expandedStage === item.stage ? 'fde-detail-stage-active' : ''}`} onClick={() => { setStage(item.stage); setExpandedStage(expandedStage === item.stage ? null : item.stage) }}>
          <span className="fde-detail-stage-rail"><span>{completed ? '✓' : index + 1}</span></span>
          <span className="fde-detail-stage-copy"><strong>{item.stage}</strong><small>{completed ? shortProjectDate(date?.actualDate ?? date?.date) : date?.basis === 'approved' ? `改期至 ${shortProjectDate(date.date)}` : `计划 ${shortProjectDate(date?.date)}`}</small></span>
          {current && <span className="fde-detail-stage-state"><Badge tone="blue">当前节点</Badge></span>}
        </button>
      })}</div>
      {project.stage === '已 Close' && <p className="fde-flow-finished">项目已完成交割</p>}
    </Card>
      {expandedStage && (() => {
        const expandedIndex = data.stages.findIndex(item => item.stage === expandedStage)
        const expanded = data.stages[expandedIndex]
        if (!expanded) return null
        const expandedMaterials = expanded.materials ?? []
        const expandedApprovals = expanded.approvals ?? []
        const expandedDone = expandedIndex < currentIndex || project.stage === '已 Close'
        const expandedCurrent = expanded.stage === project.stage && !expandedDone
        const expandedDate = data.timeline.find(v => v.stage === expanded.stage)
        const expandedBindings = data.materials.filter(b => b.stage === expanded.stage)
        const prevStage = expandedIndex > 0 ? data.stages[expandedIndex - 1].stage : null
        return <Card className="fde-detail-stage-overview">
          <div className="fde-detail-stage-overview-head"><span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${expandedDone ? 'bg-emerald-500 text-white' : expandedCurrent ? 'bg-blue-500 text-white' : 'bg-slate-200 text-slate-500'}`}>{expandedDone ? '✓' : expandedIndex + 1}</span><h2>阶段详情 · {expanded.stage}</h2><span>{expandedDone ? '已完成' : expandedCurrent ? '进行中' : '待开始'}</span></div>
          <div className="fde-detail-stage-overview-grid">
            <div className="fde-detail-stage-fact">
              <h3 className="mb-2 text-xs font-semibold text-slate-500">进入条件</h3>
              <ul className="space-y-1 text-sm text-slate-700">
                {prevStage ? <li>· 完成「{prevStage}」审批</li> : <li>· 由项目池或线索转入</li>}
                {expanded.requiresFund && <li>· 明确投资基金</li>}
                {expanded.stage === '尽调计划审核' && <li>· 完整有效的倒排计划</li>}
              </ul>
            </div>
            <div className="fde-detail-stage-fact">
              <h3 className="mb-2 text-xs font-semibold text-slate-500">必备材料</h3>
              {expandedMaterials.length ? <ul className="space-y-1 text-sm">{expandedMaterials.map(requirement => { const satisfied = materialIsSatisfied(expandedBindings.filter(b => b.requirementKey === requirement.key), files); return <li key={requirement.key} className={satisfied ? 'text-slate-700' : 'text-amber-700'}>{satisfied ? '✓' : '○'} {requirement.label}</li> })}</ul> : <p className="text-sm text-slate-400">无独立文件要求</p>}
            </div>
            <div className="fde-detail-stage-fact">
              <h3 className="mb-2 text-xs font-semibold text-slate-500">负责人</h3>
              {expandedApprovals.length ? <div className="flex flex-wrap gap-1">{expandedApprovals.map(approval => <span key={approval.duty} className="rounded bg-brand-50 px-2 py-1 text-xs text-brand-700">{approval.name}{approval.approverNames?.length ? ` · ${approval.approverNames.join('、')}` : ' · 未配置'}</span>)}</div> : <p className="text-sm text-slate-400">无审批节点</p>}
            </div>
            <div className="fde-detail-stage-fact">
              <h3 className="mb-2 text-xs font-semibold text-slate-500">计划</h3>
              <p className="text-sm text-slate-700">{expandedDate?.actualDate ? `已于 ${shortProjectDate(expandedDate.actualDate)} 通过` : `计划 ${shortProjectDate(expandedDate?.date)}`}</p>
            </div>
            <div className="fde-detail-stage-fact fde-detail-stage-fact-wide">
              <h3 className="mb-2 text-xs font-semibold text-slate-500">完成标准</h3>
              <p className="text-sm text-slate-700">{expandedApprovals.length ? expandedApprovals.map(approval => `${approval.name}（${approval.mode}）`).join(' → ') + ' 通过' : '完成阶段动作'}</p>
            </div>
          </div>
        </Card>
      })()}
      <Card className="fde-detail-stage-focus">
        <div className="fde-current-stage-head"><div><span>{stage === project.stage ? '当前节点' : '节点详情'}</span><h2>{stage}</h2><p>计划日期 {shortProjectDate(stageDate?.date)}{stage === project.stage && remainingTasks ? ` · 剩余任务 ${remainingTasks} 项` : ''}</p></div><div className="fde-detail-inline-actions"><Button variant="secondary" onClick={() => setMaterialsOpen(true)}>节点材料</Button>{approval ? <Button onClick={() => navigate(`/workflow?view=project&project=${project.id}&request=${approval.id}`)}>查看阶段审批</Button> : canStartApproval ? <Button onClick={() => navigate(`/workflow?view=project&project=${project.id}`)}>发起阶段审批</Button> : null}</div></div>
        <div className="fde-stage-readiness" aria-label="节点状态"><span data-state={missing.length ? 'warning' : 'ready'}>{stageRequirements.length ? `材料 ${stageRequirements.length - missing.length}/${stageRequirements.length}` : '无需材料'}</span><span data-state={peopleConfigured ? 'ready' : 'warning'}>{peopleConfigured ? '人员已配置' : '人员待配置'}</span><span data-state={!planRequired || planConfirmed ? 'ready' : 'warning'}>{planRequired ? planConfirmed ? '计划已确认' : '计划待确认' : '无需确认计划'}</span><span data-state={blockers.length ? 'warning' : 'ready'}>{blockers.length ? `${blockers.length} 项阻塞` : '无阻塞'}</span>{canStartApproval && !approval && <span data-state="active">可发起审批</span>}</div>
        {approval?.status === '审批中' ? <div className="fde-stage-approval-waiting"><strong>审批进行中</strong><span>{approval.currentNodeName}</span></div> : blockers.length > 0 && <div className="fde-stage-blockers">{missing.length > 0 && <div><span>待补材料 {missing.length} 项</span>{onUpload && <Button variant="secondary" onClick={onUpload}>去上传</Button>}</div>}{!peopleConfigured && <div><span>缺少{missingDuties.join('、') || '项目负责人'}</span>{onGovernance && <Button variant="secondary" onClick={onGovernance}>配置人员</Button>}</div>}{planRequired && !planConfirmed && <div><span>项目计划未确认</span><Button variant="secondary" onClick={() => navigate(`/projects/${project.id}?tab=tasks`)}>去确认</Button></div>}{project.classification === 'pool' && <div><span>项目尚未入库</span><Button variant="secondary" onClick={() => navigate(`/workflow?view=project&project=${project.id}`)}>去处理</Button></div>}</div>}
      </Card></>}

    {mode === 'materials' && <Card className="fde-detail-material-register"><div className="fde-detail-card-head"><h2>节点材料</h2><div className="fde-detail-inline-actions"><Badge tone={totalRequired === totalSatisfied ? 'green' : 'amber'}>{totalSatisfied} / {totalRequired} 已齐备</Badge>{onUpload && isActive && <Button onClick={onUpload}>上传文件</Button>}</div></div><div>{materialStages.map(item => {
      const remaining = item.materials.filter(requirement => !materialIsSatisfied(data.materials.filter(binding => binding.stage === item.stage && binding.requirementKey === requirement.key), files))
      const completed = item.materials.length - remaining.length
      return <button key={item.stage} className={`fde-detail-material-row ${item.stage === project.stage ? 'current' : ''}`} onClick={() => { setStage(item.stage); setMaterialsOpen(true) }}><span className="fde-detail-material-marker">{remaining.length ? '○' : '✓'}</span><span><strong>{item.stage}</strong><small>{remaining.length ? `待处理 ${remaining.slice(0, 2).map(value => value.label).join('、')}${remaining.length > 2 ? ' 等' : ''}` : '准入材料已处理'}</small></span><span className="fde-detail-material-progress"><span><i style={{ width: `${completed / item.materials.length * 100}%` }} /></span><strong>{completed} / {item.materials.length}</strong></span><span>→</span></button>
    })}{!materialStages.length && <p className="fde-detail-empty">当前流程无独立文件要求</p>}</div></Card>}

    <Modal open={materialsOpen} onClose={() => setMaterialsOpen(false)} title={`节点材料 · ${stage}`} width="max-w-3xl"><Card className="fde-panel p-5">
      <div className="flex items-center justify-between"><h2 className="font-semibold">阶段材料 · {stage}</h2>{mode === 'materials' && <select className="input max-w-44" value={stage} onChange={(event) => setStage(event.target.value)}>{data.stages.map((item) => <option key={item.stage}>{item.stage}</option>)}</select>}</div>
      {!selectedStage?.materials.length && <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-500">本阶段无文件要求。</p>}
      <div className="mt-4 space-y-3">{selectedStage?.materials.map((requirement) => {
        const bindings = data.materials.filter((item) => item.stage === stage && item.requirementKey === requirement.key)
        const waiverBinding = bindings.find(binding => binding.waiverReason)
        const fileBindings = bindings.filter(binding => binding.fileId)
        const valid = materialIsSatisfied(bindings, files)
        return <div className="rounded-lg border border-slate-200 p-3" key={requirement.key}>
          <div className="flex items-center gap-2">{valid ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Circle className="h-4 w-4 text-amber-600" />}<strong className="text-sm">{requirement.label}</strong><Badge tone={valid ? 'green' : 'amber'}>{valid ? waiverBinding ? '已免传' : `已绑定 ${fileBindings.length} 份` : '待补充'}</Badge></div>
          {waiverBinding?.waiverReason && <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-slate-50 p-2 text-xs text-slate-600"><span>免传说明：{waiverBinding.waiverReason}</span>{isActive && <button className="shrink-0 text-rose-600" disabled={busy} onClick={() => void removeBinding(waiverBinding)}>移除</button>}</div>}
          {fileBindings.length > 0 && <div className="mt-2 space-y-2">{fileBindings.map(binding => { const boundFile = files.find(file => file.id === binding.fileId); return <div key={binding.id} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 p-2 text-xs"><span className="min-w-0 truncate text-slate-600">{boundFile?.name ?? '文件已不可见'} · 绑定 V{binding.fileVersion}{boundFile && boundFile.version !== binding.fileVersion ? `（当前 V${boundFile.version}，需重新绑定）` : ''}</span>{isActive && <button className="shrink-0 text-rose-600" disabled={busy} onClick={() => void removeBinding(binding)}>解除绑定</button>}</div> })}</div>}
          {isActive && <div className="mt-3 flex flex-wrap gap-2"><select className="input min-w-44 flex-1" value={fileChoices[requirement.key] ?? ''} onChange={(event) => setFileChoices({ ...fileChoices, [requirement.key]: event.target.value })}><option value="">继续选择要绑定的项目文件</option>{files.filter(file => !fileBindings.some(binding => binding.fileId === file.id && binding.fileVersion === file.version)).map((file) => <option value={file.id} key={file.id}>{file.name} · V{file.version}</option>)}</select><Button variant="secondary" loading={busy} disabled={!fileChoices[requirement.key]} onClick={() => { const fileId = fileChoices[requirement.key]; if (fileId) void bind(requirement.key, fileId).then(() => setFileChoices(current => ({ ...current, [requirement.key]: '' }))) }}><FileCheck2 className="h-4 w-4" />增加绑定</Button>{isOwner && !fileBindings.length && data.stages.find((item) => item.stage === stage)?.allowWaiver && <Button variant="secondary" onClick={() => { setWaiver(requirement); setWaiverReason(waiverBinding?.waiverReason ?? '') }}>申请免传</Button>}</div>}
        </div>
      })}</div>
    </Card></Modal>

    {mode === 'tasks' && <Card className="fde-detail-reverse-plan">
      <div className="fde-project-plan-summary"><div><span>项目计划</span><h2>{data.plan ? `V${data.plan.revision}` : '尚未配置'}</h2></div><dl><div><dt>项目目标日</dt><dd>{shortProjectDate(data.plan?.targetDate ?? project.targetDate)}</dd></div><div><dt>计划完成率</dt><dd>{planCompletion}%</dd></div><div><dt>最近更新</dt><dd>{data.plan?.updatedAt ? shortProjectDate(data.plan.updatedAt) : '未更新'}</dd></div></dl><div className="fde-detail-inline-actions">{data.plan && <Badge tone={planLocked ? 'green' : 'amber'}>{planLocked ? '已通过·可修订' : data.plan.status === 'review' ? '审核中' : '草稿'}</Badge>}{data.plan && <Button variant="secondary" onClick={() => setPlanExpanded(value => !value)}>{planExpanded ? '收起计划' : '展开计划'}</Button>}{canEditPlan && <Button onClick={() => { setPlanExpanded(true); setPlanEditing(value => !value) }}>{planEditing ? '结束编辑' : data.plan ? '编辑计划' : '配置计划'}</Button>}</div></div>
      {!data.plan && !planEditing && <div className="fde-detail-plan-empty">尚未配置项目计划</div>}
      {planExpanded && canEditPlan && planEditing && <div className="fde-plan-baseline"><div className="flex flex-wrap items-end gap-3"><label><span className="label">周期</span><select className="input" disabled={planLocked} value={cycleDays} onChange={(event) => setCycleDays(Number(event.target.value))}>{data.policy.cycleDays.map((days) => <option value={days} key={days}>{days} 天</option>)}</select></label><label><span className="label">最终日期</span><input type="date" className="input" disabled={planLocked} value={targetDate} onChange={(event) => setTargetDate(event.target.value)} /></label>{!planLocked && <Button disabled={!targetDate} loading={busy} onClick={() => { void savePlan(true) }}>生成计划</Button>}{actions.length > 0 && <Button variant="secondary" loading={busy} onClick={() => { void savePlan(false) }}><Save className="h-4 w-4" />保存修订</Button>}</div></div>}
      {planExpanded && data.plan && !planEditing && <div className="fde-detail-plan-list">{actions.map(action => <div className="fde-detail-plan-row" key={action.id}><button className={`fde-detail-plan-check ${action.status === '已完成' ? 'completed' : ''}`} disabled={!action.taskId} aria-label={`${action.title}：打开对应任务`} onClick={() => navigate(`/projects/${project.id}?tab=tasks&task=${action.taskId ?? ''}`)}>{action.status === '已完成' ? '✓' : ''}</button><div><strong>{action.title}</strong><div className="fde-plan-row-facts"><span>主负责人：{data.members.find(member => member.id === action.ownerUserId)?.name ?? '未配置'}</span><span>参与人员：{action.participantUserIds.map(id => data.members.find(member => member.id === id)?.name).filter(Boolean).join('、') || '仅主负责人'}</span><span>截止日期：{shortProjectDate(action.effectiveDueDate)}</span><span>交付物：{action.deliverable || '未填写'}</span><Badge tone={action.status === '已完成' ? 'green' : action.status === '待验收' ? 'amber' : 'blue'}>{action.status}</Badge></div></div></div>)}</div>}
      {planExpanded && data.plan && planEditing && <div className="fde-plan-editor" aria-label="项目计划任务编辑器">
        <p className="fde-plan-editor-hint"><GripVertical className="h-4 w-4" />拖动调整顺序</p>
        {actions.map((action, index) => {
          const critical = ['internal_review', 'ic', 'payment', 'close'].includes(action.actionKey)
          return <article key={action.id} className={`fde-plan-editor-row ${draggedAction === index ? 'dragging' : ''}`} draggable onDragStart={() => setDraggedAction(index)} onDragEnd={() => setDraggedAction(null)} onDragOver={event => event.preventDefault()} onDrop={event => dropAction(index, event)}>
            <button type="button" className="fde-plan-drag" aria-label={`拖动第 ${index + 1} 项调整顺序`} title="拖动调整顺序"><GripVertical /></button>
            <div className="fde-plan-editor-main">
              <div className="fde-plan-editor-title"><span>{String(index + 1).padStart(2, '0')}</span><input className="input" aria-label={`第 ${index + 1} 项任务名称`} value={action.title} onChange={event => updateAction(index, { title: event.target.value })} /></div>
              <div className="fde-plan-editor-fields">
                <label><span className="label">主负责人</span><select className="input" value={action.ownerUserId} onChange={event => updateAction(index, { ownerUserId: event.target.value, participantUserIds: [...new Set([...action.participantUserIds, event.target.value])] })}>{data.members.map(member => <option value={member.id} key={member.id}>{member.name} · {member.role}</option>)}</select></label>
                <label><span className="label">截止日期</span><input className="input" type="date" value={action.dueDate} onChange={event => updateAction(index, { dueDate: event.target.value, effectiveDueDate: event.target.value })} /></label>
                <label className="fde-plan-deliverable"><span className="label">交付物</span><input className="input" value={action.deliverable} onChange={event => updateAction(index, { deliverable: event.target.value })} /></label>
              </div>
              <details className="fde-plan-participants"><summary><Users className="h-4 w-4" />参与人员 <strong>{action.participantUserIds.length}</strong><span>{action.participantUserIds.map(id => data.members.find(member => member.id === id)?.name).filter(Boolean).join('、')}</span></summary><div>{data.members.map(member => <label key={member.id}><input type="checkbox" checked={action.participantUserIds.includes(member.id)} disabled={member.id === action.ownerUserId} onChange={event => updateAction(index, { participantUserIds: event.target.checked ? [...action.participantUserIds, member.id] : action.participantUserIds.filter(id => id !== member.id) })} /><span>{member.name}</span><small>{member.role}{member.id === action.ownerUserId ? ' · 主负责人' : ''}</small></label>)}</div></details>
            </div>
            <div className="fde-plan-editor-actions"><button type="button" onClick={() => addAction(index, false)}><Plus />上方增加</button><button type="button" onClick={() => addAction(index, true)}><Plus />下方增加</button><button type="button" className="danger" disabled={critical} title={critical ? '内核、投决、打款与完成交割为流程关键任务，不可删除' : '删除此任务'} onClick={() => setActions(current => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 />删除</button></div>
          </article>
        })}
      </div>}
      {data.planHistory.length > 1 && <div className="fde-plan-history" aria-label="历史计划版本"><span>历史版本</span><div>{data.planHistory.map((plan) => <Badge key={plan.id} tone={plan.status === 'archived' ? 'slate' : 'blue'}>V{plan.revision} · {plan.status === 'archived' ? '已归档' : '当前'} · {shortProjectDate(plan.targetDate)}</Badge>)}</div></div>}
    </Card>}
    <Modal open={Boolean(waiver)} onClose={() => setWaiver(null)} title={`材料免传：${waiver?.label ?? ''}`} footer={<><Button variant="secondary" onClick={() => setWaiver(null)}>取消</Button><Button loading={busy} disabled={waiverReason.trim().length < 5} onClick={async () => { if (waiver) { await bind(waiver.key, undefined, waiverReason); setWaiver(null) } }}>保存免传说明</Button></>}><p className="mb-3 text-sm text-slate-500">请填写免传原因和替代证据。</p><textarea className="textarea min-h-28" value={waiverReason} onChange={(event) => setWaiverReason(event.target.value)} placeholder="填写免传原因、替代证据及责任说明（至少 5 字）" /></Modal>
  </div>
}
