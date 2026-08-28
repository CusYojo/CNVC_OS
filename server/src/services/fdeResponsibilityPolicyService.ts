import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { responsibilityPolicies as heads, responsibilityPolicyVersions as versions, responsibilityPolicyCommands as commands, responsibilityPolicyEvents as events, roles, userRoles, users } from '../db/schema.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { policyHash } from './fdeWorkflowPolicyService.js'
import { responsibilityPolicyCommand, responsibilityPolicyReceipt, responsibilityPolicyRecovery, responsibilityPolicySchema, type ResponsibilityPolicyReceipt } from '../contracts/fdeResponsibilityPolicyContract.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>
const code = 'responsibility'
const fail = (status: number, errorCode: string, message: string): never => { throw Object.assign(new Error(message), { status, code: errorCode }) }

async function businessApprover(reader: Reader, userId: string) {
  const [row] = await reader.select({ id: users.id }).from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id)).innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(users.id, userId), eq(users.status, '启用'), eq(roles.status, '启用'), eq(roles.fdeCategory, 'institution_leader'))).limit(1)
  return Boolean(row)
}

async function actorContext(tx: Tx, actorId: string, lock: boolean) {
  const identity = createMySqlIdentityRepositoryContext(tx)
  const actor = lock ? await identity.users.lockById(actorId) : await identity.users.findById(actorId)
  if (!actor || actor.status !== '启用') return fail(403, 'RESP_ACTOR_FORBIDDEN', '账号不可用，请重新登录')
  return { identity, actor }
}

async function capabilities(tx: Tx, actorId: string) {
  const { identity } = await actorContext(tx, actorId, false)
  const manage = (await identity.users.listPermissionCodes(actorId)).includes('system.manage')
  const approve = await businessApprover(tx, actorId)
  if (!manage && !approve) return fail(403, 'RESP_POLICY_FORBIDDEN', '仅授权配置人员或机构业务审批人可访问责任规则')
  return { manage, approve }
}

function configurationFor(version: typeof versions.$inferSelect) {
  const config = responsibilityPolicySchema.parse(version.configuration)
  if (policyHash(config) !== version.sha256) return fail(409, 'RESP_POLICY_INTEGRITY', '规则内容与版本哈希不一致，已阻止使用')
  return config
}

