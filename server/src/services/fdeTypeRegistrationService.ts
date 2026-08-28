import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, like } from 'drizzle-orm'
import { db } from '../db/client.js'
import { fdeTypeRegistrationCommands as commands, fdeTypePolicyReviews, fdeTypePolicyEvents, fdeWorkflowPolicies as heads, fdeWorkflowPolicyVersions as versions, projectClassificationHistory, projectMembers, projects, roles, userRoles } from '../db/schema.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { typePolicyCode, typePolicyDefinition, typePolicyName } from '../contracts/fdeTypePolicyContract.js'
import { prepareTypeRegistration, typeRegistrationCommand, typeRegistrationReceipt, typeRegistrationRecovery } from '../contracts/fdeTypeRegistrationContract.js'
import { policyHash } from './fdeWorkflowPolicyService.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
const fail = (status: number, code: string, message: string): never => { throw Object.assign(new Error(message), { status, code }) }
async function actor(tx: Tx, uid: string, lock = false) {
  const identity = createMySqlIdentityRepositoryContext(tx)
  const user = lock ? await identity.users.lockById(uid) : await identity.users.findById(uid)
  if (!user || user.status !== '启用') return fail(403, 'TYPE_REGISTRATION_FORBIDDEN', '当前账号不可用')
  return { user, identity }
}
async function roleIds(tx: Tx, uid: string) {
  return (await tx.select({ id: roles.id }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, uid), eq(roles.status, '启用'), inArray(roles.fdeCategory, ['institution_leader', 'project_lead', 'member'])))).map(r => r.id)
}
async function approvedDefinition(tx: Tx, head: typeof heads.$inferSelect, version: typeof versions.$inferSelect) {
  const configuration = typePolicyDefinition.parse(version.configuration)
  if (!head.enabled || head.activeVersionId !== version.id || version.status !== 'published' || !version.publishedBy || !version.publishedAt
    || typePolicyCode(configuration.type) !== head.code || policyHash(configuration) !== version.sha256 || !configuration.registration || !configuration.planApprovals?.length) return fail(409, 'TYPE_REGISTRATION_UNAVAILABLE', '模板未完整审核并显式启用登记，不能创建项目')
  const [review] = await tx.select().from(fdeTypePolicyReviews).where(eq(fdeTypePolicyReviews.versionId, version.id))
  const [authored] = review?.approvedBy ? await tx.select({ id: fdeTypePolicyEvents.id }).from(fdeTypePolicyEvents).where(and(eq(fdeTypePolicyEvents.versionId, version.id), eq(fdeTypePolicyEvents.actorId, review.approvedBy), inArray(fdeTypePolicyEvents.action, ['create', 'save']))).limit(1) : []
  const [activated] = await tx.select({ id: fdeTypePolicyEvents.id }).from(fdeTypePolicyEvents).where(and(eq(fdeTypePolicyEvents.versionId, version.id), eq(fdeTypePolicyEvents.action, 'activate'))).limit(1)
  if (!review?.approvedBy || !review.approvedAt || review.approvedHash !== version.sha256 || review.approvedBy === version.createdBy || authored || !activated) return fail(409, 'TYPE_REGISTRATION_APPROVAL_REQUIRED', '缺少独立审核或显式启用证据')
  return configuration
}
export async function listTypeRegistrationOptions(uid: string) {
  return db.transaction(async tx => {
    await actor(tx, uid)
    const actualRoles = await roleIds(tx, uid)
    if (!actualRoles.length) return { policies: [] }
    const candidates = await tx.select({ head: heads, version: versions }).from(heads).innerJoin(versions, eq(versions.id, heads.activeVersionId))
      .where(and(like(heads.code, 'noninvestment:%'), eq(heads.enabled, true))).orderBy(asc(heads.code))
    const result = []
    for (const { head, version } of candidates) {
      const config = typePolicyDefinition.safeParse(version.configuration)
      if (!config.success || !config.data.registration?.roleIds.some(id => actualRoles.includes(id))) continue
      const configuration = await approvedDefinition(tx, head, version)
      result.push({ policyId: head.id, versionId: version.id, policyVersion: head.version, sha256: version.sha256, name: head.name, configuration })
    }
    return { policies: result }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
export async function registerTypeProject(uid: string, raw: unknown) {
  const input = typeRegistrationCommand.parse(raw), hash = policyHash(input)
  return db.transaction(async tx => {
    const { user, identity } = await actor(tx, uid, true)
    const [prior] = await tx.select().from(commands).where(and(eq(commands.actorId, uid), eq(commands.commandId, input.commandId)))
    if (prior) {
      if (prior.closedAt) return fail(409, 'TYPE_REGISTRATION_COMMAND_CLOSED', '原请求已封闭，请重新读取并确认')
      if (prior.commandHash !== hash) return fail(409, 'TYPE_REGISTRATION_COMMAND_REUSED', '同一请求编号不能用于其他登记内容')
      return typeRegistrationReceipt.parse(prior.receipt)
    }
    const [head] = await tx.select().from(heads).where(and(eq(heads.id, input.policyId), like(heads.code, 'noninvestment:%'))).for('update')
    if (!head || !head.enabled || head.activeVersionId !== input.versionId) return fail(409, 'TYPE_REGISTRATION_UNAVAILABLE', '所选模板已停用或换版，请重新读取')
    if (head.version !== input.expectedPolicyVersion) return fail(409, 'VERSION_CONFLICT', '模板状态已变化，请重新核对')
    const [version] = await tx.select().from(versions).where(and(eq(versions.id, input.versionId), eq(versions.policyId, head.id)))
    if (!version || version.sha256 !== input.expectedSha256) return fail(409, 'TYPE_REGISTRATION_VERSION_CHANGED', '所选模板内容已变化')
    const config = await approvedDefinition(tx, head, version), actualRoles = await roleIds(tx, uid)
    if (!config.registration!.roleIds.some(id => actualRoles.includes(id))) return fail(403, 'TYPE_REGISTRATION_FORBIDDEN', '当前角色没有此模板登记权')
    let initial
    try { initial = prepareTypeRegistration(config, input, actualRoles) } catch (error) { return fail(409, 'TYPE_REGISTRATION_PLAN_INVALID', (error as Error).message) }
    const projectId = randomUUID()
    await tx.insert(projects).values({ id: projectId, name: input.name, projectType: typePolicyName(config.type), owner: user.name, ownerUserId: uid, createdBy: uid,
      collaborators: [], ...initial, workflowModel: 'fde-v1', workflowPolicyVersionId: version.id, lifecycle: 'active', stageSource: '独立非投资登记', progress: 0 })
    await tx.insert(projectMembers).values({ projectId, userId: uid, memberRole: 'owner', sourceName: user.name })
    await tx.insert(projectClassificationHistory).values({ projectId, fromClassification: null, toClassification: initial.classification, reason: input.reason, changedBy: uid, changedByName: user.name })
    const receipt = typeRegistrationReceipt.parse({ commandId: input.commandId, projectId, policyId: head.id, versionId: version.id, version: 1 })
    await tx.insert(commands).values({ actorId: uid, commandId: input.commandId, commandHash: hash, receipt })
    await identity.audits.append({ userId: uid, userName: user.name, module: '非投资登记', action: '登记项目', target: JSON.stringify({ ...receipt, policySha256: version.sha256, reason: input.reason, tasksCreated: false, leadConverted: false }) })
    return receipt
  }, { isolationLevel: 'read committed' })
}
export async function recoverTypeRegistration(uid: string, raw: unknown) {
  const { commandId } = typeRegistrationRecovery.parse(raw)
  return db.transaction(async tx => {
    const { user, identity } = await actor(tx, uid, true)
    const [prior] = await tx.select().from(commands).where(and(eq(commands.actorId, uid), eq(commands.commandId, commandId)))
    if (prior?.receipt) return { state: 'committed' as const, receipt: typeRegistrationReceipt.parse(prior.receipt) }
    if (prior && !prior.closedAt) return fail(409, 'TYPE_REGISTRATION_COMMAND_INTEGRITY', '登记回执不完整，请保留现场')
    if (!prior) {
      await tx.insert(commands).values({ actorId: uid, commandId, closedAt: new Date() })
      await identity.audits.append({ userId: uid, userName: user.name, module: '非投资登记', action: '封闭未提交请求', target: JSON.stringify({ commandId, receiptOnly: true }) })
    }
    return { state: 'not_committed' as const, receipt: null }
  }, { isolationLevel: 'read committed' })
}
