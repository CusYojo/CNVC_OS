import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  oaApprovalNodes,
  oaApprovalRecords,
  oaApprovalRevisions,
  oaApprovalRequests,
  oaWorkflowLogs,
  projectFiles,
  projectPlanActions,
  projectPlans,
  projects, projectMembers,
  todos,
  users,
} from '../db/schema.js'
import type { UserRepository } from '../repositories/identityRepository.js'
import { createMySqlIdentityRepositoryContext, identityRepositories } from '../repositories/index.js'
import { requireAccessibleProject } from './projectAccessService.js'
import { listProjects } from './projectService.js'
import { formatShanghaiDateKey } from '../utils/shanghaiTime.js'
import { evaluateFdeStageGate, lockApprovedFdePlan } from './fdeWorkflowService.js'
import { resolveFdeApprovalNodes } from './fdeGovernanceService.js'
import { actOnFdeTaskExtension, closeTaskExtensions } from './fdeTaskService.js'
import { canReadReferencedDirectiveTasks, closeProjectDirectiveSchedules } from './fdeDirectiveLinksService.js'
import { appendPlanReviewRecord } from './fdeProjectRecordService.js'
import { projectFileAccessCondition, requireProjectFileAccess } from './projectFileAccessService.js'
import { approveNodeTransition } from '../contracts/approvalNodeTransition.js'
import { legacyApprovalAccessCondition } from './oaRequestAccessService.js'

const fdeProjectStages = ['入库', '立项', '尽调计划制定', '尽调计划审核', '尽调', '内核', '投决', '打款', '已 Close'] as const
const legacyProjectStages = ['线索', '初筛', '立项', '尽调', '上会', '投决', '投后', '退出'] as const
type ProjectStage = typeof fdeProjectStages[number] | typeof legacyProjectStages[number] | '放弃'
type ApprovalType =
  | '立项审批' | '尽调计划审核' | '尽调启动审批' | '内核审批' | '投决审批' | '打款审批'
  | '初筛审批' | '上会申请' | '投后移交审批' | '项目终止审批'
type ApprovalAction = 'approve' | 'return' | 'reject' | 'withdraw' | 'resubmit'
type OaTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

type NodeBlueprint = {
  name: string
  roleLabel: string
  roles: string[]
  mode: '或签' | '会签'
}

const blueprintByType: Record<ApprovalType, {
  nodes: NodeBlueprint[]
  checklist: Array<[string, boolean]>
}> = {
  初筛审批: {
    nodes: [
      { name: '投资总监初筛', roleLabel: '投资总监', roles: ['投资总监'], mode: '或签' },
      { name: '平台登记复核', roleLabel: '平台运营/投委会秘书', roles: ['平台运营', '投委会秘书'], mode: '或签' },
    ],
    checklist: [['公司主体与来源可追溯', true], ['项目简介与推荐理由完整', true], ['重复项目已排查', true]],
  },
  立项审批: {
    nodes: [
      { name: '投资总监审批', roleLabel: '投资总监', roles: ['投资总监'], mode: '或签' },
      { name: '风控合规会签', roleLabel: '风控与法务', roles: ['风控与法务', '风控法务'], mode: '会签' },
      { name: '平台主管备案', roleLabel: '平台运营/投委会秘书', roles: ['平台运营', '投委会秘书'], mode: '或签' },
    ],
    checklist: [['初筛结论已形成', true], ['核心团队与商业模式已访谈', true], ['重大合规风险已初查', true], ['融资方案已核验', false]],
  },
  尽调计划审核: {
    nodes: [
      { name: '计划审核人复核', roleLabel: '投资总监/计划审核人', roles: ['投资总监', '投委会秘书'], mode: '或签' },
    ],
    checklist: [['周期与最终日期已填写', true], ['行动负责人、日期和交付物完整', true], ['倒排计划确定性校验通过', true]],
  },
  尽调启动审批: {
    nodes: [
      { name: '投资总监审批', roleLabel: '投资总监', roles: ['投资总监'], mode: '或签' },
      { name: '财务与法务排期', roleLabel: '财务/风控与法务', roles: ['财务', '风控与法务', '风控法务'], mode: '会签' },
    ],
    checklist: [['立项审批已通过', true], ['尽调清单与分工已确认', true], ['数据室权限已开通', true]],
  },
  内核审批: {
    nodes: [
      { name: '项目负责人确认', roleLabel: '投资总监/项目负责人', roles: ['投资总监', '投资经理'], mode: '或签' },
      { name: '财务法务会签', roleLabel: '财务/风控与法务', roles: ['财务', '风控与法务', '风控法务'], mode: '会签' },
      { name: '授权领导审批', roleLabel: '董事长/总裁', roles: ['董事长', '总裁'], mode: '或签' },
    ],
    checklist: [['投资说明书初稿已归档', true], ['投资意向书初稿已归档', true], ['投资基金已明确', true]],
  },
  上会申请: {
    nodes: [
      { name: '投资总监预审', roleLabel: '投资总监', roles: ['投资总监'], mode: '或签' },
      { name: '财务法务风控会签', roleLabel: '财务/风控与法务', roles: ['财务', '风控与法务', '风控法务'], mode: '会签' },
      { name: '投委会秘书排会', roleLabel: '投委会秘书', roles: ['投委会秘书'], mode: '或签' },
    ],
    checklist: [['投资建议书已定稿', true], ['财务尽调结论已上传', true], ['法务尽调结论已上传', true], ['核心风险与对策已闭环', true], ['估值与投资条款已确认', true]],
  },
  投决审批: {
    nodes: [
      { name: '投委会表决', roleLabel: '投委会委员', roles: ['投委会委员'], mode: '会签' },
      { name: '董事长终审', roleLabel: '董事长', roles: ['董事长'], mode: '或签' },
    ],
    checklist: [['投委会会议纪要已归档', true], ['表决票达到通过门槛', true], ['附带条件已明确责任人', true]],
  },
  打款审批: {
    nodes: [
      { name: '项目负责人确认', roleLabel: '投资总监/项目负责人', roles: ['投资总监', '投资经理'], mode: '或签' },
      { name: '财务复核', roleLabel: '财务', roles: ['财务'], mode: '或签' },
      { name: '授权领导终审', roleLabel: '董事长/总裁', roles: ['董事长', '总裁'], mode: '或签' },
    ],
    checklist: [['投委会决议已归档', true], ['打款单已归档', true], ['收款账户与投资主体已复核', true]],
  },
  投后移交审批: {
    nodes: [
      { name: '投资负责人确认', roleLabel: '投资总监', roles: ['投资总监'], mode: '或签' },
      { name: '投后负责人接收', roleLabel: '投后负责人/投后管理组', roles: ['投后负责人', '投后管理组'], mode: '或签' },
      { name: '财务归档', roleLabel: '财务', roles: ['财务'], mode: '或签' },
    ],
    checklist: [['协议与交割文件已归档', true], ['投后指标基线已建立', true], ['董事席位与信息权已登记', true]],
  },
  项目终止审批: {
    nodes: [
      { name: '投资总监审批', roleLabel: '投资总监', roles: ['投资总监'], mode: '或签' },
      { name: '平台归档', roleLabel: '平台运营/投委会秘书', roles: ['平台运营', '投委会秘书'], mode: '或签' },
    ],
    checklist: [['终止原因已说明', true], ['外部沟通已完成', true], ['资料与复盘已归档', true]],
  },
}

