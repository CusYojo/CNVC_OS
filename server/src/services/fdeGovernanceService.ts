import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projectDutyAssignments, projectGovernanceChanges, projectMembers, projects, roles, userRoles, users } from '../db/schema.js'
import { FDE_LEADERSHIP_DUTIES, FDE_PROJECT_DUTIES, type FdeApprovalDuty, type FdeDutyAssignment, type FdeProjectDuty } from '../contracts/fdeGovernanceContract.js'
import { createMySqlIdentityRepositoryContext, identityRepositories } from '../repositories/index.js'
import { requireAccessibleProject } from './projectAccessService.js'
import { getProjectWorkflowPolicy } from './fdeWorkflowPolicyService.js'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>
type ProjectRow = typeof projects.$inferSelect
export type FdeCreationPerson = {
  id: string
  name: string
  department: string
  role: string
  roleCodes: string[]
  categories: string[]
  capabilities: {
    canOwn: boolean
    canBoss: boolean
    canProjectManager: boolean
    canLegal: boolean
    canFinance: boolean
  }
}
type Person = Omit<FdeCreationPerson, 'capabilities'>
export type FdeCreationDuty = 'boss' | 'project_manager' | 'legal' | 'finance'
export type FdeCreationAssignment = { duty: FdeCreationDuty; userId: string }
const failure = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code })
const assignmentKey = (item: { duty: string; userId: string }) => `${item.duty}:${item.userId}`

async function enabledPeople(reader: Reader): Promise<Person[]> {
  const rows = await reader.select({ id: users.id, name: users.name, department: users.department, role: users.role, roleCode: roles.code, category: roles.fdeCategory }).from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id)).innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(users.status, '启用'), eq(roles.status, '启用'))).orderBy(asc(users.name))
  const people = new Map<string, Person>()
  for (const row of rows) {
    const person = people.get(row.id) ?? { id: row.id, name: row.name, department: row.department, role: row.role, roleCodes: [], categories: [] }
    person.roleCodes.push(row.roleCode)
    if (row.category && !person.categories.includes(row.category)) person.categories.push(row.category)
    people.set(row.id, person)
  }
  return [...people.values()]
}

function creationPerson(person: Person): FdeCreationPerson {
  const businessCategories = ['institution_leader', 'project_lead', 'member']
  return {
    ...person,
    capabilities: {
      canOwn: person.categories.some((category) => businessCategories.includes(category)),
      canBoss: person.roleCodes.some((code) => ['FDE_CHAIRMAN', 'FDE_PRESIDENT'].includes(code)),
      canProjectManager: person.categories.some((category) => ['institution_leader', 'secretary', 'project_lead', 'member'].includes(category)),
      canLegal: person.roleCodes.includes('FDE_LEGAL') || /法务/.test(person.role),
      // 当前组织没有单独的财务角色编码，专业岗均可承担财务复核；新增专岗后会自动进入候选列表。
      canFinance: person.categories.includes('specialist'),
    },
  }
}

export async function getFdeProjectCreationRoster(userId: string) {
  const actor = await identityRepositories.users.findById(userId)
  if (!actor || actor.status !== '启用') throw failure(403, 'USER_DISABLED_OR_MISSING', '当前账号不可创建项目')
  const people = (await enabledPeople(db))
    .filter((person) => person.categories.some((category) => category !== 'system_admin'))
    .map(creationPerson)
  return { people }
}

