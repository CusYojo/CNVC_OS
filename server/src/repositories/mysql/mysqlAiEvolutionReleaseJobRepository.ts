import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { aiEvolutionApprovals as approvals, aiEvolutionCandidates as candidates, aiEvolutionReleaseJobs as jobs,
  aiEvolutionRuns as runs, aiEvolutionEvents as events, aiEvolutionAudits as audits } from '../../db/schema.js'
import { parseEvolutionReleaseReceipt, type EvolutionReleaseReceipt } from '../../runtime/evolution/evolutionReleaseCoordinator.js'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'

const identifier = z.string().uuid()
const idempotency = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
export type EvolutionReleaseJobLease = { jobId: string; leaseOwner: string; leaseToken: number }
export type EvolutionReleaseJob = typeof jobs.$inferSelect

export class MySqlAiEvolutionReleaseJobRepository {
  async latestForOwner(actorUserId: string, candidateId: string) {
    identifier.parse(actorUserId); identifier.parse(candidateId)
    const [row] = await db.select().from(jobs).where(and(eq(jobs.actorUserId, actorUserId), eq(jobs.candidateId, candidateId)))
      .orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(1)
    return row ?? null
  }

  async enqueue(input: { actorUserId: string; candidateId: string; approvalId: string; targetEnvironment: string; idempotencyKey: string }, now = new Date()) {
    identifier.parse(input.actorUserId); identifier.parse(input.candidateId); identifier.parse(input.approvalId); idempotency.parse(input.idempotencyKey)
    if (!input.targetEnvironment.trim() || input.targetEnvironment.length > 128) throw evolutionError(400, 'EVOLUTION_RELEASE_TARGET', '发布环境无效')
    const inputHash = evolutionContentHash({ candidateId: input.candidateId, approvalId: input.approvalId, targetEnvironment: input.targetEnvironment })
    return db.transaction(async tx => {
      const [existing] = await tx.select().from(jobs).where(and(eq(jobs.actorUserId, input.actorUserId), eq(jobs.idempotencyKey, input.idempotencyKey))).for('update')
      if (existing) {
        if (existing.inputHash !== inputHash || existing.candidateId !== input.candidateId || existing.approvalId !== input.approvalId) {
          throw evolutionError(409, 'EVOLUTION_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同发布请求')
        }
        return existing
      }
      const [bound] = await tx.select({ approval: approvals, candidate: candidates, run: runs }).from(approvals)
        .innerJoin(candidates, eq(candidates.id, approvals.candidateId)).innerJoin(runs, eq(runs.id, candidates.runId))
        .where(and(eq(approvals.id, input.approvalId), eq(approvals.actorUserId, input.actorUserId), eq(runs.ownerUserId, input.actorUserId))).for('update')
      if (!bound || bound.candidate.id !== input.candidateId || bound.candidate.kind !== 'code' || bound.candidate.status !== 'approved'
        || bound.approval.purpose !== 'release' || bound.approval.decision !== 'approved' || bound.approval.consumedAt
        || bound.approval.environment !== input.targetEnvironment || bound.approval.expiresAt <= now) {
        throw evolutionError(409, 'EVOLUTION_RELEASE_APPROVAL_REQUIRED', '需要与代码候选和目标环境一致的有效发布批准')
      }
      const proposedId = randomUUID()
      await tx.insert(jobs).values({ id: proposedId, actorUserId: input.actorUserId, candidateId: input.candidateId,
        approvalId: input.approvalId, environment: input.targetEnvironment, idempotencyKey: input.idempotencyKey,
        inputHash, status: 'queued', updatedAt: now })
        .onDuplicateKeyUpdate({ set: { id: sql`${jobs.id}` } })
      const [stored] = await tx.select().from(jobs).where(and(eq(jobs.actorUserId, input.actorUserId), eq(jobs.idempotencyKey, input.idempotencyKey))).for('update')
      if (!stored || stored.inputHash !== inputHash) throw evolutionError(409, 'EVOLUTION_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同发布请求')
      if (stored.candidateId !== input.candidateId || stored.approvalId !== input.approvalId) throw evolutionError(409, 'EVOLUTION_RELEASE_APPROVAL_REQUIRED', '发布批准已用于其他请求')
      if (stored.id !== proposedId) return stored
      await tx.insert(events).values({ id: randomUUID(), runId: bound.run.id, sequence: bound.run.nextEventSequence,
        eventType: 'release_queued', payload: { schemaVersion: 1, jobId: stored.id, approvalId: input.approvalId, targetEnvironment: input.targetEnvironment } })
      await tx.update(runs).set({ nextEventSequence: bound.run.nextEventSequence + 1 }).where(eq(runs.id, bound.run.id))
      await tx.insert(audits).values({ id: randomUUID(), actorUserId: input.actorUserId, proposalId: bound.run.proposalId,
        action: 'release_queued', contentHash: bound.candidate.contentHash })
      return stored
    })
  }