function workflowError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code })
}

function isDuplicateKeyError(error: unknown) {
  let candidate: unknown = error
  for (let depth = 0; depth < 5 && candidate && typeof candidate === 'object'; depth += 1) {
    const details = candidate as { code?: string; errno?: number; cause?: unknown }
    if (details.code === 'ER_DUP_ENTRY' || details.errno === 1062) return true
    candidate = details.cause
  }
  return false
}

function approvalType(fromStage: ProjectStage, targetStage: ProjectStage): ApprovalType {
  if (targetStage === '放弃') return '项目终止审批'
  if (fromStage === '立项' && targetStage === '尽调计划制定') return '立项审批'
  if (fromStage === '尽调计划制定' && targetStage === '尽调计划审核') return '尽调计划审核'
  if (fromStage === '尽调计划审核' && targetStage === '尽调') return '尽调启动审批'
  if (fromStage === '尽调' && targetStage === '内核') return '内核审批'
  if (fromStage === '内核' && targetStage === '投决') return '投决审批'
  if (fromStage === '投决' && targetStage === '打款') return '投决审批'
  if (fromStage === '打款' && targetStage === '已 Close') return '打款审批'
  if (fromStage === '线索' && targetStage === '初筛') return '初筛审批'
  if (fromStage === '初筛' && targetStage === '立项') return '立项审批'
  if (fromStage === '立项' && targetStage === '尽调') return '尽调启动审批'
  if (fromStage === '尽调' && targetStage === '上会') return '上会申请'
  if (fromStage === '上会' && targetStage === '投决') return '投决审批'
  if (fromStage === '投决' && targetStage === '投后') return '投后移交审批'
  throw workflowError(409, 'OA_STAGE_TRANSITION_INVALID', `不能从“${fromStage}”直接推进到“${targetStage}”`)
}

function expectedNextStage(stage: ProjectStage, workflowModel: string): ProjectStage | undefined {
  if (workflowModel === 'fde-v1') {
    const fdeIndex = fdeProjectStages.indexOf(stage as typeof fdeProjectStages[number])
    return fdeIndex >= 0 ? fdeProjectStages[fdeIndex + 1] : undefined
  }
  const legacyIndex = legacyProjectStages.indexOf(stage as typeof legacyProjectStages[number])
  return legacyIndex >= 0 ? legacyProjectStages[legacyIndex + 1] : undefined
}

function progressForStage(stage: ProjectStage, current: number, workflowModel: string) {
  if (stage === '放弃') return current
  const fdeProgress: Record<string, number> = { 入库: 0, 立项: 10, 尽调计划制定: 18, 尽调计划审核: 22, 尽调: 58, 内核: 75, 投决: 90, 打款: 100, '已 Close': 100 }
  if (workflowModel === 'fde-v1' && stage in fdeProgress) return fdeProgress[stage]
  const legacyIndex = legacyProjectStages.indexOf(stage as typeof legacyProjectStages[number])
  return legacyIndex >= 0 ? Math.min(100, (legacyIndex + 1) * 13) : current
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : undefined
}

