import { ArrowRight, CheckCircle2, Circle, Clock3, FileCheck2, GitBranch, Plus, RotateCcw, Send, ShieldCheck, XCircle } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, Drawer, Modal, PageHeader, SearchInput, StageBadge, Tabs } from '../components/ui'
import { useAuthStore } from '../store/useAuthStore'
import type { ApprovalRequest, ProjectStage } from '../types'

const workflowStages: ProjectStage[] = ['线索', '初筛', '立项', '尽调', '上会', '投决', '投后', '退出']
const approvalTone = (status: ApprovalRequest['status']) => status === '已通过' ? 'green' : status === '审批中' ? 'blue' : status === '已退回' ? 'amber' : status === '已拒绝' ? 'red' : 'slate'
const nextStageFor = (stage: ProjectStage) => stage === '放弃' ? null : workflowStages[workflowStages.indexOf(stage) + 1] ?? null
const splitApprovers = (value: string) => value.split('/').map((item) => item.trim()).filter(Boolean)
const standardApprovalChain = [
  ['线索 → 初筛', '投资总监初筛', '平台登记复核'],
  ['初筛 → 立项', '投资总监审批', '风控合规会签', '平台主管备案'],
  ['立项 → 尽调', '投资总监审批', '财务与法务排期'],
  ['尽调 → 上会', '投资总监预审', '财务法务风控会签', '投委会秘书排会'],
  ['上会 → 投决', '投委会表决', '董事长终审'],
  ['投决 → 投后', '投资负责人确认', '投后负责人接收', '财务归档'],
]

