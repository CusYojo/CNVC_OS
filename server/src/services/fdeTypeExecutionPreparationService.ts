import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { fdeTypePolicyEvents, fdeTypePolicyReviews, fdeWorkflowPolicies, fdeWorkflowPolicyVersions, projectDutyAssignments, projectMembers, projects, roles, userRoles, users } from '../db/schema.js'
import { compileTypeExecutionPlan, typeExecutionRoster, type TypeExecutionRoster } from '../contracts/fdeTypeExecutionContract.js'
import { fdeDate, fdeDueTime } from '../contracts/fdeTaskContract.js'
import { typeDuty, typePolicyCode, typePolicyDefinition, typePolicyName } from '../contracts/fdeTypePolicyContract.js'
import { projectAccessCondition } from './projectAccessService.js'
import { policyHash } from './fdeWorkflowPolicyService.js'

type Reader = Pick<typeof db, 'select'>
const fail = (status: number, code: string, message: string): never => { throw Object.assign(new Error(message), { status, code }) }
const request = z.object({
  expectedProjectVersion: z.number().int().positive(), expectedGovernanceVersion: z.number().int().positive(),
  expectedPolicyVersionId: z.string().uuid(), expectedPolicySha256: z.string().regex(/^[a-f0-9]{64}$/),
  cycleDays: z.number().int(), targetDate: fdeDate,
  selections: z.array(z.object({ actionKey: z.string(), userId: z.string().uuid(), dueTime: fdeDueTime.nullable() }).strict()).max(80),
}).strict()

// The snapshot is built from stable MySQL identities and explicit project
// assignments. Organization-wide leadership alone is not a project duty.
export async function readTypeExecutionRoster(reader: Reader, project: typeof projects.$inferSelect): Promise<TypeExecutionRoster> {
  const [assignments, members] = await Promise.all([
    reader.select({ userId: projectDutyAssignments.userId, duty: projectDutyAssignments.duty }).from(projectDutyAssignments).where(eq(projectDutyAssignments.projectId, project.id)),
    reader.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id)),
  ])
  const ids = [...new Set([project.ownerUserId, ...assignments.map(a => a.userId)].filter((id): id is string => Boolean(id)))]
  if (!ids.length) return fail(409, 'TYPE_EXECUTION_DUTY_MISSING', '项目缺少稳定负责人和职责身份')
  const [people, bindings] = await Promise.all([
    reader.select({ id: users.id, status: users.status }).from(users).where(inArray(users.id, ids)),
    reader.select({ userId: userRoles.userId, category: roles.fdeCategory, code: roles.code }).from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(inArray(userRoles.userId, ids), eq(roles.status, '启用'))),
  ])
  const memberIds = new Set(members.map(m => m.userId))
  return typeExecutionRoster.parse({ governanceVersion: project.governanceVersion, people: people.map(p => {
    const personRoles = bindings.filter(r => r.userId === p.id)
    const duties = [...new Set([...(project.ownerUserId === p.id ? ['owner'] : []), ...assignments.filter(a => a.userId === p.id).map(a => typeDuty.parse(a.duty))])]
    return { userId: p.id, enabled: p.status === '启用', duties,
      canReadProject: project.ownerUserId === p.id || memberIds.has(p.id) || duties.some(d => d !== 'coordinator'),
      categories: [...new Set(personRoles.map(r => r.category).filter((c): c is string => Boolean(c)))], roleCodes: [...new Set(personRoles.map(r => r.code))] }
  }) })
}