function materialSnapshotIdentity(snapshot: typeof oaApprovalRequests.$inferSelect['materialSnapshot']) {
  // MySQL 的 JSON 二进制格式会重新排列对象键；比较业务字段，不能比较对象序列化顺序。
  return JSON.stringify(snapshot.map((item) => [item.requirementKey, item.fileId, item.fileVersion, item.waiverReason])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
}

async function activeUser(userRepository: UserRepository, userId: string) {
  const user = await userRepository.findById(userId)
  if (!user || user.status !== '启用') throw workflowError(401, 'AUTH_INVALID', '当前用户不存在或已禁用')
  return user
}

async function resolveBlueprintNodes(userRepository: UserRepository, type: ApprovalType, nodes?: NodeBlueprint[], excludedUserId?: string) {
  const resolved = [] as Array<NodeBlueprint & { approverUserIds: string[]; approverNames: string[] }>
  for (const node of nodes ?? blueprintByType[type].nodes) {
    const rows = (await userRepository.findEnabledByRoles(node.roles)).filter((row) => row.id !== excludedUserId)
    if (!rows.length) {
      throw workflowError(
        409,
        'OA_APPROVER_NOT_CONFIGURED',
        `审批节点“${node.name}”没有启用的稳定账号，请先配置角色：${node.roleLabel}`,
      )
    }
    resolved.push({
      ...node,
      approverUserIds: rows.map((row) => row.id),
      approverNames: rows.map((row) => row.name),
    })
  }
  return resolved
}

async function createNodeTodos(
  database: OaTransaction,
  input: {
    requestId: string
    requestTitle: string
    projectId: string
    projectName: string
    node: typeof oaApprovalNodes.$inferSelect
    createdBy: string
    priority: string
  },
) {
  const due = formatShanghaiDateKey(new Date(Date.now() + 2 * 86_400_000))
  if (!input.node.approverUserIds.length) return
  await database.insert(todos).values(input.node.approverUserIds.map((userId, index) => ({
    projectId: input.projectId,
    projectName: input.projectName,
    title: `审批：${input.requestTitle} · ${input.node.name}`,
    owner: input.node.approverNames[index] || '待配置',
    ownerUserId: userId,
    dueDate: due,
    priority: input.priority === '紧急' ? '高' : '中',
    status: '未开始',
    type: '流程',
    approvalRequestId: input.requestId,
    createdBy: input.createdBy,
  })))
}

async function loadPublicRequests(requestIds: string[]) {
  if (!requestIds.length) return []
  const [requestRows, nodeRows, recordRows, revisionRows] = await Promise.all([
    db.select().from(oaApprovalRequests).where(inArray(oaApprovalRequests.id, requestIds)),
    db.select().from(oaApprovalNodes).where(inArray(oaApprovalNodes.requestId, requestIds))
      .orderBy(asc(oaApprovalNodes.sequence)),
    db.select().from(oaApprovalRecords).where(inArray(oaApprovalRecords.requestId, requestIds))
      .orderBy(asc(oaApprovalRecords.createdAt)),
    db.select().from(oaApprovalRevisions).where(inArray(oaApprovalRevisions.requestId, requestIds)).orderBy(asc(oaApprovalRevisions.revision)),
  ])
  const nodesByRequest = new Map<string, typeof nodeRows>()
  for (const node of nodeRows) nodesByRequest.set(node.requestId, [...(nodesByRequest.get(node.requestId) ?? []), node])
  const recordsByRequest = new Map<string, typeof recordRows>()
  for (const record of recordRows) recordsByRequest.set(record.requestId, [...(recordsByRequest.get(record.requestId) ?? []), record])
  const planIds = [...new Set(requestRows.map((request) => request.planId).filter((id): id is string => Boolean(id)))]
  const [planRows, planActionRows] = planIds.length ? await Promise.all([
    db.select().from(projectPlans).where(inArray(projectPlans.id, planIds)),
    db.select().from(projectPlanActions).where(inArray(projectPlanActions.planId, planIds)).orderBy(asc(projectPlanActions.sortOrder)),
  ]) : [[], []]
  const planPeopleIds = [...new Set(planActionRows.flatMap((action) => [action.ownerUserId, ...action.participantUserIds]))]
  const planPeople = planPeopleIds.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, planPeopleIds))
    : []
  const planById = new Map(planRows.map((plan) => [plan.id, plan]))
  const planActionsById = new Map<string, typeof planActionRows>()
  for (const action of planActionRows) planActionsById.set(action.planId, [...(planActionsById.get(action.planId) ?? []), action])
  const planPersonName = new Map(planPeople.map((person) => [person.id, person.name]))
  const byId = new Map(requestRows.map((request) => [request.id, request]))
  return requestIds.flatMap((id) => {
    const request = byId.get(id)
    if (!request) return []
    const plan = request.planId ? planById.get(request.planId) : undefined
    const planReview = plan ? {
      revision: plan.revision,
      cycleDays: plan.cycleDays,
      targetDate: plan.targetDate,
      actions: (planActionsById.get(plan.id) ?? []).map((action) => ({
        id: action.id,
        title: action.title,
        owner: planPersonName.get(action.ownerUserId) ?? '待配置',
        participants: [...new Set(action.participantUserIds)]
          .map((participantId) => planPersonName.get(participantId))
          .filter((name): name is string => Boolean(name)),
        dueDate: action.dueDate,
        deliverable: action.deliverable,
        status: action.status,
      })),
    } : undefined
    return [{
      id: request.id,
      requestNo: request.requestNo,
      projectId: request.projectId,
      projectName: request.projectName,
      title: request.title,
      type: request.type,
      businessType: request.businessType,
      taskId: request.taskId,
      businessPayload: request.businessPayload,
      fromStage: request.fromStage,
      targetStage: request.targetStage,
      status: request.status,
      applicant: request.applicantName,
      applicantUserId: request.applicantUserId,
      department: request.department,
      priority: request.priority,
      currentNodeId: request.currentNodeId ?? undefined,
      currentNodeName: request.currentNodeName,
      reason: request.reason,
      amount: request.amount ?? undefined,
      valuation: request.valuation ?? undefined,
      submittedAt: iso(request.submittedAt)!,
      completedAt: iso(request.completedAt),
      attachments: request.attachments,
      checklist: request.checklist,
      materialSnapshot: request.materialSnapshot,
      planId: request.planId ?? undefined,
      planReview,
      revisions: revisionRows.filter((revision) => revision.requestId === id).map((revision) => ({ ...revision, submittedAt: iso(revision.submittedAt)! })),
      lockVersion: request.lockVersion,
      nodes: (nodesByRequest.get(id) ?? []).map((node) => ({
        id: node.id,
        name: node.name,
        approver: node.approverNames.join(' / '),
        approverUserIds: node.approverUserIds,
        approverRole: node.approverRole,
        mode: node.mode,
        sequence: node.sequence,
        status: node.status,
        approvedBy: node.approvedByNames,
        approvedByUserIds: node.approvedByUserIds,
        completedAt: iso(node.completedAt),
        comment: node.comment ?? undefined,
      })),
      records: (recordsByRequest.get(id) ?? []).map((record) => ({
        id: record.id,
        nodeId: record.nodeId,
        nodeName: record.nodeName,
        operator: record.operatorName,
        operatorUserId: record.operatorUserId,
        action: record.action,
        comment: record.comment,
        createdAt: iso(record.createdAt)!,
      })),
    }]
  })
}

