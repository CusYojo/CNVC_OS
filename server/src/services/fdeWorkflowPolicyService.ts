import { createHash } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { fdeWorkflowPolicies, fdeWorkflowPolicyVersions, projects } from '../db/schema.js'
import { fdeWorkflowPolicySchema, fdeWorkflowPolicySnapshotSchema, type FdeWorkflowPolicyConfig } from '../contracts/fdeWorkflowPolicyContract.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import type { SystemAdministrator } from './systemAdministrationService.js'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>
const failure = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code })
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
export const policyHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')

async function requireAdministrator(tx: Transaction, actor: SystemAdministrator) {
  const identity = createMySqlIdentityRepositoryContext(tx)
  const user = await identity.users.lockById(actor.userId)
  if (!user || user.status !== '启用' || !(await identity.users.listPermissionCodes(user.id)).includes('system.manage')) throw failure(403, 'ROLE_FORBIDDEN', '仅管理员可以管理流程规则')
  return { identity, user }
}

export async function getProjectWorkflowPolicy(reader: Reader, project: { workflowPolicyVersionId: string | null; projectType?: string }) {
  if (project.projectType && project.projectType !== '投资项目') throw failure(409, 'FDE_TYPE_EXECUTION_REQUIRED', '非投资项目必须使用独立类型执行流程，不能套用投资模板')
  if (!project.workflowPolicyVersionId) throw failure(409, 'FDE_POLICY_NOT_BOUND', '项目尚未绑定批准的流程规则版本')
  const [version] = await reader.select().from(fdeWorkflowPolicyVersions).where(eq(fdeWorkflowPolicyVersions.id, project.workflowPolicyVersionId)).limit(1)
  if (!version || version.status !== 'published') throw failure(409, 'FDE_POLICY_NOT_PUBLISHED', '项目规则版本不可用')
  const configuration = fdeWorkflowPolicySchema.parse(version.configuration)
  if (policyHash(configuration) !== version.sha256) throw failure(409, 'FDE_POLICY_INTEGRITY_FAILED', '流程规则哈希不一致，已阻止业务推进')
  return { id: version.id, revision: version.revision, configuration }
}

export async function activeWorkflowPolicyVersion(tx: Transaction) {
  // 与发布锁定同一主记录，创建事务只能绑定发布前或发布后的一个完整版本。
  const [policy] = await tx.select().from(fdeWorkflowPolicies).where(eq(fdeWorkflowPolicies.code, 'investment')).limit(1).for('update')
  if (!policy?.enabled || !policy.activeVersionId) throw failure(409, 'FDE_POLICY_DISABLED', '投资流程模板已停用或未发布，不能创建新项目')
  await getProjectWorkflowPolicy(tx, { workflowPolicyVersionId: policy.activeVersionId })
  return policy.activeVersionId
}

export async function listFdeWorkflowPolicies() {
  const policies = await db.select().from(fdeWorkflowPolicies).where(sql`${fdeWorkflowPolicies.code} NOT LIKE 'noninvestment:%'`)
  const versions = await db.select({ version: fdeWorkflowPolicyVersions }).from(fdeWorkflowPolicyVersions).innerJoin(fdeWorkflowPolicies, eq(fdeWorkflowPolicies.id, fdeWorkflowPolicyVersions.policyId)).where(sql`${fdeWorkflowPolicies.code} NOT LIKE 'noninvestment:%'`).orderBy(desc(fdeWorkflowPolicyVersions.revision))
  const counts = await db.select({ versionId: projects.workflowPolicyVersionId, total: sql<number>`COUNT(*)` }).from(projects).groupBy(projects.workflowPolicyVersionId)
  return policies.map((policy) => ({ ...policy, versions: versions.map(row => row.version).filter((version) => version.policyId === policy.id).map((version) => ({
    ...version,
    // Historical rows are immutable audit evidence. Return the original JSON even
    // when it predates the current shape; execution and draft creation stay strict.
    configuration: version.configuration as FdeWorkflowPolicyConfig,
    configurationValid: fdeWorkflowPolicySnapshotSchema.safeParse(version.configuration).success,
    boundProjects: Number(counts.find((count) => count.versionId === version.id)?.total ?? 0),
  })) }))
}