async function describeVersions(tx: Tx, rows: Array<typeof versions.$inferSelect>, actorId: string, access: { manage: boolean; approve: boolean }) {
  if (!rows.length) return []
  const ids = [...new Set(rows.flatMap(row => [row.createdBy, row.lastEditedBy, row.approvedBy, row.publishedBy].filter((id): id is string => Boolean(id))))]
  const names = new Map((await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map(row => [row.id, row.name]))
  const authored = new Set((await tx.select({ id: events.versionId }).from(events).where(and(inArray(events.versionId, rows.map(row => row.id)), eq(events.actorId, actorId), sql`${events.action} IN ('create','save')`))).map(row => row.id))
  return Promise.all(rows.map(async row => ({
    ...row, configuration: configurationFor(row),
    createdByName: names.get(row.createdBy) ?? row.createdBy, lastEditedByName: names.get(row.lastEditedBy) ?? row.lastEditedBy,
    approvedByName: row.approvedBy ? names.get(row.approvedBy) ?? row.approvedBy : null, publishedByName: row.publishedBy ? names.get(row.publishedBy) ?? row.publishedBy : null,
    capabilities: {
      save: access.manage && row.status === 'draft',
      approve: access.approve && row.status === 'draft' && !authored.has(row.id) && row.createdBy !== actorId && row.lastEditedBy !== actorId,
      publish: access.manage && row.status === 'approved' && Boolean(row.approvedBy && await businessApprover(tx, row.approvedBy)) && row.configuration.rules.some(rule => rule.enabled),
    },
  })))
}

async function currentView(tx: Tx, actorId: string, access: { manage: boolean; approve: boolean }) {
  const [policy] = await tx.select().from(heads).where(eq(heads.code, code))
  const [active] = policy?.activeVersionId ? await tx.select().from(versions).where(and(eq(versions.id, policy.activeVersionId), eq(versions.policyCode, code))) : []
  if (policy?.activeVersionId && (!active || active.status !== 'published')) return fail(409, 'RESP_POLICY_INTEGRITY', '当前发布规则缺失或状态异常')
  return { policy: policy ?? null, capabilities: access, activeVersion: active ? (await describeVersions(tx, [active], actorId, access))[0] : null }
}

export async function getCurrentResponsibilityPolicy(actorId: string) {
  return db.transaction(async tx => currentView(tx, actorId, await capabilities(tx, actorId)), { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function listResponsibilityPolicies(actorId: string, rawQuery: unknown = {}) {
  const query = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), eventPage: z.coerce.number().int().min(1).max(100000).default(1) }).strict().parse(rawQuery)
  return db.transaction(async tx => {
    const access = await capabilities(tx, actorId)
    const current = await currentView(tx, actorId, access)
    const rows = await tx.select().from(versions).where(eq(versions.policyCode, code)).orderBy(desc(versions.revision)).limit(21).offset((query.page - 1) * 20)
    const history = await tx.select().from(events).where(eq(events.policyCode, code)).orderBy(desc(events.createdAt), desc(events.id)).limit(21).offset((query.eventPage - 1) * 20)
    const actorIds = [...new Set(history.map(row => row.actorId))]
    const actorNames = new Map(actorIds.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, actorIds))).map(row => [row.id, row.name]) : [])
    // Historical configuration is only visible to the same authorized policy
    // audience. This endpoint grants no project, file or personnel-record access.
    return { ...current, versions: await describeVersions(tx, rows.slice(0, 20), actorId, access), events: history.slice(0, 20).map(row => ({ ...row, actorName: actorNames.get(row.actorId) ?? row.actorId })), page: query.page, eventPage: query.eventPage, hasMore: rows.length > 20, eventsHaveMore: history.length > 20, productionScoringImplemented: false }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export async function getResponsibilityPolicyVersion(actorId: string, id: string) {
  z.string().uuid().parse(id)
  return db.transaction(async tx => {
    const access = await capabilities(tx, actorId)
    const [version] = await tx.select().from(versions).where(and(eq(versions.id, id), eq(versions.policyCode, code)))
    if (!version) return fail(404, 'RESP_POLICY_NOT_FOUND', '责任规则版本不存在')
    return (await describeVersions(tx, [version], actorId, access))[0]
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

// Future responsibility consumers must call this while holding their source
// transaction, then store the exact returned version/hash with their event.
// Missing/unpublished/disabled policies are a no-op, never a task error.
export async function activeResponsibilityPolicy(tx: Tx, occurredAt: Date) {
  if (!Number.isFinite(occurredAt.getTime())) return fail(400, 'RESP_EVENT_TIME_INVALID', '责任事件时间无效')
  const [policy] = await tx.select().from(heads).where(eq(heads.code, code)).limit(1).for('update')
  if (!policy?.enabled || !policy.activeVersionId) return null
  const [version] = await tx.select().from(versions).where(and(eq(versions.id, policy.activeVersionId), eq(versions.policyCode, code)))
  if (!version || version.status !== 'published' || !version.approvedBy || !version.publishedAt) return fail(409, 'RESP_POLICY_INTEGRITY', '当前责任规则未正确批准发布')
  // Publication and activation are different business events. In particular,
  // re-enabling must not score events that happened during the disabled period.
  // The domain event is committed atomically with the head. Order by the
  // monotonic policy version, not timestamp/UUID ties within one millisecond.
  const [activation] = await tx.select().from(events).where(and(eq(events.policyCode, code), eq(events.action, 'toggle')))
    .orderBy(desc(sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${events.snapshot}, '$.afterPolicy.version')) AS UNSIGNED)`)).limit(1)
  const activatedHead = z.object({ activeVersionId: z.string().uuid(), enabled: z.literal(true), version: z.number().int().positive() }).safeParse(activation?.snapshot.afterPolicy)
  if (!activation || !activatedHead.success || activatedHead.data.activeVersionId !== version.id || activatedHead.data.version > policy.version) return fail(409, 'RESP_POLICY_INTEGRITY', '责任规则启用事件缺失或与当前版本不一致')
  const effectiveFrom = new Date(Math.max(version.publishedAt.getTime(), activation.createdAt.getTime()))
  if (occurredAt < effectiveFrom) return null
  return { id: version.id, revision: version.revision, sha256: version.sha256, configuration: configurationFor(version), effectiveFrom, activationEventId: activation.id }
}

export async function executeResponsibilityPolicyCommand(actorId: string, raw: unknown) {
  const input = responsibilityPolicyCommand.parse(raw), hash = policyHash(input)
  return db.transaction(async tx => {
    // User-row lock is also used by recovery, so a reliable "not committed"
    // response seals out a request arriving later. No browser payload replay.
    const { actor, identity } = await actorContext(tx, actorId, true)
    const [prior] = await tx.select().from(commands).where(and(eq(commands.actorId, actorId), eq(commands.commandId, input.commandId)))
    if (prior) {
      if (prior.closedAt) return fail(409, 'RESP_COMMAND_CLOSED', '原请求已确认未提交并封闭，请读取最新状态后重新确认')
      if (prior.commandHash !== hash) return fail(409, 'RESP_COMMAND_REUSED', '请求编号已用于不同动作或内容')
      return responsibilityPolicyReceipt.parse(prior.receipt)
    }
    const access = await capabilities(tx, actorId)
    if (input.action === 'approve' ? !access.approve : !access.manage) return fail(403, 'RESP_POLICY_ACTION_FORBIDDEN', '当前职责不能执行此规则操作')
    await tx.insert(heads).values({ code }).onDuplicateKeyUpdate({ set: { code } })
    const [policy] = await tx.select().from(heads).where(eq(heads.code, code)).limit(1).for('update')
    if ('expectedPolicyVersion' in input) {
      const fresh = input.action === 'create' && input.expectedPolicyVersion === 0 && policy.nextRevision === 1 && policy.version === 1
      if (!fresh && policy.version !== input.expectedPolicyVersion) return fail(409, 'VERSION_CONFLICT', '责任规则已变化，请刷新后重新确认')
    }
    const current = 'versionId' in input ? (await tx.select().from(versions).where(and(eq(versions.id, input.versionId), eq(versions.policyCode, code))).limit(1).for('update'))[0] : null
    if ('versionId' in input) {
      if (!current) return fail(404, 'RESP_POLICY_NOT_FOUND', '责任规则版本不存在')
      if (current.version !== input.expectedDraftVersion) return fail(409, 'VERSION_CONFLICT', '责任规则版本已变化')
      configurationFor(current)
    }
    let versionId = current?.id ?? null, draftVersion = current?.version ?? null
    let status: ResponsibilityPolicyReceipt['status'] = 'draft'
    let snapshot: Record<string, unknown> = { beforePolicy: policy, beforeVersion: current }
    if (input.action === 'create') {
      const [created] = await tx.insert(versions).values({ policyCode: code, revision: policy.nextRevision, configuration: input.configuration, sha256: policyHash(input.configuration), reason: input.reason, createdBy: actorId, lastEditedBy: actorId }).$returningId()
      versionId = created.id; draftVersion = 1
      await tx.update(heads).set({ nextRevision: policy.nextRevision + 1 }).where(eq(heads.code, code))
      snapshot = { ...snapshot, configuration: input.configuration, sha256: policyHash(input.configuration), revision: policy.nextRevision }
    } else if (input.action === 'save') {
      if (current!.status !== 'draft') return fail(409, 'RESP_POLICY_IMMUTABLE', '批准或发布后的版本不可修改，请另建草稿')
      draftVersion = current!.version + 1
      await tx.update(versions).set({ configuration: input.configuration, sha256: policyHash(input.configuration), reason: input.reason, lastEditedBy: actorId, version: draftVersion }).where(eq(versions.id, current!.id))
      snapshot = { ...snapshot, configuration: input.configuration, sha256: policyHash(input.configuration) }
    } else if (input.action === 'approve') {
      if (current!.status !== 'draft') return fail(409, 'RESP_POLICY_IMMUTABLE', '只能批准尚未批准的草稿')
      const [authored] = await tx.select({ id: events.id }).from(events).where(and(eq(events.versionId, current!.id), eq(events.actorId, actorId), sql`${events.action} IN ('create','save')`)).limit(1)
      if (authored || current!.createdBy === actorId || current!.lastEditedBy === actorId) return fail(403, 'RESP_POLICY_SELF_APPROVAL', '规则编制或修订人不能批准本人参与编制的版本')
      status = 'approved'; draftVersion = current!.version + 1
      await tx.update(versions).set({ status, approvedBy: actorId, approvedAt: new Date(), reason: input.reason, version: draftVersion }).where(eq(versions.id, current!.id))
    } else if (input.action === 'publish') {
      if (current!.status !== 'approved' || !current!.approvedBy || !current!.approvedAt) return fail(409, 'RESP_POLICY_APPROVAL_REQUIRED', '发布前必须由独立机构业务审批人批准具体版本')
      if (!await businessApprover(tx, current!.approvedBy)) return fail(409, 'RESP_POLICY_APPROVER_CHANGED', '原批准人已停用或失去业务审批职责，请重新编制并批准')
      if (!current!.configuration.rules.some(rule => rule.enabled)) return fail(409, 'RESP_POLICY_NO_ENABLED_RULE', '全部事件停用的草稿不能发布为生效规则')
      status = 'published'; draftVersion = current!.version + 1
      await tx.update(versions).set({ status, publishedBy: actorId, publishedAt: new Date(), reason: input.reason, version: draftVersion }).where(eq(versions.id, current!.id))
      // Publish does not enable scoring. Enabling is a separate, explicit action.
      await tx.update(heads).set({ activeVersionId: current!.id, enabled: false }).where(eq(heads.code, code))
    } else {
      if (input.enabled) {
        const [active] = policy.activeVersionId ? await tx.select().from(versions).where(and(eq(versions.id, policy.activeVersionId), eq(versions.policyCode, code))) : []
        if (!active || active.status !== 'published' || !active.approvedBy || !active.publishedAt) return fail(409, 'RESP_POLICY_APPROVAL_REQUIRED', '未批准发布的责任规则不能启用')
        configurationFor(active)
      }
      status = input.enabled ? 'enabled' : 'disabled'
      await tx.update(heads).set({ enabled: input.enabled }).where(eq(heads.code, code))
    }
    await tx.update(heads).set({ version: policy.version + 1 }).where(eq(heads.code, code))
    const receipt = responsibilityPolicyReceipt.parse({ commandId: input.commandId, action: input.action, policyVersion: policy.version + 1, versionId, draftVersion, status })
    const [afterPolicy] = await tx.select().from(heads).where(eq(heads.code, code))
    const [afterVersion] = versionId ? await tx.select().from(versions).where(eq(versions.id, versionId)) : []
    await tx.insert(events).values({ policyCode: code, versionId, actorId, commandId: input.commandId, action: input.action, reason: input.reason, snapshot: { ...snapshot, afterPolicy, afterVersion: afterVersion ?? null } })
    await tx.insert(commands).values({ actorId, commandId: input.commandId, commandHash: hash, receipt })
    await identity.audits.append({ userId: actorId, userName: actor.name, module: '责任规则', action: input.action, target: JSON.stringify({ policyCode: code, versionId, commandId: input.commandId, policyVersion: receipt.policyVersion, reason: input.reason, historicalRescore: false }) })
    return receipt
  }, { isolationLevel: 'read committed' })
}

export async function recoverResponsibilityPolicyCommand(actorId: string, raw: unknown) {
  const { commandId } = responsibilityPolicyRecovery.parse(raw)
  return db.transaction(async tx => {
    const { actor, identity } = await actorContext(tx, actorId, true)
    const [prior] = await tx.select().from(commands).where(and(eq(commands.actorId, actorId), eq(commands.commandId, commandId)))
    if (prior?.receipt) return { state: 'committed' as const, receipt: responsibilityPolicyReceipt.parse(prior.receipt) }
    if (prior && !prior.closedAt) return fail(409, 'RESP_COMMAND_INTEGRITY', '请求回执状态异常，需人工核对，不能断言未提交')
    if (!prior) {
      await tx.insert(commands).values({ actorId, commandId, closedAt: new Date() })
      await identity.audits.append({ userId: actorId, userName: actor.name, module: '责任规则', action: '封闭未提交请求', target: JSON.stringify({ commandId, policyCode: code, receiptOnly: true }) })
    }
    return { state: 'not_committed' as const, receipt: null }
  }, { isolationLevel: 'read committed' })
}