export async function listOaApprovalRequests(userId: string) {
  const actor = await activeUser(identityRepositories.users, userId)
  const rows = await db.select({ id: oaApprovalRequests.id }).from(oaApprovalRequests)
    .where(legacyApprovalAccessCondition({ uid: actor.id, name: actor.name, role: actor.role }))
    .orderBy(desc(oaApprovalRequests.submittedAt))
  return await loadPublicRequests(rows.map((row) => row.id))
}

async function requireOaRequestAccess(userId: string, requestId: string) {
  const actor = await activeUser(identityRepositories.users, userId)
  const [request] = await db.select().from(oaApprovalRequests)
    .where(eq(oaApprovalRequests.id, requestId)).limit(1)
  if (!request) throw workflowError(404, 'OA_REQUEST_NOT_FOUND', '审批申请不存在')
  if (request.businessType === 'office' || !request.projectId) throw workflowError(409, 'OA_BUSINESS_ROUTE_REQUIRED', '请使用通用 OA 入口处理此申请')
  if (request.taskId && !await canReadReferencedDirectiveTasks(db, [request.taskId], userId)) throw workflowError(403, 'FDE_DIRECTIVE_FORBIDDEN', '无权读取批示关联审批')
  if (request.applicantUserId === actor.id) return request
  const [assigned] = await db.select({ id: oaApprovalNodes.id }).from(oaApprovalNodes)
    .where(and(
      eq(oaApprovalNodes.requestId, request.id),
      sql<boolean>`JSON_CONTAINS(${oaApprovalNodes.approverUserIds}, JSON_QUOTE(${userId}))`,
    )).limit(1)
  if (assigned) return request
  await requireAccessibleProject(userId, request.projectId)
  return request
}

export async function listOaWorkflowLogs(userId: string) {
  const accessible = await listProjects({ page: 1, pageSize: 100_000 }, userId)
  const projectIds = accessible.list.map((project) => project.id)
  if (!projectIds.length) return []
  const rows = await db.select().from(oaWorkflowLogs)
    .where(inArray(oaWorkflowLogs.projectId, projectIds))
    .orderBy(desc(oaWorkflowLogs.createdAt))
  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    fromStage: row.fromStage,
    toStage: row.toStage,
    operator: row.operatorName,
    comment: row.comment,
    createdAt: iso(row.createdAt)!,
    requestId: row.requestId,
    requestNo: row.requestNo,
    source: row.source,
  }))
}