export async function createFdePolicyDraft(policyId: string, input: { sourceVersionId: string; expectedVersion: number; reason: string }, actor: SystemAdministrator) {
  return db.transaction(async (tx) => {
    const { identity, user } = await requireAdministrator(tx, actor)
    const [policy] = await tx.select().from(fdeWorkflowPolicies).where(eq(fdeWorkflowPolicies.id, policyId)).limit(1).for('update')
    if (!policy) throw failure(404, 'FDE_POLICY_NOT_FOUND', '流程模板不存在')
    if (policy.code.startsWith('noninvestment:')) throw failure(409, 'FDE_TYPE_POLICY_ENDPOINT_REQUIRED', '非投资模板须通过独立审核与版本命令管理')
    if (policy.version !== input.expectedVersion) throw failure(409, 'VERSION_CONFLICT', '模板已变更，请刷新')
    const [source] = await tx.select().from(fdeWorkflowPolicyVersions).where(and(eq(fdeWorkflowPolicyVersions.id, input.sourceVersionId), eq(fdeWorkflowPolicyVersions.policyId, policyId))).limit(1)
    if (!source) throw failure(404, 'FDE_POLICY_VERSION_NOT_FOUND', '源版本不存在')
    const configuration = fdeWorkflowPolicySchema.parse(source.configuration)
    const [created] = await tx.insert(fdeWorkflowPolicyVersions).values({ policyId, revision: policy.nextRevision, configuration, sha256: policyHash(configuration), reason: input.reason, createdBy: user.id }).$returningId()
    await tx.update(fdeWorkflowPolicies).set({ nextRevision: policy.nextRevision + 1, version: policy.version + 1 }).where(eq(fdeWorkflowPolicies.id, policyId))
    await identity.audits.append({ userId: user.id, userName: user.name, module: 'FDE模板与规则', action: '创建规则草稿', target: JSON.stringify({ policyId, versionId: created.id, sourceVersionId: source.id, revision: policy.nextRevision, reason: input.reason }) })
    return created
  })
}

export async function saveFdePolicyDraft(id: string, input: { expectedVersion: number; configuration: FdeWorkflowPolicyConfig; reason: string }, actor: SystemAdministrator) {
  const configuration = fdeWorkflowPolicySchema.parse(input.configuration)
  return db.transaction(async (tx) => {
    const { identity, user } = await requireAdministrator(tx, actor)
    const [current] = await tx.select().from(fdeWorkflowPolicyVersions).where(eq(fdeWorkflowPolicyVersions.id, id)).limit(1).for('update')
    if (!current) throw failure(404, 'FDE_POLICY_VERSION_NOT_FOUND', '规则版本不存在')
    const [policy] = await tx.select().from(fdeWorkflowPolicies).where(eq(fdeWorkflowPolicies.id, current.policyId))
    if (!policy || policy.code.startsWith('noninvestment:')) throw failure(409, 'FDE_TYPE_POLICY_ENDPOINT_REQUIRED', '非投资模板不能通过投资规则入口编辑')
    if (current.status !== 'draft') throw failure(409, 'FDE_POLICY_IMMUTABLE', '已发布版本不可修改，请创建新草稿')
    if (current.version !== input.expectedVersion) throw failure(409, 'VERSION_CONFLICT', '草稿已被修改，请刷新')
    const sha256 = policyHash(configuration)
    await tx.update(fdeWorkflowPolicyVersions).set({ configuration, sha256, reason: input.reason, version: current.version + 1, updatedAt: new Date() }).where(eq(fdeWorkflowPolicyVersions.id, id))
    await identity.audits.append({ userId: user.id, userName: user.name, module: 'FDE模板与规则', action: '保存规则草稿', target: JSON.stringify({ versionId: id, beforeHash: current.sha256, afterHash: sha256, reason: input.reason }) })
    return { id, version: current.version + 1 }
  })
}