export async function prepareFdeCreationGovernance(reader: Reader, input: { ownerUserId: string; assignments: FdeCreationAssignment[] }) {
  const people = await enabledPeople(reader)
  const byId = new Map(people.map((person) => [person.id, creationPerson(person)]))
  const normalized = new Map<string, FdeDutyAssignment>()
  const selected = (duty: FdeCreationDuty) => input.assignments.filter((item) => item.duty === duty)
  const requireDuty = (duty: FdeCreationDuty, label: string) => {
    if (!selected(duty).length) throw failure(400, 'FDE_CREATION_DUTY_REQUIRED', `快速新建项目必须至少配置 1 位${label}`)
  }
  requireDuty('boss', '老板（陈斌或黄昕）')
  requireDuty('project_manager', '项目经理')
  requireDuty('legal', '法务')
  requireDuty('finance', '财务')
  const owner = byId.get(input.ownerUserId)
  if (!owner?.capabilities.canOwn) throw failure(400, 'FDE_OWNER_INVALID', '项目负责人必须是启用的业务人员')
  for (const assignment of input.assignments) {
    const person = byId.get(assignment.userId)
    if (!person) throw failure(400, 'FDE_DUTY_PERSON_INVALID', '职责人员不存在或已禁用')
    if (assignment.duty === 'boss' && !person.capabilities.canBoss) throw failure(400, 'FDE_BOSS_INVALID', '老板只能选择陈斌或黄昕对应的启用账号')
    if (assignment.duty === 'project_manager' && !person.capabilities.canProjectManager) throw failure(400, 'FDE_PROJECT_MANAGER_INVALID', '项目经理必须是启用的项目业务人员')
    if (assignment.duty === 'legal' && !person.capabilities.canLegal) throw failure(400, 'FDE_LEGAL_INVALID', '法务必须选择具备法务岗位的启用账号')
    if (assignment.duty === 'finance' && !person.capabilities.canFinance) throw failure(400, 'FDE_FINANCE_INVALID', '财务必须选择具备专业复核岗位的启用账号')
    if (assignment.duty === 'legal' || assignment.duty === 'finance') {
      const persistent: FdeDutyAssignment = { duty: assignment.duty, userId: assignment.userId }
      normalized.set(assignmentKey(persistent), persistent)
    }
  }
  // 快速创建时同步补齐现有审批策略依赖的职责，避免进入下一阶段后因缺岗中断。
  for (const boss of selected('boss')) {
    normalized.set(assignmentKey({ duty: 'concerned_leader', userId: boss.userId }), { duty: 'concerned_leader', userId: boss.userId })
    const person = byId.get(boss.userId)!
    if (person.roleCodes.includes('FDE_CHAIRMAN')) normalized.set(assignmentKey({ duty: 'chairman', userId: boss.userId }), { duty: 'chairman', userId: boss.userId })
    if (person.roleCodes.includes('FDE_PRESIDENT')) normalized.set(assignmentKey({ duty: 'president', userId: boss.userId }), { duty: 'president', userId: boss.userId })
  }
  for (const manager of selected('project_manager')) normalized.set(assignmentKey({ duty: 'secretary', userId: manager.userId }), { duty: 'secretary', userId: manager.userId })
  const assignments = [...normalized.values()]
  // 用户显式选的职责必须严格校验类别；系统自动补齐的职责（concerned_leader/chairman/president/secretary）
  // 用于下游审批策略依赖，不强制要求 eligible 类别，只校验人员存在且启用。
  const explicitDuties = new Set<FdeProjectDuty>(input.assignments.flatMap((assignment): FdeProjectDuty[] =>
    assignment.duty === 'legal' || assignment.duty === 'finance' ? [assignment.duty] : []))
  const explicitAssignments = assignments.filter((a) => explicitDuties.has(a.duty))
  const autoAssignments = assignments.filter((a) => !explicitDuties.has(a.duty))
  validateAssignments(input.ownerUserId, explicitAssignments, people)
  for (const assignment of autoAssignments) {
    if (!byId.get(assignment.userId)) throw failure(400, 'FDE_DUTY_PERSON_INVALID', `自动补配的职责人员不存在或已禁用：${assignment.duty}`)
  }
  return { owner: byId.get(input.ownerUserId)!, assignments, people: [...byId.values()] }
}

