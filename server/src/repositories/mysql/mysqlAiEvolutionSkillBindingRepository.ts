import { randomUUID } from 'node:crypto'
import { and, eq, gt, lte, asc } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { aiEvolutionSkillVersions as versions, aiEvolutionSkillBindings as bindings, aiEvolutionSkillBindingChanges as changes,
  aiEvolutionApprovals as approvals, aiEvolutionCandidates as candidates, aiEvolutionRuns as runs,
  aiEvolutionEvaluations as evaluations, aiEvolutionAudits as audits } from '../../db/schema.js'
import { evolutionSkillTrialTarget, assertEvolutionSkillTrial } from '../../services/aiEvolutionSkillTrialPolicy.js'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { parseEvolutionSkillPackage } from '../../runtime/evolution/evolutionSkillPackage.js'
import type { AiEvolutionArtifactStore } from '../../services/aiEvolutionArtifactStore.js'
import { evolutionSkillPromotionTarget, assertEvolutionSkillPromotionBinding } from '../../services/aiEvolutionSkillPromotionPolicy.js'
import { assertEvolutionReleaseBinding } from '../../services/aiEvolutionReleasePolicy.js'

export class MySqlAiEvolutionSkillBindingRepository {
  /** Host reauthorizes capability, source and scope before calling; promotion retains the fallback. */
  async promoteTrial(input: { target: ReturnType<typeof evolutionSkillPromotionTarget>; approvalId: string;
    expectedCandidateId: string; idempotencyKey: string;
    actor: { userId: string; enabled: boolean; targetEnvironmentGrant: boolean } },
    store: Pick<AiEvolutionArtifactStore, 'read'>, now = new Date()) {
    z.string().uuid().parse(input.approvalId); z.string().uuid().parse(input.expectedCandidateId)
    z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).parse(input.idempotencyKey)
    if (!input.actor.enabled || !input.actor.targetEnvironmentGrant) throw evolutionError(403, 'EVOLUTION_RELEASE_FORBIDDEN', '缺少正式发布授权')
    const { environment, ...raw } = input.target
    const target = evolutionSkillPromotionTarget(raw)
    if (target.environment !== environment) throw evolutionError(409, 'EVOLUTION_PROMOTION_BINDING', '正式发布摘要不一致')
    const inputHash = evolutionContentHash({ target, approvalId: input.approvalId })
    return db.transaction(async tx => {
      const [binding] = await tx.select().from(bindings).where(eq(bindings.id, target.bindingId)).for('update')
      if (!binding || binding.updatedBy !== input.actor.userId) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '技能绑定不存在')
      const [row] = await tx.select({ approval: approvals, candidate: candidates, run: runs, evaluation: evaluations }).from(approvals)
        .innerJoin(candidates, eq(candidates.id, approvals.candidateId)).innerJoin(runs, eq(runs.id, candidates.runId))
        .innerJoin(evaluations, eq(evaluations.candidateId, candidates.id))
        .where(and(eq(approvals.id, input.approvalId), eq(approvals.actorUserId, input.actor.userId), eq(runs.ownerUserId, input.actor.userId))).for('update')
      if (!row || row.candidate.id !== input.expectedCandidateId) throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '正式批准与候选不一致')
      const [previous] = await tx.select().from(changes).where(and(eq(changes.actorUserId, input.actor.userId), eq(changes.idempotencyKey, input.idempotencyKey)))
      if (previous) {
        if (previous.inputHash !== inputHash) throw evolutionError(409, 'EVOLUTION_IDEMPOTENCY_CONFLICT', '正式发布请求输入已变化')
        return { bindingId: previous.bindingId, versionId: previous.nextVersionId, revision: previous.revision, duplicate: true }
      }
      assertEvolutionSkillPromotionBinding({ target, binding, now })
      if (row.approval.consumedAt || row.approval.purpose !== 'release' || row.run.status !== 'succeeded'
        || row.evaluation.evaluationHash !== evolutionContentHash({ candidateHash: row.candidate.contentHash, report: row.evaluation.report })
        || row.candidate.contentHash !== evolutionContentHash({ kind: row.candidate.kind, baseRef: row.candidate.baseRef, manifest: row.candidate.manifest, summary: row.candidate.summary })) {
        throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '批准已使用或候选评估记录不一致')
      }
      const [version] = await tx.select().from(versions).where(eq(versions.id, target.versionId))
      const [fallback] = await tx.select().from(versions).where(eq(versions.id, target.fallbackVersionId))
      if (!version || !fallback || version.contentHash !== row.candidate.manifest.sourceHash
        || !row.evaluation.report.checks.some(check => check.id === 'improvement' && check.verdict === 'PASS')) throw evolutionError(409, 'EVOLUTION_PROMOTION_BINDING', '正式版本与评估不一致')
      for (const saved of [version, fallback]) {
        if (saved.ownerUserId !== input.actor.userId || saved.capabilityId !== target.capabilityId) throw evolutionError(403, 'EVOLUTION_SKILL_VERSION_FORBIDDEN', '技能版本归属不一致')
        const bundle = parseEvolutionSkillPackage(JSON.parse((await store.read(saved.runId, saved.packageArtifact)).toString('utf8')))
        if (bundle.contentHash !== saved.contentHash || bundle.packageHash !== saved.packageHash || evolutionContentHash(saved.content) !== bundle.contentHash) throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '版本包校验失败')
      }
      assertEvolutionReleaseBinding({ operation: 'skill_promotion', candidate: { ...row.candidate, kind: 'skill', sourceHash: row.candidate.manifest.sourceHash, scope: row.run.frozenSpec.scope },
        evaluation: { candidateHash: row.evaluation.candidateHash, hash: row.evaluation.evaluationHash, report: row.evaluation.report },
        authorization: { ...row.approval, purpose: 'release', decision: row.approval.decision as 'approved' | 'rejected', targetEnvironment: row.approval.environment },
        actor: input.actor, targetEnvironment: target.environment, currentBaseRef: fallback.contentHash, now })
      const revision = binding.revision + 1
      await tx.update(bindings).set({ trialExpiresAt: null, revision, updatedAt: now }).where(eq(bindings.id, binding.id))
      await tx.insert(changes).values({ id: randomUUID(), bindingId: binding.id, actorUserId: input.actor.userId, operation: 'promotion',
        idempotencyKey: input.idempotencyKey, inputHash, previousVersionId: version.id, nextVersionId: version.id, revision, approvalId: row.approval.id })
      await tx.update(approvals).set({ consumedAt: now }).where(eq(approvals.id, row.approval.id))
      await tx.insert(audits).values({ id: randomUUID(), actorUserId: input.actor.userId, proposalId: row.run.proposalId,
        action: 'skill_trial_promoted', contentHash: inputHash })
      return { bindingId: binding.id, versionId: version.id, revision, duplicate: false }
    })
  }
  async listExpired(now: Date, afterId?: string) {
    if (!Number.isFinite(now.getTime())) throw Error('Invalid skill expiry time')
    if (afterId) z.string().uuid().parse(afterId)
    return db.select({ id: bindings.id }).from(bindings)
      .where(and(lte(bindings.trialExpiresAt, now), afterId ? gt(bindings.id, afterId) : undefined))
      .orderBy(asc(bindings.id)).limit(100)
  }
  /** Caller must authorize the capability and exact scope before using this metadata. */
  async findForScope(capabilityId: string, scope: { type: 'user' | 'project'; key: string }) {
    const [binding] = await db.select().from(bindings).where(and(eq(bindings.capabilityId, capabilityId),
      eq(bindings.scopeType, scope.type), eq(bindings.scopeKey, scope.key)))
    return binding ?? null
  }
  async findForPublisher(userId: string, bindingId: string) {
    const [binding] = await db.select().from(bindings).where(and(eq(bindings.id, bindingId), eq(bindings.updatedBy, userId)))
    return binding ?? null
  }
  /** Host-only read. Caller authorizes the requested scope; callback authorizes the selected version's source before reading bytes. */
  async resolveForScope(input: { capabilityId: string; scope: { type: 'user' | 'project'; key: string } },
    authorize: (selection: { bindingId: string; versionId: string; ownerUserId: string; runId: string; candidateId: string | null }) => Promise<void>,
    store: Pick<AiEvolutionArtifactStore, 'read'>, now = new Date()) {
    z.string().uuid().parse(input.capabilityId)
    z.object({ type: z.enum(['user', 'project']), key: z.string().min(1).max(128) }).strict().parse(input.scope)
    if (!Number.isFinite(now.getTime())) throw Error('Invalid skill resolution time')
    // The pointer is read once; selected versions are immutable. Authorization
    // may query the database, so no transaction connection is retained here.
    return (async () => {
      const tx = db
      const [binding] = await tx.select().from(bindings).where(and(eq(bindings.capabilityId, input.capabilityId),
        eq(bindings.scopeType, input.scope.type), eq(bindings.scopeKey, input.scope.key)))
      if (!binding) return null
      const expired = binding.trialExpiresAt !== null && binding.trialExpiresAt <= now
      const versionId = expired ? binding.fallbackVersionId : binding.activeVersionId
      if (!versionId) throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '到期技能缺少回退版本')
      const [version] = await tx.select().from(versions).where(eq(versions.id, versionId))
      if (!version || version.capabilityId !== input.capabilityId) throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '生效技能版本不存在或能力不一致')
      const selection = { bindingId: binding.id, versionId, ownerUserId: version.ownerUserId, runId: version.runId, candidateId: version.candidateId }
      await authorize(selection)
      const bundle = parseEvolutionSkillPackage(JSON.parse((await store.read(version.runId, version.packageArtifact)).toString('utf8')))
      if (bundle.contentHash !== version.contentHash || bundle.packageHash !== version.packageHash
        || evolutionContentHash(version.content) !== bundle.contentHash) throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '生效技能包与版本记录不一致')
      await authorize(selection)
      const snapshot = { schemaVersion: 1 as const, capabilityId: input.capabilityId, scope: { ...input.scope },
        bindingId: binding.id, bindingRevision: binding.revision, versionId, contentHash: bundle.contentHash,
        packageHash: bundle.packageHash, reason: expired ? 'trial_expired' as const : 'active' as const,
        selectedAt: now.toISOString(), trialExpiresAt: binding.trialExpiresAt?.toISOString() ?? null }
      return { snapshot, snapshotHash: evolutionContentHash(snapshot), bundle }
    })()
  }

  /** Restore only the already-recorded fallback; the caller must revalidate scope and source grants. */
  async rollbackTrial(input: { bindingId: string; expectedRevision: number; idempotencyKey: string; expectedActiveHash?: string;
    actor: { userId: string; enabled: boolean; targetEnvironmentGrant: boolean } },
    store: Pick<AiEvolutionArtifactStore, 'read'>, now = new Date()) {
    const result = await this.restoreTrial(input, store, now, false)
    if (!result) throw Error('Rollback did not restore a version')
    return result
  }

  /** Host-only expiry of an already approved deadline; never accepts a replacement version. */
  async expireTrial(bindingId: string, store: Pick<AiEvolutionArtifactStore, 'read'>, now = new Date()) {
    z.string().uuid().parse(bindingId)
    if (!Number.isFinite(now.getTime())) throw Error('Invalid skill expiry time')
    const [binding] = await db.select().from(bindings).where(eq(bindings.id, bindingId))
    if (!binding || !binding.trialExpiresAt || binding.trialExpiresAt > now) return null
    return this.restoreTrial({ bindingId, expectedRevision: binding.revision,
      idempotencyKey: `expiry:${bindingId}:${binding.revision}`,
      actor: { userId: binding.updatedBy, enabled: true, targetEnvironmentGrant: true } }, store, now, true)
  }

  private async restoreTrial(input: { bindingId: string; expectedRevision: number; idempotencyKey: string; expectedActiveHash?: string;
    actor: { userId: string; enabled: boolean; targetEnvironmentGrant: boolean } },
    store: Pick<AiEvolutionArtifactStore, 'read'>, now: Date, expiredOnly: boolean) {
    z.string().uuid().parse(input.bindingId); z.number().int().positive().parse(input.expectedRevision)
    z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).parse(input.idempotencyKey)
    if (!input.actor.enabled || !input.actor.targetEnvironmentGrant) throw evolutionError(403, 'EVOLUTION_RELEASE_FORBIDDEN', '缺少技能作用域回退授权')
    const operation = expiredOnly ? 'expiry' : 'rollback'
    const inputHash = evolutionContentHash({ operation, bindingId: input.bindingId, expectedRevision: input.expectedRevision,
      ...(input.expectedActiveHash ? { expectedActiveHash: input.expectedActiveHash } : {}) })
    return db.transaction(async tx => {
      const [binding] = await tx.select().from(bindings).where(eq(bindings.id, input.bindingId)).for('update')
      if (!binding || binding.updatedBy !== input.actor.userId) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '技能绑定不存在或无权回退')
      const [previous] = await tx.select().from(changes).where(and(eq(changes.actorUserId, input.actor.userId), eq(changes.idempotencyKey, input.idempotencyKey)))
      if (previous) {
        if (previous.inputHash !== inputHash) throw evolutionError(409, 'EVOLUTION_IDEMPOTENCY_CONFLICT', '同一回退请求对应不同输入')
        return { bindingId: previous.bindingId, versionId: previous.nextVersionId, revision: previous.revision, duplicate: true }
      }
      if (expiredOnly && (!binding.trialExpiresAt || binding.trialExpiresAt > now)) return null
      if (binding.revision !== input.expectedRevision || !binding.fallbackVersionId) {
        throw evolutionError(409, 'EVOLUTION_REVISION_CONFLICT', '技能版本已变化或没有可回退版本')
      }
      const [fallback] = await tx.select().from(versions).where(eq(versions.id, binding.fallbackVersionId))
      const [active] = await tx.select().from(versions).where(eq(versions.id, binding.activeVersionId))
      if (input.expectedActiveHash && active?.contentHash !== input.expectedActiveHash) {
        throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '回退请求与当前技能版本不一致')
      }
      if (!fallback || !active || fallback.capabilityId !== binding.capabilityId || active.capabilityId !== binding.capabilityId
        || fallback.ownerUserId !== input.actor.userId || active.ownerUserId !== input.actor.userId) {
        throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '当前版本与回退版本绑定不一致')
      }
      const bundle = parseEvolutionSkillPackage(JSON.parse((await store.read(fallback.runId, fallback.packageArtifact)).toString('utf8')))
      if (bundle.contentHash !== fallback.contentHash || bundle.packageHash !== fallback.packageHash
        || evolutionContentHash(fallback.content) !== bundle.contentHash) throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '回退版本包校验失败')
      const revision = binding.revision + 1
      await tx.update(bindings).set({ activeVersionId: fallback.id, fallbackVersionId: null, trialExpiresAt: null,
        revision, updatedBy: input.actor.userId, updatedAt: now }).where(eq(bindings.id, binding.id))
      await tx.insert(changes).values({ id: randomUUID(), bindingId: binding.id, actorUserId: input.actor.userId,
        operation, idempotencyKey: input.idempotencyKey, inputHash,
        previousVersionId: active.id, nextVersionId: fallback.id, revision })
      if (active.candidateId) await tx.update(candidates).set({ status: 'rolled_back' })
        .where(and(eq(candidates.id, active.candidateId), eq(candidates.status, 'active')))
      const [run] = await tx.select().from(runs).where(eq(runs.id, active.runId))
      await tx.insert(audits).values({ id: randomUUID(), actorUserId: input.actor.userId, proposalId: run?.proposalId,
        action: expiredOnly ? 'skill_trial_expired' : 'skill_trial_rolled_back', contentHash: inputHash })
      return { bindingId: binding.id, versionId: fallback.id, revision, duplicate: false }
    })
  }

  /** Host must revalidate scope/capability/source grants before supplying actor. No HTTP-supplied grant booleans. */
  async activateTrial(input: { target: ReturnType<typeof evolutionSkillTrialTarget>; approvalId: string; idempotencyKey: string; expectedCandidateId?: string;
    actor: { userId: string; enabled: boolean; targetEnvironmentGrant: boolean }; maxTrialSeconds: number },
    store: Pick<AiEvolutionArtifactStore, 'read'>, now = new Date()) {
    z.string().uuid().parse(input.approvalId)
    z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).parse(input.idempotencyKey)
    if (!input.actor.enabled || !input.actor.targetEnvironmentGrant) throw evolutionError(403, 'EVOLUTION_RELEASE_FORBIDDEN', '缺少技能作用域发布授权')
    const { environment: _environment, ...values } = input.target
    const target = evolutionSkillTrialTarget(values)
    if (target.environment !== input.target.environment) throw evolutionError(409, 'EVOLUTION_SKILL_TRIAL_BINDING', '试用目标摘要不一致')
    const inputHash = evolutionContentHash({ target, approvalId: input.approvalId })
    return db.transaction(async tx => {
      const [row] = await tx.select({ approval: approvals, candidate: candidates, run: runs, evaluation: evaluations }).from(approvals)
        .innerJoin(candidates, eq(candidates.id, approvals.candidateId)).innerJoin(runs, eq(runs.id, candidates.runId))
        .innerJoin(evaluations, eq(evaluations.candidateId, candidates.id))
        .where(and(eq(approvals.id, input.approvalId), eq(approvals.actorUserId, input.actor.userId), eq(runs.ownerUserId, input.actor.userId))).for('update')
      if (!row) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '发布批准不存在或无权访问')
      if (input.expectedCandidateId && row.candidate.id !== input.expectedCandidateId) {
        throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布批准与请求候选不一致')
      }
      const [previous] = await tx.select().from(changes).where(and(eq(changes.actorUserId, input.actor.userId), eq(changes.idempotencyKey, input.idempotencyKey)))
      if (previous) {
        if (previous.inputHash !== inputHash) throw evolutionError(409, 'EVOLUTION_IDEMPOTENCY_CONFLICT', '同一发布请求对应不同输入')
        return { bindingId: previous.bindingId, versionId: previous.nextVersionId, revision: previous.revision, duplicate: true }
      }
      if (row.approval.consumedAt || row.approval.purpose !== 'release') throw evolutionError(409, 'EVOLUTION_RELEASE_APPROVAL_REQUIRED', '发布批准已使用或用途不正确')
      const [version] = await tx.select().from(versions).where(eq(versions.id, target.versionId))
      const [fallback] = await tx.select().from(versions).where(eq(versions.id, target.fallbackVersionId))
      if (!version || !fallback || version.ownerUserId !== input.actor.userId || fallback.ownerUserId !== input.actor.userId) {
        throw evolutionError(403, 'EVOLUTION_SKILL_VERSION_FORBIDDEN', '无权使用指定技能版本')
      }
      const [binding] = await tx.select().from(bindings).where(and(eq(bindings.capabilityId, target.capabilityId),
        eq(bindings.scopeType, target.scope.type), eq(bindings.scopeKey, target.scope.key))).for('update')
      if (row.run.status !== 'succeeded' || row.run.frozenSpec.kind !== 'skill'
        || row.evaluation.evaluationHash !== evolutionContentHash({ candidateHash: row.candidate.contentHash, report: row.evaluation.report })
        || row.candidate.contentHash !== evolutionContentHash({ kind: row.candidate.kind, baseRef: row.candidate.baseRef, manifest: row.candidate.manifest, summary: row.candidate.summary })) {
        throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '候选记录或评估摘要不一致')
      }
      assertEvolutionSkillTrial({ target, version, fallback, binding: binding ?? null, maxTrialSeconds: input.maxTrialSeconds,
        release: { candidate: { ...row.candidate, kind: 'skill', sourceHash: row.candidate.manifest.sourceHash, scope: row.run.frozenSpec.scope },
          evaluation: { candidateHash: row.evaluation.candidateHash, hash: row.evaluation.evaluationHash, report: row.evaluation.report },
          authorization: { ...row.approval, purpose: 'release', decision: row.approval.decision as 'approved' | 'rejected', targetEnvironment: row.approval.environment },
          actor: input.actor, targetEnvironment: target.environment, currentBaseRef: fallback.contentHash, now } })
      for (const saved of [version, fallback]) {
        const bundle = parseEvolutionSkillPackage(JSON.parse((await store.read(saved.runId, saved.packageArtifact)).toString('utf8')))
        if (bundle.contentHash !== saved.contentHash || bundle.packageHash !== saved.packageHash
          || evolutionContentHash(saved.content) !== bundle.contentHash) throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '登记版本包校验失败')
      }
      const bindingId = binding?.id ?? randomUUID(), revision = (binding?.revision ?? 0) + 1
      const update = { activeVersionId: version.id, fallbackVersionId: fallback.id, trialExpiresAt: new Date(target.trialExpiresAt),
        revision, updatedBy: input.actor.userId, updatedAt: now }
      if (binding) await tx.update(bindings).set(update).where(eq(bindings.id, binding.id))
      else await tx.insert(bindings).values({ id: bindingId, capabilityId: target.capabilityId, scopeType: target.scope.type, scopeKey: target.scope.key, ...update })
      await tx.insert(changes).values({ id: randomUUID(), bindingId, actorUserId: input.actor.userId, operation: 'trial',
        idempotencyKey: input.idempotencyKey, inputHash, previousVersionId: fallback.id, nextVersionId: version.id, revision, approvalId: row.approval.id })
      await tx.update(approvals).set({ consumedAt: now }).where(eq(approvals.id, row.approval.id))
      await tx.update(candidates).set({ status: 'active' }).where(eq(candidates.id, row.candidate.id))
      await tx.insert(audits).values({ id: randomUUID(), actorUserId: input.actor.userId, proposalId: row.run.proposalId,
        action: 'skill_trial_activated', contentHash: inputHash })
      return { bindingId, versionId: version.id, revision, duplicate: false }
    })
  }
}
