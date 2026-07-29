import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useAuthStore } from './useAuthStore'
import { apiGet, apiPost, apiPatch, apiDelete, ApiError } from '../lib/api'
import {
  aiSummaries,
  approvalRequests,
  auditLogs,
  files,
  leads,
  materialJobs,
  meetings,
  notifications,
  postUpdates,
  projects,
  risks,
  templates,
  todos,
  users,
  workflowLogs,
} from '../mock/data'
import type {
  AISummary,
  ApprovalRequest,
  ApprovalType,
  AuditLog,
  Lead,
  MaterialJob,
  Meeting,
  Notification,
  PostUpdate,
  Project,
  ProjectFile,
  ProjectStage,
  RiskAlert,
  Template,
  Todo,
  User,
  WorkflowLog,
} from '../types'

const now = () => new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
import { uid as _uid } from '../lib/uid'
const id = (prefix: string) => `${prefix}-${_uid().slice(0, 8)}`
const stageOrder: ProjectStage[] = ['线索', '初筛', '立项', '尽调', '上会', '投决', '投后', '退出']
const splitApprovers = (value: string) => value.split('/').map((item) => item.trim()).filter(Boolean)
let latestLeadListRequest = 0

const approvalTypeFor = (fromStage: ProjectStage, targetStage: ProjectStage): ApprovalType => {
  if (targetStage === '放弃') return '项目终止审批'
  if (fromStage === '线索' && targetStage === '初筛') return '初筛审批'
  if (fromStage === '初筛' && targetStage === '立项') return '立项审批'
  if (fromStage === '立项' && targetStage === '尽调') return '尽调启动审批'
  if (fromStage === '尽调' && targetStage === '上会') return '上会申请'
  if (fromStage === '上会' && targetStage === '投决') return '投决审批'
  if (fromStage === '投决' && targetStage === '投后') return '投后移交审批'
  return '项目终止审批'
}

const approvalBlueprint = (type: ApprovalType) => {
  const blueprints: Record<ApprovalType, { nodes: [string, string, string, '或签' | '会签'][]; checklist: [string, boolean][] }> = {
    初筛审批: {
      nodes: [['投资总监初筛', '陈思齐', '投资总监', '或签'], ['平台登记复核', '唐婉', '平台运营', '或签']],
      checklist: [['公司主体与来源可追溯', true], ['项目简介与推荐理由完整', true], ['重复项目已排查', true]],
    },
    立项审批: {
      nodes: [['投资总监审批', '陈思齐', '投资总监', '或签'], ['风控合规会签', '赵旻 / 孙璐', '风控与法务', '会签'], ['平台主管备案', '唐婉', '平台运营', '或签']],
      checklist: [['初筛结论已形成', true], ['核心团队与商业模式已访谈', true], ['重大合规风险已初查', true], ['融资方案已核验', false]],
    },
    尽调启动审批: {
      nodes: [['投资总监审批', '陈思齐', '投资总监', '或签'], ['财务与法务排期', '财务组 / 孙璐', '财务与法务', '会签']],
      checklist: [['立项审批已通过', true], ['尽调清单与分工已确认', true], ['数据室权限已开通', true]],
    },
    上会申请: {
      nodes: [['投资总监预审', '陈思齐', '投资总监', '或签'], ['财务法务风控会签', '财务组 / 孙璐 / 赵旻', '专业职能', '会签'], ['投委会秘书排会', '唐婉', '投委会秘书', '或签']],
      checklist: [['投资建议书已定稿', true], ['财务尽调结论已上传', true], ['法务尽调结论已上传', true], ['核心风险与对策已闭环', true], ['估值与投资条款已确认', true]],
    },
    投决审批: {
      nodes: [['投委会表决', '投委会委员', '投委会', '会签'], ['董事长终审', '董事长', '决策人', '或签']],
      checklist: [['投委会会议纪要已归档', true], ['表决票达到通过门槛', true], ['附带条件已明确责任人', true]],
    },
    投后移交审批: {
      nodes: [['投资负责人确认', '陈思齐', '投资总监', '或签'], ['投后负责人接收', '投后管理组', '投后负责人', '或签'], ['财务归档', '财务组', '财务', '或签']],
      checklist: [['协议与交割文件已归档', true], ['投后指标基线已建立', true], ['董事席位与信息权已登记', true]],
    },
    项目终止审批: {
      nodes: [['投资总监审批', '陈思齐', '投资总监', '或签'], ['平台归档', '唐婉', '平台运营', '或签']],
      checklist: [['终止原因已说明', true], ['外部沟通已完成', true], ['资料与复盘已归档', true]],
    },
  }
  return blueprints[type]
}