async function canManage(project: ProjectRow, userId: string, tx?: Transaction) {
  if (project.ownerUserId === userId) return true
  const repository = tx ? createMySqlIdentityRepositoryContext(tx).users : identityRepositories.users
  return (await repository.listPermissionCodes(userId)).includes('fde.governance.manage')
}

function validateAssignments(ownerId: string, assignments: FdeDutyAssignment[], people: Person[]) {
  const byId = new Map(people.map((person) => [person.id, person]))
  const owner = byId.get(ownerId)
  if (!owner || !owner.categories.some((category) => ['institution_leader', 'project_lead', 'member'].includes(category))) throw failure(400, 'FDE_OWNER_INVALID', '项目负责人必须是启用的业务人员')
  if (new Set(assignments.map(assignmentKey)).size !== assignments.length) throw failure(400, 'FDE_DUTY_DUPLICATE', '项目职责不能重复绑定')
  const executives = assignments.filter(item => item.duty === 'executive_lead')
  if (executives.length > 1 || executives.some(lead => !assignments.some(item => item.duty === 'concerned_leader' && item.userId === lead.userId))) throw failure(400, 'FDE_EXECUTIVE_LEAD_INVALID', '牵头领导只能指定一位，且必须同时是关注领导；未配置时保留缺岗提示')
  for (const assignment of assignments) {
    const definition = FDE_PROJECT_DUTIES.find((item) => item.code === assignment.duty)
    const person = byId.get(assignment.userId)
    console.error('[validateAssignments] duty=' + assignment.duty + ' userId=' + assignment.userId + ' person=' + (person?.name ?? 'NOT_FOUND') + ' categories=' + JSON.stringify(person?.categories ?? null) + ' eligible=' + JSON.stringify(definition?.eligible ?? null))
    if (!definition || !person || !person.categories.some((category) => (definition.eligible as readonly string[]).includes(category))) throw failure(400, 'FDE_DUTY_PERSON_INVALID', '职责人员不存在、已禁用或不符合机构角色类别')
    if (assignment.duty === 'chairman' && !person.roleCodes.includes('FDE_CHAIRMAN')) throw failure(400, 'FDE_EXECUTIVE_ROLE_INVALID', '董事长审批职责必须绑定董事长角色')
    if (assignment.duty === 'president' && !person.roleCodes.includes('FDE_PRESIDENT')) throw failure(400, 'FDE_EXECUTIVE_ROLE_INVALID', '计划审核职责必须绑定总裁角色')
  }
}

function effectiveLeadership(assignments: Array<{ duty: string; userId: string }>, people: Person[]) {
  void people
  return assignments.filter((item) => FDE_LEADERSHIP_DUTIES.includes(item.duty as FdeProjectDuty))
}

async function lockedProject(tx: Transaction, projectId: string) {
  await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) throw failure(404, 'PROJECT_NOT_FOUND', '项目不存在')
  if (project.workflowModel !== 'fde-v1') throw failure(409, 'FDE_LEGACY_PROJECT', '历史项目请使用原项目成员管理流程')
  if (project.lifecycle !== 'active') throw failure(409, 'FDE_PROJECT_INACTIVE', '关闭或归档项目不能修改治理配置')
  return project
}

async function applyGovernance(tx: Transaction, project: ProjectRow, ownerId: string, assignments: FdeDutyAssignment[], actorId: string, people: Person[]) {
  validateAssignments(ownerId, assignments, people)
  const peopleById = new Map(people.map((person) => [person.id, person]))
  const owner = peopleById.get(ownerId)!
  await tx.delete(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, project.id))
  if (assignments.length) await tx.insert(projectDutyAssignments).values(assignments.map((assignment) => ({ ...assignment, projectId: project.id, assignedBy: actorId })))
  // 协调人仅维护排期，不因排期职责获得项目内容；其他明确职责同步到既有成员关系。
  const participantIds = [...new Set(assignments.filter((assignment) => assignment.duty !== 'coordinator').map((assignment) => assignment.userId))].filter((id) => id !== ownerId)
  await tx.delete(projectMembers).where(eq(projectMembers.projectId, project.id))
  await tx.insert(projectMembers).values([
    { projectId: project.id, userId: ownerId, memberRole: 'owner', sourceName: owner.name },
    ...participantIds.map((userId) => ({ projectId: project.id, userId, memberRole: 'collaborator', sourceName: peopleById.get(userId)!.name })),
  ])
  await tx.update(projects).set({ ownerUserId: ownerId, owner: owner.name, collaborators: participantIds.map((id) => peopleById.get(id)!.name), governanceVersion: project.governanceVersion + 1, version: project.version + 1, updatedAt: new Date() }).where(eq(projects.id, project.id))
}