export async function publishFdePolicyVersion(policyId: string, input: { versionId: string; expectedPolicyVersion: number; expectedDraftVersion: number; reason: string }, actor: SystemAdministrator) {
  return db.transaction(async (tx) => {
    const { identity, user } = await requireAdministrator(tx, actor)
    const [policy] = await tx.select().from(fdeWorkflowPolicies).where(eq(fdeWorkflowPolicies.id, policyId)).limit(1).for('update')
    const [draft] = await tx.select().from(fdeWorkflowPolicyVersions).where(and(eq(fdeWorkflowPolicyVersions.id, input.versionId), eq(fdeWorkflowPolicyVersions.policyId, policyId))).limit(1).for('update')
    if (!policy || !draft) throw failure(404, 'FDE_POLICY_VERSION_NOT_FOUND', '模板或草稿不存在')
    if (policy.code.startsWith('noninvestment:')) throw failure(409, 'FDE_TYPE_POLICY_ENDPOINT_REQUIRED', '非投资模板不能绕过独立审核发布')
    if (policy.version !== input.expectedPolicyVersion || draft.version !== input.expectedDraftVersion) throw failure(409, 'VERSION_CONFLICT', '模板或草稿版本已变化，请重新预览')
    if (draft.status !== 'draft') throw failure(409, 'FDE_POLICY_IMMUTABLE', '只能发布草稿版本')
    const config = fdeWorkflowPolicySchema.parse(draft.configuration)
    if (policyHash(config) !== draft.sha256) throw failure(409, 'FDE_POLICY_INTEGRITY_FAILED', '草稿哈希校验失败')
    await tx.update(fdeWorkflowPolicyVersions).set({ status: 'published', publishedBy: user.id, publishedAt: new Date(), reason: input.reason, version: draft.version + 1 }).where(eq(fdeWorkflowPolicyVersions.id, draft.id))
    await tx.update(fdeWorkflowPolicies).set({ activeVersionId: draft.id, enabled: true, version: policy.version + 1 }).where(eq(fdeWorkflowPolicies.id, policyId))
    await identity.audits.append({ userId: user.id, userName: user.name, module: 'FDE模板与规则', action: '发布流程规则', target: JSON.stringify({ policyId, beforeVersionId: policy.activeVersionId, afterVersionId: draft.id, sha256: draft.sha256, scope: 'new-projects-only', reason: input.reason }) })
    return { id: draft.id, revision: draft.revision, scope: 'new-projects-only' }
  })
}

export async function setFdePolicyEnabled(id: string, input: { enabled: boolean; expectedVersion: number; reason: string }, actor: SystemAdministrator) {
  return db.transaction(async (tx) => {
    const { identity, user } = await requireAdministrator(tx, actor)
    const [policy] = await tx.select().from(fdeWorkflowPolicies).where(eq(fdeWorkflowPolicies.id, id)).limit(1).for('update')
    if (!policy) throw failure(404, 'FDE_POLICY_NOT_FOUND', '流程模板不存在')
    if (policy.code.startsWith('noninvestment:')) throw failure(409, 'FDE_TYPE_POLICY_ENDPOINT_REQUIRED', '非投资模板执行能力尚未启用，不能从投资入口启用')
    if (policy.version !== input.expectedVersion) throw failure(409, 'VERSION_CONFLICT', '模板已改变')
    await tx.update(fdeWorkflowPolicies).set({ enabled: input.enabled, version: policy.version + 1 }).where(eq(fdeWorkflowPolicies.id, id))
    await identity.audits.append({ userId: user.id, userName: user.name, module: 'FDE模板与规则', action: input.enabled ? '启用流程模板' : '停用流程模板', target: JSON.stringify({ policyId: id, reason: input.reason, existingProjectsUnchanged: true }) })
    return { id, enabled: input.enabled }
  })
}
