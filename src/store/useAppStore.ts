import { create } from 'zustand'
import { useAuthStore } from './useAuthStore'
import { apiGet, apiPost, apiPatch, apiDelete, ApiError } from '../lib/api'
import type {
  AISummary,
  ApprovalRequest,
  AuditLog,
  Lead,
  LeadListItem,
  Meeting,
  Notification,
  Project,
  ProjectClassification,
  ProjectFile,
  ProjectStage,
  RiskAlert,
  Template,
  Todo,
  User,
  WorkflowLog,
} from '../types'

let latestLeadListRequest = 0

export type LeadListQuery = {
  page?: number
  pageSize?: number
  channel?: string
  sort?: 'latest' | 'score' | 'funding' | 'valuation' | 'customer' | 'profileUpdated' | ''
  keyword?: string
  source?: string
  industry?: string
  industryLevel1?: string
  industryLevel2?: string
  industrySegment?: string
  region?: string
  leadType?: 'company' | 'research' | ''
  stage?: string
  updatedRange?: '7d' | '30d' | '90d' | ''
  productRoute?: string
  institution?: string
  institutionType?: string
  academicInstitution?: string
  latestRound?: string
  customerStageMin?: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | ''
  profileStatus?: 'never' | 'verified' | 'partial' | 'conflicted' | 'missing' | 'not_applicable' | 'stale' | ''
  hasConflict?: 'true' | 'false' | ''
  productionStage?: string
  hasMajorInstitution?: 'true' | 'false' | ''
  academicRelation?: string
  hasCommercializationLink?: 'true' | 'false' | ''
  fundingDateFrom?: string
  fundingDateTo?: string
  valuationMin?: number
  valuationMax?: number
  valuationCurrency?: 'CNY' | 'USD' | 'HKD' | 'EUR' | ''
  valuationType?: 'pre_money' | 'post_money' | 'undisclosed' | ''
  customerTier?: 'A' | 'B' | 'C' | ''
  hasVerifiedCustomer?: 'true' | 'false' | ''
}

