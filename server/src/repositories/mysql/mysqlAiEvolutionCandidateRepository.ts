import { randomUUID } from 'node:crypto'
import { accountEvolutionTime } from '../../services/aiEvolutionElapsedTime.js'
import { and, eq, desc, asc, gt, inArray, isNotNull, or } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { aiEvolutionCandidates as candidates, aiEvolutionEvaluations as evaluations, aiEvolutionApprovals as approvals,
  aiEvolutionRuns as runs, aiEvolutionEvents as events, aiEvolutionAudits as audits, aiEvolutionReleaseJobs as releaseJobs } from '../../db/schema.js'
import { assertEvolutionLease, evolutionContentHash, evolutionError, type EvolutionLeaseIdentity } from '../../services/aiEvolutionPolicyService.js'
import { evaluationHasRequiredEvidence, type EvolutionCandidateManifest, type EvolutionEvaluationReport } from '../../contracts/aiEvolutionEvaluationContract.js'
import type { EvolutionKind, EvolutionScope } from '../../contracts/aiEvolutionContract.js'
import { assertEvolutionReleaseBinding, type EvolutionReleaseAuthorization } from '../../services/aiEvolutionReleasePolicy.js'
import { parseEvolutionReleaseReceipt, type EvolutionReleaseReceipt } from '../../runtime/evolution/evolutionReleaseCoordinator.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const manifestSchema = z.object({
  schemaVersion: z.literal(1), sourceHash: hash, patchHash: hash, dependencyLockHash: hash,
  environment: z.string().min(1).max(128),
  artifacts: z.array(z.object({ storageKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,239}$/).refine((key) => !key.split('/').some((part) => part === '..' || part === '.' || !part)),
    sha256: hash, bytes: z.number().int().min(0).max(1_073_741_824), kind: z.enum(['patch', 'web', 'server', 'screenshot', 'report', 'content']),
  }).strict()).min(1).max(5000),
}).strict()

export class MySqlAiEvolutionCandidateRepository {
  async listClaimedReleases(afterApprovalId?: string, limit = 100) {
    if (afterApprovalId !== undefined) z.string().uuid().parse(afterApprovalId)
    const size = z.number().int().min(1).max(100).parse(limit)
    const where = [eq(approvals.purpose, 'release'), eq(approvals.decision, 'approved'), isNotNull(approvals.consumedAt),
      or(eq(candidates.status, 'activating'), and(inArray(candidates.status, ['active', 'failed', 'rolled_back']),
        inArray(releaseJobs.status, ['prepared', 'activating'])) )!]
    if (afterApprovalId) where.push(gt(approvals.id, afterApprovalId))
    return db.select({ approvalId: approvals.id, candidateId: candidates.id, actorUserId: approvals.actorUserId,
      targetEnvironment: approvals.environment }).from(approvals)
      .innerJoin(candidates, eq(candidates.id, approvals.candidateId))
      .innerJoin(runs, eq(runs.id, candidates.runId))
      .leftJoin(releaseJobs, eq(releaseJobs.approvalId, approvals.id))
      .where(and(...where)).orderBy(asc(approvals.id)).limit(size)
  }

