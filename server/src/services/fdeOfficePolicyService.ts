import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { departments, oaOfficePolicies as policies, oaOfficePolicyVersions as versions, oaOfficePolicyCommands as commands, roles, users } from '../db/schema.js'
import { officePolicyCommandTarget, officePolicyReceipt, type OfficePolicyCommandTarget, type OfficePolicyReceipt } from '../contracts/fdeOfficePolicyCommandContract.js'
import { officePolicyConfig, officeRoute, type OfficeDefinition, type OfficeNodeRule } from '../contracts/fdeOfficeContract.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { policyHash } from './fdeWorkflowPolicyService.js'
import { officeActor, officeFail, officeProject, officeRoleEligible, type OfficeReader, type OfficeTx } from './fdeOfficeAccessService.js'

export const officePolicySave = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().min(0), configuration: officePolicyConfig, reason: z.string().trim().min(5).max(2000) }).strict()
async function lockPolicyCommand(tx: OfficeTx, userId: string, target: OfficePolicyCommandTarget) {
  const identity = createMySqlIdentityRepositoryContext(tx), actor = await identity.users.lockById(userId)
  if (!actor || actor.status !== '启用') return officeFail('OFFICE_ACTOR_UNAVAILABLE', '当前账号不可用', 403)
  // User -> command -> policy -> version. Taking the user lock before the
  // command's actor FK prevents shared-to-exclusive upgrades in admin races.
  await tx.insert(commands).values({ actorId: userId, commandId: target.clientRequestId, targetId: target.id, action: target.action })
    .onDuplicateKeyUpdate({ set: { id: sql`${commands.id}` } })
  const [command] = await tx.select().from(commands).where(and(eq(commands.actorId, userId), eq(commands.commandId, target.clientRequestId))).for('update')
  if (command.targetId !== target.id || command.action !== target.action) return officeFail('OFFICE_POLICY_COMMAND_REUSED', '规则请求编号已绑定其他目标或动作')
  return { command, actor, identity }
}
async function withPolicyCommand(target: OfficePolicyCommandTarget, userId: string, input: unknown, work: (tx: OfficeTx) => Promise<OfficePolicyReceipt>) {
  return db.transaction(async tx => {
    const { command } = await lockPolicyCommand(tx, userId, target), hash = policyHash(input)
    if (command.closedAt) return officeFail('OFFICE_POLICY_COMMAND_CLOSED', '旧规则请求已封闭，请核对当前版本后重新确认')
    if (command.receipt) {
      if (command.commandHash !== hash) return officeFail('OFFICE_POLICY_COMMAND_REUSED', '规则请求编号不能用于不同内容')
      return officePolicyReceipt.parse(command.receipt)
    }
    const receipt = officePolicyReceipt.parse(await work(tx))
    await tx.update(commands).set({ commandHash: hash, receipt, completedAt: new Date() }).where(eq(commands.id, command.id))
    return receipt
  }, { isolationLevel: 'read committed' })
}
export async function resolveOfficePolicyCommand(userId: string, raw: unknown) {
  const target = officePolicyCommandTarget.parse(raw)
  return db.transaction(async tx => {
    const { command, actor, identity } = await lockPolicyCommand(tx, userId, target)
    if (command.receipt) return { state: 'committed' as const, receipt: officePolicyReceipt.parse(command.receipt) }
    if (!command.closedAt) {
      await tx.update(commands).set({ closedAt: new Date() }).where(eq(commands.id, command.id))
      await identity.audits.append({ userId, userName: actor.name, module: '通用OA规则', action: '核对未提交并封闭请求', target: `${target.id} / ${target.action} / ${target.clientRequestId}` })
    }
    return { state: 'not_applied' as const }
  }, { isolationLevel: 'read committed' })
}
async function administrator(tx: OfficeTx, userId: string) {
  const identity = createMySqlIdentityRepositoryContext(tx), actor = await identity.users.lockById(userId)
  if (!actor || actor.status !== '启用' || !(await identity.users.listPermissionCodes(userId)).includes('system.manage')) return officeFail('OFFICE_POLICY_FORBIDDEN', '仅系统管理授权人可维护规则', 403)
  return { identity, actor }
}
async function validateRoles(tx: OfficeTx, raw: z.infer<typeof officePolicyConfig>) {
  const ids = [...new Set([...raw.routes.flatMap(r => r.nodes.flatMap(n => n.roleIds)), ...(raw.execution?.roleIds ?? [])])]
  const found = await tx.select().from(roles).where(and(inArray(roles.id, ids), eq(roles.status, '启用')))
  if (found.length !== ids.length || found.some(r => !r.fdeCategory || r.fdeCategory === 'system_admin')) return officeFail('OFFICE_POLICY_ROLE_INVALID', '审批角色必须为启用的稳定业务岗位')
  const departmentIds = [...new Set(raw.routes.flatMap(r => r.when.departmentIds ?? []))]
  if (departmentIds.length && (await tx.select().from(departments).where(and(inArray(departments.id, departmentIds), eq(departments.status, '启用')))).length !== departmentIds.length) return officeFail('OFFICE_POLICY_DEPARTMENT_INVALID', '路由部门须为启用的稳定组织')
  for (const route of raw.routes) for (const node of route.nodes) for (const uid of node.fixedUserIds) {
    const person = await officeActor(tx, uid)
    if (!person.roleIds.some(id => node.roleIds.includes(id))) return officeFail('OFFICE_POLICY_PERSON_INVALID', '指定审批人必须具有节点的有效岗位')
  }
  for (const uid of raw.execution?.userIds ?? []) {
    const person = await officeActor(tx, uid)
    if (!person.roleIds.some(role => raw.execution!.roleIds.includes(role))) return officeFail('OFFICE_EXECUTION_PERSON_INVALID', '执行账号须明确具有配置的有效业务岗位，审批身份或管理员身份不代替执行授权')
  }
}
export async function saveOfficePolicy(id: string, userId: string, raw: unknown) {
  const input = officePolicySave.parse(raw)
  return withPolicyCommand({ id, action: 'save', clientRequestId: input.clientRequestId }, userId, input, async tx => {
    const { identity, actor } = await administrator(tx, userId)
    await validateRoles(tx, input.configuration)
    await tx.insert(policies).values({ id: randomUUID(), kind: input.configuration.kind }).onDuplicateKeyUpdate({ set: { kind: input.configuration.kind } })
    const [policy] = await tx.select().from(policies).where(eq(policies.kind, input.configuration.kind)).for('update')
    const [prior] = await tx.select().from(versions).where(eq(versions.id, id)).for('update')
    if (input.expectedVersion === 0) {
      if (prior) return officeFail('OFFICE_POLICY_EXISTS', '规则版本已存在，请打开原版本')
      await tx.insert(versions).values({ id, policyId: policy.id, revision: policy.nextRevision, configuration: input.configuration, sha256: policyHash(input.configuration), createdBy: userId, reason: input.reason })
      await tx.update(policies).set({ nextRevision: policy.nextRevision + 1, version: policy.version + 1 }).where(eq(policies.id, policy.id))
    } else {
      if (!prior || prior.policyId !== policy.id || prior.status !== 'draft') return officeFail('OFFICE_POLICY_IMMUTABLE', '只能编辑本类型的草稿规则')
      if (prior.version !== input.expectedVersion) return officeFail('VERSION_CONFLICT', '规则草稿版本已变化')
      await tx.update(versions).set({ configuration: input.configuration, sha256: policyHash(input.configuration), reason: input.reason, version: prior.version + 1 }).where(eq(versions.id, id))
    }
    await identity.audits.append({ userId, userName: actor.name, module: '通用OA规则', action: '保存草稿', target: `${id} / ${input.reason}` })
    return { id, action: 'save', policyId: policy.id, version: prior ? prior.version + 1 : 1, policyVersion: policy.version + (prior ? 0 : 1), status: 'draft', enabled: policy.enabled }
  })
}
export async function publishOfficePolicy(id: string, userId: string, raw: unknown) {
  const input = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), expectedPolicyVersion: z.number().int().positive(), reason: z.string().trim().min(5).max(2000) }).strict().parse(raw)
  return withPolicyCommand({ id, action: 'publish', clientRequestId: input.clientRequestId }, userId, input, async tx => {
    const { identity, actor } = await administrator(tx, userId)
    const [initial] = await tx.select().from(versions).where(eq(versions.id, id))
    if (!initial) return officeFail('OFFICE_POLICY_MISSING', '规则版本不存在', 404)
    const [policy] = await tx.select().from(policies).where(eq(policies.id, initial.policyId)).for('update')
    const [version] = await tx.select().from(versions).where(eq(versions.id, id)).for('update')
    if (version.status !== 'draft' || version.version !== input.expectedVersion || policy.version !== input.expectedPolicyVersion) return officeFail('VERSION_CONFLICT', '规则或草稿已变化，请重新预览')
    const config = officePolicyConfig.parse(version.configuration)
    if (policyHash(config) !== version.sha256) return officeFail('OFFICE_POLICY_INTEGRITY', '规则哈希不一致')
    await validateRoles(tx, config)
    await tx.update(versions).set({ status: 'published', publishedBy: userId, publishedAt: new Date(), version: version.version + 1, reason: input.reason }).where(eq(versions.id, id))
    await tx.update(policies).set({ activeVersionId: id, enabled: true, version: policy.version + 1 }).where(eq(policies.id, policy.id))
    await identity.audits.append({ userId, userName: actor.name, module: '通用OA规则', action: '发布规则', target: `${id} / 仅影响下一次明确提交 / ${input.reason}` })
    return { id, action: 'publish', policyId: policy.id, version: version.version + 1, policyVersion: policy.version + 1, status: 'published', enabled: true }
  })
}
export async function listOfficePolicies(userId: string) {
  return db.transaction(async tx => {
    await administrator(tx, userId)
    const heads = await tx.select().from(policies), all = await tx.select().from(versions).orderBy(desc(versions.revision))
    return heads.map(p => ({ ...p, versions: all.filter(v => v.policyId === p.id) }))
  })
}
export async function pinnedOfficePolicy(reader: OfficeReader, versionId: string | null) {
  const [row] = versionId ? await reader.select().from(versions).where(eq(versions.id, versionId)) : []
  if (!row || row.status !== 'published') return officeFail('OFFICE_POLICY_UNAVAILABLE', '审批所绑定规则不可用')
  const configuration = officePolicyConfig.parse(row.configuration)
  if (policyHash(configuration) !== row.sha256) return officeFail('OFFICE_POLICY_INTEGRITY', '审批规则哈希不一致')
  return { ...row, configuration }
}
export async function resolveOfficeRoute(tx: OfficeTx, definition: OfficeDefinition, userId: string, lock = false) {
  const actor = await officeActor(tx, userId)
  const query = tx.select().from(policies).where(eq(policies.kind, definition.details.kind))
  const [head] = lock ? await query.for('update') : await query
  if (!head?.enabled || !head.activeVersionId) return officeFail('OFFICE_POLICY_NOT_PUBLISHED', '该类型尚未配置已发布审批规则')
  const policy = await pinnedOfficePolicy(tx, head.activeVersionId)
  const route = officeRoute(definition, policy.configuration, actor.departmentIds)
  const all = await tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.status, '启用'))
  const used = new Set([userId]), resolved: Array<{ rule: OfficeNodeRule; userIds: string[]; names: string[] }> = []
  for (const rule of route.nodes) {
    const candidates = []
    for (const person of all) {
      if (used.has(person.id) || (rule.fixedUserIds.length && !rule.fixedUserIds.includes(person.id)) || !await officeRoleEligible(tx, person.id, rule, actor.departmentIds)) continue
      try { await officeProject(tx, person.id, definition.projectId); candidates.push(person) } catch (error) { if ((error as { code?: string }).code !== 'OFFICE_PROJECT_FORBIDDEN') throw error }
    }
    candidates.sort((a, b) => a.id.localeCompare(b.id))
    if (!candidates.length) return officeFail('OFFICE_APPROVER_MISSING', `节点“${rule.name}”缺少不同于申请人及前序节点的有效审批账号`)
    const selected = candidates
    selected.forEach(p => used.add(p.id))
    resolved.push({ rule, userIds: selected.map(p => p.id), names: selected.map(p => p.name) })
  }
  const departmentIds = [...actor.departmentIds].sort()
  const routeHash = policyHash({ policyVersionId: policy.id, policyHash: policy.sha256, routeKey: route.key, nodes: resolved, departmentIds })
  return { policy, routeKey: route.key, nodes: resolved, departmentIds, routeHash }
}

export async function setOfficePolicyEnabled(id: string, userId: string, raw: unknown) {
  const input = z.object({ clientRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), enabled: z.boolean(), reason: z.string().trim().min(5).max(2000) }).strict().parse(raw)
  return withPolicyCommand({ id, action: 'enabled', clientRequestId: input.clientRequestId }, userId, input, async tx => {
    const { identity, actor } = await administrator(tx, userId)
    const [policy] = await tx.select().from(policies).where(eq(policies.id, id)).for('update')
    if (!policy || policy.version !== input.expectedVersion) return officeFail('VERSION_CONFLICT', '规则已变化，请刷新')
    if (input.enabled) await pinnedOfficePolicy(tx, policy.activeVersionId)
    await tx.update(policies).set({ enabled: input.enabled, version: policy.version + 1 }).where(eq(policies.id, id))
    await identity.audits.append({ userId, userName: actor.name, module: '通用OA规则', action: input.enabled ? '启用' : '停用', target: `${id} / ${input.reason}` })
    return { id, action: 'enabled', policyId: id, version: policy.version + 1, policyVersion: policy.version + 1, enabled: input.enabled }
  })
}