interface AppState {
  isAuthenticated: boolean
  currentUser: User
  projects: Project[]
  files: ProjectFile[]
  aiSummaries: AISummary[]
  todos: Todo[]
  meetings: Meeting[]
  risks: RiskAlert[]
  workflowLogs: WorkflowLog[]
  approvalRequests: ApprovalRequest[]
  materialJobs: MaterialJob[]
  leads: Lead[]
  leadPagination: { total: number; page: number; pageSize: number; totalPages: number }
  leadStats: { total: number; verified: number; highPriority: number; avgCompleteness: number }
  scoringLeadIds: string[]
  postUpdates: PostUpdate[]
  users: User[]
  templates: Template[]
  auditLogs: AuditLog[]
  notifications: Notification[]
  login: (email: string) => void
  logout: () => void
  addProject: (project: Omit<Project, 'id' | 'updatedAt' | 'createdAt' | 'score' | 'progress'>) => Promise<Project>
  updateProject: (projectId: string, patch: Partial<Project>) => void
  deleteProject: (projectId: string) => Promise<void>
  pinProject: (projectId: string, pinned: boolean) => Promise<void>
  moveProjectStage: (projectId: string, nextStage: ProjectStage, comment: string) => void
  createApprovalRequest: (input: {
    projectId: string
    targetStage: ProjectStage
    reason: string
    priority?: '普通' | '紧急'
    amount?: string
    valuation?: string
    attachments?: string[]
  }) => ApprovalRequest | undefined
  approveRequest: (requestId: string, comment: string) => void
  returnRequest: (requestId: string, comment: string) => void
  resubmitApprovalRequest: (requestId: string, comment: string) => void
  rejectRequest: (requestId: string, comment: string) => void
  withdrawRequest: (requestId: string, comment: string) => void
  addFile: (file: Omit<ProjectFile, 'id' | 'uploadedAt' | 'version'>) => void
  deleteFile: (fileId: string) => Promise<void>
  finishFileParsing: (fileId: string) => void
  addLead: (lead: Omit<Lead, 'id'>) => Promise<Lead>
  fetchLeads: (page?: number, pageSize?: number, channel?: string, sort?: string, keyword?: string, source?: string, industry?: string, region?: string) => Promise<void>
  fetchLeadStats: () => Promise<void>
  startScoring: (leadId: string) => Promise<void>
  fetchLeadDetail: (leadId: string) => Promise<Lead | null>
  updateLead: (leadId: string, patch: Partial<Lead>) => void
  mergeLeadLocal: (leadId: string, patch: Partial<Lead>) => void
  convertLead: (leadId: string) => Promise<Project | undefined>
  saveSummary: (summary: AISummary) => void
  addTodo: (todo: Omit<Todo, 'id'>) => void
  updateTodo: (todoId: string, patch: Partial<Todo>) => void
  deleteTodo: (todoId: string) => void
  addMeeting: (meeting: Omit<Meeting, 'id'>, newTodos?: Omit<Todo, 'id'>[]) => Promise<Meeting>
  updateMeeting: (meetingId: string, patch: Partial<Meeting>) => void
  addRisk: (risk: Omit<RiskAlert, 'id'>) => Promise<RiskAlert>
  updateRisk: (riskId: string, patch: Partial<RiskAlert>) => void
  addMaterialJob: (job: Omit<MaterialJob, 'id'>) => MaterialJob
  updateMaterialJob: (jobId: string, patch: Partial<MaterialJob>) => void
  addPostUpdate: (update: Omit<PostUpdate, 'id' | 'updatedAt'>) => void
  addAudit: (module: string, action: string, target: string) => void
  toggleUserStatus: (userId: string) => void
  addUser: (user: Omit<User, 'id' | 'lastLogin'>) => void
  markNotificationsRead: () => void
  resetDemo: () => void
  hydrateFromServer: () => Promise<void>
}

