import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { fdeWorkflowPolicies as heads, fdeWorkflowPolicyVersions as versions, fdeTypePolicyReviews as reviews, fdeTypePolicyCommands as commands, fdeTypePolicyEvents as events, projects, users, roles, userRoles } from '../db/schema.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { policyHash } from './fdeWorkflowPolicyService.js'
import { previewTypePlan, typePolicyCode, typePolicyCommand, typePolicyDefinition, typePolicyName, typePolicyReceipt, typePolicyRecovery, type TypePolicyReceipt } from '../contracts/fdeTypePolicyContract.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>
const fail = (status: number, code: string, message: string): never => { throw Object.assign(new Error(message), { status, code }) }
const pageQuery = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), eventPage: z.coerce.number().int().min(1).max(100000).default(1) }).strict()
async function businessApprover(reader: Reader, uid: string) {
  const [actor] = await reader.select({ id: users.id }).from(users).innerJoin(userRoles, eq(users.id, userRoles.userId)).innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(users.id, uid), eq(users.status, '启用'), eq(roles.status, '启用'), eq(roles.fdeCategory, 'institution_leader'))).limit(1)
  return Boolean(actor)
}
async function checkRegistrationRoles(tx: Tx, configuration: ReturnType<typeof typePolicyDefinition.parse>) {
  if (!configuration.registration) return
  const rows = await tx.select({ id: roles.id }).from(roles).where(and(inArray(roles.id, configuration.registration.roleIds), eq(roles.status, '启用'), inArray(roles.fdeCategory, ['institution_leader', 'project_lead', 'member'])))
  if (rows.length !== configuration.registration.roleIds.length) return fail(409, 'TYPE_REGISTRATION_ROLES_INVALID', '登记角色须为当前有效且可担任项目负责人的业务角色；管理员不自动获得登记权')
  if (!configuration.planApprovals?.length) return fail(409, 'TYPE_REGISTRATION_PLAN_POLICY_REQUIRED', '登记规则必须同时明确独立计划审批节点')
}
export async function typeRegistrationRoleOptions(uid: string) {
  return db.transaction(async tx => {
    await capabilities(tx, uid)
    return { roles: await tx.select({ id: roles.id, name: roles.name }).from(roles).where(and(eq(roles.status, '启用'), inArray(roles.fdeCategory, ['institution_leader', 'project_lead', 'member']))).orderBy(asc(roles.name)) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
async function actorContext(tx: Tx, uid: string, lock = false) {
  const identity = createMySqlIdentityRepositoryContext(tx), actor = lock ? await identity.users.lockById(uid) : await identity.users.findById(uid)
  if (!actor || actor.status !== '启用') return fail(403, 'TYPE_POLICY_ACTOR_FORBIDDEN', '当前账号不可用')
  return { identity, actor }
}
async function capabilities(tx: Tx, uid: string) {
  const { identity } = await actorContext(tx, uid)
  const manage = (await identity.users.listPermissionCodes(uid)).includes('system.manage'), approve = await businessApprover(tx, uid)
  if (!manage && !approve) return fail(403, 'TYPE_POLICY_FORBIDDEN', '仅配置管理人员或机构业务审核人可访问非投资模板')
  return { manage, approve }
}
function configurationFor(row: typeof versions.$inferSelect, policy: typeof heads.$inferSelect) {
  const config = typePolicyDefinition.parse(row.configuration)
  if (typePolicyCode(config.type) !== policy.code || policyHash(config) !== row.sha256) return fail(409, 'TYPE_POLICY_INTEGRITY', '类型、版本内容或哈希不一致，不能继续操作')
  return config
}
async function describe(tx: Tx, policy: typeof heads.$inferSelect, rows: Array<typeof versions.$inferSelect>, uid: string, access: { manage: boolean; approve: boolean }) {
  if (!rows.length) return []
  const checks = await tx.select().from(reviews).where(inArray(reviews.versionId, rows.map(r => r.id)))
  const authored = new Set((await tx.select({ versionId: events.versionId }).from(events).where(and(inArray(events.versionId, rows.map(r => r.id)), eq(events.actorId, uid), inArray(events.action, ['create', 'save'])))).map(r => r.versionId))
  const ids = [...new Set([...rows.flatMap(r => [r.createdBy, r.publishedBy]), ...checks.map(r => r.approvedBy)].filter((s): s is string => Boolean(s)))]
  const names = new Map(ids.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map(u => [u.id, u.name]) : [])
  return Promise.all(rows.map(async row => {
    const review = checks.find(r => r.versionId === row.id)
    if (!review || Boolean(review.approvedBy) !== Boolean(review.approvedAt) || Boolean(review.approvedBy) !== Boolean(review.approvedHash)
      || review.approvedBy && review.approvedHash !== row.sha256 || row.status === 'published' && !review.approvedBy) return fail(409, 'TYPE_POLICY_INTEGRITY', '独立审核记录缺失或不完整')
    const status = row.status === 'published' ? 'published' : review.approvedBy ? 'approved' : 'draft'
    return { ...row, configuration: configurationFor(row, policy), status, approvedBy: review.approvedBy, approvedAt: review.approvedAt,
      createdByName: names.get(row.createdBy ?? '') ?? '原人员不可用', approvedByName: names.get(review.approvedBy ?? '') ?? null, publishedByName: names.get(row.publishedBy ?? '') ?? null,
      capabilities: { save: access.manage && status === 'draft', approve: access.approve && status === 'draft' && !authored.has(row.id) && row.createdBy !== uid,
        publish: access.manage && status === 'approved' && Boolean(review.approvedBy && await businessApprover(tx, review.approvedBy)),
        activate: access.manage && status === 'published' && policy.activeVersionId === row.id && !policy.enabled && Boolean(row.configuration && configurationFor(row, policy).registration && review.approvedBy && await businessApprover(tx, review.approvedBy)),
        deactivate: access.manage && status === 'published' && policy.activeVersionId === row.id && policy.enabled } }
  }))
}
export async function listTypePolicies(uid: string, raw: unknown = {}) {
  const { page } = pageQuery.parse(raw)
  return db.transaction(async tx => {
    const access = await capabilities(tx, uid), where = like(heads.code, 'noninvestment:%')
    const rows = await tx.select().from(heads).where(where).orderBy(asc(heads.code)).limit(21).offset((page - 1) * 20)
    const [total] = await tx.select({ n: sql<number>`COUNT(*)` }).from(heads).where(where)
    return { capabilities: access, policies: rows.slice(0, 20), page, hasMore: rows.length > 20, total: Number(total.n), executionAvailable: rows.some(row => row.enabled) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
export async function getTypePolicy(uid: string, id: string, raw: unknown = {}) {
  z.string().uuid().parse(id); const { page, eventPage } = pageQuery.parse(raw)
  return db.transaction(async tx => {
    const access = await capabilities(tx, uid)
    const [policy] = await tx.select().from(heads).where(and(eq(heads.id, id), like(heads.code, 'noninvestment:%')))
    if (!policy) return fail(404, 'TYPE_POLICY_NOT_FOUND', '非投资模板不存在')
    const rows = await tx.select().from(versions).where(eq(versions.policyId, id)).orderBy(desc(versions.revision)).limit(21).offset((page - 1) * 20)
    const history = await tx.select().from(events).where(eq(events.policyId, id)).orderBy(desc(events.createdAt), desc(events.id)).limit(21).offset((eventPage - 1) * 20)
    const [count] = await tx.select({ n: sql<number>`COUNT(*)` }).from(projects).innerJoin(versions, eq(versions.id, projects.workflowPolicyVersionId)).where(eq(versions.policyId, id))
    return { capabilities: access, policy, versions: await describe(tx, policy, rows.slice(0, 20), uid, access), events: history.slice(0, 20), page, eventPage,
      hasMore: rows.length > 20, eventsHaveMore: history.length > 20, boundProjects: Number(count.n), executionAvailable: policy.enabled }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
export async function previewTypePolicy(uid: string, raw: unknown) {
  return db.transaction(async tx => {
    await capabilities(tx, uid)
    try { const result = previewTypePlan(raw); return { ...result, configurationHash: policyHash(typePolicyDefinition.parse((raw as { configuration: unknown }).configuration)) } }
    catch (error) { if (error instanceof z.ZodError) throw error; return fail(400, 'TYPE_POLICY_PREVIEW_INVALID', (error as Error).message) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
export async function executeTypePolicy(uid: string, raw: unknown) {
  const input = typePolicyCommand.parse(raw), hash = policyHash(input)
  return db.transaction(async tx => {
    const { actor, identity } = await actorContext(tx, uid, true)
    const [prior] = await tx.select().from(commands).where(and(eq(commands.actorId, uid), eq(commands.commandId, input.commandId)))
    if (prior) {
      if (prior.closedAt) return fail(409, 'TYPE_POLICY_COMMAND_CLOSED', '原请求已封闭，读取最新状态后重新确认')
      if (prior.commandHash !== hash) return fail(409, 'TYPE_POLICY_COMMAND_REUSED', '请求编号已经用于其他内容')
      return typePolicyReceipt.parse(prior.receipt)
    }
    const access = await capabilities(tx, uid)
    if (input.action === 'approve' ? !access.approve : !access.manage) return fail(403, 'TYPE_POLICY_ACTION_FORBIDDEN', '当前职责不能执行此模板操作')
    if ('configuration' in input) await checkRegistrationRoles(tx, input.configuration)
    if (input.action === 'create') await tx.insert(heads).values({ id: randomUUID(), code: typePolicyCode(input.configuration.type), name: typePolicyName(input.configuration.type), enabled: false, nextRevision: 1 }).onDuplicateKeyUpdate({ set: { code: typePolicyCode(input.configuration.type) } })
    const [policy] = await tx.select().from(heads).where(input.action === 'create' ? eq(heads.code, typePolicyCode(input.configuration.type)) : and(eq(heads.id, input.policyId), like(heads.code, 'noninvestment:%'))).limit(1).for('update')
    if (!policy) return fail(404, 'TYPE_POLICY_NOT_FOUND', '非投资模板不存在')
    if ('expectedPolicyVersion' in input && !(input.action === 'create' && input.expectedPolicyVersion === 0 && policy.nextRevision === 1 && policy.version === 1) && policy.version !== input.expectedPolicyVersion) return fail(409, 'VERSION_CONFLICT', '模板已变化，请重新读取并核对')
    const [current] = input.action === 'create' ? [] : await tx.select().from(versions).where(and(eq(versions.id, input.versionId), eq(versions.policyId, policy.id))).for('update')
    const [review] = current ? await tx.select().from(reviews).where(eq(reviews.versionId, current.id)) : []
    if (input.action !== 'create') {
      if (!current || !review) return fail(404, 'TYPE_POLICY_VERSION_NOT_FOUND', '模板版本或审核记录不存在')
      if (current.version !== input.expectedVersion) return fail(409, 'VERSION_CONFLICT', '当前版本已变化')
      configurationFor(current, policy)
    }
    let versionId = current?.id ?? randomUUID(), version = current?.version ?? 1, status: TypePolicyReceipt['status'] = 'draft'
    if (input.action === 'create') {
      await tx.insert(versions).values({ id: versionId, policyId: policy.id, revision: policy.nextRevision, configuration: input.configuration, sha256: policyHash(input.configuration), reason: input.reason, createdBy: uid })
      await tx.insert(reviews).values({ versionId })
      await tx.update(heads).set({ nextRevision: policy.nextRevision + 1 }).where(eq(heads.id, policy.id))
    } else if (input.action === 'save') {
      if (current!.status !== 'draft' || review!.approvedBy) return fail(409, 'TYPE_POLICY_IMMUTABLE', '已审核或发布版本不可编辑，请另建修订')
      if (typePolicyCode(input.configuration.type) !== policy.code) return fail(409, 'TYPE_POLICY_TYPE_IMMUTABLE', '既有模板不能改为另一项目类型')
      version++
      await tx.update(versions).set({ configuration: input.configuration, sha256: policyHash(input.configuration), reason: input.reason, version, updatedAt: new Date() }).where(eq(versions.id, versionId))
    } else if (input.action === 'approve') {
      if (current!.status !== 'draft' || review!.approvedBy) return fail(409, 'TYPE_POLICY_IMMUTABLE', '只能独立审核未批准草稿')
      const [authored] = await tx.select({ id: events.id }).from(events).where(and(eq(events.versionId, versionId), eq(events.actorId, uid), inArray(events.action, ['create', 'save']))).limit(1)
      if (current!.createdBy === uid || authored) return fail(403, 'TYPE_POLICY_SELF_APPROVAL', '参与编制或修订的人不能审核同一版本')
      version++; status = 'approved'
      await tx.update(reviews).set({ approvedBy: uid, approvedAt: new Date(), approvedHash: current!.sha256 }).where(eq(reviews.versionId, versionId))
      await tx.update(versions).set({ version, updatedAt: new Date() }).where(eq(versions.id, versionId))
    } else if (input.action === 'activate' || input.action === 'deactivate') {
      const configuration = configurationFor(current!, policy)
      if (current!.status !== 'published' || policy.activeVersionId !== versionId || !review!.approvedBy || !review!.approvedAt || review!.approvedHash !== current!.sha256) return fail(409, 'TYPE_POLICY_ACTIVATION_REQUIRED', '只能显式启停当前独立审核并发布的版本')
      if (policy.enabled === (input.action === 'activate')) return fail(409, 'TYPE_POLICY_STATE_UNCHANGED', '启停状态已变化，请重新读取')
      if (input.action === 'activate') {
        if (!configuration.registration) return fail(409, 'TYPE_REGISTRATION_POLICY_REQUIRED', '未裁决登记规则，不能启用；请另建修订并独立审核')
        await checkRegistrationRoles(tx, configuration)
        const [authored] = await tx.select({ id: events.id }).from(events).where(and(eq(events.versionId, versionId), eq(events.actorId, review!.approvedBy), inArray(events.action, ['create', 'save']))).limit(1)
        if (current!.createdBy === review!.approvedBy || authored) return fail(409, 'TYPE_POLICY_SELF_APPROVAL', '审核人参与过此版本编制，不能启用')
        if (!await businessApprover(tx, review!.approvedBy)) return fail(409, 'TYPE_POLICY_APPROVER_CHANGED', '审核人资格已失效，不能启用')
      }
      status = 'published'
      await tx.update(heads).set({ enabled: input.action === 'activate' }).where(eq(heads.id, policy.id))
    } else {
      if (current!.status !== 'draft' || !review!.approvedBy || !review!.approvedAt || review!.approvedHash !== current!.sha256) return fail(409, 'TYPE_POLICY_APPROVAL_REQUIRED', '发布前需要独立审核具体内容版本')
      if (!await businessApprover(tx, review!.approvedBy)) return fail(409, 'TYPE_POLICY_APPROVER_CHANGED', '审核人当前资格失效，请另建修订后重新审核')
      version++; status = 'published'
      await tx.update(versions).set({ status, version, publishedBy: uid, publishedAt: new Date(), updatedAt: new Date() }).where(eq(versions.id, versionId))
      // Publishing never activates a definition or migrates existing projects.
      await tx.update(heads).set({ activeVersionId: versionId, enabled: false }).where(eq(heads.id, policy.id))
    }
    await tx.update(heads).set({ version: policy.version + 1 }).where(eq(heads.id, policy.id))
    const activation = input.action === 'activate' || input.action === 'deactivate'
    const receipt = typePolicyReceipt.parse({ commandId: input.commandId, action: input.action, policyId: policy.id, versionId, policyVersion: policy.version + 1, version, status, ...(activation ? { enabled: input.action === 'activate' } : {}) })
    const [after] = await tx.select().from(versions).where(eq(versions.id, versionId))
    await tx.insert(events).values({ policyId: policy.id, versionId, actorId: uid, commandId: input.commandId, action: input.action, reason: input.reason, snapshot: { beforePolicy: policy, beforeVersion: current ?? null, afterVersion: after, receipt, activation } })
    await tx.insert(commands).values({ actorId: uid, commandId: input.commandId, commandHash: hash, receipt })
    await identity.audits.append({ userId: uid, userName: actor.name, module: '非投资流程模板', action: input.action, target: JSON.stringify({ ...receipt, reason: input.reason, existingProjectsUnchanged: true, activation }) })
    return receipt
  }, { isolationLevel: 'read committed' })
}
export async function recoverTypePolicy(uid: string, raw: unknown) {
  const { commandId } = typePolicyRecovery.parse(raw)
  return db.transaction(async tx => {
    const { actor, identity } = await actorContext(tx, uid, true)
    const [prior] = await tx.select().from(commands).where(and(eq(commands.actorId, uid), eq(commands.commandId, commandId)))
    if (prior?.receipt) return { state: 'committed' as const, receipt: typePolicyReceipt.parse(prior.receipt) }
    if (prior && !prior.closedAt) return fail(409, 'TYPE_POLICY_COMMAND_INTEGRITY', '回执不完整，不能认定原操作未提交')
    if (!prior) {
      await tx.insert(commands).values({ actorId: uid, commandId, closedAt: new Date() })
      await identity.audits.append({ userId: uid, userName: actor.name, module: '非投资流程模板', action: '封闭未提交请求', target: JSON.stringify({ commandId, receiptOnly: true }) })
    }
    return { state: 'not_committed' as const, receipt: null }
  }, { isolationLevel: 'read committed' })
}