export function WorkflowPage() {
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
  const initialProjectId = searchParams.get('project') ?? projects.find((project) => currentUser.role === '系统管理员' || project.owner === currentUser.name || project.collaborators.includes(currentUser.name))?.id ?? ''
  const requestedView = searchParams.get('view')
  const [tab, setTab] = useState(['project', 'pending', 'mine', 'all', 'board'].includes(requestedView ?? '') ? requestedView! : 'project')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ApprovalRequest | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showChain, setShowChain] = useState(false)
  const [projectId, setProjectId] = useState(initialProjectId)
  const [targetStage, setTargetStage] = useState<ProjectStage>(() => nextStageFor(projects.find((item) => item.id === initialProjectId)?.stage ?? '线索') ?? '初筛')
  const [reason, setReason] = useState('')
  const [priority, setPriority] = useState<'普通' | '紧急'>('普通')
  const [comment, setComment] = useState('资料核验范围清楚，同意进入下一节点。')

  const isActionableByCurrentUser = (request: ApprovalRequest) => {
    if (request.status !== '审批中') return false
    const node = request.nodes.find((item) => item.id === request.currentNodeId)
    if (!node) return false
    if (currentUser.role === '系统管理员') return true
    return splitApprovers(node.approver).includes(currentUser.name) && !(node.mode === '会签' && node.approvedBy?.includes(currentUser.name))
  }
  const actionableRequests = requests.filter(isActionableByCurrentUser)
  const pendingCount = actionableRequests.length
  useEffect(() => {
    const view = searchParams.get('view')
    if (view && ['project', 'pending', 'mine', 'all', 'board'].includes(view)) setTab(view)
    if (searchParams.get('project')) setProjectId(searchParams.get('project')!)
    const requestId = searchParams.get('request')
    if (requestId) setSelected(requests.find((item) => item.id === requestId) ?? null)
  }, [searchParams, requests])
  const visibleRequests = useMemo(() => requests
    .filter((item) => tab === 'pending' ? isActionableByCurrentUser(item) : tab === 'mine' ? item.applicant === currentUser.name : true)
    .filter((item) => !query || `${item.requestNo}${item.title}${item.projectName}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)), [requests, tab, currentUser.name, currentUser.role, query])

  const selectedProject = projects.find((item) => item.id === projectId)
  const projectRequests = requests.filter((item) => item.projectId === projectId).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
  const manageableProjects = projects.filter((project) => currentUser.role === '系统管理员' || project.owner === currentUser.name || project.collaborators.includes(currentUser.name))
  const visibleProjects = manageableProjects.filter((project) => !['退出', '放弃'].includes(project.stage) && (!query || `${project.name}${project.companyName}`.toLowerCase().includes(query.toLowerCase())))
  const defaultTarget = selectedProject ? nextStageFor(selectedProject.stage) : null
  const activeRequest = selectedProject && requests.find((item) => item.projectId === selectedProject.id && item.status === '审批中')
  const selectedCurrentNode = selected?.nodes.find((node) => node.id === selected.currentNodeId)
  const canApproveSelected = !!selectedCurrentNode
    && (splitApprovers(selectedCurrentNode.approver).includes(currentUser.name) || currentUser.role === '系统管理员')
    && !(selectedCurrentNode.mode === '会签' && selectedCurrentNode.approvedBy?.includes(currentUser.name) && currentUser.role !== '系统管理员')
  const canWithdrawSelected = !!selected && (selected.applicant === currentUser.name || currentUser.role === '系统管理员')
  const canResubmitSelected = !!selected && selected.status === '已退回' && (selected.applicant === currentUser.name || currentUser.role === '系统管理员')

  const openCreate = (nextProjectId = projectId) => {
    const project = projects.find((item) => item.id === nextProjectId)
    if (!project) return
    if (currentUser.role !== '系统管理员' && project.owner !== currentUser.name && !project.collaborators.includes(currentUser.name)) {
      showToast('你不是该项目负责人或协作成员，不能发起申请', 'error')
      return
    }
    const active = requests.find((item) => item.projectId === project.id && item.status === '审批中')
    if (active) {
      setSelected(active)
      showToast('该项目已有审批中的 OA，不能重复发起', 'error')
      return
    }
    const next = nextStageFor(project.stage)
    if (!next) {
      showToast('该项目没有可继续推进的标准阶段', 'error')
      return
    }
    setProjectId(project.id)
    setTargetStage(next)
    setReason(`申请将${project.name}从“${project.stage}”推进至“${next}”。请按节点检查材料完整性、关键风险与决策依据。`)
    setShowCreate(true)
  }

  const submit = () => {
    if (!selectedProject || !reason.trim()) return showToast('请填写审批事由', 'error')
    const created = createRequest({ projectId: selectedProject.id, targetStage, reason, priority })
    if (!created) return showToast('未能发起审批，请检查项目状态', 'error')
    setSelected(created)
    setShowCreate(false)
    setTab('pending')
    showToast(`${created.requestNo} 已提交；项目阶段将在全部节点通过后自动更新`)
  }

  const act = (action: 'approve' | 'return' | 'reject' | 'withdraw') => {
    if (!selected) return
    if (!comment.trim()) return showToast('请填写审批意见', 'error')
    if (action === 'approve') approveRequest(selected.id, comment)
    if (action === 'return') returnRequest(selected.id, comment)
    if (action === 'reject') rejectRequest(selected.id, comment)
    if (action === 'withdraw') withdrawRequest(selected.id, comment)
    setSelected(null)
    showToast(action === 'approve' ? '当前节点已通过；如为末节点，项目阶段已同步' : action === 'return' ? '申请已退回，项目阶段未变化' : action === 'reject' ? '申请已拒绝，项目阶段未变化' : '申请已撤回，项目阶段未变化')
  }

  const resubmit = () => {
    if (!selected || !comment.trim()) return showToast('请填写补充说明后重新提交', 'error')
    resubmitApprovalRequest(selected.id, comment)
    setSelected(null)
    setTab('mine')
    showToast(`${selected.requestNo} 已重新提交，项目阶段保持锁定直至全部节点通过`)
  }

  return (
    <div>
      <PageHeader
        title="OA 审批中心"
        description="发起、审批、退回与归档形成完整闭环；项目阶段只接受“全部审批通过”的 OA 结果。"
        actions={<><Button variant="secondary" onClick={() => setShowChain(true)}><GitBranch className="h-4 w-4" />标准投资审批链</Button><Button onClick={() => openCreate()}><Plus className="h-4 w-4" />发起 OA</Button></>}
      />

      <div className="mb-5 grid grid-cols-4 gap-4">
        {[
          ['我的待办审批', pendingCount, '当前节点由我处理', 'blue'],
          ['本月通过', requests.filter((item) => item.status === '已通过').length, '完成后自动同步阶段', 'green'],
          ['退回 / 拒绝', requests.filter((item) => ['已退回', '已拒绝'].includes(item.status)).length, '项目阶段保持不变', 'amber'],
          ['受 OA 管控项目', projects.filter((item) => item.stageSource === 'OA审批' || requests.some((request) => request.projectId === item.id)).length, '全程留痕可审计', 'purple'],
        ].map(([label, value, note, tone]) => <Card key={String(label)} className="p-4"><div className="flex items-center justify-between"><p className="text-xs text-slate-500">{label}</p><Badge tone={tone as 'blue'}>{note}</Badge></div><p className="mt-3 text-2xl font-semibold text-slate-900">{value}</p></Card>)}
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-5">
          <Tabs tabs={[{ id: 'project', label: '按项目申请' }, { id: 'pending', label: '待办审批', count: pendingCount }, { id: 'mine', label: '我发起的' }, { id: 'all', label: '全部流程', count: requests.length }, { id: 'board', label: '项目阶段看板' }]} value={tab} onChange={setTab} />
          <SearchInput className="w-[280px]" placeholder={tab === 'project' ? '搜索要申请的项目…' : '搜索单号、项目或流程…'} value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>

        {tab === 'project' ? (
          <div className="grid min-h-[520px] grid-cols-[330px_1fr] border-t border-slate-100">
            <div className="border-r border-slate-100 p-3">
              <p className="px-2 pb-3 pt-1 text-xs text-slate-400">第一步：选择需要发起申请的项目</p>
              <div className="max-h-[610px] space-y-1 overflow-y-auto pr-1 scrollbar-thin">
                {visibleProjects.map((project) => {
                  const pending = requests.find((item) => item.projectId === project.id && item.status === '审批中')
                  return <button key={project.id} onClick={() => { setProjectId(project.id); const next = nextStageFor(project.stage); if (next) setTargetStage(next) }} className={`w-full rounded-xl border p-3 text-left transition ${projectId === project.id ? 'border-brand-300 bg-brand-50 ring-2 ring-brand-100' : 'border-transparent hover:bg-slate-50'}`}><div className="flex items-center justify-between"><p className="truncate text-sm font-semibold text-slate-700">{project.name}</p><StageBadge stage={project.stage} /></div><p className="mt-1 truncate text-xs text-slate-400">{project.companyName}</p><div className="mt-2 flex items-center justify-between text-[10px]"><span className="text-slate-400">负责人 {project.owner}</span>{pending ? <Badge tone="blue">审批中</Badge> : <span className="text-brand-600">可申请 →</span>}</div></button>
                })}
              </div>
            </div>
            <div className="p-6">
              {selectedProject ? <div>
                <div className="flex items-start justify-between"><div><p className="text-xs font-medium text-brand-600">第二步：确认项目与申请类型</p><h2 className="mt-2 text-xl font-semibold text-slate-900">{selectedProject.name}</h2><p className="mt-1 text-sm text-slate-400">{selectedProject.companyName} · {selectedProject.industry} · 负责人 {selectedProject.owner}</p></div>{activeRequest ? <Button variant="secondary" onClick={() => setSelected(activeRequest)}>查看审批中的 OA</Button> : <Button onClick={() => openCreate(selectedProject.id)}><Plus className="h-4 w-4" />发起该项目申请</Button>}</div>
                <div className="mt-6 rounded-xl border border-brand-100 bg-brand-50/60 p-5"><p className="text-xs text-brand-600">系统建议的下一项申请</p><div className="mt-3 flex items-center gap-3"><StageBadge stage={selectedProject.stage} /><ArrowRight className="h-4 w-4 text-slate-300" />{defaultTarget ? <StageBadge stage={defaultTarget} /> : <Badge>无后续阶段</Badge>}<span className="text-sm font-medium text-slate-700">{defaultTarget ? `${selectedProject.stage} → ${defaultTarget} 阶段审批` : '项目流程已完成'}</span></div><p className="mt-3 text-xs leading-5 text-slate-500">系统按项目当前阶段自动匹配审批模板、节点和前置检查；不能跨阶段申请，也不能直接修改项目状态。</p></div>
                <div className="mt-6 grid grid-cols-3 gap-3">{[['当前阶段', selectedProject.stage], ['项目负责人', selectedProject.owner], ['历史 OA', `${projectRequests.length} 条`]].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-4"><p className="text-xs text-slate-400">{label}</p><p className="mt-1 text-sm font-semibold text-slate-700">{value}</p></div>)}</div>
                <div className="mt-6"><h3 className="text-sm font-semibold text-slate-800">该项目的申请记录</h3><div className="mt-3 space-y-2">{projectRequests.map((request) => <button key={request.id} onClick={() => setSelected(request)} className="flex w-full items-center rounded-lg border border-slate-200 p-3 text-left hover:border-brand-200"><div className="flex-1"><p className="text-sm font-medium text-slate-700">{request.title}</p><p className="mt-1 text-xs text-slate-400">{request.requestNo} · {request.applicant} · {request.submittedAt}</p></div><Badge tone={approvalTone(request.status)}>{request.status}</Badge><span className="ml-4 text-xs text-brand-600">查看 →</span></button>)}{!projectRequests.length && <div className="rounded-lg border border-dashed border-slate-200 p-8 text-center text-sm text-slate-400">该项目尚未发起 OA 申请</div>}</div></div>
              </div> : <div className="grid h-full place-items-center text-sm text-slate-400">请先从左侧选择项目</div>}
            </div>
          </div>
        ) : tab !== 'board' ? (
          <div className="divide-y divide-slate-100">
            {visibleRequests.map((request) => {
              const currentNode = request.nodes.find((node) => node.id === request.currentNodeId)
              return (
                <button key={request.id} onClick={() => setSelected(request)} className="grid w-full grid-cols-[1.5fr_.8fr_.8fr_1fr_120px] items-center gap-4 px-5 py-4 text-left hover:bg-slate-50">
                  <div><div className="flex items-center gap-2"><span className="font-medium text-slate-800">{request.title}</span><Badge tone={approvalTone(request.status)}>{request.status}</Badge>{request.priority === '紧急' && <Badge tone="red">紧急</Badge>}</div><p className="mt-1 text-xs text-slate-400">{request.requestNo} · {request.applicant} · {request.submittedAt}</p></div>
                  <div><p className="text-xs text-slate-400">阶段变更</p><div className="mt-1 flex items-center gap-1"><StageBadge stage={request.fromStage} /><ArrowRight className="h-3 w-3 text-slate-300" /><StageBadge stage={request.targetStage} /></div></div>
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
              {workflowStages.map((stage, index) => <div key={stage} className="min-h-[330px] rounded-xl border border-slate-200 bg-slate-50/70"><div className="flex items-center justify-between border-b border-slate-200 px-3 py-3"><div className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-md bg-brand-100 text-[10px] font-semibold text-brand-700">{index + 1}</span><span className="text-sm font-semibold text-slate-700">{stage}</span></div><Badge>{projects.filter((item) => item.stage === stage).length}</Badge></div><div className="space-y-2 p-2.5">{projects.filter((item) => item.stage === stage).map((project) => { const pending = requests.find((item) => item.projectId === project.id && item.status === '审批中'); return <button key={project.id} onClick={() => pending ? setSelected(pending) : openCreate(project.id)} className="w-full rounded-lg border border-slate-200 bg-white p-3 text-left hover:border-brand-300"><p className="truncate text-xs font-semibold text-slate-700">{project.name}</p><p className="mt-1.5 text-[10px] text-slate-400">{project.owner} · {project.industry}</p><div className="mt-3">{pending ? <Badge tone="blue">{pending.currentNodeName}</Badge> : <Badge tone="slate">可发起下一阶段 OA</Badge>}</div></button>})}</div></div>)}
            </div>
          </div>
        )}
      </Card>

      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected?.title ?? '审批详情'} width="w-[760px]" footer={selected?.status === '审批中' ? <>{canWithdrawSelected && <Button variant="secondary" onClick={() => act('withdraw')}>撤回</Button>}{canApproveSelected ? <><Button variant="danger" onClick={() => act('reject')}><XCircle className="h-4 w-4" />拒绝</Button><Button variant="secondary" onClick={() => act('return')}><RotateCcw className="h-4 w-4" />退回补充</Button><Button onClick={() => act('approve')}><CheckCircle2 className="h-4 w-4" />同意并流转</Button></> : <span className="text-xs text-slate-500">当前节点由 {selectedCurrentNode?.approver ?? '指定审批人'} 处理；你只能查看流程。</span>}</> : canResubmitSelected ? <Button onClick={resubmit}><Send className="h-4 w-4" />补充后重新提交</Button> : undefined}>
        {selected && <div className="space-y-6">
          <div className="rounded-xl border border-brand-100 bg-brand-50/60 p-4"><div className="flex items-center justify-between"><div><p className="text-xs text-brand-600">{selected.requestNo}</p><p className="mt-1 font-semibold text-slate-800">{selected.projectName}</p></div><Badge tone={approvalTone(selected.status)}>{selected.status}</Badge></div><div className="mt-4 flex items-center gap-2"><StageBadge stage={selected.fromStage} /><ArrowRight className="h-4 w-4 text-slate-300" /><StageBadge stage={selected.targetStage} /><span className="ml-2 text-xs text-slate-500">仅最终通过后同步项目阶段</span></div></div>
          <div className="grid grid-cols-2 gap-3 text-sm"><div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-400">申请人 / 部门</p><p className="mt-1 text-slate-700">{selected.applicant} · {selected.department}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-400">融资计划 / 估值</p><p className="mt-1 text-slate-700">{selected.amount || '未披露'} / {selected.valuation || '待核验'}</p></div></div>
          <section><h3 className="text-sm font-semibold text-slate-800">申请事由</h3><p className="mt-2 rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-600">{selected.reason}</p></section>
          <section><h3 className="text-sm font-semibold text-slate-800">前置检查</h3><div className="mt-3 grid grid-cols-2 gap-2">{selected.checklist.map((item) => <div key={item.label} className="flex items-center gap-2 rounded-lg border border-slate-100 px-3 py-2 text-xs text-slate-600">{item.passed ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Circle className="h-4 w-4 text-amber-500" />}{item.label}{item.required && <span className="ml-auto text-rose-400">必需</span>}</div>)}</div></section>
          <section><h3 className="text-sm font-semibold text-slate-800">审批链</h3><div className="mt-4 space-y-0">{selected.nodes.map((node, index) => <div key={node.id} className="relative flex gap-3 pb-5 last:pb-0"><div className="flex flex-col items-center"><span className={`grid h-8 w-8 place-items-center rounded-full ${node.status === '已通过' ? 'bg-emerald-500 text-white' : node.status === '待审批' || node.status === '会签中' ? 'bg-brand-600 text-white ring-4 ring-brand-50' : node.status === '已退回' || node.status === '已拒绝' ? 'bg-rose-500 text-white' : 'bg-slate-100 text-slate-400'}`}>{node.status === '已通过' ? <CheckCircle2 className="h-4 w-4" /> : node.status === '待审批' || node.status === '会签中' ? <Clock3 className="h-4 w-4" /> : index + 1}</span>{index < selected.nodes.length - 1 && <span className="h-full w-px bg-slate-200" />}</div><div className="flex-1 rounded-lg border border-slate-100 p-3"><div className="flex items-center justify-between"><p className="text-sm font-medium text-slate-700">{node.name}</p><Badge tone={node.status === '已通过' ? 'green' : node.status === '待审批' || node.status === '会签中' ? 'blue' : node.status === '已退回' || node.status === '已拒绝' ? 'red' : 'slate'}>{node.status}</Badge></div><p className="mt-1 text-xs text-slate-400">{node.approver} · {node.approverRole} · {node.mode}</p>{node.mode === '会签' && <p className="mt-2 text-[11px] text-brand-600">会签进度：{node.approvedBy?.length ?? 0}/{splitApprovers(node.approver).length}{node.approvedBy?.length ? ` · 已同意：${node.approvedBy.join('、')}` : ''}</p>}{node.comment && <p className="mt-2 text-xs leading-5 text-slate-600">“{node.comment}”</p>}</div></div>)}</div></section>
          <section><h3 className="text-sm font-semibold text-slate-800">附件与审批意见</h3><div className="mt-3 flex flex-wrap gap-2">{selected.attachments.map((item) => <Badge key={item} tone="slate"><FileCheck2 className="mr-1 h-3 w-3" />{item}</Badge>)}</div>{(selected.status === '审批中' || canResubmitSelected) && <textarea className="textarea mt-4 min-h-24" value={comment} onChange={(event) => setComment(event.target.value)} placeholder={canResubmitSelected ? '说明已补充的材料和修订内容…' : '填写审批意见；退回和拒绝时为必填…'} />}</section>
          <section><h3 className="text-sm font-semibold text-slate-800">操作记录</h3><div className="mt-3 space-y-2">{selected.records.map((record) => <div key={record.id} className="flex gap-3 rounded-lg bg-slate-50 p-3 text-xs"><ShieldCheck className="mt-0.5 h-4 w-4 text-brand-500" /><div><p className="font-medium text-slate-700">{record.operator} · {record.action} · {record.nodeName}</p><p className="mt-1 leading-5 text-slate-500">{record.comment}</p><p className="mt-1 text-slate-400">{record.createdAt}</p></div></div>)}</div></section>
        </div>}
      </Drawer>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="发起项目 OA 审批" width="max-w-3xl" footer={<><Button variant="secondary" onClick={() => setShowCreate(false)}>取消</Button><Button onClick={submit}><Send className="h-4 w-4" />提交审批</Button></>}>
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4"><label><span className="label">项目</span><select className="input" value={projectId} onChange={(event) => { const nextId = event.target.value; const project = projects.find((item) => item.id === nextId); setProjectId(nextId); if (project && nextStageFor(project.stage)) setTargetStage(nextStageFor(project.stage)!); setReason('') }}>{manageableProjects.filter((item) => !['退出', '放弃'].includes(item.stage)).map((item) => <option key={item.id} value={item.id}>{item.name}（当前：{item.stage}）</option>)}</select></label><label><span className="label">优先级</span><select className="input" value={priority} onChange={(event) => setPriority(event.target.value as '普通' | '紧急')}><option>普通</option><option>紧急</option></select></label></div>
          {activeRequest && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">该项目已有审批中的 OA：{activeRequest.requestNo}，不能重复发起。</div>}
          <div className="rounded-xl border border-brand-100 bg-brand-50/50 p-4"><p className="text-xs font-medium text-brand-700">申请的阶段变更</p><div className="mt-3 flex items-center gap-3"><StageBadge stage={selectedProject?.stage ?? '线索'} /><ArrowRight className="h-4 w-4 text-slate-300" /><select className="input w-32" value={targetStage} onChange={(event) => setTargetStage(event.target.value as ProjectStage)}>{defaultTarget && <option>{defaultTarget}</option>}<option>放弃</option></select><span className="text-xs text-slate-500">提交不会立即改状态；所有审批节点通过后自动同步。</span></div></div>
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