export async function createOaApprovalRequest(input: {
  userId: string
  projectId: string
  targetStage: ProjectStage
  reason: string
  priority?: '普通' | '紧急'
  amount?: string
  valuation?: string
  attachments?: string[]
}) {
  await requireAccessibleProject(input.userId, input.projectId)
  const requestId = randomUUID()
  try {
    await db.transaction(async (tx) => {
      const identity = createMySqlIdentityRepositoryContext(tx)
      await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${input.projectId} FOR UPDATE`)
      const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId)).limit(1)
      if (!project) throw workflowError(404, 'PROJECT_NOT_FOUND', '项目不存在')
      const actor = await activeUser(identity.users, input.userId)
      const fromStage = project.stage as ProjectStage
      console.error('[OA_DEBUG] fromStage=' + fromStage + ' input.targetStage=' + input.targetStage + ' workflowModel=' + project.workflowModel + ' expectedNext=' + expectedNextStage(fromStage, project.workflowModel))
      const isPlanSubmission = project.workflowModel === 'fde-v1' && fromStage === '尽调计划制定'
      if (project.workflowModel === 'fde-v1' && project.ownerUserId !== actor.id) {
        const [membership] = await tx.select({ userId: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, actor.id))).limit(1)
        if (!isPlanSubmission || !membership) throw workflowError(403, isPlanSubmission ? 'FDE_PROJECT_TEAM_REQUIRED' : 'FDE_OWNER_REQUIRED', isPlanSubmission ? '尽调计划仅限投资项目组成员提交' : 'FDE 阶段申请必须由项目负责人提交')
      }
      if (project.lifecycle !== 'active') throw workflowError(409, 'OA_PROJECT_INACTIVE', '关闭或归档项目不能发起阶段审批')
      if (project.classification === 'pool') throw workflowError(409, 'OA_POOL_INTAKE_REQUIRED', '请先完成项目池入库初筛，再发起阶段审批')
      if (input.targetStage !== '放弃' && input.targetStage !== expectedNextStage(fromStage, project.workflowModel)) {
        throw workflowError(409, 'OA_STAGE_TRANSITION_INVALID', 'OA 只能推进到项目的下一标准阶段')
      }
      const type = approvalType(fromStage, input.targetStage)
      const requestFromStage = isPlanSubmission ? '尽调计划审核' : fromStage
      const targetStage = isPlanSubmission ? '尽调' : input.targetStage
      const fileRows = await tx.select({ name: projectFiles.name }).from(projectFiles).where(and(eq(projectFiles.projectId, project.id), projectFileAccessCondition(actor.id)))
      const actualNames = new Set(fileRows.map((file) => file.name))
      const attachments = [...new Set(input.attachments ?? fileRows.map((file) => file.name))]
      if (attachments.some((name) => !actualNames.has(name))) {
        throw workflowError(409, 'OA_ATTACHMENT_INVALID', '附件必须来自当前项目的真实材料文件')
      }
      const gate = project.workflowModel === 'fde-v1' && input.targetStage !== '放弃'
        ? await evaluateFdeStageGate(tx, project) : undefined
      for (const source of gate?.snapshot ?? []) if (source.fileId) await requireProjectFileAccess(tx, source.fileId, actor.id)
      const checklist = gate?.checklist ?? blueprintByType[type].checklist.map(([label, required]) => ({ label, required, passed: false }))
      const resolvedNodes = project.workflowModel === 'fde-v1'
        ? await resolveFdeApprovalNodes(tx, project, input.targetStage === '放弃' ? '立项' : fromStage, actor.id)
        : await resolveBlueprintNodes(identity.users, type)
      const requestNo = `OA${formatShanghaiDateKey(new Date()).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`
      const submitNodeId = randomUUID()
      const approvalNodes = resolvedNodes.map((node, index) => ({
        id: randomUUID(),
        requestId,
        name: node.name,
        approverRole: node.roleLabel,
        mode: node.mode,
        sequence: index + 2,
        status: index === 0 ? '待审批' : '未开始',
        approverUserIds: node.approverUserIds,
        approverNames: node.approverNames,
        approvedByUserIds: [] as string[],
        approvedByNames: [] as string[],
      }))
      const firstNode = approvalNodes[0]
      const title = `${project.name} ${type}`
      await tx.insert(oaApprovalRequests).values({
        id: requestId,
        requestNo,
        projectId: project.id,
        projectName: project.name,
        title,
        type,
        fromStage: requestFromStage,
        targetStage,
        status: '审批中',
        applicantUserId: actor.id,
        applicantName: actor.name,
        department: actor.department,
        priority: input.priority ?? '普通',
        activeKey: project.id,
        currentNodeId: firstNode.id,
        currentNodeName: firstNode.name,
        reason: input.reason,
        amount: input.amount ?? project.financing,
        valuation: input.valuation ?? project.valuation,
        attachments,
        checklist,
        materialSnapshot: gate?.snapshot ?? [],
        planId: gate?.planId ?? null,
      })
      await tx.insert(oaApprovalNodes).values([{
        id: submitNodeId,
        requestId,
        name: '发起人提交',
        approverRole: '发起人',
        mode: '或签',
        sequence: 1,
        status: '已通过',
        approverUserIds: [actor.id],
        approverNames: [actor.name],
        approvedByUserIds: [actor.id],
        approvedByNames: [actor.name],
        completedAt: new Date(),
        comment: input.reason,
      }, ...approvalNodes])
      await tx.insert(oaApprovalRevisions).values({ requestId, revision: 1, submittedBy: actor.id, snapshot: {
        fromStage: requestFromStage, targetStage, reason: input.reason, attachments, checklist,
        materialSnapshot: gate?.snapshot ?? [], planId: gate?.planId ?? null,
        approverSnapshot: approvalNodes.map((node) => ({ name: node.name, role: node.approverRole, mode: node.mode, userIds: node.approverUserIds, names: node.approverNames })),
      } })
      await tx.insert(oaApprovalRecords).values({
        requestId,
        nodeId: submitNodeId,
        nodeName: '发起人提交',
        operatorUserId: actor.id,
        operatorName: actor.name,
        action: '提交',
        comment: input.reason,
      })
      await tx.update(projects).set({
        latestApprovalId: requestId,
        ...(isPlanSubmission ? { stage: '尽调计划审核', progress: 22, stageSource: '计划提交' } : {}),
        version: sql`${projects.version} + 1`,
        updatedAt: new Date(),
      })
        .where(eq(projects.id, project.id))
      if (isPlanSubmission && gate?.planId) await tx.update(projectPlans).set({ status: 'review', updatedAt: new Date() }).where(eq(projectPlans.id, gate.planId))
      if (isPlanSubmission) {
        const { reconcileTimelineEvent } = await import('./fdeTimelineTaskService.js')
        await reconcileTimelineEvent(tx, project.id, actor.id, { source: 'stage', sourceKey: `stage:${requestId}:submit`, approvalId: requestId })
      }
      await createNodeTodos(tx, {
        requestId,
        requestTitle: title,
        projectId: project.id,
        projectName: project.name,
        node: firstNode as typeof oaApprovalNodes.$inferSelect,
        createdBy: actor.id,
        priority: input.priority ?? '普通',
      })
      await identity.audits.append({
        userId: actor.id,
        userName: actor.name,
        module: 'OA 流程',
        action: '发起审批',
        target: `${requestNo} · ${title}`,
      })
    })
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw workflowError(409, 'OA_ACTIVE_REQUEST_EXISTS', '该项目已有审批中的 OA，不能重复发起')
    }
    throw error
  }
  return (await loadPublicRequests([requestId]))[0]
}

async function finishOpenTodos(tx: OaTransaction, requestId: string) {
  await tx.update(todos).set({ status: '已完成', version: sql`${todos.version} + 1` })
    .where(and(eq(todos.approvalRequestId, requestId), ne(todos.status, '已完成')))
}

export async function actOnOaApprovalRequest(input: {
  userId: string
  requestId: string
  action: ApprovalAction
  comment: string
  expectedVersion?: number
}) {
  const initialRequest = await requireOaRequestAccess(input.userId, input.requestId)
  if (['agent_schedule', 'project_replan'].includes(initialRequest.businessType)) throw workflowError(409, 'OA_BUSINESS_ROUTE_REQUIRED', '节点改期或整体重排必须使用对应独立审批入口，不能推进项目阶段或转交')
  if (initialRequest.businessType === 'task_extension') {
    await actOnFdeTaskExtension(input)
    return { request: (await loadPublicRequests([input.requestId]))[0], project: undefined }
  }
  let changedProjectId: string | undefined
  try {
    await db.transaction(async (tx) => {
      const identity = createMySqlIdentityRepositoryContext(tx)
      // 所有项目写操作统一先锁项目，再锁请求/任务，避免延期与阶段终态相互死锁。
      await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${initialRequest.projectId} FOR UPDATE`)
      await tx.execute(sql`SELECT ${oaApprovalRequests.id} FROM ${oaApprovalRequests} WHERE ${oaApprovalRequests.id}=${input.requestId} FOR UPDATE`)
      const [request] = await tx.select().from(oaApprovalRequests)
        .where(eq(oaApprovalRequests.id, input.requestId)).limit(1)
      if (!request) throw workflowError(404, 'OA_REQUEST_NOT_FOUND', '审批申请不存在')
      if (!request.projectId || request.businessType === 'office') throw workflowError(409, 'OA_BUSINESS_ROUTE_REQUIRED', '此入口仅处理项目审批')
      await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${request.projectId} FOR UPDATE`)
      const [project] = await tx.select().from(projects).where(eq(projects.id, request.projectId)).limit(1)
      if (!project) throw workflowError(409, 'OA_PROJECT_MISSING', '审批关联项目不存在')
      if ((project.workflowModel === 'fde-v1' || input.expectedVersion !== undefined) && input.expectedVersion !== request.lockVersion) {
        throw workflowError(409, 'OA_VERSION_CONFLICT', '审批已被处理或版本已变化，请刷新后重试')
      }
      const actor = await activeUser(identity.users, input.userId)
      const isAdmin = actor.role === '系统管理员' && project.workflowModel !== 'fde-v1'
      const nodes = await tx.select().from(oaApprovalNodes)
        .where(eq(oaApprovalNodes.requestId, request.id)).orderBy(asc(oaApprovalNodes.sequence))
      const submitNode = nodes[0]
      const currentNode = nodes.find((node) => node.id === request.currentNodeId)
      const now = new Date()
      const isPlanReview = project.workflowModel === 'fde-v1' && request.type === '尽调计划审核'

      if (input.action === 'resubmit') {
        if (request.status !== '已退回') throw workflowError(409, 'OA_RESUBMIT_INVALID', '只有已退回申请可以重新提交')
        if (!isAdmin && request.applicantUserId !== actor.id) throw workflowError(403, 'OA_ACTION_FORBIDDEN', '只有发起人可以重新提交')
        const firstApprovalNode = nodes[1]
        if (!submitNode || !firstApprovalNode) throw workflowError(409, 'OA_NODES_INVALID', '审批节点配置不完整')
        if (project.stage !== (isPlanReview ? '尽调计划制定' : request.fromStage) || project.lifecycle !== 'active') throw workflowError(409, 'OA_PROJECT_STATE_CHANGED', '项目状态已变化，不能重提旧申请')
        const gate = project.workflowModel === 'fde-v1' && request.targetStage !== '放弃'
          ? await evaluateFdeStageGate(tx, project) : undefined
        for (const source of gate?.snapshot ?? []) if (source.fileId) await requireProjectFileAccess(tx, source.fileId, actor.id)
        const [previousRevision] = await tx.select().from(oaApprovalRevisions).where(eq(oaApprovalRevisions.requestId, request.id)).orderBy(desc(oaApprovalRevisions.revision)).limit(1)
        await tx.insert(oaApprovalRevisions).values({ requestId: request.id, revision: (previousRevision?.revision ?? 0) + 1, submittedBy: actor.id, snapshot: {
          fromStage: request.fromStage, targetStage: request.targetStage, reason: input.comment,
          attachments: request.attachments, checklist: gate?.checklist ?? request.checklist,
          materialSnapshot: gate?.snapshot ?? request.materialSnapshot, planId: gate?.planId ?? request.planId,
          approverSnapshot: nodes.slice(1).map((node) => ({ name: node.name, role: node.approverRole, mode: node.mode, userIds: node.approverUserIds, names: node.approverNames })),
        } })
        await tx.update(oaApprovalNodes).set({
          status: '未开始', approvedByUserIds: [], approvedByNames: [], completedAt: null, comment: null, updatedAt: now,
        }).where(and(eq(oaApprovalNodes.requestId, request.id), ne(oaApprovalNodes.id, submitNode.id)))
        await tx.update(oaApprovalNodes).set({
          status: '已通过', approvedByUserIds: [actor.id], approvedByNames: [actor.name],
          completedAt: now, comment: input.comment, updatedAt: now,
        }).where(eq(oaApprovalNodes.id, submitNode.id))
        await tx.update(oaApprovalNodes).set({ status: '待审批', updatedAt: now })
          .where(eq(oaApprovalNodes.id, firstApprovalNode.id))
        await tx.update(oaApprovalRequests).set({
          status: '审批中', activeKey: request.projectId, currentNodeId: firstApprovalNode.id,
          currentNodeName: firstApprovalNode.name, reason: input.comment, submittedAt: now,
          completedAt: null, lockVersion: request.lockVersion + 1, updatedAt: now,
          ...(gate ? { checklist: gate.checklist, materialSnapshot: gate.snapshot, planId: gate.planId ?? null } : {}),
        }).where(eq(oaApprovalRequests.id, request.id))
        await finishOpenTodos(tx, request.id)
        await createNodeTodos(tx, {
          requestId: request.id, requestTitle: request.title, projectId: request.projectId,
          projectName: request.projectName, node: firstApprovalNode, createdBy: actor.id, priority: request.priority,
        })
        await tx.insert(oaApprovalRecords).values({
          requestId: request.id, nodeId: submitNode.id, nodeName: '退回后重新提交',
          operatorUserId: actor.id, operatorName: actor.name, action: '提交', comment: input.comment,
        })
        await tx.update(projects).set({
          latestApprovalId: request.id,
          ...(isPlanReview ? { stage: '尽调计划审核', progress: 22, stageSource: '计划提交' } : {}),
          version: sql`${projects.version} + 1`,
          updatedAt: now,
        }).where(eq(projects.id, request.projectId))
        if (isPlanReview && gate?.planId) {
          await tx.update(projectPlans).set({ status: 'review', updatedAt: now }).where(eq(projectPlans.id, gate.planId))
          changedProjectId = project.id
          const { reconcileTimelineEvent } = await import('./fdeTimelineTaskService.js')
          await reconcileTimelineEvent(tx, project.id, actor.id, { source: 'stage', sourceKey: `stage:${request.id}:${request.lockVersion + 1}`, approvalId: request.id })
        }
      } else {
        if (request.status !== '审批中' || !currentNode) throw workflowError(409, 'OA_ACTION_INVALID', '当前申请不在可审批状态')
        const isCurrentApprover = currentNode.approverUserIds.includes(actor.id)
        if (input.action === 'withdraw') {
          if (!isAdmin && request.applicantUserId !== actor.id) throw workflowError(403, 'OA_ACTION_FORBIDDEN', '只有发起人可以撤回')
        } else if (request.applicantUserId === actor.id) {
          throw workflowError(403, 'OA_SELF_APPROVAL_FORBIDDEN', '申请人不能审批自己的申请')
        } else if (!isAdmin && !isCurrentApprover) {
          throw workflowError(403, 'OA_ACTION_FORBIDDEN', '当前节点不属于该用户')
        }

        const actionLabel = input.action === 'approve' ? '同意'
          : input.action === 'return' ? '退回'
            : input.action === 'reject' ? '拒绝' : '撤回'
        if (project.workflowModel === 'fde-v1' && input.action !== 'withdraw') {
          for (const source of request.materialSnapshot) if (source.fileId) await requireProjectFileAccess(tx, source.fileId, actor.id)
        }
        if (input.action === 'approve') {
          if (!isAdmin && currentNode.approvedByUserIds.includes(actor.id)) {
            throw workflowError(409, 'OA_ALREADY_APPROVED', '当前用户已提交过该会签节点')
          }
          const transition = approveNodeTransition({ ...currentNode, actorId: actor.id, override: isAdmin })
          const approvedIds = transition.approvedIds
          const approvedNames = [...new Set([...currentNode.approvedByNames, actor.name])]
          const nodeCompleted = transition.completed
          const currentIndex = nodes.findIndex((node) => node.id === currentNode.id)
          const nextNode = nodeCompleted ? nodes[currentIndex + 1] : undefined
          const requestCompleted = nodeCompleted && !nextNode
          if (project.stage !== request.fromStage || project.lifecycle !== 'active') {
            throw workflowError(409, 'OA_PROJECT_STATE_CHANGED', '项目状态已变化，当前审批不能继续推进')
          }
          if (project.workflowModel === 'fde-v1' && request.targetStage !== '放弃') {
            const gate = await evaluateFdeStageGate(tx, project)
            if (materialSnapshotIdentity(gate.snapshot) !== materialSnapshotIdentity(request.materialSnapshot) || (gate.planId ?? null) !== request.planId) {
              throw workflowError(409, 'OA_MATERIAL_SNAPSHOT_CHANGED', '送审材料或计划版本已变化，请退回发起人修订后重提')
            }
          }
          await tx.update(oaApprovalNodes).set({
            approvedByUserIds: approvedIds,
            approvedByNames: approvedNames,
            status: nodeCompleted ? '已通过' : '会签中',
            completedAt: nodeCompleted ? now : null,
            comment: input.comment,
            updatedAt: now,
          }).where(eq(oaApprovalNodes.id, currentNode.id))
          if (nextNode) {
            await tx.update(oaApprovalNodes).set({ status: '待审批', updatedAt: now })
              .where(eq(oaApprovalNodes.id, nextNode.id))
          }
          await finishOpenTodos(tx, request.id)
          if (nodeCompleted && nextNode) {
            await createNodeTodos(tx, {
              requestId: request.id, requestTitle: request.title, projectId: request.projectId,
              projectName: request.projectName, node: nextNode, createdBy: actor.id, priority: request.priority,
            })
          } else if (!nodeCompleted) {
            const remainingIds = currentNode.approverUserIds.filter((id) => !approvedIds.includes(id))
            const remainingNames = currentNode.approverNames.filter((_, index) => remainingIds.includes(currentNode.approverUserIds[index]))
            await createNodeTodos(tx, {
              requestId: request.id, requestTitle: request.title, projectId: request.projectId,
              projectName: request.projectName,
              node: { ...currentNode, approverUserIds: remainingIds, approverNames: remainingNames },
              createdBy: actor.id, priority: request.priority,
            })
          }
          await tx.update(oaApprovalRequests).set({
            status: requestCompleted ? '已通过' : '审批中',
            activeKey: requestCompleted ? null : request.projectId,
            currentNodeId: requestCompleted ? null : (nodeCompleted ? nextNode!.id : currentNode.id),
            currentNodeName: requestCompleted ? '流程完成' : (nodeCompleted ? nextNode!.name : `${currentNode.name}（会签中）`),
            completedAt: requestCompleted ? now : null,
            lockVersion: request.lockVersion + 1,
            updatedAt: now,
          }).where(eq(oaApprovalRequests.id, request.id))
          if (requestCompleted) {
            if (project.workflowModel === 'fde-v1' && request.targetStage === '尽调') await lockApprovedFdePlan(tx, project.id)
            const progress = progressForStage(request.targetStage as ProjectStage, project.progress, project.workflowModel)
            const isClosed = request.targetStage === '已 Close'
            await tx.update(projects).set({
              stage: request.targetStage,
              stageSource: 'OA审批',
              latestApprovalId: request.id,
              progress,
              lifecycle: isClosed ? 'closed' : project.lifecycle,
              version: sql`${projects.version} + 1`,
              updatedAt: now,
            }).where(eq(projects.id, project.id))
            if (isClosed) {
              const taskRows = await tx.select({ id: todos.id }).from(todos).where(eq(todos.projectId, project.id))
              await closeTaskExtensions(tx, taskRows.map((task) => task.id), actor.id, '项目 Close，未决延期关闭')
              await tx.update(todos).set({ status: '已关闭', closureReason: '项目 Close；未伪造成果验收通过', version: sql`${todos.version} + 1` })
                .where(and(eq(todos.projectId, project.id), ne(todos.status, '已完成'), ne(todos.status, '已取消'), ne(todos.status, '已归档'), ne(todos.status, '已关闭')))
              await closeProjectDirectiveSchedules(tx, project.id, actor.id, '项目 Close，未确认批示排期关闭，保留任务成果')
            }
            await tx.insert(oaWorkflowLogs).values({
              projectId: project.id,
              requestId: request.id,
              requestNo: request.requestNo,
              fromStage: request.fromStage,
              toStage: request.targetStage,
              operatorUserId: actor.id,
              operatorName: actor.name,
              comment: `${request.requestNo} 全部审批节点通过：${input.comment}`,
              source: 'OA审批',
            })
            changedProjectId = project.id
          }
        } else {
          const terminalStatus = input.action === 'return' ? '已退回'
            : input.action === 'reject' ? '已拒绝' : '已撤回'
          const nodeStatus = input.action === 'return' ? '已退回'
            : input.action === 'reject' ? '已拒绝' : currentNode.status
          if (input.action !== 'withdraw') {
            await tx.update(oaApprovalNodes).set({
              status: nodeStatus, completedAt: now, comment: input.comment, updatedAt: now,
            }).where(eq(oaApprovalNodes.id, currentNode.id))
          }
          await tx.update(oaApprovalRequests).set({
            status: terminalStatus,
            activeKey: null,
            currentNodeId: null,
            currentNodeName: input.action === 'return' ? '已退回发起人'
              : input.action === 'reject' ? '流程已拒绝' : '发起人已撤回',
            completedAt: now,
            lockVersion: request.lockVersion + 1,
            updatedAt: now,
          }).where(eq(oaApprovalRequests.id, request.id))
          await finishOpenTodos(tx, request.id)
          if (isPlanReview) {
            await tx.update(projects).set({ stage: '尽调计划制定', progress: 18, version: sql`${projects.version} + 1`, updatedAt: now }).where(eq(projects.id, project.id))
            if (request.planId) await tx.update(projectPlans).set({ status: 'draft', updatedAt: now }).where(eq(projectPlans.id, request.planId))
            changedProjectId = project.id
          }
        }
        await tx.insert(oaApprovalRecords).values({
          requestId: request.id,
          nodeId: currentNode.id,
          nodeName: input.action === 'withdraw' ? '发起人撤回' : currentNode.name,
          operatorUserId: actor.id,
          operatorName: actor.name,
          action: actionLabel,
          comment: input.comment,
        })
        if (isPlanReview) await appendPlanReviewRecord(tx, request.id, actor.id, input.action, input.comment)
        if (changedProjectId === project.id) {
          const { reconcileTimelineEvent } = await import('./fdeTimelineTaskService.js')
          await reconcileTimelineEvent(tx, project.id, actor.id, { source: 'stage', sourceKey: `stage:${request.id}:${request.lockVersion + 1}`, approvalId: request.id })
        }
      }
      await identity.audits.append({
        userId: actor.id,
        userName: actor.name,
        module: 'OA 流程',
        action: input.action === 'approve' ? '审批同意'
          : input.action === 'return' ? '退回申请'
            : input.action === 'reject' ? '拒绝申请'
              : input.action === 'withdraw' ? '撤回申请' : '重新提交',
        target: `${request.requestNo} · ${input.comment}`,
      })
    })
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw workflowError(409, 'OA_ACTIVE_REQUEST_EXISTS', '该项目已有审批中的 OA，不能重新提交')
    }
    throw error
  }
  const request = (await loadPublicRequests([input.requestId]))[0]
  const project = changedProjectId
    ? (await db.select().from(projects).where(eq(projects.id, changedProjectId)).limit(1))[0]
    : undefined
  return { request, project }
}