  /** Recover only persisted claims; expiration does not erase an already consumed approval. */
  async readClaimedRelease(approvalId: string, actorUserId: string, targetEnvironment: string) {
    return db.transaction(async (tx) => {
      const [row] = await tx.select({ approval: approvals, candidate: candidates, run: runs }).from(approvals)
        .innerJoin(candidates, eq(candidates.id, approvals.candidateId)).innerJoin(runs, eq(runs.id, candidates.runId))
        .where(and(eq(approvals.id, approvalId), eq(approvals.actorUserId, actorUserId), eq(runs.ownerUserId, actorUserId))).for('update')
      if (!row) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '发布记录不存在或无权访问')
      if (row.approval.purpose !== 'release' || row.approval.decision !== 'approved' || !row.approval.consumedAt
        || row.approval.environment !== targetEnvironment || row.approval.candidateHash !== row.candidate.contentHash) {
        throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布恢复缺少对应的已领取批准')
      }
      const history = await tx.select().from(events).where(and(eq(events.runId, row.run.id), eq(events.eventType, 'release_claimed')))
      const claims = history.filter(event => event.payload.approvalId === approvalId)
      if (claims.length !== 1 || claims[0].payload.targetEnvironment !== targetEnvironment) {
        throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布领取记录缺失或不一致')
      }
      const receipt = parseEvolutionReleaseReceipt(claims[0].payload.receipt)
      if (receipt.candidateHash !== row.candidate.contentHash) throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布记录候选摘要不一致')
      if (!['activating', 'active', 'failed', 'rolled_back'].includes(row.candidate.status)) {
        throw evolutionError(409, 'EVOLUTION_RELEASE_STATE', '候选没有可恢复的发布状态')
      }
      return { approvalId, candidateId: row.candidate.id, runId: row.run.id, kind: row.candidate.kind,
        targetEnvironment, receipt, status: row.candidate.status, manifest: row.candidate.manifest }
    })
  }

  /** actor/grant/base are revalidated by the host service, never copied from HTTP input. */
  async recordReleaseApproval(candidateId: string, input: {
    actor: Parameters<typeof assertEvolutionReleaseBinding>[0]['actor']; currentBaseRef: string;
    candidateHash: string; evaluationHash: string; scope: EvolutionScope; targetEnvironment: string; expiresAt: Date;
    operation?: 'skill_promotion';
  }, now = new Date()) {
    if (input.expiresAt.getTime() - now.getTime() > 86_400_000) throw evolutionError(400, 'EVOLUTION_APPROVAL_EXPIRY', '发布批准有效期不能超过 24 小时')
    return db.transaction(async (tx) => {
      const [row] = await tx.select({ candidate: candidates, run: runs, evaluation: evaluations }).from(candidates)
        .innerJoin(runs, eq(runs.id, candidates.runId)).innerJoin(evaluations, eq(evaluations.candidateId, candidates.id))
        .where(and(eq(candidates.id, candidateId), eq(runs.ownerUserId, input.actor.userId))).for('update')
      if (!row) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '候选不存在或无权访问')
      const authorization: EvolutionReleaseAuthorization = { purpose: 'release', candidateId, candidateHash: input.candidateHash,
        evaluationHash: input.evaluationHash, scope: input.scope, actorUserId: input.actor.userId,
        targetEnvironment: input.targetEnvironment, expiresAt: input.expiresAt, decision: 'approved' }
      assertEvolutionReleaseBinding({ candidate: { ...row.candidate, kind: row.candidate.kind as EvolutionKind, sourceHash: row.candidate.manifest.sourceHash, scope: row.run.frozenSpec.scope },
        evaluation: { candidateHash: row.evaluation.candidateHash, hash: row.evaluation.evaluationHash, report: row.evaluation.report },
        authorization, actor: input.actor, currentBaseRef: input.currentBaseRef, targetEnvironment: input.targetEnvironment, now, operation: input.operation })
      const id = randomUUID()
      await tx.insert(approvals).values({ id, candidateId, purpose: 'release', actorUserId: input.actor.userId, candidateHash: input.candidateHash,
        evaluationHash: input.evaluationHash, scope: input.scope, environment: input.targetEnvironment, decision: 'approved', expiresAt: input.expiresAt })
      await tx.insert(audits).values({ id: randomUUID(), actorUserId: input.actor.userId, proposalId: row.run.proposalId, action: 'release_approved', contentHash: input.candidateHash })
      return { approvalId: id }
    })
  }

  async recordRequestedRollbackApproval(candidateId: string, actorUserId: string, targetEnvironment: string,
    candidateHash: string, evaluationHash: string, now = new Date()) {
    return db.transaction(async tx => {
      const [row] = await tx.select({ candidate: candidates, run: runs, evaluation: evaluations, job: releaseJobs }).from(candidates)
        .innerJoin(runs, eq(runs.id, candidates.runId)).innerJoin(evaluations, eq(evaluations.candidateId, candidates.id))
        .innerJoin(releaseJobs, eq(releaseJobs.candidateId, candidates.id))
        .where(and(eq(candidates.id, candidateId), eq(runs.ownerUserId, actorUserId), eq(candidates.status, 'active'),
          eq(releaseJobs.operation, 'release'), eq(releaseJobs.status, 'succeeded'), eq(releaseJobs.environment, targetEnvironment)))
        .orderBy(desc(releaseJobs.completedAt), desc(releaseJobs.id)).limit(1).for('update')
      if (!row || row.candidate.contentHash !== candidateHash || row.evaluation.evaluationHash !== evaluationHash || !row.job.receipt) {
        throw evolutionError(409, 'EVOLUTION_ROLLBACK_UNAVAILABLE', '当前候选没有可回退的已验证发布记录')
      }
      const receipt = parseEvolutionReleaseReceipt(row.job.receipt)
      if (!receipt.previousReleaseId || !receipt.previousIdentity) throw evolutionError(409, 'EVOLUTION_ROLLBACK_UNAVAILABLE', '该发布没有可验证的上一版本')
      const id = randomUUID(), expiresAt = new Date(now.getTime() + 60 * 60_000)
      await tx.insert(approvals).values({ id, candidateId, actorUserId, candidateHash, evaluationHash,
        scope: row.run.frozenSpec.scope, environment: targetEnvironment, decision: 'approved', purpose: 'release_rollback', expiresAt })
      await tx.insert(audits).values({ id: randomUUID(), actorUserId, proposalId: row.run.proposalId,
        action: 'release_rollback_approved', contentHash: candidateHash })
      return { approvalId: id, sourceReleaseJobId: row.job.id, expiresAt }
    })
  }

  async claimRequestedRollback(approvalId: string, actorUserId: string, receiptInput: EvolutionReleaseReceipt, now = new Date()) {
    const receipt = parseEvolutionReleaseReceipt(receiptInput)
    return db.transaction(async tx => {
      const [row] = await tx.select({ approval: approvals, candidate: candidates, run: runs }).from(approvals)
        .innerJoin(candidates, eq(candidates.id, approvals.candidateId)).innerJoin(runs, eq(runs.id, candidates.runId))
        .where(and(eq(approvals.id, approvalId), eq(approvals.actorUserId, actorUserId))).for('update')
      if (!row || row.approval.purpose !== 'release_rollback' || row.approval.decision !== 'approved'
        || row.approval.expiresAt <= now || row.approval.consumedAt || row.candidate.status !== 'active'
        || row.candidate.contentHash !== receipt.candidateHash) {
        throw evolutionError(409, 'EVOLUTION_ROLLBACK_APPROVAL_REQUIRED', '回退批准已失效或候选状态已变化')
      }
      await tx.update(approvals).set({ consumedAt: now }).where(eq(approvals.id, approvalId))
      await tx.update(candidates).set({ status: 'activating' }).where(eq(candidates.id, row.candidate.id))
      await tx.insert(events).values({ id: randomUUID(), runId: row.run.id, sequence: row.run.nextEventSequence,
        eventType: 'release_rollback_claimed', payload: { schemaVersion: 1, approvalId, targetEnvironment: row.approval.environment, receipt } })
      await tx.update(runs).set({ nextEventSequence: row.run.nextEventSequence + 1 }).where(eq(runs.id, row.run.id))
      return { candidateId: row.candidate.id, runId: row.run.id }
    })
  }

  async completeRequestedRollback(approvalId: string, actorUserId: string, receiptInput: EvolutionReleaseReceipt) {
    const receipt = parseEvolutionReleaseReceipt(receiptInput)
    return db.transaction(async tx => {
      const [row] = await tx.select({ approval: approvals, candidate: candidates, run: runs }).from(approvals)
        .innerJoin(candidates, eq(candidates.id, approvals.candidateId)).innerJoin(runs, eq(runs.id, candidates.runId))
        .where(and(eq(approvals.id, approvalId), eq(approvals.actorUserId, actorUserId))).for('update')
      if (!row || row.approval.purpose !== 'release_rollback' || !row.approval.consumedAt
        || row.candidate.status !== 'activating' || row.candidate.contentHash !== receipt.candidateHash) {
        throw evolutionError(409, 'EVOLUTION_ROLLBACK_BINDING', '回退结果缺少对应的已领取批准')
      }
      await tx.update(candidates).set({ status: 'rolled_back' }).where(eq(candidates.id, row.candidate.id))
      await tx.insert(events).values({ id: randomUUID(), runId: row.run.id, sequence: row.run.nextEventSequence,
        eventType: 'release_rollback_completed', payload: { schemaVersion: 1, approvalId, receipt, outcome: 'rolled_back' } })
      await tx.update(runs).set({ nextEventSequence: row.run.nextEventSequence + 1 }).where(eq(runs.id, row.run.id))
      await tx.insert(audits).values({ id: randomUUID(), actorUserId, proposalId: row.run.proposalId,
        action: 'release_rolled_back_by_request', contentHash: receipt.candidateHash })
      return { status: 'rolled_back' as const }
    })
  }

  /** Transactionally consume a release approval before any deployment side effect. */
  async claimRelease(approvalId: string, input: {
    actor: Parameters<typeof assertEvolutionReleaseBinding>[0]['actor']; currentBaseRef: string; targetEnvironment: string;
    receipt: EvolutionReleaseReceipt;
  }, now = new Date()) {
    const receipt = parseEvolutionReleaseReceipt(input.receipt)
    return db.transaction(async (tx) => {
      const [row] = await tx.select({ approval: approvals, candidate: candidates, run: runs, evaluation: evaluations }).from(approvals)
        .innerJoin(candidates, eq(candidates.id, approvals.candidateId)).innerJoin(runs, eq(runs.id, candidates.runId))
        .innerJoin(evaluations, eq(evaluations.candidateId, candidates.id))
        .where(and(eq(approvals.id, approvalId), eq(runs.ownerUserId, input.actor.userId))).for('update')
      if (!row) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '发布批准不存在或无权访问')
      if (receipt.candidateHash !== row.candidate.contentHash) throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '暂存版本与批准候选不一致')
      if (Boolean(receipt.previousReleaseId) !== Boolean(receipt.previousIdentity)) {
        throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '旧版本编号与运行身份不一致')
      }
      if (row.candidate.kind === 'code' && (receipt.candidateIdentity.baseCommit !== row.candidate.baseRef
        || receipt.candidateIdentity.patchHash !== row.candidate.manifest.patchHash
        || receipt.candidateIdentity.lockHash !== row.candidate.manifest.dependencyLockHash)) {
        throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '候选运行身份与已验收构建不一致')
      }
      if (row.approval.purpose !== 'release') throw evolutionError(409, 'EVOLUTION_RELEASE_APPROVAL_REQUIRED', '批准用途不符')
      if (row.approval.consumedAt) {
        const history = await tx.select().from(events).where(and(eq(events.runId, row.run.id), eq(events.eventType, 'release_claimed')))
        const prior = history.find((event) => event.payload.approvalId === approvalId)
        if (!prior || prior.payload.targetEnvironment !== input.targetEnvironment
          || evolutionContentHash(prior.payload.receipt) !== evolutionContentHash(receipt)
          || !['activating', 'active', 'failed', 'rolled_back'].includes(row.candidate.status)) {
          throw evolutionError(409, 'EVOLUTION_RELEASE_APPROVAL_REQUIRED', '批准已被其他发布请求使用')
        }
        return { candidateId: row.candidate.id, runId: row.run.id, manifest: row.candidate.manifest,
          status: row.candidate.status, duplicate: true as const }
      }
      assertEvolutionReleaseBinding({ candidate: { ...row.candidate, kind: row.candidate.kind as EvolutionKind, sourceHash: row.candidate.manifest.sourceHash, scope: row.run.frozenSpec.scope },
        evaluation: { candidateHash: row.evaluation.candidateHash, hash: row.evaluation.evaluationHash, report: row.evaluation.report },
        authorization: { ...row.approval, purpose: 'release', decision: row.approval.decision as 'approved' | 'rejected', targetEnvironment: row.approval.environment },
        actor: input.actor, currentBaseRef: input.currentBaseRef, targetEnvironment: input.targetEnvironment, now })
      await tx.update(approvals).set({ consumedAt: now }).where(eq(approvals.id, approvalId))
      await tx.update(candidates).set({ status: 'activating' }).where(eq(candidates.id, row.candidate.id))
      await tx.insert(events).values({ id: randomUUID(), runId: row.run.id, sequence: row.run.nextEventSequence, eventType: 'release_claimed',
        payload: { schemaVersion: 1, approvalId, targetEnvironment: input.targetEnvironment, receipt } })
      await tx.update(runs).set({ nextEventSequence: row.run.nextEventSequence + 1 }).where(eq(runs.id, row.run.id))
      await tx.insert(audits).values({ id: randomUUID(), actorUserId: input.actor.userId, proposalId: row.run.proposalId, action: 'release_claimed', contentHash: row.candidate.contentHash })
      return { candidateId: row.candidate.id, runId: row.run.id, manifest: row.candidate.manifest,
        status: 'activating' as const, duplicate: false as const }
    })
  }

  async completeRelease(approvalId: string, actorUserId: string, receiptInput: EvolutionReleaseReceipt, outcome: 'active' | 'failed' | 'rolled_back') {
    const receipt = parseEvolutionReleaseReceipt(receiptInput)
    z.enum(['active', 'failed', 'rolled_back']).parse(outcome)
    return db.transaction(async (tx) => {
      const [row] = await tx.select({ approval: approvals, candidate: candidates, run: runs }).from(approvals)
        .innerJoin(candidates, eq(candidates.id, approvals.candidateId)).innerJoin(runs, eq(runs.id, candidates.runId))
        .where(and(eq(approvals.id, approvalId), eq(approvals.actorUserId, actorUserId))).for('update')
      if (!row || row.approval.purpose !== 'release' || !row.approval.consumedAt || row.candidate.contentHash !== receipt.candidateHash) throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布结果缺少对应的已领取批准')
      const history = await tx.select().from(events).where(and(eq(events.runId, row.run.id), eq(events.eventType, 'release_claimed')))
      const claim = history.find((event) => event.payload.approvalId === approvalId)
      if (!claim || evolutionContentHash(claim.payload.receipt) !== evolutionContentHash(receipt)) throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布结果与暂存版本记录不一致')
      if (row.candidate.status === outcome) return { status: outcome, duplicate: true }
      if (row.candidate.status !== 'activating') throw evolutionError(409, 'EVOLUTION_RELEASE_STATE', '发布结果已记录为不同状态')
      await tx.update(candidates).set({ status: outcome }).where(eq(candidates.id, row.candidate.id))
      await tx.insert(events).values({ id: randomUUID(), runId: row.run.id, sequence: row.run.nextEventSequence, eventType: 'release_completed',
        payload: { schemaVersion: 1, approvalId, receipt, outcome } })
      await tx.update(runs).set({ nextEventSequence: row.run.nextEventSequence + 1 }).where(eq(runs.id, row.run.id))
      await tx.insert(audits).values({ id: randomUUID(), actorUserId, proposalId: row.run.proposalId, action: `release_${outcome}`, contentHash: receipt.candidateHash })
      return { status: outcome, duplicate: false }
    })
  }
  async latestIdForProposal(userId: string, proposalId: string) {
    const [row] = await db.select({ id: candidates.id }).from(candidates).innerJoin(runs, eq(runs.id, candidates.runId))
      .where(and(eq(runs.ownerUserId, userId), eq(runs.proposalId, proposalId))).orderBy(desc(candidates.createdAt), desc(candidates.id)).limit(1)
    return row?.id ?? null
  }
  /** Trusted evaluator calls this after storing and hashing real artifacts; no direct HTTP submission. */
  async completeRun(identity: EvolutionLeaseIdentity, input: { baseRef: string; summary: string; manifest: EvolutionCandidateManifest; evaluation: EvolutionEvaluationReport }, now = new Date()) {
    const manifest = manifestSchema.parse(input.manifest)
    if (!input.summary.trim() || input.summary.length > 4000 || input.baseRef.length > 128
      || new Set(manifest.artifacts.map((artifact) => artifact.storageKey)).size !== manifest.artifacts.length) {
      throw evolutionError(422, 'EVOLUTION_INVALID_CANDIDATE', '候选摘要、基线或产物清单无效')
    }
    return db.transaction(async (tx) => {
      const [run] = await tx.select().from(runs).where(eq(runs.id, identity.runId)).for('update')
      if (!run || run.status !== 'evaluating' || run.stage === 'terminating' || !run.leaseExpiresAt) throw evolutionError(409, 'EVOLUTION_STALE_EXECUTOR', '执行权已失效')
      assertEvolutionLease({ runId: run.id, attempt: run.attempt, leaseToken: run.leaseToken, inputHash: run.inputHash,
        leaseExpiresAt: run.leaseExpiresAt, cancelRequestedAt: run.cancelRequestedAt }, identity, now)
      const kind = run.frozenSpec.kind
      const accounting = accountEvolutionTime(run, now)
      if (accounting.elapsedSeconds >= run.budget.maxDurationSeconds) throw evolutionError(409, 'EVOLUTION_DURATION_EXCEEDED', '任务累计执行时间预算已耗尽')
      const target = run.frozenSpec.target
      if ((target.type === 'code' && input.baseRef !== target.baseCommit) || (target.type === 'skill' && input.baseRef !== target.baseContentHash)
        || input.evaluation.candidateHash !== manifest.sourceHash || !evaluationHasRequiredEvidence(kind, input.evaluation)) {
        throw evolutionError(409, 'EVOLUTION_EVALUATION_INCOMPLETE', '候选基线或独立验收证据不完整')
      }
      const requiredArtifacts = kind === 'code' ? ['patch', 'web', 'server', 'screenshot', 'report'] : ['content', 'report']
      if (requiredArtifacts.some((type) => !manifest.artifacts.some((artifact) => artifact.kind === type))) throw evolutionError(422, 'EVOLUTION_ARTIFACTS_INCOMPLETE', '缺少候选交付物')
      const contentHash = evolutionContentHash({ kind, baseRef: input.baseRef, manifest, summary: input.summary })
      const evaluationHash = evolutionContentHash({ candidateHash: contentHash, report: input.evaluation })
      const id = randomUUID()
      await tx.insert(candidates).values({ id, runId: run.id, kind, baseRef: input.baseRef, contentHash, manifest, summary: input.summary, status: 'awaiting_approval' })
      await tx.insert(evaluations).values({ id: randomUUID(), candidateId: id, candidateHash: contentHash, evaluationHash, report: input.evaluation })
      await tx.update(runs).set({ ...accounting, timeAccountedAt: null, status: 'succeeded', stage: 'succeeded', leaseOwner: null, leaseExpiresAt: null, updatedAt: now, nextEventSequence: run.nextEventSequence + 1 }).where(eq(runs.id, run.id))
      await tx.insert(events).values({ id: randomUUID(), runId: run.id, sequence: run.nextEventSequence, eventType: 'candidate_ready', payload: { schemaVersion: 1, candidateId: id, contentHash, evaluationHash } })
      return { id, contentHash, evaluationHash, status: 'awaiting_approval' as const }
    })
  }

  async findForOwner(userId: string, id: string) {
    const [row] = await db.select({ candidate: candidates, evaluation: evaluations, proposalId: runs.proposalId }).from(candidates)
      .innerJoin(runs, eq(runs.id, candidates.runId)).innerJoin(evaluations, eq(evaluations.candidateId, candidates.id))
      .where(and(eq(candidates.id, id), eq(runs.ownerUserId, userId))).limit(1)
    return row ?? null
  }

  /** Service must verify current identity and scope before entering this transaction. */
  async decide(userId: string, id: string, input: { candidateHash: string; evaluationHash: string; scope: EvolutionScope; environment: string; decision: 'approved' | 'rejected'; expiresAt: Date }, now = new Date()) {
    if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= now || input.expiresAt.getTime() - now.getTime() > 86_400_000) {
      throw evolutionError(400, 'EVOLUTION_APPROVAL_EXPIRY', '批准有效期必须在未来 24 小时内')
    }
    return db.transaction(async (tx) => {
      const [row] = await tx.select({ candidate: candidates, run: runs, evaluation: evaluations }).from(candidates)
        .innerJoin(runs, eq(runs.id, candidates.runId)).innerJoin(evaluations, eq(evaluations.candidateId, candidates.id))
        .where(and(eq(candidates.id, id), eq(runs.ownerUserId, userId))).for('update')
      if (!row) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '候选不存在或无权访问')
      if (row.candidate.status !== 'awaiting_approval' || row.candidate.contentHash !== input.candidateHash
        || row.evaluation.evaluationHash !== input.evaluationHash || row.evaluation.candidateHash !== input.candidateHash
        || row.candidate.manifest.environment !== input.environment || evolutionContentHash(row.run.frozenSpec.scope) !== evolutionContentHash(input.scope)
        || !evaluationHasRequiredEvidence(row.candidate.kind as EvolutionKind, row.evaluation.report)) {
        throw evolutionError(409, 'EVOLUTION_APPROVAL_BINDING', '候选、验收或生效范围已变化，请重新审阅')
      }
      const approvalId = randomUUID()
      await tx.insert(approvals).values({ id: approvalId, candidateId: id, actorUserId: userId, candidateHash: input.candidateHash,
        evaluationHash: input.evaluationHash, scope: input.scope, environment: input.environment, decision: input.decision, expiresAt: input.expiresAt })
      await tx.update(candidates).set({ status: input.decision === 'approved' ? 'approved' : 'retired' }).where(eq(candidates.id, id))
      await tx.insert(audits).values({ id: randomUUID(), actorUserId: userId, proposalId: row.run.proposalId, action: `candidate_${input.decision}`, contentHash: input.candidateHash })
      return { approvalId, candidateId: id, status: input.decision === 'approved' ? 'approved' : 'retired' }
    })
  }
}