const defaultUser = users[0]

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      isAuthenticated: false,
      currentUser: defaultUser as User,
      projects,
      files,
      aiSummaries,
      todos,
      meetings,
      risks,
      workflowLogs,
      approvalRequests,
      materialJobs,
      leads,
      leadPagination: {
        total: leads.length,
        page: 1,
        pageSize: Math.max(leads.length, 1),
        totalPages: 1,
      },
      leadStats: {
        total: leads.length,
        verified: leads.filter((lead) => lead.verificationStatus === '已核验').length,
        highPriority: leads.filter((lead) => lead.score >= 80).length,
        avgCompleteness: leads.length
          ? Math.round(leads.reduce((sum, lead) => sum + lead.completeness, 0) / leads.length)
          : 0,
      },
      scoringLeadIds: [],
      postUpdates,
      users,
      templates,
      auditLogs,
      notifications,
      // 兼容逻辑：老的 login 动作依然调用，但当真成功后询问 authStore
      login: (email: string) => {
        const user = users.find((item) => item.email === email) ?? (email.includes('admin') ? users[4] : users[0])
        set({ isAuthenticated: true, currentUser: user as User })
        get().addAudit('账号安全', '登录成功', `${user.email} 登录系统`)
      },
      logout: () => {
        try { useAuthStore.getState().logout() } catch {}
        get().addAudit('账号安全', '退出登录', `${get().currentUser.email} 退出系统`)
        set({ isAuthenticated: false })
      },
      // 从后端拉取所有实体数据，调用一次
      hydrateFromServer: async () => {
        if (!useAuthStore.getState().isAuthenticated) return
        // 注意: 故意不发 /leads 请求 — leads 走分页(由 SourcingPage 单独 fetchLeads 拉)
        // 之前 hydrate 拉全量 leads 阻塞首次页面渲染 7s+,改成按需拉
        const results = await Promise.allSettled([
          apiGet<{ list: Project[] }>('/projects'),
          apiGet<{ list: Meeting[] }>('/meetings'),
          apiGet<{ list: Todo[] }>('/todos'),
          apiGet<{ list: RiskAlert[] }>('/risks'),
          apiGet<{ list: User[] }>('/users'),
          apiGet<{ list: AISummary[] }>('/ai-summaries'),
          apiGet<{ list: ProjectFile[] }>('/projects/files/all'),
        ])
        const next: Partial<AppState> = {}
        if (results[0].status === 'fulfilled') next.projects = results[0].value.list
        if (results[1].status === 'fulfilled') next.meetings = results[1].value.list
        if (results[2].status === 'fulfilled') next.todos = results[2].value.list
        if (results[3].status === 'fulfilled') next.risks = results[3].value.list
        if (results[4].status === 'fulfilled') next.users = results[4].value.list
        if (results[5].status === 'fulfilled') next.aiSummaries = results[5].value.list
        if (results[6]?.status === 'fulfilled') next.files = (results[6].value as { list: ProjectFile[] }).list
        set(next as AppState)
      },
      addProject: async (project) => {
        try {
          const created = await apiPost<Project>('/projects', project)
          set((state) => ({ projects: [created, ...state.projects] }))
          get().addAudit('项目管理', '创建项目', created.name)
          return created
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '创建项目失败'
          get().addAudit('项目管理', '创建项目失败', `${project.name ?? ''}: ${msg}`)
          throw e
        }
      },
      updateProject: async (projectId, patch) => {
        try {
          const updated = await apiPatch<Project>(`/projects/${projectId}`, patch)
          set((state) => ({
            projects: state.projects.map((project) => project.id === projectId ? updated : project),
          }))
          get().addAudit('项目管理', '编辑项目', updated.name)
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '更新项目失败'
          get().addAudit('项目管理', '编辑项目失败', `${projectId}: ${msg}`)
          throw e
        }
      },
      deleteProject: async (projectId) => {
        const proj = get().projects.find((p) => p.id === projectId)
        try {
          await apiDelete(`/projects/${projectId}`)
          set((state) => ({ projects: state.projects.filter((p) => p.id !== projectId) }))
          get().addAudit('项目管理', '删除项目(连带知识库)', proj?.name ?? projectId)
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '删除项目失败'
          get().addAudit('项目管理', '删除项目失败', `${projectId}: ${msg}`)
          throw e
        }
      },
      pinProject: async (projectId, pinned) => {
        try {
          await apiPost(`/projects/${projectId}/pin`, { pinned })
          set((state) => ({ projects: state.projects.map((p) => p.id === projectId ? { ...p, pinned } as Project : p) }))
          get().addAudit('项目管理', pinned ? '置顶项目' : '取消置顶', projectId)
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '置顶失败'
          get().addAudit('项目管理', '置顶操作失败', `${projectId}: ${msg}`)
          throw e
        }
      },
      moveProjectStage: (projectId, nextStage, comment) => {
        get().createApprovalRequest({ projectId, targetStage: nextStage, reason: comment })
      },
      createApprovalRequest: (input) => {
        const project = get().projects.find((item) => item.id === input.projectId)
        const expectedNextStage = stageOrder[stageOrder.indexOf(project?.stage ?? '放弃') + 1]
        if (!project || project.stage === input.targetStage || ['退出', '放弃'].includes(project.stage)) return undefined
        if (input.targetStage !== '放弃' && input.targetStage !== expectedNextStage) return undefined
        const active = get().approvalRequests.find((item) => item.projectId === input.projectId && item.status === '审批中')
        if (active) return active
        const type = approvalTypeFor(project.stage, input.targetStage)
        const blueprint = approvalBlueprint(type)
        const requestId = id('oa')
        const requestNo = `OA${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(get().approvalRequests.length + 1).padStart(4, '0')}`
        const submitNodeId = `${requestId}-n1`
        const nodes = [
          {
            id: submitNodeId,
            name: '发起人提交',
            approver: get().currentUser.name,
            approverRole: get().currentUser.role,
            mode: '或签' as const,
            sequence: 1,
            status: '已通过' as const,
            completedAt: now(),
            comment: input.reason,
          },
          ...blueprint.nodes.map(([name, approver, role, mode], index) => ({
            id: `${requestId}-n${index + 2}`,
            name,
            approver,
            approverRole: role,
            mode,
            sequence: index + 2,
            status: index === 0 ? '待审批' as const : '未开始' as const,
          })),
        ]
        const created: ApprovalRequest = {
          id: requestId,
          requestNo,
          projectId: project.id,
          projectName: project.name,
          title: `${project.name} ${type}`,
          type,
          fromStage: project.stage,
          targetStage: input.targetStage,
          status: '审批中',
          applicant: get().currentUser.name,
          department: get().currentUser.department,
          priority: input.priority ?? '普通',
          currentNodeId: nodes[1]?.id,
          currentNodeName: nodes[1]?.name ?? '流程完成',
          reason: input.reason,
          amount: input.amount ?? project.financing,
          valuation: input.valuation ?? project.valuation,
          submittedAt: now(),
          attachments: input.attachments ?? get().files.filter((file) => file.projectId === project.id).map((file) => file.name),
          checklist: blueprint.checklist.map(([label, required]) => ({ label, required, passed: required })),
          nodes,
          records: [{
            id: id('oar'),
            nodeId: submitNodeId,
            nodeName: '发起人提交',
            operator: get().currentUser.name,
            action: '提交',
            comment: input.reason,
            createdAt: now(),
          }],
        }
        set((state) => ({
          approvalRequests: [created, ...state.approvalRequests],
          projects: state.projects.map((item) => item.id === project.id ? { ...item, latestApprovalId: created.id, updatedAt: now() } : item),
          todos: [{
            id: id('t'),
            title: `审批：${created.title}`,
            projectId: project.id,
            projectName: project.name,
            owner: nodes[1]?.approver ?? '平台主管',
            dueDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
            priority: created.priority === '紧急' ? '高' : '中',
            status: '未开始',
            type: '流程',
          }, ...state.todos],
        }))
        get().addAudit('OA 流程', '发起审批', `${created.requestNo} · ${created.title}`)
        return created
      },
      approveRequest: (requestId, comment) => {
        const request = get().approvalRequests.find((item) => item.id === requestId)
        if (!request || request.status !== '审批中' || !request.currentNodeId) return
        const currentIndex = request.nodes.findIndex((node) => node.id === request.currentNodeId)
        if (currentIndex < 0) return
        const currentNode = request.nodes[currentIndex]
        const approvers = splitApprovers(currentNode.approver)
        const currentUser = get().currentUser
        if (!approvers.includes(currentUser.name) && currentUser.role !== '系统管理员') return
        if (currentNode.mode === '会签' && currentNode.approvedBy?.includes(currentUser.name) && currentUser.role !== '系统管理员') return
        const approvedBy = Array.from(new Set([
          ...(currentNode.approvedBy ?? []),
          ...(currentUser.role === '系统管理员' && !approvers.includes(currentUser.name) ? approvers : [currentUser.name]),
        ]))
        const currentNodeCompleted = currentNode.mode === '或签' || approvedBy.length >= approvers.length
        const nextNode = currentNodeCompleted ? request.nodes[currentIndex + 1] : undefined
        const completed = currentNodeCompleted && !nextNode
        const completedAt = now()
        const updatedRequest: ApprovalRequest = {
          ...request,
          status: completed ? '已通过' : '审批中',
          currentNodeId: currentNodeCompleted ? nextNode?.id : currentNode.id,
          currentNodeName: completed ? '流程完成' : currentNodeCompleted ? nextNode!.name : `${currentNode.name}（${approvedBy.length}/${approvers.length}）`,
          completedAt: completed ? completedAt : undefined,
          nodes: request.nodes.map((node, index) => {
            if (index === currentIndex) return {
              ...node,
              approvedBy,
              status: currentNodeCompleted ? '已通过' : '会签中',
              completedAt: currentNodeCompleted ? completedAt : undefined,
              comment: currentNodeCompleted ? comment : node.comment,
            }
            if (index === currentIndex + 1) return { ...node, status: '待审批' }
            return node
          }),
          records: [...request.records, {
            id: id('oar'),
            nodeId: request.currentNodeId,
            nodeName: request.currentNodeName,
            operator: get().currentUser.name,
            action: '同意',
            comment,
            createdAt: completedAt,
          }],
        }
        const project = get().projects.find((item) => item.id === request.projectId)
        const log: WorkflowLog | undefined = completed && project ? {
          id: id('w'),
          projectId: project.id,
          fromStage: request.fromStage,
          toStage: request.targetStage,
          operator: get().currentUser.name,
          comment: `${request.requestNo} 全部审批节点通过：${comment}`,
          createdAt: completedAt,
          requestId: request.id,
          requestNo: request.requestNo,
          source: 'OA审批',
        } : undefined
        set((state) => ({
          approvalRequests: state.approvalRequests.map((item) => item.id === requestId ? updatedRequest : item),
          projects: state.projects.map((item) => completed && item.id === request.projectId ? {
            ...item,
            stage: request.targetStage,
            stageSource: 'OA审批',
            latestApprovalId: request.id,
            progress: request.targetStage === '放弃' ? item.progress : Math.max(item.progress, Math.min(100, (stageOrder.indexOf(request.targetStage) + 1) * 13)),
            updatedAt: completedAt,
          } : item),
          workflowLogs: log ? [log, ...state.workflowLogs] : state.workflowLogs,
          todos: state.todos.map((todo) => todo.projectId === request.projectId && todo.title.includes(request.title)
            ? {
              ...todo,
              status: completed ? '已完成' : '进行中',
              owner: currentNodeCompleted
                ? nextNode?.approver ?? todo.owner
                : approvers.filter((name) => !approvedBy.includes(name)).join(' / '),
            }
            : todo),
        }))
        get().addAudit('OA 流程', completed ? '审批通过并同步项目阶段' : currentNodeCompleted ? '审批节点通过' : '会签意见提交', `${request.requestNo} · ${request.currentNodeName}`)
      },
      returnRequest: (requestId, comment) => {
        const request = get().approvalRequests.find((item) => item.id === requestId)
        if (!request || request.status !== '审批中' || !request.currentNodeId) return
        const currentNode = request.nodes.find((node) => node.id === request.currentNodeId)
        if (!currentNode || (!currentNode.approver.includes(get().currentUser.name) && get().currentUser.role !== '系统管理员')) return
        const stamp = now()
        set((state) => ({
          approvalRequests: state.approvalRequests.map((item) => item.id === requestId ? {
            ...item,
            status: '已退回',
            completedAt: stamp,
            currentNodeId: undefined,
            currentNodeName: '已退回发起人',
            nodes: item.nodes.map((node) => node.id === request.currentNodeId ? { ...node, status: '已退回', completedAt: stamp, comment } : node),
            records: [...item.records, { id: id('oar'), nodeId: request.currentNodeId!, nodeName: request.currentNodeName, operator: get().currentUser.name, action: '退回', comment, createdAt: stamp }],
          } : item),
          todos: state.todos.map((todo) => todo.projectId === request.projectId && todo.title.includes(request.title) ? { ...todo, status: '已完成' } : todo),
        }))
        get().addAudit('OA 流程', '退回申请', `${request.requestNo} · ${comment}`)
      },
      resubmitApprovalRequest: (requestId, comment) => {
        const request = get().approvalRequests.find((item) => item.id === requestId)
        const currentUser = get().currentUser
        if (!request || request.status !== '已退回') return
        if (request.applicant !== currentUser.name && currentUser.role !== '系统管理员') return
        const stamp = now()
        const firstApprovalNode = request.nodes[1]
        if (!firstApprovalNode) return
        set((state) => ({
          approvalRequests: state.approvalRequests.map((item) => item.id === requestId ? {
            ...item,
            status: '审批中',
            currentNodeId: firstApprovalNode.id,
            currentNodeName: firstApprovalNode.name,
            completedAt: undefined,
            reason: comment,
            submittedAt: stamp,
            nodes: item.nodes.map((node, index) => index === 0
              ? { ...node, status: '已通过', completedAt: stamp, comment }
              : { ...node, status: index === 1 ? '待审批' : '未开始', approvedBy: [], completedAt: undefined, comment: undefined }),
            records: [...item.records, {
              id: id('oar'),
              nodeId: item.nodes[0].id,
              nodeName: '退回后重新提交',
              operator: currentUser.name,
              action: '提交',
              comment,
              createdAt: stamp,
            }],
          } : item),
          projects: state.projects.map((item) => item.id === request.projectId ? { ...item, latestApprovalId: request.id, updatedAt: stamp } : item),
          todos: [{
            id: id('t'),
            title: `审批：${request.title}`,
            projectId: request.projectId,
            projectName: request.projectName,
            owner: firstApprovalNode.approver,
            dueDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
            priority: request.priority === '紧急' ? '高' : '中',
            status: '未开始',
            type: '流程',
          }, ...state.todos],
        }))
        get().addAudit('OA 流程', '退回后重新提交', `${request.requestNo} · ${comment}`)
      },
      rejectRequest: (requestId, comment) => {
        const request = get().approvalRequests.find((item) => item.id === requestId)
        if (!request || request.status !== '审批中' || !request.currentNodeId) return
        const currentNode = request.nodes.find((node) => node.id === request.currentNodeId)
        if (!currentNode || (!currentNode.approver.includes(get().currentUser.name) && get().currentUser.role !== '系统管理员')) return
        const stamp = now()
        set((state) => ({
          approvalRequests: state.approvalRequests.map((item) => item.id === requestId ? {
            ...item,
            status: '已拒绝',
            completedAt: stamp,
            currentNodeId: undefined,
            currentNodeName: '流程已拒绝',
            nodes: item.nodes.map((node) => node.id === request.currentNodeId ? { ...node, status: '已拒绝', completedAt: stamp, comment } : node),
            records: [...item.records, { id: id('oar'), nodeId: request.currentNodeId!, nodeName: request.currentNodeName, operator: get().currentUser.name, action: '拒绝', comment, createdAt: stamp }],
          } : item),
          todos: state.todos.map((todo) => todo.projectId === request.projectId && todo.title.includes(request.title) ? { ...todo, status: '已完成' } : todo),
        }))
        get().addAudit('OA 流程', '拒绝申请', `${request.requestNo} · ${comment}`)
      },
      withdrawRequest: (requestId, comment) => {
        const request = get().approvalRequests.find((item) => item.id === requestId)
        if (!request || request.status !== '审批中') return
        if (request.applicant !== get().currentUser.name && get().currentUser.role !== '系统管理员') return
        const stamp = now()
        set((state) => ({
          approvalRequests: state.approvalRequests.map((item) => item.id === requestId ? {
            ...item,
            status: '已撤回',
            completedAt: stamp,
            currentNodeId: undefined,
            currentNodeName: '发起人已撤回',
            records: [...item.records, { id: id('oar'), nodeId: item.nodes[0].id, nodeName: '发起人撤回', operator: get().currentUser.name, action: '撤回', comment, createdAt: stamp }],
          } : item),
          todos: state.todos.map((todo) => todo.projectId === request.projectId && todo.title.includes(request.title) ? { ...todo, status: '已完成' } : todo),
        }))
        get().addAudit('OA 流程', '撤回申请', `${request.requestNo} · ${comment}`)
      },
      addFile: async (file) => {
        try {
          const created = await apiPost<ProjectFile>(`/projects/files`, file)
          set((state) => ({ files: [created, ...state.files] }))
          get().addAudit('资料库', '上传文件', created.name)
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '上传文件失败'
          get().addAudit('资料库', '上传文件失败', `${file.name ?? ''}: ${msg}`)
          throw e
        }
      },
      finishFileParsing: async (fileId) => {
        try {
          const updated = await apiPost<ProjectFile>(`/files/${fileId}/finish-parse`)
          set((state) => ({ files: state.files.map((file) => file.id === fileId ? updated : file) }))
        } catch (e) {
          // 静默失败不影响 UI
        }
      },
      deleteFile: async (fileId) => {
        const f = get().files.find((x) => x.id === fileId)
        try {
          await apiDelete(`/projects/files/${fileId}`)
          set((state) => ({ files: state.files.filter((x) => x.id !== fileId) }))
          get().addAudit('资料库', '删除文件(连带RAG)', f?.name ?? fileId)
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '删除失败'
          get().addAudit('资料库', '删除文件失败', `${fileId}: ${msg}`)
          throw e
        }
      },
      fetchLeads: async (page = 1, pageSize = 50, channel = '', sort = '', keyword = '', source = '', industry = '', region = '') => {
        const requestId = ++latestLeadListRequest
        try {
          const qs = `/leads?page=${page}&pageSize=${pageSize}`
            + (channel ? `&channel=${encodeURIComponent(channel)}` : '')
            + (sort ? `&sort=${encodeURIComponent(sort)}` : '')
            + (keyword ? `&keyword=${encodeURIComponent(keyword)}` : '')
            + (source ? `&source=${encodeURIComponent(source)}` : '')
            + (industry ? `&industry=${encodeURIComponent(industry)}` : '')
            + (region ? `&region=${encodeURIComponent(region)}` : '')
          const r = await apiGet<{ list: Lead[]; total: number; page: number; pageSize: number; totalPages: number }>(qs)
          // 用户快速切换筛选条件时，只允许最后一次请求更新列表，避免旧结果后到并覆盖新结果。
          if (requestId !== latestLeadListRequest) return
          set({ leads: r.list, leadPagination: { total: r.total, page: r.page, pageSize: r.pageSize, totalPages: r.totalPages } })
        } catch (e) {
          if (requestId !== latestLeadListRequest) return
          get().addAudit('项目获取池', '分页拉取失败', (e as Error).message)
          throw e
        }
      },
      // 全局统计(顶部卡片用,聚合全库不受分页影响)
      fetchLeadStats: async () => {
        try {
          const r = await apiGet<{ total: number; verified: number; highPriority: number; avgCompleteness: number }>('/leads/stats')
          set({ leadStats: r })
        } catch (e) { get().addAudit('项目获取池', '统计拉取失败', (e as Error).message) }
      },
      // 触发 AI 评分并全局轮询到完成 —— 状态存 store 的 scoringLeadIds,
      // 不依赖组件生命周期,切换项目/页面再回来评分不中断,完成后自动把结果 merge 进列表。
      startScoring: async (leadId: string) => {
        if (get().scoringLeadIds.includes(leadId)) return  // 已在评分中,避免重复触发
        set((state) => ({ scoringLeadIds: [...state.scoringLeadIds, leadId] }))
        const finish = () => set((state) => ({ scoringLeadIds: state.scoringLeadIds.filter((x) => x !== leadId) }))
        try {
          await apiPost(`/leads/${leadId}/score`, {})
          const deadline = Date.now() + 20 * 60 * 1000
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 6000))
            const st = await apiGet<{
              status: 'queued' | 'running' | 'retrying' | 'done' | 'failed' | 'idle'
              error?: string
              attempts?: number
              maxAttempts?: number
              retryCycles?: number
            }>(`/leads/${leadId}/score`)
            if (st.status === 'queued' || st.status === 'running' || st.status === 'retrying') {
              const activeStatus: 'queued' | 'running' | 'retrying' = st.status
              set((state) => ({
                leads: state.leads.map((lead) => lead.id === leadId ? {
                  ...lead,
                  scoreJob: {
                    status: activeStatus,
                    attempts: st.attempts ?? lead.scoreJob?.attempts ?? 0,
                    maxAttempts: st.maxAttempts ?? lead.scoreJob?.maxAttempts ?? 3,
                    retryCycles: st.retryCycles ?? lead.scoreJob?.retryCycles,
                    updatedAt: new Date().toISOString(),
                    error: st.error,
                  },
                } : lead),
              }))
              continue
            }
            if (st.status === 'done') {
              const fresh = await apiGet<Lead>(`/leads/${leadId}`)
              if (fresh) set((state) => ({ leads: state.leads.map((l) => l.id === leadId ? { ...l, ...fresh } : l) }))
              return
            }
            if (st.status === 'failed') {
              const fresh = await apiGet<Lead>(`/leads/${leadId}`).catch(() => null)
              if (fresh) set((state) => ({ leads: state.leads.map((l) => l.id === leadId ? { ...l, ...fresh } : l) }))
              const attemptText = st.attempts && st.maxAttempts ? `（${st.attempts}/${st.maxAttempts} 次）` : ''
              get().addAudit('项目获取池', 'AI 评分暂未完成', `${leadId}${attemptText}`)
              return
            }
          }
          // 浏览器停止高频轮询不等于取消任务；后端会继续排队执行，页面刷新后可从持久状态接续。
          const fresh = await apiGet<Lead>(`/leads/${leadId}`).catch(() => null)
          if (fresh) set((state) => ({ leads: state.leads.map((l) => l.id === leadId ? { ...l, ...fresh } : l) }))
          if (fresh?.scoreJob && ['queued', 'running', 'retrying'].includes(fresh.scoreJob.status)) {
            get().addAudit('项目获取池', 'AI 评分仍在后台执行', fresh.name)
          }
        } catch (e) {
          get().addAudit('项目获取池', 'AI 评分请求失败', (e as Error).message)
        } finally {
          finish()
        }
      },
      // 拉单条 lead 详情(含 scoring/radar_profile/sources/funding_rounds 等 jsonb 大字段)
      // 列表接口已精简不返回这些字段,详情弹窗打开时按需拉
      fetchLeadDetail: async (leadId: string) => {
        try {
          const r = await apiGet<Lead>(`/leads/${leadId}`)
          return r
        } catch (e) {
          get().addAudit('项目获取池', '详情拉取失败', (e as Error).message)
          return null
        }
      },
      addLead: async (lead) => {
        try {
          const created = await apiPost<Lead>('/leads', lead)
          set((state) => ({ leads: [created, ...state.leads] }))
          get().addAudit('项目获取池', '上传并解析 BP', created.name)
          return created
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '新建线索失败'
          get().addAudit('项目获取池', '新建线索失败', `${lead.name ?? ''}: ${msg}`)
          throw e
        }
      },
      updateLead: async (leadId, patch) => {
        try {
          const updated = await apiPatch<Lead>(`/leads/${leadId}`, patch)
          set((state) => ({ leads: state.leads.map((lead) => lead.id === leadId ? updated : lead) }))
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '编辑线索失败'
        }
      },
      // 纯本地合并 store 里的某条 lead(不发后端请求) —— AI 评分完成后用它把新 score/scoring 立即反映到列表
      mergeLeadLocal: (leadId, patch) => {
        set((state) => ({ leads: state.leads.map((lead) => lead.id === leadId ? { ...lead, ...patch } : lead) }))
      },
      convertLead: async (leadId) => {
        const listLead = get().leads.find((item) => item.id === leadId)
        if (!listLead || listLead.poolStatus === '已转专属项目') return undefined
        // 列表接口精简了 fundingRounds/sources/highlights/risks/scoring 等大字段,
        // 转专属项目需要这些完整字段 —— 先拉一次详情,拉不到就用列表版兜底(带默认值防崩)
        const detail = await get().fetchLeadDetail(leadId)
        const lead = {
          ...listLead,
          ...(detail ?? {}),
          fundingRounds: (detail?.fundingRounds ?? listLead.fundingRounds ?? []),
          riskTags: (detail?.riskTags ?? listLead.riskTags ?? []),
          highlights: (detail?.highlights ?? listLead.highlights ?? []),
          risks: (detail?.risks ?? listLead.risks ?? []),
          sources: (detail?.sources ?? listLead.sources ?? []),
        } as typeof listLead
        const existing = get().projects.find((item) => item.name === lead.name)
        if (existing) {
          set((state) => ({
            projects: state.projects.map((project) => project.id === existing.id ? { ...project, owner: get().currentUser.name, updatedAt: now() } : project),
            leads: state.leads.map((item) => item.id === leadId ? {
              ...item,
              poolStatus: '已转专属项目',
              claimedBy: get().currentUser.name,
              convertedProjectId: existing.id,
            } : item),
          }))
          get().addAudit('项目获取池', '领取为我的专属项目', `${lead.name} → ${get().currentUser.name}`)
          // 同步后端：持久化 poolStatus + 触发领取自动 AI 分析(缺此步刷新会打回原状)
          try {
            await apiPost(`/leads/${leadId}/convert`, { projectId: existing.id })
            // 后端成功后再断言一次本地状态，防止期间 hydrate 竞态把绿色标覆盖回去
            set((state) => ({ leads: state.leads.map((item) => item.id === leadId ? { ...item, poolStatus: '已转专属项目', claimedBy: get().currentUser.name, convertedProjectId: existing.id } : item) }))
          } catch { /* 后端同步失败不阻断前端 */ }
          return get().projects.find((project) => project.id === existing.id)
        }
        const project = await get().addProject({
          name: lead.name,
          companyName: lead.companyName,
          industry: lead.industry,
          round: lead.round,
          stage: '线索',
          owner: get().currentUser.name,
          collaborators: [],
          source: lead.source,
          financing: lead.financing,
          valuation: (lead.fundingRounds ?? [])[0]?.valuation ?? '未公开，待核验',
          riskLevel: lead.riskTags.length > 1 ? '中' : '低',
          summary: lead.summary,
          tags: [lead.industry, ...lead.riskTags],
          businessModel: '待尽调补充',
          market: '待行业研究补充',
          team: lead.team,
          stageSource: '线索转入',
          scoring: lead.scoring,
        })
        if (!project) return undefined
        get().saveSummary({
          projectId: project.id,
          positioning: lead.summary,
          highlights: lead.highlights,
          risks: lead.risks,
          questions: ['核心客户的付费与续费情况如何？', '未来 18 个月的核心里程碑与资金用途是什么？'],
          missing: ['审计财务数据', '前十大客户明细'],
          confidence: lead.score,
          sources: lead.sources.map((source) => `${source.title} · ${source.url}`).slice(0, 5),
          updatedAt: now(),
        })
        get().addFile({
          projectId: project.id,
          name: lead.source.includes('BP') ? `${lead.name}_BP及公开信息.pdf` : `${lead.name}_公开信息快照.html`,
          type: lead.source.includes('BP') ? 'PDF' : 'HTML',
          category: lead.source.includes('BP') ? '项目资料' : '公开情报',
          size: lead.source.includes('BP') ? '8.6 MB' : '256 KB',
          uploader: get().currentUser.name,
          parseStatus: '成功',
          visibility: '项目成员',
        })
        set((state) => ({
          leads: state.leads.map((item) => item.id === leadId ? {
            ...item,
            poolStatus: '已转专属项目',
            claimedBy: get().currentUser.name,
            convertedProjectId: project.id,
          } : item),
        }))
        get().addAudit('项目获取池', '领取为我的专属项目', `${lead.name} → ${get().currentUser.name}`)
        // 同步后端：持久化 poolStatus + 触发领取自动 AI 分析(缺此步刷新会打回原状)
        try {
          await apiPost(`/leads/${leadId}/convert`, { projectId: project.id })
          set((state) => ({ leads: state.leads.map((item) => item.id === leadId ? { ...item, poolStatus: '已转专属项目', claimedBy: get().currentUser.name, convertedProjectId: project.id } : item) }))
        } catch { /* 后端同步失败不阻断前端 */ }
        return project
      },
      saveSummary: async (summary) => {
        try {
          const saved = await apiPost<AISummary>('/ai-summaries', summary)
          set((state) => {
            const others = state.aiSummaries.filter((item) => item.projectId !== saved.projectId)
            return { aiSummaries: [saved, ...others] }
          })
          const project = get().projects.find((item) => item.id === summary.projectId)
          get().addAudit('AI 工具箱', '保存项目摘要', project?.name ?? summary.projectId)
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '保存摘要失败'
          get().addAudit('AI 工具箱', '保存摘要失败', `${summary.positioning.slice(0, 40)}: ${msg}`)
        }
      },
      addTodo: async (todo) => {
        try {
          const created = await apiPost<Todo>('/todos', todo)
          set((state) => ({ todos: [created, ...state.todos] }))
          get().addAudit('待办管理', '创建待办', created.title)
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '创建待办失败'
          get().addAudit('待办管理', '创建待办失败', `${todo.title ?? ''}: ${msg}`)
          throw e
        }
      },
      updateTodo: async (todoId, patch) => {
        try {
          const updated = await apiPatch<Todo>(`/todos/${todoId}`, patch)
          set((state) => ({ todos: state.todos.map((todo) => todo.id === todoId ? updated : todo) }))
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '更新待办失败'
        }
      },
      deleteTodo: async (todoId) => {
        const target = get().todos.find((todo) => todo.id === todoId)
        try {
          await apiDelete(`/todos/${todoId}`)
          set((state) => ({ todos: state.todos.filter((todo) => todo.id !== todoId) }))
          get().addAudit('待办管理', '删除待办', target?.title ?? todoId)
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '删除待办失败'
          get().addAudit('待办管理', '删除待办失败', `${target?.title ?? todoId}: ${msg}`)
          throw e
        }
      },
      addMeeting: async (meeting, newTodos = []) => {
        try {
          const created = await apiPost<Meeting>('/meetings', meeting)
          const createdTodos: Todo[] = []
          for (const t of newTodos) {
            try {
              const todoRow = await apiPost<Todo>('/todos', { ...t, meetingId: created.id })
              createdTodos.push(todoRow)
            } catch { /* 单个 todo 失败不挡主流程 */ }
          }
          set((state) => ({
            meetings: [created, ...state.meetings],
            todos: [...createdTodos, ...state.todos],
          }))
          get().addAudit('会议纪要', '新建并生成纪要', created.title)
          return created
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '新建会议失败'
          get().addAudit('会议纪要', '新建会议失败', `${meeting.title ?? ''}: ${msg}`)
          throw e
        }
      },
      updateMeeting: async (meetingId, patch) => {
        try {
          const updated = await apiPatch<Meeting>(`/meetings/${meetingId}`, patch)
          set((state) => ({ meetings: state.meetings.map((meeting) => meeting.id === meetingId ? updated : meeting) }))
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '更新会议失败'
        }
      },
      addRisk: async (risk) => {
        try {
          const created = await apiPost<RiskAlert>('/risks', risk)
          set((state) => ({ risks: [created, ...state.risks] }))
          get().addAudit('风险预警', '新增风险', `${created.projectName}：${created.type}`)
          return created
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '新增风险失败'
          get().addAudit('风险预警', '新增风险失败', `${risk.projectName}：${risk.type}: ${msg}`)
          throw e
        }
      },
      updateRisk: async (riskId, patch) => {
        try {
          const updated = await apiPatch<RiskAlert>(`/risks/${riskId}`, patch)
          set((state) => ({ risks: state.risks.map((risk) => risk.id === riskId ? updated : risk) }))
          const risk = get().risks.find((item) => item.id === riskId)
          get().addAudit('风险预警', '更新风险状态', risk?.projectName ?? riskId)
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '更新风险失败'
        }
      },
      addMaterialJob: (job) => {
        const created: MaterialJob = { ...job, id: id('mat') }
        set((state) => ({ materialJobs: [created, ...state.materialJobs] }))
        get().addAudit('上会材料', '创建生成任务', `${created.projectName}：${created.type}`)
        return created
      },
      updateMaterialJob: (jobId, patch) => set((state) => ({ materialJobs: state.materialJobs.map((job) => job.id === jobId ? { ...job, ...patch } : job) })),
      addPostUpdate: (update) => {
        const created: PostUpdate = { ...update, id: id('post'), updatedAt: new Date().toISOString().slice(0, 10) }
        set((state) => ({ postUpdates: [created, ...state.postUpdates] }))
        get().addAudit('投后工具', '新增经营更新', created.period)
      },
      addAudit: (module, action, target) => {
        const log: AuditLog = { id: id('a'), user: get().currentUser.name, module, action, target, ip: '10.20.14.35', createdAt: now() }
        set((state) => ({ auditLogs: [log, ...state.auditLogs].slice(0, 100) }))
      },
      toggleUserStatus: async (userId) => {
        try {
          const updated = await apiPost<User>(`/users/${userId}/toggle-status`)
          set((state) => ({
            users: state.users.map((user) => user.id === userId ? updated : user),
          }))
          get().addAudit('系统管理', '更新用户状态', updated.name)
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '切换用户状态失败'
        }
      },
      addUser: async (user) => {
        try {
          const created = await apiPost<User>('/users', user)
          set((state) => ({ users: [...state.users, created] }))
          get().addAudit('系统管理', '新增用户', created.name)
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '新增用户失败'
          get().addAudit('系统管理', '新增用户失败', `${user.email ?? ''}: ${msg}`)
        }
      },
      markNotificationsRead: () => set((state) => ({ notifications: state.notifications.map((notification) => ({ ...notification, isRead: true })) })),
      resetDemo: () => set({
        isAuthenticated: false,
        currentUser: defaultUser,
        projects,
        files,
        aiSummaries,
        todos,
        meetings,
        risks,
        workflowLogs,
        approvalRequests,
        materialJobs,
        postUpdates,
        users,
        templates,
        auditLogs,
        notifications,
      }),
    }),
    { name: 'cybernaut-investment-mvp-v10', partialize: (state) => ({
      isAuthenticated: state.isAuthenticated,
      auditLogs: state.auditLogs,
      notifications: state.notifications,
      currentUser: state.currentUser,
    }) },
  ),
)