export async function getFdeGovernance(projectId: string, userId: string) {
  const project = await requireAccessibleProject(userId, projectId)
  const [assignments, changes, people, manageable] = await Promise.all([
    db.select().from(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, projectId)),
    db.select().from(projectGovernanceChanges).where(eq(projectGovernanceChanges.projectId, projectId)).orderBy(desc(projectGovernanceChanges.createdAt)),
    enabledPeople(db), canManage(project, userId),
  ])
  const leadership = effectiveLeadership(assignments, people)
  const rosterIds = [...new Set([project.ownerUserId, ...assignments.map((item) => item.userId), ...leadership.map((item) => item.userId), ...changes.flatMap((change) => [change.requestedBy, ...change.requiredConfirmers])].filter((id): id is string => Boolean(id)))]
  const allUsers = rosterIds.length ? await db.select({ id: users.id, name: users.name, role: users.role, status: users.status }).from(users).where(inArray(users.id, rosterIds)) : []
  return {
    projectId, version: project.governanceVersion, ownerUserId: project.ownerUserId,
    duties: FDE_PROJECT_DUTIES, assignments, effectiveLeadership: leadership,
    roster: allUsers, changes, eligiblePeople: manageable ? people.filter((person) => person.categories.some((category) => category !== 'system_admin')) : [],
    capabilities: { canManage: manageable && project.lifecycle === 'active', canSubmitStage: project.ownerUserId === userId && project.lifecycle === 'active' },
  }
}