  async claimNext(leaseOwner: string, leaseSeconds = 120, now = new Date()) {
    if (!leaseOwner.trim() || leaseOwner.length > 128 || !Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) throw Error('Invalid release lease')
    return db.transaction(async tx => {
      const [row] = await tx.select().from(jobs).where(and(
        or(eq(jobs.status, 'queued'), eq(jobs.status, 'prepared'), eq(jobs.status, 'preparing')),
        or(isNull(jobs.leaseExpiresAt), lt(jobs.leaseExpiresAt, now)),
      )).orderBy(asc(jobs.createdAt), asc(jobs.id)).limit(1).for('update', { skipLocked: true })
      if (!row) return null
      const leaseToken = row.leaseToken + 1
      const status = row.status === 'prepared' ? 'prepared' : 'preparing'
      const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000)
      await tx.update(jobs).set({ status, attempt: row.attempt + 1, leaseToken, leaseOwner, leaseExpiresAt, updatedAt: now })
        .where(and(eq(jobs.id, row.id), eq(jobs.leaseToken, row.leaseToken)))
      return { ...row, status, attempt: row.attempt + 1, leaseToken, leaseOwner, leaseExpiresAt }
    })
  }

  async savePrepared(identity: EvolutionReleaseJobLease, receiptInput: EvolutionReleaseReceipt, now = new Date()) {
    const receipt = parseEvolutionReleaseReceipt(receiptInput)
    return db.transaction(async tx => {
      const [row] = await tx.select().from(jobs).where(eq(jobs.id, identity.jobId)).for('update')
      if (!row || row.status !== 'preparing' || row.leaseOwner !== identity.leaseOwner || row.leaseToken !== identity.leaseToken
        || !row.leaseExpiresAt || row.leaseExpiresAt <= now) throw evolutionError(409, 'EVOLUTION_RELEASE_LEASE_LOST', '发布任务执行权已失效')
      await tx.update(jobs).set({ status: 'prepared', receipt, updatedAt: now }).where(eq(jobs.id, row.id))
      return { ...row, status: 'prepared' as const, receipt }
    })
  }

  async renewLease(identity: EvolutionReleaseJobLease, leaseSeconds = 120, now = new Date()) {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) throw Error('Invalid release lease')
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000)
    const result = await db.update(jobs).set({ leaseExpiresAt, updatedAt: now }).where(and(eq(jobs.id, identity.jobId),
      eq(jobs.leaseOwner, identity.leaseOwner), eq(jobs.leaseToken, identity.leaseToken), gt(jobs.leaseExpiresAt, now),
      or(eq(jobs.status, 'preparing'), eq(jobs.status, 'prepared'), eq(jobs.status, 'activating'))))
    if (result[0].affectedRows !== 1) throw evolutionError(409, 'EVOLUTION_RELEASE_LEASE_LOST', '发布任务执行权已失效')
    return leaseExpiresAt
  }

  async releaseForRetry(identity: EvolutionReleaseJobLease, error: { code: string; message: string }, retry: boolean, now = new Date()) {
    const parsed = z.object({ code: z.string().min(1).max(80), message: z.string().min(1).max(1000) }).strict().parse(error)
    const result = await db.update(jobs).set({ status: retry ? 'queued' : 'failed', error: parsed,
      leaseOwner: null, leaseExpiresAt: null, updatedAt: now, completedAt: retry ? null : now }).where(and(eq(jobs.id, identity.jobId),
      eq(jobs.leaseOwner, identity.leaseOwner), eq(jobs.leaseToken, identity.leaseToken),
      or(eq(jobs.status, 'preparing'), eq(jobs.status, 'prepared'))))
    if (result[0].affectedRows !== 1) throw evolutionError(409, 'EVOLUTION_RELEASE_LEASE_LOST', '发布任务执行权已失效')
  }

  async markActivating(identity: EvolutionReleaseJobLease, now = new Date()) {
    return db.transaction(async tx => {
      const [row] = await tx.select().from(jobs).where(eq(jobs.id, identity.jobId)).for('update')
      if (!row || row.status !== 'prepared' || !row.receipt || row.leaseOwner !== identity.leaseOwner || row.leaseToken !== identity.leaseToken
        || !row.leaseExpiresAt || row.leaseExpiresAt <= now) throw evolutionError(409, 'EVOLUTION_RELEASE_LEASE_LOST', '发布任务执行权已失效')
      const receipt = parseEvolutionReleaseReceipt(row.receipt)
      await tx.update(jobs).set({ status: 'activating', updatedAt: now }).where(eq(jobs.id, row.id))
      return { ...row, status: 'activating' as const, receipt }
    })
  }

  async settleDispatchFailure(identity: EvolutionReleaseJobLease, error: { code: string; message: string }, maxAttempts = 3, now = new Date()) {
    const parsed = z.object({ code: z.string().min(1).max(80), message: z.string().min(1).max(1000) }).strict().parse(error)
    return db.transaction(async tx => {
      const [row] = await tx.select({ job: jobs, approval: approvals }).from(jobs).innerJoin(approvals, eq(approvals.id, jobs.approvalId))
        .where(eq(jobs.id, identity.jobId)).for('update')
      if (!row || row.job.leaseOwner !== identity.leaseOwner || row.job.leaseToken !== identity.leaseToken
        || !['prepared', 'activating'].includes(row.job.status)) return 'superseded' as const
      if (row.approval.consumedAt || row.job.status === 'activating') {
        await tx.update(jobs).set({ status: 'activating', error: parsed, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
          .where(eq(jobs.id, row.job.id))
        return 'recovery' as const
      }
      const retry = row.job.attempt < maxAttempts
      await tx.update(jobs).set({ status: retry ? 'queued' : 'failed', error: parsed, leaseOwner: null, leaseExpiresAt: null,
        completedAt: retry ? null : now, updatedAt: now }).where(eq(jobs.id, row.job.id))
      return retry ? 'retry' as const : 'failed' as const
    })
  }

  async completeByApproval(approvalId: string, receiptInput: EvolutionReleaseReceipt,
    outcome: 'active' | 'failed' | 'rolled_back', now = new Date()) {
    identifier.parse(approvalId)
    const receipt = parseEvolutionReleaseReceipt(receiptInput)
    return db.transaction(async tx => {
      const [row] = await tx.select().from(jobs).where(eq(jobs.approvalId, approvalId)).for('update')
      if (!row) return null
      if (!row.receipt || evolutionContentHash(parseEvolutionReleaseReceipt(row.receipt)) !== evolutionContentHash(receipt)) {
        throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '发布任务与完成凭据不一致')
      }
      const status = outcome === 'active' ? 'succeeded' : outcome
      if (row.status === status) return row
      if (!['prepared', 'activating'].includes(row.status)) throw evolutionError(409, 'EVOLUTION_RELEASE_STATE', '发布任务不处于可完成状态')
      await tx.update(jobs).set({ status, error: outcome === 'failed' ? { code: 'EVOLUTION_RELEASE_FAILED', message: '目标保持在原版本' } : null,
        leaseOwner: null, leaseExpiresAt: null, completedAt: now, updatedAt: now }).where(eq(jobs.id, row.id))
      return { ...row, status, completedAt: now }
    })
  }
}