// Read-only preparation for the independent runtime adapter. It deliberately
// cannot bind an investment/legacy project, select the latest policy implicitly,
// activate a policy, materialize tasks, or create/migrate a project. Future write
// commands must repeat these checks inside their locked transaction.
export async function previewBoundTypeExecution(projectId: string, actorId: string, raw: unknown) {
  return db.transaction(tx => loadBoundTypeExecution(tx, projectId, actorId, raw), { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

// Caller owns transaction and project lock for write commands.
export async function loadBoundTypeExecution(tx: Reader, projectId: string, actorId: string, raw: unknown) {
  z.string().uuid().parse(projectId); z.string().uuid().parse(actorId)
  const input = request.parse(raw)
    const [actor] = await tx.select().from(users).where(and(eq(users.id, actorId), eq(users.status, '启用')))
    if (!actor) return fail(403, 'TYPE_EXECUTION_FORBIDDEN', '当前账号不可用')
    const [project] = await tx.select().from(projects).where(and(eq(projects.id, projectId), projectAccessCondition({ uid: actor.id, name: actor.name, role: actor.role })))
    if (!project) return fail(403, 'TYPE_EXECUTION_FORBIDDEN', '无权读取当前项目')
    if (project.workflowModel !== 'fde-v1' || project.projectType === '投资项目') return fail(409, 'TYPE_EXECUTION_PROJECT_MODEL', '仅为已明确绑定的非投资项目准备执行；不得改写投资或历史项目')
    if (project.lifecycle !== 'active' || project.classification === 'pool') return fail(409, 'TYPE_EXECUTION_PROJECT_INACTIVE', '只有有效非投资业务项目可准备执行，项目池登记不能直接执行')
    if (project.version !== input.expectedProjectVersion || project.governanceVersion !== input.expectedGovernanceVersion) return fail(409, 'TYPE_EXECUTION_VERSION_CONFLICT', '项目或职责版本已变化')
    if (!project.workflowPolicyVersionId || project.workflowPolicyVersionId !== input.expectedPolicyVersionId) return fail(409, 'TYPE_EXECUTION_BINDING_CHANGED', '项目尚未绑定此具体模板版本，不自动切换到最新版本')
    const [version] = await tx.select().from(fdeWorkflowPolicyVersions).where(eq(fdeWorkflowPolicyVersions.id, project.workflowPolicyVersionId))
    if (!version) return fail(409, 'TYPE_EXECUTION_POLICY_INVALID', '项目绑定版本不存在')
    const [[head], [review]] = await Promise.all([
      tx.select().from(fdeWorkflowPolicies).where(eq(fdeWorkflowPolicies.id, version.policyId)),
      tx.select().from(fdeTypePolicyReviews).where(eq(fdeTypePolicyReviews.versionId, version.id)),
    ])
    const configuration = typePolicyDefinition.parse(version.configuration)
    if (!head || head.code !== typePolicyCode(configuration.type) || project.projectType !== typePolicyName(configuration.type)
      || policyHash(configuration) !== version.sha256 || input.expectedPolicySha256 !== version.sha256) return fail(409, 'TYPE_EXECUTION_POLICY_INTEGRITY', '项目类型、模板内容或所见哈希不一致')
    if (version.status !== 'published' || !version.publishedBy || !version.publishedAt || !review?.approvedBy
      || !review.approvedAt || review.approvedHash !== version.sha256 || review.approvedBy === version.createdBy) return fail(409, 'TYPE_EXECUTION_POLICY_NOT_APPROVED', '必须使用经过独立审核且已发布的具体版本')
    const [authored] = await tx.select({ id: fdeTypePolicyEvents.id }).from(fdeTypePolicyEvents).where(and(
      eq(fdeTypePolicyEvents.versionId, version.id), eq(fdeTypePolicyEvents.actorId, review.approvedBy),
      inArray(fdeTypePolicyEvents.action, ['create', 'save']),
    )).limit(1)
    if (authored) return fail(409, 'TYPE_EXECUTION_POLICY_NOT_APPROVED', '审核人参与过该版本编制，独立审核证据无效')
    const roster = await readTypeExecutionRoster(tx, project)
    const author = roster.people.find(p => p.userId === actorId)
    if (!author?.enabled || !author.canReadProject
      || !(author.duties.includes('owner') && author.categories.some(c => ['institution_leader', 'project_lead', 'member'].includes(c))
        || author.duties.includes('secretary') && author.categories.some(c => ['secretary', 'project_lead', 'member'].includes(c)))) return fail(403, 'TYPE_EXECUTION_PREPARE_FORBIDDEN', '仅当前有效负责人或推进秘书可核对执行计划')
    const plan = compileTypeExecutionPlan({ binding: { projectId, policyVersionId: version.id, policySha256: version.sha256 },
      configuration, roster, cycleDays: input.cycleDays, targetDate: input.targetDate, selections: input.selections })
    return { plan, projectVersion: project.version, policyEnabled: head.enabled, executionAvailable: false as const, persisted: false as const }
}