export async function proposeFdeGovernance(input: { projectId: string; userId: string; ownerUserId: string; assignments: FdeDutyAssignment[]; reason: string; expectedVersion: number }) {
  await requireAccessibleProject(input.userId, input.projectId)
  const changeId = randomUUID()
  await db.transaction(async (tx) => {
    const project = await lockedProject(tx, input.projectId)
    if (!await canManage(project, input.userId, tx)) throw failure(403, 'FDE_GOVERNANCE_FORBIDDEN', '仅项目负责人或授权机构领导可修改治理配置')
    if (project.governanceVersion !== input.expectedVersion) throw failure(409, 'FDE_GOVERNANCE_VERSION_CONFLICT', '治理配置已变化，请刷新后重试')
    if (input.reason.trim().length < 5) throw failure(400, 'FDE_GOVERNANCE_REASON_REQUIRED', '请填写至少 5 字的变更理由')
    const [pending] = await tx.select({ id: projectGovernanceChanges.id }).from(projectGovernanceChanges).where(eq(projectGovernanceChanges.activeKey, project.id)).limit(1)
    if (pending) throw failure(409, 'FDE_GOVERNANCE_PENDING', '已有领导参与规则变更待确认，不能重复提交')
    const people = await enabledPeople(tx)
    validateAssignments(input.ownerUserId, input.assignments, people)
    const previous = await tx.select({ duty: projectDutyAssignments.duty, userId: projectDutyAssignments.userId }).from(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, project.id))
    const nextKeys = new Set(effectiveLeadership(input.assignments, people).map(assignmentKey))
    const requiredConfirmers = [...new Set(effectiveLeadership(previous, people).filter((item) => !nextKeys.has(assignmentKey(item))).map((item) => item.userId))]
    const requiresConfirmation = requiredConfirmers.length > 0
    await tx.insert(projectGovernanceChanges).values({
      id: changeId, projectId: project.id, baseVersion: project.governanceVersion,
      proposedOwnerId: input.ownerUserId, proposedAssignments: input.assignments,
      previousSnapshot: { ownerUserId: project.ownerUserId, assignments: previous }, reason: input.reason.trim(),
      status: requiresConfirmation ? 'awaiting_confirmation' : 'applied', activeKey: requiresConfirmation ? project.id : null,
      requestedBy: input.userId, requiredConfirmers, confirmations: [], appliedAt: requiresConfirmation ? null : new Date(),
    })
    if (!requiresConfirmation) {
      await applyGovernance(tx, project, input.ownerUserId, input.assignments, input.userId, people)
      const { reconcileTimelineEvent } = await import('./fdeTimelineTaskService.js')
      await reconcileTimelineEvent(tx, project.id, input.userId, { source: 'governance', sourceKey: `governance:${changeId}` })
    }
    const actor = await createMySqlIdentityRepositoryContext(tx).users.findById(input.userId)
    await createMySqlIdentityRepositoryContext(tx).audits.append({ userId: input.userId, userName: actor?.name ?? '未知用户', module: 'FDE组织与权限', action: requiresConfirmation ? '提交领导参与规则变更' : '更新项目治理', target: JSON.stringify({ projectId: project.id, changeId, before: previous, after: input.assignments, reason: input.reason, requiredConfirmers }) })
  })
  // 转移负责人后发起人可能已无项目读取权，只返回自己的变更回执。
  const [change] = await db.select().from(projectGovernanceChanges).where(eq(projectGovernanceChanges.id, changeId)).limit(1)
  return change
}

export async function decideFdeGovernance(input: { projectId: string; changeId: string; userId: string; decision: 'confirm' | 'reject' | 'cancel'; comment: string; expectedVersion: number }) {
  await requireAccessibleProject(input.userId, input.projectId)
  return db.transaction(async (tx) => {
    const project = await lockedProject(tx, input.projectId)
    const [change] = await tx.select().from(projectGovernanceChanges).where(and(eq(projectGovernanceChanges.id, input.changeId), eq(projectGovernanceChanges.projectId, project.id))).limit(1)
    if (!change) throw failure(404, 'FDE_GOVERNANCE_CHANGE_NOT_FOUND', '治理变更不存在')
    if (change.status !== 'awaiting_confirmation' || change.version !== input.expectedVersion) throw failure(409, 'FDE_GOVERNANCE_CHANGE_CONFLICT', '治理变更已处理或版本过期')
    if (input.comment.trim().length < 2) throw failure(400, 'FDE_GOVERNANCE_COMMENT_REQUIRED', '请填写决定说明')
    if (input.decision === 'cancel') {
      if (change.requestedBy !== input.userId) throw failure(403, 'FDE_GOVERNANCE_CONFIRM_FORBIDDEN', '仅发起人可撤回变更')
    } else {
      if (!change.requiredConfirmers.includes(input.userId)) throw failure(403, 'FDE_GOVERNANCE_CONFIRM_FORBIDDEN', '只有被移出参与规则的相关领导可以确认或拒绝')
      if (change.confirmations.some((item) => item.userId === input.userId)) throw failure(409, 'FDE_GOVERNANCE_ALREADY_CONFIRMED', '当前领导已经处理过该变更')
    }
    if (project.governanceVersion !== change.baseVersion) throw failure(409, 'FDE_GOVERNANCE_VERSION_CONFLICT', '原治理版本已改变，不能覆盖')
    const confirmations = [...change.confirmations, { userId: input.userId, decision: input.decision, comment: input.comment.trim(), at: new Date().toISOString() }]
    const complete = input.decision === 'confirm' && change.requiredConfirmers.every((id) => confirmations.some((item) => item.userId === id && item.decision === 'confirm'))
    const status = input.decision === 'cancel' ? 'cancelled' : input.decision === 'reject' ? 'rejected' : complete ? 'applied' : 'awaiting_confirmation'
    if (complete) {
      await applyGovernance(tx, project, change.proposedOwnerId, change.proposedAssignments as FdeDutyAssignment[], input.userId, await enabledPeople(tx))
      const { reconcileTimelineEvent } = await import('./fdeTimelineTaskService.js')
      await reconcileTimelineEvent(tx, project.id, input.userId, { source: 'governance', sourceKey: `governance:${change.id}` })
    }
    await tx.update(projectGovernanceChanges).set({ status, confirmations, activeKey: status === 'awaiting_confirmation' ? project.id : null, version: change.version + 1, updatedAt: new Date(), appliedAt: complete ? new Date() : null }).where(eq(projectGovernanceChanges.id, change.id))
    const actor = await createMySqlIdentityRepositoryContext(tx).users.findById(input.userId)
    await createMySqlIdentityRepositoryContext(tx).audits.append({ userId: input.userId, userName: actor?.name ?? '未知用户', module: 'FDE组织与权限', action: '处理领导参与规则变更', target: JSON.stringify({ projectId: project.id, changeId: change.id, decision: input.decision, comment: input.comment, status }) })
    return { id: change.id, status, version: change.version + 1 }
  })
}

