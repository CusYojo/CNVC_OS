import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  oaApprovalNodes,
  oaApprovalRecords,
  oaApprovalRequests,
  oaWorkflowLogs,
  projects,
  todos,
} from '../db/schema.js'
import type { UserRepository } from '../repositories/identityRepository.js'
import { createMySqlIdentityRepositoryContext, identityRepositories } from '../repositories/index.js'
import { requireAccessibleProject } from './projectAccessService.js'
import { listProjects } from './projectService.js'
import { formatShanghaiDateKey } from '../utils/shanghaiTime.js'

const projectStages = ['线索', '初筛', '立项', '尽调', '上会', '投决', '投后', '退出'] as const
type ProjectStage = typeof projectStages[number] | '放弃'
type ApprovalType = '初筛审批' | '立项审批' | '尽调启动审批' | '上会申请' | '投决审批' | '投后移交审批' | '项目终止审批'
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
  尽调启动审批: {
    nodes: [
      { name: '投资总监审批', roleLabel: '投资总监', roles: ['投资总监'], mode: '或签' },
      { name: '财务与法务排期', roleLabel: '财务/风控与法务', roles: ['财务', '风控与法务', '风控法务'], mode: '会签' },
    ],
    checklist: [['立项审批已通过', true], ['尽调清单与分工已确认', true], ['数据室权限已开通', true]],
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
  if (fromStage === '线索' && targetStage === '初筛') return '初筛审批'
  if (fromStage === '初筛' && targetStage === '立项') return '立项审批'
  if (fromStage === '立项' && targetStage === '尽调') return '尽调启动审批'
  if (fromStage === '尽调' && targetStage === '上会') return '上会申请'
  if (fromStage === '上会' && targetStage === '投决') return '投决审批'
  if (fromStage === '投决' && targetStage === '投后') return '投后移交审批'
  throw workflowError(409, 'OA_STAGE_TRANSITION_INVALID', `不能从“${fromStage}”直接推进到“${targetStage}”`)
}

function expectedNextStage(stage: ProjectStage): ProjectStage | undefined {
  const index = projectStages.indexOf(stage as typeof projectStages[number])
  return index >= 0 ? projectStages[index + 1] : undefined
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : undefined
}

async function activeUser(userRepository: UserRepository, userId: string) {
  const user = await userRepository.findById(userId)
  if (!user || user.status !== '启用') throw workflowError(401, 'AUTH_INVALID', '当前用户不存在或已禁用')
  return user
}

