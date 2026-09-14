import { ArrowRight, CheckCircle2, Circle, Clock3, FileCheck2, GitBranch, Plus, RotateCcw, Send, ShieldCheck, XCircle } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, Drawer, Modal, SearchInput, StageBadge, Tabs } from '../components/ui'
import { useAuthStore } from '../store/useAuthStore'
import type { ApprovalRequest, Project, ProjectStage } from '../types'
import { FdeOfficePanel } from '../components/FdeOfficePanel'
import { FdeTypePolicyPanel } from '../components/FdeTypePolicyPanel'
import { approvalCenterReturnPath } from '../../server/src/contracts/fdeApprovalCenterContract'
import { safeVisibleText } from '../../server/src/contracts/textIntegrityContract'

const workflowStages: ProjectStage[] = ['入库', '立项', '尽调计划制定', '尽调计划审核', '尽调', '内核', '投决', '打款', '投后']
const legacyWorkflowStages: ProjectStage[] = ['线索', '初筛', '立项', '尽调', '上会', '投决', '投后', '退出']
const approvalTone = (status: ApprovalRequest['status']) => status === '已通过' ? 'green' : status === '审批中' ? 'blue' : status === '已退回' ? 'amber' : status === '已拒绝' ? 'red' : 'slate'
const taskTone = (status: string) => status === '已完成' ? 'green' : status === '进行中' || status === '待验收' ? 'blue' : status === '已退回' ? 'amber' : status === '已取消' ? 'slate' : 'slate'
const nextStageFor = (stage: ProjectStage, model = 'legacy') => {
  if (['放弃', '退出', '已 Close'].includes(stage)) return null
  const stages = model === 'fde-v1' ? [...workflowStages, '已 Close' as ProjectStage] : legacyWorkflowStages
  const index = stages.indexOf(stage)
  return index >= 0 ? stages[index + 1] ?? null : null
}
const splitApprovers = (value: string) => value.split('/').map((item) => item.trim()).filter(Boolean)
const approvalReference = (request: Pick<ApprovalRequest, 'businessType' | 'requestNo'>) => {
  if (request.businessType === 'task_extension') return '任务延期申请'
  return /^[A-Z]+-[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(request.requestNo) ? '项目审批' : request.requestNo
}
const readableApprovalText = (value: unknown) => safeVisibleText(value)
const readableDateTime = (value: unknown) => {
  const raw = String(value ?? '')
  const timestamp = Date.parse(raw)
  if (!raw || Number.isNaN(timestamp)) return readableApprovalText(raw)
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(timestamp)).replace(/\//g, '-')
}
const standardApprovalChain = [
  ['入库 → 立项', '董事长/总裁审批（任意一人）'],
  ['立项 → 计划制定', '投资项目组任意成员制定计划（无审批）'],
  ['计划制定 → 计划审核', '投资项目组任意成员提交计划'],
  ['计划审核 → 尽调', '董事长/总裁审批（任意一人）'],
  ['尽调 → 内核', '董事长/总裁审批（任意一人）'],
  ['内核 → 投决', '财务审批 → 法务审批 → 董事长/总裁审批（任意一人）'],
  ['投决 → 打款', '董事长审批 → 总裁审批（两人均需通过）'],
  ['打款 → 完成交割', '财务审批'],
]

function WorkflowStageRail({ project, pending }: { project: Project; pending?: ApprovalRequest }) {
  const stages = [...workflowStages, '已 Close' as ProjectStage]
  const currentIndex = Math.max(0, stages.indexOf(project.stage))
  return (
    <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-200 bg-gradient-to-r from-slate-50 via-white to-brand-50/50 px-5 py-5">
      <div className="flex min-w-[850px] items-start">
        {stages.map((stage, index) => {
          const done = index < currentIndex
          const current = index === currentIndex
          return <div key={stage} className="relative flex flex-1 flex-col items-center text-center">
            {index > 0 && <span className={`absolute right-1/2 top-4 h-0.5 w-full ${index <= currentIndex ? 'bg-emerald-400' : 'bg-slate-200'}`} />}
            <span className={`relative z-10 grid h-8 w-8 place-items-center rounded-full text-xs font-bold shadow-sm ${done ? 'bg-emerald-500 text-white' : current ? 'bg-brand-600 text-white ring-4 ring-brand-100' : 'border border-slate-200 bg-white text-slate-400'}`}>{done ? <CheckCircle2 className="h-4 w-4" /> : index + 1}</span>
            <span className={`mt-2 whitespace-nowrap text-xs ${current ? 'font-semibold text-brand-700' : done ? 'text-emerald-700' : 'text-slate-400'}`}>{stage}</span>
            {current && <span className="mt-1 rounded-full bg-brand-100 px-2 py-0.5 text-xs text-brand-700">{pending ? `${pending.currentNodeName}审批中` : '当前阶段'}</span>}
          </div>
        })}
      </div>
    </div>
  )
}

export function WorkflowPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  if (params.get('view') === 'type-policies') return <FdeTypePolicyPanel />
  const explicitSpace = params.get('space')
  const projectSpace = explicitSpace === 'project' || (explicitSpace !== 'office' && (['project', 'board', 'all'].includes(params.get('view') ?? '') || Boolean(params.get('project')) || Boolean(params.get('request'))))
  return <div className="space-y-5">
    <header className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><h1 className="text-2xl font-semibold tracking-tight text-slate-900">审批中心</h1><p className="mt-1 text-sm text-slate-500">集中处理项目决策与日常办公申请</p></div>
        <div className="inline-flex rounded-xl bg-slate-100 p-1" role="tablist" aria-label="审批中心分类">
          <button role="tab" aria-selected={projectSpace} className={`rounded-lg px-5 py-2.5 text-sm font-semibold transition ${projectSpace ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`} onClick={() => navigate('/workflow?space=project&view=pending')}>项目审批</button>
          <button role="tab" aria-selected={!projectSpace} className={`rounded-lg px-5 py-2.5 text-sm font-semibold transition ${!projectSpace ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`} onClick={() => navigate('/workflow?space=office&view=pending')}>办公申请</button>
        </div>
      </div>
    </header>
    {projectSpace ? <ProjectWorkflowPage /> : <FdeOfficePanel />}
  </div>
}

function ProjectWorkflowPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const projects = useAppStore((state) => state.projects)
  const requests = useAppStore((state) => state.approvalRequests)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const createRequest = useAppStore((state) => state.createApprovalRequest)
  const approveRequest = useAppStore((state) => state.approveRequest)
  const returnRequest = useAppStore((state) => state.returnRequest)
  const resubmitApprovalRequest = useAppStore((state) => state.resubmitApprovalRequest)
  const rejectRequest = useAppStore((state) => state.rejectRequest)
  const withdrawRequest = useAppStore((state) => state.withdrawRequest)
  const { showToast } = useToast()
  const initialProjectId = searchParams.get('project') ?? projects.find((project) => currentUser.role === '系统管理员' || project.isParticipant)?.id ?? ''
  const requestedView = searchParams.get('view')
  const [tab, setTab] = useState(['pending', 'mine', 'all', 'board'].includes(requestedView ?? '') ? requestedView! : 'pending')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ApprovalRequest | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showChain, setShowChain] = useState(false)
  const [projectId, setProjectId] = useState(initialProjectId)
  const [targetStage, setTargetStage] = useState<ProjectStage>(() => {
    const initialProject = projects.find((item) => item.id === initialProjectId)
    return initialProject ? nextStageFor(initialProject.stage, initialProject.workflowModel) ?? '立项' : '立项'
  })
  const [reason, setReason] = useState('')
  const [priority, setPriority] = useState<'普通' | '紧急'>('普通')
  const [comment, setComment] = useState('')
  const [returnDialogOpen, setReturnDialogOpen] = useState(false)
  const [returnComment, setReturnComment] = useState('')

  const isActionableByCurrentUser = (request: ApprovalRequest) => {
    if (['agent_schedule', 'project_replan'].includes(request.businessType ?? '')) return false
    if (request.status !== '审批中') return false
    if (request.applicantUserId === currentUser.id) return false
    const node = request.nodes.find((item) => item.id === request.currentNodeId)
    if (!node) return false
    if (currentUser.role === '系统管理员' && request.businessType !== 'task_extension' && projects.find((project) => project.id === request.projectId)?.workflowModel !== 'fde-v1') return true
    return (node.approverUserIds?.includes(currentUser.id) ?? splitApprovers(node.approver).includes(currentUser.name)) && !(node.mode === '会签' && (node.approvedByUserIds?.includes(currentUser.id) ?? node.approvedBy?.includes(currentUser.name)))
  }
  const actionableRequests = requests.filter(isActionableByCurrentUser)
  const pendingCount = actionableRequests.length
  useEffect(() => {
    const view = searchParams.get('view')
    if (view && ['pending', 'mine', 'all', 'board'].includes(view)) setTab(view)
    if (searchParams.get('project')) setProjectId(searchParams.get('project')!)
    const requestId = searchParams.get('request')
    if (requestId) setSelected(requests.find((item) => item.id === requestId) ?? null)
  }, [searchParams, requests])
  const visibleRequests = useMemo(() => requests
    .filter((item) => tab === 'pending' ? isActionableByCurrentUser(item) : tab === 'mine' ? (item.applicantUserId ? item.applicantUserId === currentUser.id : item.applicant === currentUser.name) : true)
    .filter((item) => !query || `${item.requestNo}${item.title}${item.projectName}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)), [requests, tab, currentUser.name, currentUser.role, query])

  const selectedProject = projects.find((item) => item.id === projectId)
  const projectRequests = requests.filter((item) => item.projectId === projectId).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
  const manageableProjects = projects.filter((project) => currentUser.role === '系统管理员' || (project.workflowModel === 'fde-v1' ? project.ownerUserId === currentUser.id : project.owner === currentUser.name || project.collaborators.includes(currentUser.name)))
  const visibleProjects = manageableProjects.filter((project) => (project.lifecycle ?? 'active') === 'active' && project.classification !== 'pool' && !['退出', '放弃', '已 Close'].includes(project.stage) && (!query || `${project.name}${project.companyName}`.toLowerCase().includes(query.toLowerCase())))
  const firstVisibleProjectId = visibleProjects[0]?.id
  useEffect(() => {
    if (projectId || !firstVisibleProjectId) return
    const project = projects.find((item) => item.id === firstVisibleProjectId)
    setProjectId(firstVisibleProjectId)
    const next = project && nextStageFor(project.stage, project.workflowModel)
    if (next) setTargetStage(next)
  }, [projectId, firstVisibleProjectId, projects])
  const defaultTarget = selectedProject ? nextStageFor(selectedProject.stage, selectedProject.workflowModel) : null
  const activeRequest = selectedProject && requests.find((item) => item.projectId === selectedProject.id && item.status === '审批中' && item.businessType !== 'task_extension')
  const selectedCurrentNode = selected?.nodes.find((node) => node.id === selected.currentNodeId)
  const canApproveSelected = !!selected && !!selectedCurrentNode && isActionableByCurrentUser(selected)
  const isSelectedApplicant = !!selected && (selected.applicantUserId ? selected.applicantUserId === currentUser.id : selected.applicant === currentUser.name)
  const selectedLegacyAdmin = !!selected && currentUser.role === '系统管理员' && selected.businessType !== 'task_extension' && projects.find((project) => project.id === selected.projectId)?.workflowModel === 'legacy'
  const canWithdrawSelected = !!selected && !['agent_schedule', 'project_replan'].includes(selected.businessType ?? '') && (isSelectedApplicant || selectedLegacyAdmin)
  const canResubmitSelected = !!selected && selected.status === '已退回' && (isSelectedApplicant || selectedLegacyAdmin)
  useEffect(() => {
    if (selected?.businessType === 'agent_schedule') navigate(`/projects/${selected.projectId}?tab=workflow&schedule=${selected.id}`)
    if (selected?.businessType === 'project_replan') navigate(`/projects/${selected.projectId}?tab=workflow&replan=${selected.id}`)
  }, [selected?.id, selected?.businessType, selected?.projectId, navigate])
  useEffect(() => {
    setComment('')
    setReturnComment('')
    setReturnDialogOpen(false)
  }, [selected?.id])

  const openCreate = (nextProjectId = projectId) => {
    const project = projects.find((item) => item.id === nextProjectId)
    if (!project) return
    const canSubmit = currentUser.role === '系统管理员' || (project.workflowModel === 'fde-v1' ? project.ownerUserId === currentUser.id : project.owner === currentUser.name || project.collaborators.includes(currentUser.name))
    if (!canSubmit) {
      showToast('只有项目负责人可以发起该项目的阶段审批', 'error')
      return
    }
    const active = requests.find((item) => item.projectId === project.id && item.status === '审批中')
    if (active) {
      setSelected(active)
      showToast('该项目已有审批中的 OA，不能重复发起', 'error')
      return
    }
    const next = nextStageFor(project.stage, project.workflowModel)
    if (!next) {
      showToast('该项目没有可继续推进的标准阶段', 'error')
      return
    }
    setProjectId(project.id)
    setTargetStage(next)
    setReason(`申请将${project.name}从“${project.stage}”推进至“${next}”。请按节点检查材料完整性、关键风险与决策依据。`)
    setShowCreate(true)
  }

  const submit = async () => {
    if (!selectedProject || !reason.trim()) return showToast('请填写审批事由', 'error')
    try {
      const created = await createRequest({ projectId: selectedProject.id, targetStage, reason, priority })
      if (!created) return showToast('未能发起审批，请检查项目状态', 'error')
      setSelected(created)
      setShowCreate(false)
      setTab('pending')
      showToast(`${approvalReference(created)}已提交`)
    } catch (error) {
      showToast((error as Error).message || '审批提交失败', 'error')
    }
  }

  const act = async (action: 'approve' | 'return' | 'reject' | 'withdraw', actionComment = comment) => {
    if (!selected) return
    const opinion = actionComment.trim()
    if (opinion.length < (action === 'return' ? 5 : 2)) return showToast(action === 'return' ? '退回意见至少填写 5 个字' : '请填写审批意见', 'error')
    try {
      if (action === 'approve') await approveRequest(selected.id, opinion)
      if (action === 'return') await returnRequest(selected.id, opinion)
      if (action === 'reject') await rejectRequest(selected.id, opinion)
      if (action === 'withdraw') await withdrawRequest(selected.id, opinion)
      setReturnDialogOpen(false)
      setSelected(null)
      showToast(selected.businessType === 'task_extension' ? action === 'approve' ? '延期已批准，有效任务期限已更新；项目阶段未变化' : '延期状态已更新，原任务期限保持不变' : action === 'approve' ? '当前节点已通过；如为末节点，项目阶段已同步' : action === 'return' ? '申请已退回，项目阶段未变化' : action === 'reject' ? '申请已拒绝，项目阶段未变化' : '申请已撤回，项目阶段未变化')
    } catch (error) {
      showToast((error as Error).message || '审批操作失败', 'error')
    }
  }

  const resubmit = async () => {
    if (!selected || !comment.trim()) return showToast('请填写补充说明后重新提交', 'error')
    try {
      await resubmitApprovalRequest(selected.id, comment)
      setSelected(null)
      setTab('mine')
      showToast(`${approvalReference(selected)}已重新提交`)
    } catch (error) {
      showToast((error as Error).message || '重新提交失败', 'error')
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-lg font-semibold text-slate-900">项目审批</h2><p className="mt-1 text-sm text-slate-500">待处理 {pendingCount} 项</p></div>
        <div className="flex flex-wrap gap-2"><a className="inline-flex items-center px-2 text-sm text-teal-800" href={approvalCenterReturnPath(searchParams.get('center'))}>返回审批来源</a><Button variant="secondary" onClick={() => setShowChain(true)}><GitBranch className="h-4 w-4" />审批链</Button><Button onClick={() => openCreate()}><Plus className="h-4 w-4" />发起项目审批</Button></div>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-5">
          <Tabs tabs={[{ id: 'pending', label: '待我审批', count: pendingCount }, { id: 'mine', label: '我发起的' }, { id: 'board', label: '阶段看板' }, { id: 'all', label: '全部记录', count: requests.length }]} value={tab} onChange={setTab} />
          <SearchInput className="w-[280px]" placeholder="搜索单号、项目或流程…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>

        {tab === 'project' ? (
          <div className="grid min-h-[520px] grid-cols-[330px_1fr] border-t border-slate-100">
            <div className="border-r border-slate-100 p-3">
              <p className="px-2 pb-3 pt-1 text-xs text-slate-400">第一步：选择需要发起申请的项目</p>
              <div className="max-h-[610px] space-y-1 overflow-y-auto pr-1 scrollbar-thin">
                {visibleProjects.map((project) => {
                  const pending = requests.find((item) => item.projectId === project.id && item.status === '审批中' && item.businessType !== 'task_extension')
                  return <button key={project.id} onClick={() => { setProjectId(project.id); const next = nextStageFor(project.stage, project.workflowModel); if (next) setTargetStage(next) }} className={`w-full rounded-xl border p-3 text-left transition ${projectId === project.id ? 'border-brand-300 bg-brand-50 ring-2 ring-brand-100' : 'border-transparent hover:bg-slate-50'}`}><div className="flex items-center justify-between"><p className="truncate text-sm font-semibold text-slate-700">{project.name}</p><StageBadge stage={project.stage} /></div><p className="mt-1 truncate text-xs text-slate-400">{project.companyName}</p><div className="mt-2 flex items-center justify-between text-xs"><span className="text-slate-400">负责人 {project.owner}</span>{pending ? <Badge tone="blue">审批中</Badge> : <span className="text-brand-600">可申请 →</span>}</div></button>
                })}
              </div>
            </div>
            <div className="p-6">
              {selectedProject ? <div>
                <div className="flex items-start justify-between"><div><p className="text-xs font-medium text-brand-600">第二步：确认项目与申请类型</p><h2 className="mt-2 text-xl font-semibold text-slate-900">{selectedProject.name}</h2><p className="mt-1 text-sm text-slate-400">{selectedProject.companyName} · {selectedProject.industry} · 负责人 {selectedProject.owner}</p></div>{activeRequest ? <Button variant="secondary" onClick={() => setSelected(activeRequest)}>查看审批中的 OA</Button> : <Button onClick={() => openCreate(selectedProject.id)}><Plus className="h-4 w-4" />发起该项目申请</Button>}</div>
                <WorkflowStageRail project={selectedProject} pending={activeRequest} />
                <div className="mt-6 rounded-xl border border-brand-100 bg-brand-50/60 p-5"><p className="text-xs font-medium text-brand-600">下一阶段申请</p><div className="mt-3 flex items-center gap-3"><StageBadge stage={selectedProject.stage} /><ArrowRight className="h-4 w-4 text-slate-300" />{defaultTarget ? <StageBadge stage={defaultTarget} /> : <Badge>无后续阶段</Badge>}<span className="text-sm font-medium text-slate-700">{defaultTarget ? `${selectedProject.stage} → ${defaultTarget} 阶段审批` : '项目流程已完成'}</span></div></div>
                <div className="mt-6 grid grid-cols-3 gap-3">{[['当前阶段', selectedProject.stage], ['项目负责人', selectedProject.owner], ['历史 OA', `${projectRequests.length} 条`]].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-4"><p className="text-xs text-slate-400">{label}</p><p className="mt-1 text-sm font-semibold text-slate-700">{value}</p></div>)}</div>
                <div className="mt-6"><h3 className="text-sm font-semibold text-slate-800">该项目的申请记录</h3><div className="mt-3 space-y-2">{projectRequests.map((request) => <button key={request.id} onClick={() => setSelected(request)} className="flex w-full items-center rounded-lg border border-slate-200 p-3 text-left hover:border-brand-200"><div className="flex-1"><p className="text-sm font-medium text-slate-700">{request.title}</p><p className="mt-1 text-xs text-slate-400">{approvalReference(request)} · {request.applicant} · {readableDateTime(request.submittedAt)}</p></div><Badge tone={approvalTone(request.status)}>{request.status}</Badge><span className="ml-4 text-xs text-brand-600">查看 →</span></button>)}{!projectRequests.length && <div className="rounded-lg border border-dashed border-slate-200 p-8 text-center text-sm text-slate-400">该项目尚未发起 OA 申请</div>}</div></div>
              </div> : <div className="grid h-full place-items-center text-sm text-slate-400">请先从左侧选择项目</div>}
            </div>
          </div>
        ) : tab !== 'board' ? (
          <div className="divide-y divide-slate-100">
            {visibleRequests.map((request) => {
              const currentNode = request.nodes.find((node) => node.id === request.currentNodeId)
              return (
                <button key={request.id} onClick={() => setSelected(request)} className="grid w-full grid-cols-[1.5fr_.8fr_.8fr_1fr_120px] items-center gap-4 px-5 py-4 text-left hover:bg-slate-50">
                  <div><div className="flex items-center gap-2"><span className="font-medium text-slate-800">{request.title}</span><Badge tone={approvalTone(request.status)}>{request.status}</Badge>{request.priority === '紧急' && <Badge tone="red">紧急</Badge>}</div><p className="mt-1 text-xs text-slate-400">{approvalReference(request)} · {request.applicant} · {readableDateTime(request.submittedAt)}</p></div>
                  <div><p className="text-xs text-slate-400">{request.businessType === 'task_extension' ? '任务截止日期' : '阶段变更'}</p><div className="mt-1 flex items-center gap-1">{request.businessType === 'task_extension' ? <span className="text-xs">{request.businessPayload?.originalDueDate} → {request.businessPayload?.requestedDueDate}</span> : <><StageBadge stage={request.fromStage} /><ArrowRight className="h-3 w-3 text-slate-300" /><StageBadge stage={request.targetStage} /></>}</div></div>
                  <div><p className="text-xs text-slate-400">当前节点</p><p className="mt-1 text-sm text-slate-700">{request.currentNodeName}</p></div>
                  <div><p className="text-xs text-slate-400">当前审批人</p><p className="mt-1 text-sm text-slate-700">{currentNode?.approver ?? '—'}</p></div>
                  <div className="text-right text-xs text-brand-600">查看完整流程 →</div>
                </button>
              )
            })}
            {!visibleRequests.length && <div className="p-14 text-center text-sm text-slate-400">当前筛选下没有 OA 流程</div>}
          </div>
        ) : (
          <div className="overflow-x-auto p-5">
            <div className="grid min-w-[1280px] grid-cols-8 gap-3">
              {workflowStages.map((stage, index) => <div key={stage} className="min-h-[330px] rounded-xl border border-slate-200 bg-slate-50/70"><div className="flex items-center justify-between border-b border-slate-200 px-3 py-3"><div className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-md bg-brand-100 text-xs font-semibold text-brand-700">{index + 1}</span><span className="text-sm font-semibold text-slate-700">{stage}</span></div><Badge>{projects.filter((item) => item.stage === stage).length}</Badge></div><div className="space-y-2 p-2.5">{projects.filter((item) => item.stage === stage).map((project) => { const pending = requests.find((item) => item.projectId === project.id && item.status === '审批中' && item.businessType !== 'task_extension'); return <button key={project.id} onClick={() => pending ? setSelected(pending) : openCreate(project.id)} className="w-full rounded-lg border border-slate-200 bg-white p-3 text-left hover:border-brand-300"><p className="truncate text-xs font-semibold text-slate-700">{project.name}</p><p className="mt-1.5 text-xs text-slate-400">{project.owner} · {project.industry}</p><div className="mt-3">{pending ? <Badge tone="blue">{pending.currentNodeName}</Badge> : <Badge tone="slate">可发起下一阶段 OA</Badge>}</div></button>})}</div></div>)}
            </div>
          </div>
        )}
      </Card>

      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected?.title ?? '审批详情'} width="w-[760px]" footer={selected?.status === '审批中' ? <>{canWithdrawSelected && <Button variant="secondary" onClick={() => act('withdraw')}>撤回</Button>}{canApproveSelected ? <><Button variant="danger" onClick={() => act('reject')}><XCircle className="h-4 w-4" />拒绝</Button><Button variant="secondary" onClick={() => { setReturnComment(''); setReturnDialogOpen(true) }}><RotateCcw className="h-4 w-4" />退回补充</Button><Button onClick={() => act('approve')}><CheckCircle2 className="h-4 w-4" />同意并流转</Button></> : <span className="text-xs text-slate-500">当前节点由 {selectedCurrentNode?.approver ?? '指定审批人'} 处理；你只能查看流程。</span>}</> : canResubmitSelected ? <Button onClick={resubmit}><Send className="h-4 w-4" />补充后重新提交</Button> : undefined}>
        {selected && <div className="space-y-6">
          <section><h3 className="mb-3 text-sm font-semibold text-slate-800">核心摘要</h3><div className="rounded-xl border border-brand-100 bg-brand-50/60 p-4"><div className="flex items-center justify-between"><div><p className="text-xs text-brand-600">{approvalReference(selected)}</p><p className="mt-1 font-semibold text-slate-800">{selected.projectName}</p></div><Badge tone={approvalTone(selected.status)}>{selected.status}</Badge></div><div className="mt-4 flex items-center gap-2">{selected.businessType === 'task_extension' ? <p className="text-sm">任务期限：{selected.businessPayload?.originalDueDate} → {selected.businessPayload?.requestedDueDate}</p> : <><StageBadge stage={selected.fromStage} /><ArrowRight className="h-4 w-4 text-slate-300" /><StageBadge stage={selected.targetStage} /></>}</div></div></section>
          <section><h3 className="mb-3 text-sm font-semibold text-slate-800">申请内容</h3><div className="grid grid-cols-2 gap-3 text-sm"><div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-400">申请人 / 部门</p><p className="mt-1 text-slate-700">{selected.applicant} · {selected.department}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-400">融资计划 / 估值</p><p className="mt-1 text-slate-700">{selected.amount || '未披露'} / {selected.valuation || '待核验'}</p></div></div>{readableApprovalText(selected.reason) && <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-600">{readableApprovalText(selected.reason)}</p>}</section>
          {selected.type === '尽调计划审核' && <section>
            <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-slate-800">尽调任务安排</h3>{selected.planReview && <Badge tone="blue">{selected.planReview.actions.length} 项任务</Badge>}</div>
            {selected.planReview ? <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="grid grid-cols-3 divide-x divide-slate-100 border-b border-slate-200 bg-slate-50/80">
                <div className="px-4 py-3"><p className="text-xs text-slate-400">计划版本</p><p className="mt-1 text-sm font-semibold text-slate-700">V{selected.planReview.revision}</p></div>
                <div className="px-4 py-3"><p className="text-xs text-slate-400">尽调周期</p><p className="mt-1 text-sm font-semibold text-slate-700">{selected.planReview.cycleDays} 天</p></div>
                <div className="px-4 py-3"><p className="text-xs text-slate-400">项目目标日</p><p className="mt-1 text-sm font-semibold text-slate-700">{selected.planReview.targetDate}</p></div>
              </div>
              <div className="divide-y divide-slate-100">
                {selected.planReview.actions.map((action) => <article key={action.id} className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_160px_92px] sm:items-center">
                  <div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate text-sm font-semibold text-slate-800">{readableApprovalText(action.title)}</p><Badge tone={taskTone(action.status)}>{action.status}</Badge></div><p className="mt-1 truncate text-xs text-slate-500">交付物：{readableApprovalText(action.deliverable)}</p></div>
                  <div className="min-w-0 text-xs"><p className="truncate font-medium text-slate-700">负责人：{action.owner}</p><p className="mt-1 truncate text-slate-400" title={action.participants.join('、')}>参与：{action.participants.length ? action.participants.join('、') : action.owner}</p></div>
                  <div className="text-left sm:text-right"><p className="text-xs text-slate-400">截止时间</p><p className="mt-1 whitespace-nowrap text-sm font-medium text-slate-700">{action.dueDate}</p></div>
                </article>)}
                {!selected.planReview.actions.length && <div className="px-4 py-8 text-center text-sm text-slate-400">本次计划暂无尽调任务</div>}
              </div>
            </div> : <div className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">本次审批未关联尽调计划</div>}
          </section>}
          {Boolean(selected.revisions?.length) && <section><h3 className="text-sm font-semibold text-slate-800">提交修订历史</h3><div className="mt-3 space-y-2">{selected.revisions!.map((revision) => <details className="rounded-lg bg-slate-50 p-3 text-xs" key={revision.id}><summary className="cursor-pointer">修订 V{revision.revision} · {readableDateTime(revision.submittedAt)}</summary>{readableApprovalText(revision.snapshot.reason ?? '') && <p className="mt-2 leading-5 text-slate-600">{readableApprovalText(revision.snapshot.reason ?? '')}</p>}<p className="mt-1 text-slate-500">{String(revision.snapshot.fromStage ?? '')} → {String(revision.snapshot.targetStage ?? '')}</p></details>)}</div></section>}
          <section><h3 className="text-sm font-semibold text-slate-800">前置检查</h3><div className="mt-3 grid grid-cols-2 gap-2">{selected.checklist.map((item) => <div key={item.label} className="flex items-center gap-2 rounded-lg border border-slate-100 px-3 py-2 text-xs text-slate-600">{item.passed ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Circle className="h-4 w-4 text-amber-500" />}{item.label}{item.required && <span className="ml-auto text-rose-400">必需</span>}</div>)}</div></section>
          <section><h3 className="text-sm font-semibold text-slate-800">附件材料</h3>{Boolean(selected.materialSnapshot?.length) && <div className="mt-3 grid gap-2 sm:grid-cols-2">{selected.materialSnapshot!.map((material) => <div key={material.requirementKey} className="rounded-lg border border-slate-200 p-3 text-xs"><strong>{material.requirementKey}</strong><p className="mt-1 text-slate-600">{material.waiverReason ? `免传说明：${material.waiverReason}` : `已锁定送审版本 V${material.fileVersion}`}</p></div>)}</div>}<div className="mt-3 flex flex-wrap gap-2">{selected.attachments.map((item) => <Badge key={item} tone="slate"><FileCheck2 className="mr-1 h-3 w-3" />{item}</Badge>)}{!selected.attachments.length && !selected.materialSnapshot?.length && <span className="text-sm text-slate-400">无附件</span>}</div></section>
          <section><h3 className="text-sm font-semibold text-slate-800">审批时间轴</h3><div className="mt-4 space-y-0">{selected.nodes.map((node, index) => <div key={node.id} className="relative flex gap-3 pb-5 last:pb-0"><div className="flex flex-col items-center"><span className={`grid h-8 w-8 place-items-center rounded-full ${node.status === '已通过' ? 'bg-emerald-500 text-white' : node.status === '待审批' || node.status === '会签中' ? 'bg-brand-600 text-white ring-4 ring-brand-50' : node.status === '已退回' || node.status === '已拒绝' ? 'bg-rose-500 text-white' : 'bg-slate-100 text-slate-400'}`}>{node.status === '已通过' ? <CheckCircle2 className="h-4 w-4" /> : node.status === '待审批' || node.status === '会签中' ? <Clock3 className="h-4 w-4" /> : index + 1}</span>{index < selected.nodes.length - 1 && <span className="h-full w-px bg-slate-200" />}</div><div className="flex-1 rounded-lg border border-slate-100 p-3"><div className="flex items-center justify-between"><p className="text-sm font-medium text-slate-700">{node.name}</p><Badge tone={node.status === '已通过' ? 'green' : node.status === '待审批' || node.status === '会签中' ? 'blue' : node.status === '已退回' || node.status === '已拒绝' ? 'red' : 'slate'}>{node.status}</Badge></div><p className="mt-1 text-xs text-slate-400">处理人：{node.approver} · {node.approverRole} · {node.mode}</p>{node.completedAt && <p className="mt-1 text-xs text-slate-400">处理时间：{readableDateTime(node.completedAt)}</p>}{node.mode === '会签' && <p className="mt-2 text-xs text-brand-600">会签进度：{node.approvedBy?.length ?? 0}/{splitApprovers(node.approver).length}{node.approvedBy?.length ? ` · 已同意：${node.approvedBy.join('、')}` : ''}</p>}{readableApprovalText(node.comment) && <p className="mt-2 text-xs leading-5 text-slate-600">审批意见：{readableApprovalText(node.comment)}</p>}</div></div>)}</div>{(selected.status === '审批中' || canResubmitSelected) && <textarea className="textarea mt-4 min-h-24" value={comment} onChange={(event) => setComment(event.target.value)} placeholder={canResubmitSelected ? '说明已补充的材料和修订内容…' : '填写同意、拒绝或撤回意见…'} />}</section>
          <section><h3 className="text-sm font-semibold text-slate-800">操作记录</h3><div className="mt-3 space-y-2">{selected.records.map((record) => <div key={record.id} className="flex gap-3 rounded-lg bg-slate-50 p-3 text-xs"><ShieldCheck className="mt-0.5 h-4 w-4 text-brand-500" /><div><p className="font-medium text-slate-700">{record.operator} · {record.action} · {record.nodeName}</p>{readableApprovalText(record.comment) && <p className="mt-1 leading-5 text-slate-500">{readableApprovalText(record.comment)}</p>}<p className="mt-1 text-slate-400">{readableDateTime(record.createdAt)}</p></div></div>)}</div></section>
        </div>}
      </Drawer>

      <Modal open={returnDialogOpen && Boolean(selected)} onClose={() => setReturnDialogOpen(false)} title="退回申请" footer={<><Button variant="secondary" onClick={() => setReturnDialogOpen(false)}>取消</Button><Button variant="danger" disabled={returnComment.trim().length < 5} onClick={() => void act('return', returnComment)}><RotateCcw className="h-4 w-4" />确认退回</Button></>}>
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><p className="text-sm font-semibold text-slate-800">{selected?.projectName}</p><p className="mt-1 text-xs text-slate-500">当前节点：{selected?.currentNodeName}</p></div>
          <label className="block"><span className="label">退回意见 <span className="text-rose-500">*</span></span><textarea autoFocus className="textarea min-h-28" maxLength={8000} value={returnComment} onChange={(event) => setReturnComment(event.target.value)} placeholder="请说明需要补充或修改的具体内容（至少 5 个字）" /></label>
          <div className="flex items-center justify-between text-xs text-slate-500"><span>意见将同步给申请人并保留在审批记录中</span><span>{returnComment.trim().length}/8000</span></div>
        </div>
      </Modal>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="发起项目 OA 审批" width="max-w-3xl" footer={<><Button variant="secondary" onClick={() => setShowCreate(false)}>取消</Button><Button onClick={submit}><Send className="h-4 w-4" />提交审批</Button></>}>
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4"><label><span className="label">项目</span><select className="input" value={projectId} onChange={(event) => { const nextId = event.target.value; const project = projects.find((item) => item.id === nextId); setProjectId(nextId); if (project && nextStageFor(project.stage, project.workflowModel)) setTargetStage(nextStageFor(project.stage, project.workflowModel)!); setReason('') }}>{visibleProjects.map((item) => <option key={item.id} value={item.id}>{item.name}（当前：{item.stage}）</option>)}</select></label><label><span className="label">优先级</span><select className="input" value={priority} onChange={(event) => setPriority(event.target.value as '普通' | '紧急')}><option>普通</option><option>紧急</option></select></label></div>
          {activeRequest && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">该项目已有审批中的申请，请先完成当前流程。</div>}
          <div className="rounded-xl border border-brand-100 bg-brand-50/50 p-4"><p className="text-xs font-medium text-brand-700">申请的阶段变更</p><div className="mt-3 flex items-center gap-3"><StageBadge stage={selectedProject?.stage ?? '线索'} /><ArrowRight className="h-4 w-4 text-slate-300" /><select className="input w-32" value={targetStage} onChange={(event) => setTargetStage(event.target.value as ProjectStage)}>{defaultTarget && <option>{defaultTarget}</option>}<option>放弃</option></select></div></div>
          <label><span className="label">申请事由与决策依据</span><textarea className="textarea min-h-32" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明为什么进入下一阶段、已完成哪些核验、仍有哪些风险…" /></label>
          <div className="grid grid-cols-2 gap-4"><label><span className="label">融资计划（来自项目档案）</span><input className="input" value={selectedProject?.financing ?? ''} readOnly /></label><label><span className="label">估值（来自项目档案）</span><input className="input" value={selectedProject?.valuation ?? ''} readOnly /></label></div>
        </div>
      </Modal>

      <Modal open={showChain} onClose={() => setShowChain(false)} title="赛智伯乐标准投资审批链" width="max-w-3xl" footer={<Button onClick={() => setShowChain(false)}>我知道了</Button>}>
        <div className="space-y-3">
          {standardApprovalChain.map(([transition, ...nodes], index) => <div key={transition} className="grid grid-cols-[130px_1fr] gap-4 rounded-xl border border-slate-200 p-4"><div><Badge tone="blue">第 {index + 1} 段</Badge><p className="mt-2 text-sm font-semibold text-slate-800">{transition}</p></div><div className="flex flex-wrap items-center gap-2">{nodes.map((node, nodeIndex) => <div key={node} className="flex items-center gap-2"><span className="rounded-lg bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700">{node}</span>{nodeIndex < nodes.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-slate-300" />}</div>)}</div></div>)}
          <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">会签节点必须由全部指定审批人完成；退回可补充后重新提交，拒绝与撤回则终止当前流程。只有最终节点通过后，项目阶段才会自动更新。</p>
        </div>
      </Modal>
    </div>
  )
}
