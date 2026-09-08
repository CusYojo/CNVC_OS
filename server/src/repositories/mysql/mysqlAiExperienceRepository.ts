import { randomUUID } from 'node:crypto'
import { and, eq, desc, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { aiExperiences as experiences, aiExperienceVersions as versions, aiEvolutionApplications as applications,
  aiEvolutionProposals as proposals, aiEvolutionAudits as audits } from '../../db/schema.js'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { experienceOutputCheckSchema, assertExperienceCheckVersions } from '../../services/aiExperienceOutputCheck.js'
import { z } from 'zod'

const checkBindingSchema = z.object({ snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), outputHash: z.string().regex(/^[a-f0-9]{64}$/),
  checkerVersion: z.string().min(1).max(160), maxTokens: z.number().int().min(1).max(100_000) }).strict()
const checkExecutionSchema = checkBindingSchema.extend({ reservationId: z.string().uuid(), reservedTokens: z.number().int().min(1),
  actualTokens: z.number().int().min(0).nullable(), state: z.enum(['reserved', 'settled']), reservedAt: z.string().datetime() })

export class MySqlAiExperienceRepository {
  async reserveOutputCheck(userId: string, taskId: string, input: z.infer<typeof checkBindingSchema>, reservedTokens: number) {
    const binding = checkBindingSchema.parse(input)
    if (!Number.isSafeInteger(reservedTokens) || reservedTokens < 1 || reservedTokens > binding.maxTokens) {
      throw evolutionError(409, 'EVOLUTION_BUDGET_EXCEEDED', '经验检查预留超出预算')
    }
    return db.transaction(async tx => {
      const [row] = await tx.select().from(applications).where(and(eq(applications.ownerUserId, userId), eq(applications.taskId, taskId))).for('update')
      if (!row) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '经验应用记录不存在')
      if (row.snapshotHash !== binding.snapshotHash) throw evolutionError(409, 'EVOLUTION_APPLICATION_CORRUPT', '经验快照已变化')
      if (row.checkExecution) {
        const previous = checkExecutionSchema.parse(row.checkExecution)
        if (Object.entries(binding).some(([key, value]) => previous[key as keyof typeof binding] !== value)
          || previous.reservedTokens !== reservedTokens) throw evolutionError(409, 'EVOLUTION_OUTPUT_CHECK_CONFLICT', '检查输出、模型或预算绑定已变化')
        return { reservationId: previous.reservationId, mayInvoke: false }
      }
      if (row.checkResult) throw evolutionError(409, 'EVOLUTION_OUTPUT_CHECK_CONFLICT', '任务已有检查结果')
      const execution = { ...binding, reservationId: randomUUID(), reservedTokens, actualTokens: null,
        state: 'reserved' as const, reservedAt: new Date().toISOString() }
      await tx.update(applications).set({ checkExecution: execution }).where(eq(applications.id, row.id))
      return { reservationId: execution.reservationId, mayInvoke: true }
    })
  }

  async settleOutputCheck(userId: string, taskId: string, reservationId: string, actualTokens: number | null) {
    if (actualTokens !== null && (!Number.isSafeInteger(actualTokens) || actualTokens < 0)) throw evolutionError(409, 'EVOLUTION_INVALID_USAGE', '检查用量无效')
    return db.transaction(async tx => {
      const [row] = await tx.select().from(applications).where(and(eq(applications.ownerUserId, userId), eq(applications.taskId, taskId))).for('update')
      if (!row) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '经验应用记录不存在')
      const execution = checkExecutionSchema.parse(row.checkExecution)
      if (execution.reservationId !== reservationId) throw evolutionError(409, 'EVOLUTION_OUTPUT_CHECK_CONFLICT', '检查预留不匹配')
      if (execution.state === 'settled' && execution.actualTokens !== actualTokens) throw evolutionError(409, 'EVOLUTION_OUTPUT_CHECK_CONFLICT', '已记录其他检查用量')
      await tx.update(applications).set({ checkExecution: { ...execution, actualTokens, state: 'settled' } }).where(eq(applications.id, row.id))
      return { budgetExceeded: (actualTokens ?? execution.reservedTokens) > execution.maxTokens }
    })
  }
  async findOwnedVersion(userId: string, versionId: string) {
    const [row] = await db.select({ version: versions }).from(versions)
      .innerJoin(experiences, eq(versions.experienceId, experiences.id))
      .where(and(eq(versions.id, versionId), eq(experiences.ownerUserId, userId)))
    return row?.version ?? null
  }
  /** Internal checker result only; not a client-supplied verdict. First output binding is immutable. */
  async recordOutputCheck(userId: string, taskId: string, input: unknown) {
    const result = experienceOutputCheckSchema.parse(input)
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(applications)
        .where(and(eq(applications.ownerUserId, userId), eq(applications.taskId, taskId))).for('update')
      if (!row) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '经验应用记录不存在')
      if (row.snapshotHash !== result.snapshotHash) throw evolutionError(409, 'EVOLUTION_APPLICATION_CORRUPT', '遵守检查与冻结快照不一致')
      assertExperienceCheckVersions(result, row.snapshot)
      if (row.checkExecution) {
        const execution = checkExecutionSchema.parse(row.checkExecution)
        if (execution.state !== 'settled' || execution.outputHash !== result.outputHash || execution.checkerVersion !== result.checkerVersion
          || (execution.actualTokens ?? execution.reservedTokens) > execution.maxTokens) {
          throw evolutionError(409, 'EVOLUTION_OUTPUT_CHECK_CONFLICT', '检查结果与调用或预算记录不一致')
        }
      }
      if (row.checkResult) {
        if (evolutionContentHash(row.checkResult) !== evolutionContentHash(result)) throw evolutionError(409, 'EVOLUTION_OUTPUT_CHECK_CONFLICT', '该任务已有其他输出或检查结果')
        return row
      }
      await tx.update(applications).set({ checkStatus: result.verdict, checkResult: result }).where(eq(applications.id, row.id))
      return { ...row, checkStatus: result.verdict, checkResult: result }
    })
  }
  async findApplication(userId: string, taskId: string) {
    const [row] = await db.select().from(applications).where(and(eq(applications.ownerUserId, userId), eq(applications.taskId, taskId)))
    return row ?? null
  }
  /** Explicit personal save only; caller checks stable identity, source access and proposal hash. */
  async savePersonal(userId: string, proposalId: string, expectedRevision: number, authorizedHash: string) {
    return db.transaction(async (tx) => {
      const [proposal] = await tx.select().from(proposals).where(and(eq(proposals.id, proposalId), eq(proposals.ownerUserId, userId))).for('update')
      if (!proposal) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '经验提案不存在')
      const spec = proposal.spec
      if (proposal.specHash !== authorizedHash || spec.kind !== 'experience' || spec.target.type !== 'experience'
        || spec.scope.type !== 'user' || spec.scope.key !== userId) throw evolutionError(403, 'EVOLUTION_SCOPE_FORBIDDEN', '只能保存已核验的本人经验')
      const [existing] = await tx.select().from(versions).where(eq(versions.proposalId, proposalId))
      if (existing) return { experienceId: existing.experienceId, versionId: existing.id, contentHash: existing.contentHash }
      if (proposal.revision !== expectedRevision || proposal.status !== 'ready') throw evolutionError(409, 'EVOLUTION_REVISION_CONFLICT', '经验提案已变化或尚待补充信息')
      if (spec.target.expiresAt && new Date(spec.target.expiresAt).getTime() <= Date.now()) throw evolutionError(409, 'EVOLUTION_EXPERIENCE_EXPIRED', '不能激活已过期规则')
      if (spec.target.replacesVersionIds.length > 1) throw evolutionError(409, 'EVOLUTION_EXPERIENCE_CONFLICT', '一次修改只能明确替代一个经验版本')
      let experienceId: string = randomUUID()
      const versionId = randomUUID()
      if (spec.target.replacesVersionIds.length) {
        const [old] = await tx.select({ experience: experiences, version: versions }).from(versions).innerJoin(experiences, eq(experiences.id, versions.experienceId))
          .where(and(eq(versions.id, spec.target.replacesVersionIds[0]), eq(experiences.ownerUserId, userId))).for('update')
        if (!old || old.experience.activeVersionId !== old.version.id || old.experience.status !== 'active'
          || old.experience.businessProjectId !== (spec.businessProjectId ?? null)) throw evolutionError(409, 'EVOLUTION_EXPERIENCE_CONFLICT', '被替代经验已变化或范围不同')
        experienceId = old.experience.id
        await tx.update(experiences).set({ activeVersionId: versionId, revision: old.experience.revision + 1, updatedAt: new Date() }).where(eq(experiences.id, experienceId))
      } else {
        await tx.insert(experiences).values({ id: experienceId, ownerUserId: userId, scopeType: 'user', scopeKey: userId,
          businessProjectId: spec.businessProjectId ?? null, activeVersionId: versionId, status: 'active' })
      }
      const contentHash = evolutionContentHash(spec)
      await tx.insert(versions).values({ id: versionId, experienceId, proposalId, spec, contentHash })
      await tx.update(proposals).set({ status: 'approved', revision: expectedRevision + 1, updatedAt: new Date() }).where(eq(proposals.id, proposalId))
      await tx.insert(audits).values({ id: randomUUID(), actorUserId: userId, proposalId, action: 'personal_experience_saved', contentHash })
      return { experienceId, versionId, contentHash }
    })
  }

  async listPersonal(userId: string) {
    return db.select({ experience: experiences, version: versions }).from(experiences)
      .innerJoin(versions, eq(versions.id, experiences.activeVersionId))
      .where(eq(experiences.ownerUserId, userId)).orderBy(desc(experiences.updatedAt)).limit(1000)
  }

  async disablePersonal(userId: string, id: string, expectedRevision: number) {
    return db.transaction(async (tx) => {
      const [row] = await tx.select({ experience: experiences, version: versions }).from(experiences).innerJoin(versions, eq(versions.id, experiences.activeVersionId))
        .where(and(eq(experiences.id, id), eq(experiences.ownerUserId, userId))).for('update')
      if (!row) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '经验不存在')
      if (row.experience.revision !== expectedRevision) throw evolutionError(409, 'EVOLUTION_REVISION_CONFLICT', '经验版本已变化')
      await tx.update(experiences).set({ status: 'disabled', revision: expectedRevision + 1, updatedAt: new Date() }).where(eq(experiences.id, id))
      await tx.insert(audits).values({ id: randomUUID(), actorUserId: userId, proposalId: row.version.proposalId, action: 'personal_experience_disabled', contentHash: row.version.contentHash })
      return { id, revision: expectedRevision + 1, status: 'disabled' }
    })
  }

  async recordApplication(input: { userId: string; taskId: string; conversationId?: string; taskType: string; businessProjectId?: string; snapshot: Record<string, unknown> }) {
    const snapshotHash = evolutionContentHash(input.snapshot)
    return db.transaction(async (tx) => {
      const id = randomUUID()
      await tx.insert(applications).values({ id, ownerUserId: input.userId, taskId: input.taskId, conversationId: input.conversationId ?? null,
        taskType: input.taskType, businessProjectId: input.businessProjectId ?? null, snapshot: input.snapshot, snapshotHash, checkStatus: 'not_checked' })
        .onDuplicateKeyUpdate({ set: { id: sql`${applications.id}` } })
      const [row] = await tx.select().from(applications).where(and(eq(applications.ownerUserId, input.userId), eq(applications.taskId, input.taskId))).for('update')
      if (row.snapshotHash !== snapshotHash) throw evolutionError(409, 'EVOLUTION_APPLICATION_FROZEN', '任务已经冻结其他经验版本')
      return row
    })
  }
}