export async function resolveFdeApprovalNodes(tx: Transaction, project: ProjectRow, stage: string, applicantId: string) {
  const assignments = await tx.select().from(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, project.id))
  const people = await enabledPeople(tx)
  const byId = new Map(people.map((person) => [person.id, person]))
  const policy = await getProjectWorkflowPolicy(tx, project)
  const definitions = policy.configuration.stages.find((item) => item.stage === stage)?.approvals
  if (!definitions) throw failure(409, 'FDE_APPROVAL_STAGE_INVALID', '当前阶段没有批准的审批配置')
  return definitions.map(({ duty, name, mode }) => {
    const approvalDuty = duty as FdeApprovalDuty
    const boss = approvalDuty === 'boss'
    const bindings = boss
      ? assignments.filter((assignment) => assignment.duty === 'chairman' || assignment.duty === 'president')
      : assignments.filter((assignment) => assignment.duty === approvalDuty)
    const fallbackCode = approvalDuty === 'chairman' ? 'FDE_CHAIRMAN' : approvalDuty === 'president' ? 'FDE_PRESIDENT' : null
    const ids = bindings.map((binding) => binding.userId)
    const selected = [...new Set(ids)].filter((id) => id !== applicantId).map((id) => byId.get(id)).filter((person): person is Person => Boolean(person))
    const label = boss ? '董事长/总裁审批' : FDE_PROJECT_DUTIES.find((item) => item.code === approvalDuty)!.label
    if (!selected.length || ids.some((id) => id !== applicantId && !byId.has(id))) throw failure(409, 'FDE_APPROVER_NOT_CONFIGURED', `请先配置当前项目的启用职责人员：${label}；申请人不可兼任审批人`)
    const definition = boss ? undefined : FDE_PROJECT_DUTIES.find((item) => item.code === approvalDuty)!
    if (selected.some((person) => (definition && !person.categories.some((category) => (definition.eligible as readonly string[]).includes(category))) || (fallbackCode !== null && !person.roleCodes.includes(fallbackCode)) || (boss && !person.roleCodes.some((code) => ['FDE_CHAIRMAN', 'FDE_PRESIDENT'].includes(code))))) throw failure(409, 'FDE_APPROVER_ROLE_CHANGED', `职责人员的机构角色已变化，请重新配置：${label}`)
    return { name, mode, roleLabel: label, roles: [approvalDuty], approverUserIds: selected.map((person) => person.id), approverNames: selected.map((person) => person.name) }
  })
}