export type LeadListResponse = {
  list: LeadListItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

function requiredVersion(entity: { version?: number } | undefined, label: string): number {
  if (!entity || !Number.isInteger(entity.version) || Number(entity.version) < 1) {
    throw new Error(`${label}版本信息缺失，请刷新页面后重试`)
  }
  return Number(entity.version)
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
  leads: Lead[]
  leadPagination: { total: number; page: number; pageSize: number; totalPages: number }
  leadStats: { total: number; verified: number; highPriority: number; avgCompleteness: number }
  users: User[]
  templates: Template[]
  auditLogs: AuditLog[]
  notifications: Notification[]
  logout: () => void
  addProject: (project: Omit<Project, 'id' | 'version' | 'updatedAt' | 'createdAt' | 'score' | 'progress'> & {
    governance: { ownerUserId: string; assignments: Array<{ duty: 'boss' | 'project_manager' | 'legal' | 'finance'; userId: string }> }
  }) => Promise<Project>
  updateProject: (projectId: string, patch: Partial<Project>) => Promise<Project>
  deleteProject: (projectId: string, confirmation: string) => Promise<void>
  pinProject: (projectId: string, pinned: boolean) => Promise<void>
  classifyProject: (projectId: string, toClassification: ProjectClassification, reason: string) => Promise<Project>
  moveProjectStage: (projectId: string, nextStage: ProjectStage, comment: string) => void
  createApprovalRequest: (input: {
    projectId: string
    targetStage: ProjectStage
    reason: string
    priority?: '普通' | '紧急'
    amount?: string
    valuation?: string
    attachments?: string[]
  }) => Promise<ApprovalRequest | undefined>
  approveRequest: (requestId: string, comment: string) => Promise<void>
  returnRequest: (requestId: string, comment: string) => Promise<void>
  resubmitApprovalRequest: (requestId: string, comment: string) => Promise<void>
  rejectRequest: (requestId: string, comment: string) => Promise<void>
  withdrawRequest: (requestId: string, comment: string) => Promise<void>
  deleteFile: (fileId: string) => Promise<void>
  addLead: (lead: Omit<Lead, 'id'>) => Promise<Lead>
  fetchLeads: (query?: LeadListQuery) => Promise<LeadListResponse | null>
  fetchLeadStats: () => Promise<void>
  fetchLeadDetail: (leadId: string) => Promise<Lead | null>
  mergeLeadLocal: (leadId: string, patch: Partial<Lead>) => void
  convertLead: (leadId: string) => Promise<Project | undefined>
  saveSummary: (summary: AISummary) => void
  addTodo: (todo: Omit<Todo, 'id' | 'version'>) => void
  updateTodo: (todoId: string, patch: Partial<Todo>) => Promise<Todo>
  deleteTodo: (todoId: string) => void
  addMeeting: (meeting: Omit<Meeting, 'id' | 'version'>, newTodos?: Omit<Todo, 'id' | 'version'>[], clientRequestId?: string) => Promise<Meeting>
  updateMeeting: (meetingId: string, patch: Partial<Meeting>) => Promise<Meeting>
  deleteMeeting: (meetingId: string, reason: string, clientRequestId: string) => Promise<void>
  addRisk: (risk: Omit<RiskAlert, 'id' | 'version'>) => Promise<RiskAlert>
  updateRisk: (riskId: string, patch: Partial<RiskAlert>) => Promise<RiskAlert>
  addAudit: (module: string, action: string, target: string) => void
  toggleUserStatus: (userId: string) => void
  addUser: (user: Omit<User, 'id' | 'lastLogin'>) => void
  markNotificationsRead: () => void
  hydrateFromServer: () => Promise<void>
  refreshProjectDomain: () => Promise<void>
}

const emptyUser: User = {
  id: '',
  name: '',
  email: '',
  department: '',
  role: '',
  status: '禁用',
  lastLogin: '',
}

export const useAppStore = create<AppState>()(
    (set, get) => ({
      isAuthenticated: false,
      currentUser: emptyUser,
      projects: [],
      files: [],
      aiSummaries: [],
      todos: [],
      meetings: [],
      risks: [],
      workflowLogs: [],
      approvalRequests: [],
      leads: [],
      leadPagination: {
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      },
      leadStats: {
        total: 0,
        verified: 0,
        highPriority: 0,
        avgCompleteness: 0,
      },
      users: [],
      templates: [],
      auditLogs: [],
      notifications: [],
      logout: () => {
        try { useAuthStore.getState().logout() } catch {}
        set({
          isAuthenticated: false,
          currentUser: emptyUser,
          projects: [], files: [], aiSummaries: [], todos: [], meetings: [], risks: [],
          workflowLogs: [], approvalRequests: [], leads: [],
          users: [], templates: [], auditLogs: [], notifications: [],
          leadPagination: { total: 0, page: 1, pageSize: 20, totalPages: 1 },
          leadStats: { total: 0, verified: 0, highPriority: 0, avgCompleteness: 0 },
        })
      },
      // 从后端拉取所有实体数据，调用一次
      hydrateFromServer: async () => {
        const authUser = useAuthStore.getState().user
        if (!useAuthStore.getState().isAuthenticated || !authUser) return
        const isSystemAdmin = authUser.permissionCodes?.includes('system.manage') ?? authUser.role === '系统管理员'
        // 注意: 故意不发 /leads 请求 — leads 走分页(由 SourcingPage 单独 fetchLeads 拉)
        // 之前 hydrate 拉全量 leads 阻塞首次页面渲染 7s+,改成按需拉
        const results = await Promise.allSettled([
          apiGet<{ list: Project[] }>('/projects?pageSize=100'),
          apiGet<{ list: Meeting[] }>('/meetings'),
          apiGet<{ list: Todo[] }>('/todos'),
          apiGet<{ list: RiskAlert[] }>('/risks'),
          isSystemAdmin ? apiGet<{ list: User[] }>('/users') : Promise.resolve({ list: [] as User[] }),
          apiGet<{ list: AISummary[] }>('/ai-summaries'),
          apiGet<{ list: ProjectFile[] }>('/projects/files/all'),
          apiGet<{ list: Template[] }>('/templates'),
          isSystemAdmin ? apiGet<{ list: AuditLog[] }>('/audit-logs') : Promise.resolve({ list: [] as AuditLog[] }),
          apiGet<{ list: ApprovalRequest[] }>('/oa/requests'),
          apiGet<{ list: WorkflowLog[] }>('/oa/workflow-logs'),
        ])
        const listOrEmpty = <T>(result: PromiseSettledResult<{ list: T[] }>): T[] =>
          result.status === 'fulfilled' ? result.value.list : []
        const next: Partial<AppState> = {
          isAuthenticated: true,
          currentUser: {
            id: authUser.id,
            name: authUser.name,
            email: authUser.email,
            department: authUser.department,
            role: authUser.role,
            status: authUser.status === '禁用' ? '禁用' : '启用',
            lastLogin: '',
          },
          projects: listOrEmpty(results[0]),
          meetings: listOrEmpty(results[1]),
          todos: listOrEmpty(results[2]),
          risks: listOrEmpty(results[3]),
          users: listOrEmpty(results[4]),
          aiSummaries: listOrEmpty(results[5]),
          // 文件接口失败时保留已有状态，不能把网络/数据库错误伪装成“0 份资料”。
          files: results[6].status === 'fulfilled' ? results[6].value.list : get().files,
          templates: listOrEmpty(results[7]),
          auditLogs: listOrEmpty(results[8]),
          approvalRequests: listOrEmpty(results[9]),
          workflowLogs: listOrEmpty(results[10]),
          notifications: [],
        }
        set(next as AppState)
      },
      refreshProjectDomain: async () => {
        if (!useAuthStore.getState().isAuthenticated) return
        const results = await Promise.allSettled([
          apiGet<{ list: Project[] }>('/projects?pageSize=100'),
          apiGet<{ list: ApprovalRequest[] }>('/oa/requests'),
          apiGet<{ list: Todo[] }>('/todos'),
          apiGet<{ list: WorkflowLog[] }>('/oa/workflow-logs'),
        ])
        const patch: Partial<AppState> = {}
        if (results[0].status === 'fulfilled') patch.projects = results[0].value.list
        if (results[1].status === 'fulfilled') patch.approvalRequests = results[1].value.list
        if (results[2].status === 'fulfilled') patch.todos = results[2].value.list
        if (results[3].status === 'fulfilled') patch.workflowLogs = results[3].value.list
        set(patch as AppState)
      },
      addProject: async (project) => {
        try {
          const created = await apiPost<Project>('/projects', project)
          await get().refreshProjectDomain()
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
          const expectedVersion = requiredVersion(get().projects.find((project) => project.id === projectId), '项目')
          const { version: _version, ...safePatch } = patch
          const updated = await apiPatch<Project>(`/projects/${projectId}`, { ...safePatch, expectedVersion })
          set((state) => ({
            projects: state.projects.map((project) => project.id === projectId ? updated : project),
          }))
          get().addAudit('项目管理', '编辑项目', updated.name)
          return updated
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '更新项目失败'
          get().addAudit('项目管理', '编辑项目失败', `${projectId}: ${msg}`)
          throw e
        }
      },
      deleteProject: async (projectId, confirmation) => {
        const proj = get().projects.find((p) => p.id === projectId)
        try {
          const expectedVersion = requiredVersion(proj, '项目')
          await apiDelete(`/projects/${projectId}`, { confirmation, expectedVersion })
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
          const expectedVersion = requiredVersion(get().projects.find((project) => project.id === projectId), '项目')
          const result = await apiPost<{ pinned: boolean; version: number }>(`/projects/${projectId}/pin`, { pinned, expectedVersion })
          set((state) => ({ projects: state.projects.map((p) => p.id === projectId
            ? { ...p, pinned: result.pinned, version: result.version } as Project
            : p) }))
          get().addAudit('项目管理', pinned ? '置顶项目' : '取消置顶', projectId)
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '置顶失败'
          get().addAudit('项目管理', '置顶操作失败', `${projectId}: ${msg}`)
          throw e
        }
      },
      classifyProject: async (projectId, toClassification, reason) => {
        try {
          const expectedVersion = requiredVersion(get().projects.find((project) => project.id === projectId), '项目')
          const updated = await apiPatch<Project>(`/projects/${projectId}/classification`, {
            toClassification,
            reason,
            expectedVersion,
          })
          set((state) => ({
            projects: state.projects.map((project) => project.id === projectId ? updated : project),
          }))
          return updated
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '项目分类调整失败'
          get().addAudit('项目管理', '项目分类调整失败', `${projectId}: ${msg}`)
          throw e
        }
      },
      moveProjectStage: (projectId, nextStage, comment) => {
        void get().createApprovalRequest({ projectId, targetStage: nextStage, reason: comment })
      },
      createApprovalRequest: async (input) => {
        try {
          const project = get().projects.find((item) => item.id === input.projectId)
          const created = await apiPost<ApprovalRequest>('/oa/requests', {
            ...input,
            attachments: input.attachments
              ?? get().files.filter((file) => file.projectId === input.projectId).map((file) => file.name),
            amount: input.amount ?? project?.financing,
            valuation: input.valuation ?? project?.valuation,
          })
          const refreshedProject = await apiGet<Project>(`/projects/${created.projectId}`).catch(() => undefined)
          set((state) => ({
            approvalRequests: [created, ...state.approvalRequests.filter((item) => item.id !== created.id)],
            projects: state.projects.map((item) => item.id === created.projectId
              ? { ...item, ...refreshedProject, latestApprovalId: created.id, updatedAt: refreshedProject?.updatedAt ?? created.submittedAt }
              : item),
          }))
          await get().refreshProjectDomain()
          return created
        } catch (error) {
          get().addAudit('OA 流程', '发起审批失败', (error as Error).message)
          throw error
        }
      },
      approveRequest: async (requestId, comment) => {
        const result = await apiPost<{ request: ApprovalRequest; project?: Project }>(
          `/oa/requests/${requestId}/actions`, { action: 'approve', comment, expectedVersion: get().approvalRequests.find((item) => item.id === requestId)?.lockVersion },
        )
        set((state) => ({
          approvalRequests: state.approvalRequests.map((item) => item.id === requestId ? result.request : item),
          projects: result.project
            ? state.projects.map((item) => item.id === result.project!.id ? { ...item, ...result.project } : item)
            : state.projects,
        }))
        if (result.project) {
          const logs = await apiGet<{ list: WorkflowLog[] }>('/oa/workflow-logs')
          set({ workflowLogs: logs.list })
        }
        await get().refreshProjectDomain()
      },
      returnRequest: async (requestId, comment) => {
        const result = await apiPost<{ request: ApprovalRequest; project?: Project }>(
          `/oa/requests/${requestId}/actions`, { action: 'return', comment, expectedVersion: get().approvalRequests.find((item) => item.id === requestId)?.lockVersion },
        )
        set((state) => ({ approvalRequests: state.approvalRequests.map((item) => item.id === requestId ? result.request : item), projects: result.project ? state.projects.map((item) => item.id === result.project!.id ? { ...item, ...result.project } : item) : state.projects }))
        await get().refreshProjectDomain()
      },
      resubmitApprovalRequest: async (requestId, comment) => {
        const result = await apiPost<{ request: ApprovalRequest; project?: Project }>(
          `/oa/requests/${requestId}/actions`, { action: 'resubmit', comment, expectedVersion: get().approvalRequests.find((item) => item.id === requestId)?.lockVersion },
        )
        set((state) => ({ approvalRequests: state.approvalRequests.map((item) => item.id === requestId ? result.request : item), projects: result.project ? state.projects.map((item) => item.id === result.project!.id ? { ...item, ...result.project } : item) : state.projects }))
        await get().refreshProjectDomain()
      },
      rejectRequest: async (requestId, comment) => {
        const result = await apiPost<{ request: ApprovalRequest; project?: Project }>(
          `/oa/requests/${requestId}/actions`, { action: 'reject', comment, expectedVersion: get().approvalRequests.find((item) => item.id === requestId)?.lockVersion },
        )
        set((state) => ({ approvalRequests: state.approvalRequests.map((item) => item.id === requestId ? result.request : item), projects: result.project ? state.projects.map((item) => item.id === result.project!.id ? { ...item, ...result.project } : item) : state.projects }))
        await get().refreshProjectDomain()
      },
      withdrawRequest: async (requestId, comment) => {
        const result = await apiPost<{ request: ApprovalRequest; project?: Project }>(
          `/oa/requests/${requestId}/actions`, { action: 'withdraw', comment, expectedVersion: get().approvalRequests.find((item) => item.id === requestId)?.lockVersion },
        )
        set((state) => ({ approvalRequests: state.approvalRequests.map((item) => item.id === requestId ? result.request : item), projects: result.project ? state.projects.map((item) => item.id === result.project!.id ? { ...item, ...result.project } : item) : state.projects }))
        await get().refreshProjectDomain()
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
      fetchLeads: async (query = {}) => {
        const {
          page = 1, pageSize = 20, channel = '', sort = '', keyword = '', source = '',
          industry = '', region = '', leadType = '', stage = '', updatedRange = '',
          industryLevel1 = '', industryLevel2 = '', industrySegment = '',
          productRoute = '', institution = '', institutionType = '', academicInstitution = '', latestRound = '',
          customerStageMin = '', profileStatus = '', hasConflict = '',
          productionStage = '', hasMajorInstitution = '', academicRelation = '',
          hasCommercializationLink = '', fundingDateFrom = '', fundingDateTo = '',
          valuationMin, valuationMax, valuationCurrency = '', valuationType = '',
          customerTier = '', hasVerifiedCustomer = '',
        } = query
        const requestId = ++latestLeadListRequest
        try {
          const qs = `/leads?page=${page}&pageSize=${pageSize}`
            + (channel ? `&channel=${encodeURIComponent(channel)}` : '')
            + (sort ? `&sort=${encodeURIComponent(sort)}` : '')
            + (keyword ? `&keyword=${encodeURIComponent(keyword)}` : '')
            + (source ? `&source=${encodeURIComponent(source)}` : '')
            + (industry ? `&industry=${encodeURIComponent(industry)}` : '')
            + (industryLevel1 ? `&industryLevel1=${encodeURIComponent(industryLevel1)}` : '')
            + (industryLevel2 ? `&industryLevel2=${encodeURIComponent(industryLevel2)}` : '')
            + (industrySegment ? `&industrySegment=${encodeURIComponent(industrySegment)}` : '')
            + (region ? `&region=${encodeURIComponent(region)}` : '')
            + (leadType ? `&leadType=${encodeURIComponent(leadType)}` : '')
            + (stage ? `&stage=${encodeURIComponent(stage)}` : '')
            + (updatedRange ? `&updatedRange=${encodeURIComponent(updatedRange)}` : '')
            + (productRoute ? `&productRoute=${encodeURIComponent(productRoute)}` : '')
            + (institution ? `&institution=${encodeURIComponent(institution)}` : '')
            + (institutionType ? `&institutionType=${encodeURIComponent(institutionType)}` : '')
            + (academicInstitution ? `&academicInstitution=${encodeURIComponent(academicInstitution)}` : '')
            + (latestRound ? `&latestRound=${encodeURIComponent(latestRound)}` : '')
            + (customerStageMin ? `&customerStageMin=${encodeURIComponent(customerStageMin)}` : '')
            + (profileStatus ? `&profileStatus=${encodeURIComponent(profileStatus)}` : '')
            + (hasConflict ? `&hasConflict=${encodeURIComponent(hasConflict)}` : '')
            + (productionStage ? `&productionStage=${encodeURIComponent(productionStage)}` : '')
            + (hasMajorInstitution ? `&hasMajorInstitution=${encodeURIComponent(hasMajorInstitution)}` : '')
            + (academicRelation ? `&academicRelation=${encodeURIComponent(academicRelation)}` : '')
            + (hasCommercializationLink ? `&hasCommercializationLink=${encodeURIComponent(hasCommercializationLink)}` : '')
            + (fundingDateFrom ? `&fundingDateFrom=${encodeURIComponent(fundingDateFrom)}` : '')
            + (fundingDateTo ? `&fundingDateTo=${encodeURIComponent(fundingDateTo)}` : '')
            + (valuationMin !== undefined ? `&valuationMin=${encodeURIComponent(valuationMin)}` : '')
            + (valuationMax !== undefined ? `&valuationMax=${encodeURIComponent(valuationMax)}` : '')
            + (valuationCurrency ? `&valuationCurrency=${encodeURIComponent(valuationCurrency)}` : '')
            + (valuationType ? `&valuationType=${encodeURIComponent(valuationType)}` : '')
            + (customerTier ? `&customerTier=${encodeURIComponent(customerTier)}` : '')
            + (hasVerifiedCustomer ? `&hasVerifiedCustomer=${encodeURIComponent(hasVerifiedCustomer)}` : '')
          const r = await apiGet<LeadListResponse>(qs)
          // 用户快速切换筛选条件时，只允许最后一次请求更新列表，避免旧结果后到并覆盖新结果。
          if (requestId !== latestLeadListRequest) return null
          // The shared legacy store also backs detail-era consumers typed as full Lead. The HTTP contract is
          // intentionally narrower; only the seven-column page should consume these list items directly.
          set({ leads: r.list as unknown as Lead[], leadPagination: { total: r.total, page: r.page, pageSize: r.pageSize, totalPages: r.totalPages } })
          return r
        } catch (e) {
          if (requestId !== latestLeadListRequest) return null
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
      // 纯本地合并 store 里的某条 lead(不发后端请求) —— AI 评分完成后用它把新 score/scoring 立即反映到列表
      mergeLeadLocal: (leadId, patch) => {
        set((state) => ({ leads: state.leads.map((lead) => lead.id === leadId ? { ...lead, ...patch } : lead) }))
      },
      convertLead: async (leadId) => {
        const listLead = get().leads.find((item) => item.id === leadId)
        if (listLead?.poolStatus === '已转专属项目') return undefined
        const converted = await apiPost<{ project: Project; lead: Lead }>(`/leads/${leadId}/convert`)
        set((state) => ({
          projects: [converted.project, ...state.projects.filter((project) => project.id !== converted.project.id)],
          leads: state.leads.map((item) => item.id === leadId ? { ...item, ...converted.lead } : item),
        }))
        return converted.project
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
          const expectedVersion = requiredVersion(get().todos.find((todo) => todo.id === todoId), '待办')
          const { version: _version, ...safePatch } = patch
          const updated = await apiPatch<Todo>(`/todos/${todoId}`, { ...safePatch, expectedVersion })
          set((state) => ({ todos: state.todos.map((todo) => todo.id === todoId ? updated : todo) }))
          return updated
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '更新待办失败'
          get().addAudit('待办管理', '更新待办失败', `${todoId}: ${msg}`)
          throw e
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
      addMeeting: async (meeting, newTodos = [], clientRequestId = crypto.randomUUID()) => {
        try {
          const created = await apiPost<Meeting & { createdTodos: Todo[] }>('/meetings', { ...meeting, newTodos, clientRequestId })
          set((state) => ({
            meetings: [created, ...state.meetings.filter((item) => item.id !== created.id)],
            todos: [...created.createdTodos, ...state.todos.filter((item) => !created.createdTodos.some((createdTodo) => createdTodo.id === item.id))],
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
          const expectedVersion = requiredVersion(get().meetings.find((meeting) => meeting.id === meetingId), '会议')
          const { version: _version, ...safePatch } = patch
          const updated = await apiPatch<Meeting>(`/meetings/${meetingId}`, { ...safePatch, expectedVersion })
          set((state) => ({ meetings: state.meetings.map((meeting) => meeting.id === meetingId ? updated : meeting) }))
          return updated
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '更新会议失败'
          get().addAudit('会议纪要', '更新会议失败', `${meetingId}: ${msg}`)
          throw e
        }
      },
      deleteMeeting: async (meetingId, reason, clientRequestId) => {
        const meeting = get().meetings.find((item) => item.id === meetingId)
        const expectedVersion = requiredVersion(meeting, '会议')
        try {
          await apiDelete(`/meetings/${meetingId}`, { expectedVersion, reason, clientRequestId })
          set((state) => ({
            meetings: state.meetings.filter((item) => item.id !== meetingId),
            todos: state.todos.map((todo) => todo.meetingId === meetingId && !['已完成', '已关闭', '已取消', '已归档'].includes(todo.status) ? { ...todo, status: '已取消' as const } : todo),
          }))
          get().addAudit('项目会议', '删除会议', meeting?.title ?? meetingId)
        } catch (e) {
          const msg = e instanceof ApiError ? e.message : '删除会议失败'
          get().addAudit('项目会议', '删除会议失败', `${meeting?.title ?? meetingId}: ${msg}`)
          throw e
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
          const expectedVersion = requiredVersion(get().risks.find((risk) => risk.id === riskId), '风险')
          const { version: _version, ...safePatch } = patch
          const updated = await apiPatch<RiskAlert>(`/risks/${riskId}`, { ...safePatch, expectedVersion })
          set((state) => ({ risks: state.risks.map((risk) => risk.id === riskId ? updated : risk) }))
          return updated
        } catch (e) {
          throw e
        }
      },
      // Audit records are written by the authenticated server mutation that owns
      // the business change. Client code must not manufacture authoritative logs.
      addAudit: () => undefined,
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
    }),
)