async function resolveBlueprintNodes(userRepository: UserRepository, type: ApprovalType) {
  const resolved = [] as Array<NodeBlueprint & { approverUserIds: string[]; approverNames: string[] }>
  for (const node of blueprintByType[type].nodes) {
    const rows = await userRepository.findEnabledByRoles(node.roles)
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
  const [requestRows, nodeRows, recordRows] = await Promise.all([
    db.select().from(oaApprovalRequests).where(inArray(oaApprovalRequests.id, requestIds)),
    db.select().from(oaApprovalNodes).where(inArray(oaApprovalNodes.requestId, requestIds))
      .orderBy(asc(oaApprovalNodes.sequence)),
    db.select().from(oaApprovalRecords).where(inArray(oaApprovalRecords.requestId, requestIds))
      .orderBy(asc(oaApprovalRecords.createdAt)),
  ])
  const nodesByRequest = new Map<string, typeof nodeRows>()
  for (const node of nodeRows) nodesByRequest.set(node.requestId, [...(nodesByRequest.get(node.requestId) ?? []), node])
  const recordsByRequest = new Map<string, typeof recordRows>()
  for (const record of recordRows) recordsByRequest.set(record.requestId, [...(recordsByRequest.get(record.requestId) ?? []), record])
  const byId = new Map(requestRows.map((request) => [request.id, request]))
  return requestIds.flatMap((id) => {
    const request = byId.get(id)
    if (!request) return []
    return [{
      id: request.id,
      requestNo: request.requestNo,
      projectId: request.projectId,
      projectName: request.projectName,
      title: request.title,
      type: request.type,
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
  if (actor.role === '系统管理员') {
    const rows = await db.select({ id: oaApprovalRequests.id }).from(oaApprovalRequests)
      .orderBy(desc(oaApprovalRequests.submittedAt))
    return await loadPublicRequests(rows.map((row) => row.id))
  }
  const accessible = await listProjects({ page: 1, pageSize: 100_000 }, userId)
  const projectIds = accessible.list.map((project) => project.id)
  const assigned = await db.select({ requestId: oaApprovalNodes.requestId }).from(oaApprovalNodes)
    .where(sql<boolean>`JSON_CONTAINS(${oaApprovalNodes.approverUserIds}, JSON_QUOTE(${userId}))`)
  const assignedIds = [...new Set(assigned.map((row) => row.requestId))]
  const scopes = [eq(oaApprovalRequests.applicantUserId, userId)]
  if (projectIds.length) scopes.push(inArray(oaApprovalRequests.projectId, projectIds))
  if (assignedIds.length) scopes.push(inArray(oaApprovalRequests.id, assignedIds))
  const rows = await db.select({ id: oaApprovalRequests.id }).from(oaApprovalRequests)
    .where(or(...scopes))
    .orderBy(desc(oaApprovalRequests.submittedAt))
  return await loadPublicRequests(rows.map((row) => row.id))
}

async function requireOaRequestAccess(userId: string, requestId: string) {
  const actor = await activeUser(identityRepositories.users, userId)
  const [request] = await db.select().from(oaApprovalRequests)
    .where(eq(oaApprovalRequests.id, requestId)).limit(1)
  if (!request) throw workflowError(404, 'OA_REQUEST_NOT_FOUND', '审批申请不存在')
  if (actor.role === '系统管理员' || request.applicantUserId === actor.id) return request
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
      if (input.targetStage !== '放弃' && input.targetStage !== expectedNextStage(fromStage)) {
        throw workflowError(409, 'OA_STAGE_TRANSITION_INVALID', 'OA 只能推进到项目的下一标准阶段')
      }
      const type = approvalType(fromStage, input.targetStage)
      const resolvedNodes = await resolveBlueprintNodes(identity.users, type)
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
        fromStage,
        targetStage: input.targetStage,
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
        attachments: input.attachments ?? [],
        checklist: blueprintByType[type].checklist.map(([label, required]) => ({ label, required, passed: required })),
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
        version: sql`${projects.version} + 1`,
        updatedAt: new Date(),
      })
        .where(eq(projects.id, project.id))
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
}) {
  await requireOaRequestAccess(input.userId, input.requestId)
  let changedProjectId: string | undefined
  try {
    await db.transaction(async (tx) => {
      const identity = createMySqlIdentityRepositoryContext(tx)
      await tx.execute(sql`SELECT ${oaApprovalRequests.id} FROM ${oaApprovalRequests} WHERE ${oaApprovalRequests.id}=${input.requestId} FOR UPDATE`)
      const [request] = await tx.select().from(oaApprovalRequests)
        .where(eq(oaApprovalRequests.id, input.requestId)).limit(1)
      if (!request) throw workflowError(404, 'OA_REQUEST_NOT_FOUND', '审批申请不存在')
      await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${request.projectId} FOR UPDATE`)
      const [project] = await tx.select().from(projects).where(eq(projects.id, request.projectId)).limit(1)
      if (!project) throw workflowError(409, 'OA_PROJECT_MISSING', '审批关联项目不存在')
      const actor = await activeUser(identity.users, input.userId)
      const isAdmin = actor.role === '系统管理员'
      const nodes = await tx.select().from(oaApprovalNodes)
        .where(eq(oaApprovalNodes.requestId, request.id)).orderBy(asc(oaApprovalNodes.sequence))
      const submitNode = nodes[0]
      const currentNode = nodes.find((node) => node.id === request.currentNodeId)
      const now = new Date()

      if (input.action === 'resubmit') {
        if (request.status !== '已退回') throw workflowError(409, 'OA_RESUBMIT_INVALID', '只有已退回申请可以重新提交')
        if (!isAdmin && request.applicantUserId !== actor.id) throw workflowError(403, 'OA_ACTION_FORBIDDEN', '只有发起人可以重新提交')
        const firstApprovalNode = nodes[1]
        if (!submitNode || !firstApprovalNode) throw workflowError(409, 'OA_NODES_INVALID', '审批节点配置不完整')
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
          version: sql`${projects.version} + 1`,
          updatedAt: now,
        }).where(eq(projects.id, request.projectId))
      } else {
        if (request.status !== '审批中' || !currentNode) throw workflowError(409, 'OA_ACTION_INVALID', '当前申请不在可审批状态')
        const isCurrentApprover = currentNode.approverUserIds.includes(actor.id)
        if (input.action === 'withdraw') {
          if (!isAdmin && request.applicantUserId !== actor.id) throw workflowError(403, 'OA_ACTION_FORBIDDEN', '只有发起人可以撤回')
        } else if (!isAdmin && !isCurrentApprover) {
          throw workflowError(403, 'OA_ACTION_FORBIDDEN', '当前节点不属于该用户')
        }

        const actionLabel = input.action === 'approve' ? '同意'
          : input.action === 'return' ? '退回'
            : input.action === 'reject' ? '拒绝' : '撤回'
        if (input.action === 'approve') {
          if (!isAdmin && currentNode.approvedByUserIds.includes(actor.id)) {
            throw workflowError(409, 'OA_ALREADY_APPROVED', '当前用户已提交过该会签节点')
          }
          const approvedIds = [...new Set([...currentNode.approvedByUserIds, actor.id])]
          const approvedNames = [...new Set([...currentNode.approvedByNames, actor.name])]
          const nodeCompleted = isAdmin || currentNode.mode === '或签'
            || currentNode.approverUserIds.every((id) => approvedIds.includes(id))
          const currentIndex = nodes.findIndex((node) => node.id === currentNode.id)
          const nextNode = nodeCompleted ? nodes[currentIndex + 1] : undefined
          const requestCompleted = nodeCompleted && !nextNode
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
            const stageIndex = projectStages.indexOf(request.targetStage as typeof projectStages[number])
            const progress = request.targetStage === '放弃' ? project.progress : Math.min(100, (stageIndex + 1) * 13)
            await tx.update(projects).set({
              stage: request.targetStage,
              stageSource: 'OA审批',
              latestApprovalId: request.id,
              progress,
              version: sql`${projects.version} + 1`,
              updatedAt: now,
            }).where(eq(projects.id, project.id))
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
