import { randomUUID } from 'node:crypto'
import { accountEvolutionTime } from '../../services/aiEvolutionElapsedTime.js'
import { and, asc, desc, eq, gt, sql, inArray, lte, isNull } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { aiEvolutionAudits as audits, aiEvolutionEvents as events, aiEvolutionProposals as proposals, aiEvolutionRuns as runs,
  aiEvolutionModelCalls as modelCalls, aiEvolutionCandidates as candidates } from '../../db/schema.js'
import { evolutionProposalReadiness, canTransitionEvolutionRun, EVOLUTION_KINDS, type EvolutionKind, type EvolutionRunStatus, type EvolutionSpec } from '../../contracts/aiEvolutionContract.js'
import { evolutionContentHash, evolutionError, assertEvolutionLease, type EvolutionLeaseIdentity } from '../../services/aiEvolutionPolicyService.js'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type RunRow = typeof runs.$inferSelect
const activeStatuses = ['preparing', 'executing', 'evaluating']
function kindFilter(kind?: EvolutionKind) {
  if (kind === undefined) return undefined
  if (!EVOLUTION_KINDS.includes(kind)) throw evolutionError(400, 'EVOLUTION_EXECUTOR_KIND', '执行器类型无效')
  return sql`JSON_UNQUOTE(JSON_EXTRACT(${runs.frozenSpec}, '$.kind')) = ${kind}`
}

async function appendRunEvent(tx: Transaction, row: RunRow, eventType: string, payload: Record<string, unknown>) {
  await tx.insert(events).values({ id: randomUUID(), runId: row.id, sequence: row.nextEventSequence, eventType, payload: { schemaVersion: 1, ...payload } })
  await tx.update(runs).set({ nextEventSequence: row.nextEventSequence + 1 }).where(eq(runs.id, row.id))
}

function validLease(row: RunRow | undefined, identity: EvolutionLeaseIdentity, now: Date, allowCancellation = false) {
  if (!row || !row.leaseExpiresAt || !activeStatuses.includes(row.status) || row.stage === 'terminating') {
    throw evolutionError(409, 'EVOLUTION_STALE_EXECUTOR', '执行权已撤销')
  }
  assertEvolutionLease({ ...identity, runId: row.id, attempt: row.attempt, leaseToken: row.leaseToken,
    inputHash: row.inputHash, leaseExpiresAt: row.leaseExpiresAt, cancelRequestedAt: allowCancellation ? null : row.cancelRequestedAt }, identity, now)
  if (!allowCancellation && accountEvolutionTime(row, now).elapsedSeconds >= row.budget.maxDurationSeconds) {
    throw evolutionError(409, 'EVOLUTION_DURATION_EXCEEDED', '任务累计执行时间预算已耗尽')
  }
  return row
}
const conflict = () => evolutionError(409, 'EVOLUTION_REVISION_CONFLICT', '提案已变化，请刷新后重试')
const missing = () => evolutionError(404, 'EVOLUTION_NOT_FOUND', '进化对象不存在或无权访问')

async function audit(tx: Transaction, userId: string, proposalId: string, action: string, contentHash: string) {
  await tx.insert(audits).values({ id: randomUUID(), actorUserId: userId, proposalId, action, contentHash })
}

export class MySqlAiEvolutionRepository {
  /** Bind once under the run lock; later attempts must keep the same host execution profile. */
  async bindExecutionProfile(identity: EvolutionLeaseIdentity, profileHash: string, now = new Date()) {
    if (!/^[a-f0-9]{64}$/.test(profileHash)) throw evolutionError(400, 'EVOLUTION_INVALID_PROFILE', '执行配置摘要无效')
    return db.transaction(async (tx) => {
      const [stored] = await tx.select().from(runs).where(eq(runs.id, identity.runId)).for('update')
      const row = validLease(stored, identity, now)
      const [binding] = await tx.select().from(events).where(and(eq(events.runId, row.id), eq(events.eventType, 'execution_profile_bound'))).orderBy(asc(events.sequence)).limit(1)
      if (binding) {
        if (binding.payload.profileHash !== profileHash) throw evolutionError(409, 'EVOLUTION_EXECUTION_PROFILE_CHANGED', '任务执行配置已变化，禁止更换模型或验收环境继续原任务')
        return
      }
      await appendRunEvent(tx, row, 'execution_profile_bound', { profileHash })
    })
  }
  async reserveModelCall(identity: EvolutionLeaseIdentity, callKey: string, inputHash: string, reservedTokens: number, now = new Date()) {
    if (!/^[a-z0-9_.:-]{1,128}$/.test(callKey) || !/^[a-f0-9]{64}$/.test(inputHash) || !Number.isInteger(reservedTokens) || reservedTokens < 1 || reservedTokens > 1_000_000) {
      throw evolutionError(400, 'EVOLUTION_INVALID_RESERVATION', '模型预算预留参数无效')
    }
    return db.transaction(async (tx) => {
      const [stored] = await tx.select().from(runs).where(eq(runs.id, identity.runId)).for('update')
      const row = validLease(stored, identity, now)
      const calls = await tx.select().from(modelCalls).where(eq(modelCalls.runId, row.id))
      const existing = calls.find((call) => call.callKey === callKey)
      if (existing) {
        if (existing.inputHash !== inputHash || existing.reservedTokens !== reservedTokens || existing.attempt !== identity.attempt || existing.leaseToken !== identity.leaseToken) {
          throw evolutionError(409, 'EVOLUTION_RESERVATION_CONFLICT', '调用标识已用于不同输入或执行令牌')
        }
        // Existing reservation is evidence of a possible prior external call, never permission to repeat it.
        return { reservationId: existing.id, mayInvoke: false, status: existing.status }
      }
      const committed = calls.reduce((total, call) => total + (call.actualTokens ?? call.reservedTokens), 0)
      if (committed + reservedTokens > row.budget.maxModelTokens) throw evolutionError(409, 'EVOLUTION_BUDGET_EXCEEDED', '累计模型预算不足')
      const id = randomUUID()
      await tx.insert(modelCalls).values({ id, runId: row.id, callKey, inputHash, attempt: identity.attempt,
        leaseToken: identity.leaseToken, reservedTokens, status: 'reserved' })
      await tx.update(runs).set({ modelTokens: null, updatedAt: now }).where(eq(runs.id, row.id))
      return { reservationId: id, mayInvoke: true, status: 'reserved' }
    })
  }

  async settleModelCall(identity: EvolutionLeaseIdentity, reservationId: string, actualTokens: number | null, now = new Date()) {
    if (actualTokens !== null && (!Number.isSafeInteger(actualTokens) || actualTokens < 0 || actualTokens > 2_147_483_647)) {
      throw evolutionError(400, 'EVOLUTION_INVALID_USAGE', '模型用量无效')
    }
    return db.transaction(async (tx) => {
      const [run] = await tx.select().from(runs).where(eq(runs.id, identity.runId)).for('update')
      if (!run) throw missing()
      const [call] = await tx.select().from(modelCalls).where(and(eq(modelCalls.id, reservationId), eq(modelCalls.runId, run.id))).for('update')
      if (!call || call.attempt !== identity.attempt || call.leaseToken !== identity.leaseToken || run.inputHash !== identity.inputHash) {
        throw evolutionError(409, 'EVOLUTION_RESERVATION_CONFLICT', '模型用量与预留记录不匹配')
      }
      if (call.status === 'completed') {
        if (call.actualTokens !== actualTokens) throw evolutionError(409, 'EVOLUTION_USAGE_CONFLICT', '调用用量已记录为不同值')
      }
      // Usage may arrive after cancellation/lease revocation; it updates accounting only, never task state.
      if (call.status !== 'completed') await tx.update(modelCalls).set({ status: 'completed', actualTokens, completedAt: now }).where(eq(modelCalls.id, reservationId))
      const calls = await tx.select().from(modelCalls).where(eq(modelCalls.runId, run.id))
      const exact = calls.every((item) => item.status === 'completed' && item.actualTokens !== null)
      const total = calls.reduce((sum, item) => sum + (item.actualTokens ?? item.reservedTokens), 0)
      await tx.update(runs).set({ modelTokens: exact ? total : null, updatedAt: now }).where(eq(runs.id, run.id))
      return { budgetExceeded: total > run.budget.maxModelTokens, duplicate: call.status === 'completed' }
    })
  }

  async claimNext(workerId: string, leaseSeconds = 60, now = new Date(), kind?: EvolutionKind) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(workerId) || !Number.isInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 300) {
      throw evolutionError(400, 'EVOLUTION_INVALID_LEASE', '执行器标识或租约时长无效')
    }
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(runs).where(and(eq(runs.status, 'queued'), kindFilter(kind))).orderBy(asc(runs.createdAt), asc(runs.id)).limit(1).for('update', { skipLocked: true })
      if (!row) return null
      if (row.cancelRequestedAt) {
        await tx.update(runs).set({ status: 'cancelled', stage: 'cancelled', updatedAt: now }).where(eq(runs.id, row.id))
        await appendRunEvent(tx, row, 'cancelled', { reason: 'cancelled_before_execution' })
        return null
      }
      const update = { status: 'preparing', stage: 'preparing', attempt: row.attempt + 1, leaseToken: row.leaseToken + 1,
        leaseOwner: workerId, leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000), timeAccountedAt: now, updatedAt: now }
      await tx.update(runs).set(update).where(eq(runs.id, row.id))
      await appendRunEvent(tx, row, 'preparing', { attempt: update.attempt })
      return { ...row, ...update, nextEventSequence: row.nextEventSequence + 1 }
    })
  }

  async heartbeat(identity: EvolutionLeaseIdentity, leaseSeconds = 60, now = new Date()) {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 300) throw evolutionError(400, 'EVOLUTION_INVALID_LEASE', '租约时长无效')
    return db.transaction(async (tx) => {
      const [stored] = await tx.select().from(runs).where(eq(runs.id, identity.runId)).for('update')
      const row = validLease(stored, identity, now, true)
      // Cancellation does not extend the termination grace period indefinitely.
      const accounting = accountEvolutionTime(row, now)
      const durationExceeded = accounting.elapsedSeconds >= row.budget.maxDurationSeconds
      await tx.update(runs).set({ ...accounting, updatedAt: now,
        ...(!row.cancelRequestedAt && !durationExceeded ? { leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000) } : {}),
      }).where(eq(runs.id, row.id))
      return { cancelRequested: Boolean(row.cancelRequestedAt), budget: row.budget, durationExceeded }
    })
  }

  async saveCheckpoint(identity: EvolutionLeaseIdentity, checkpoint: Record<string, unknown>, repairRounds: number, now = new Date()) {
    return db.transaction(async (tx) => {
      const [stored] = await tx.select().from(runs).where(eq(runs.id, identity.runId)).for('update')
      const row = validLease(stored, identity, now)
      if (!Number.isInteger(repairRounds) || repairRounds < row.repairRounds || repairRounds > row.budget.maxRepairRounds) {
        throw evolutionError(409, 'EVOLUTION_REPAIR_BUDGET_EXHAUSTED', '修复轮次超出预算或发生回退')
      }
      await tx.update(runs).set({ checkpoint, repairRounds, updatedAt: now }).where(eq(runs.id, row.id))
      await appendRunEvent(tx, row, 'checkpoint', { repairRounds, candidateHash: checkpoint.candidateHash })
    })
  }

  async transition(identity: EvolutionLeaseIdentity, status: EvolutionRunStatus, checkpoint?: Record<string, unknown> | null, now = new Date()) {
    return db.transaction(async (tx) => {
      const [stored] = await tx.select().from(runs).where(eq(runs.id, identity.runId)).for('update')
      const terminal = ['cancelled', 'failed', 'interrupted'].includes(status)
      const row = validLease(stored, identity, now, terminal)
      if (!canTransitionEvolutionRun(row.status as EvolutionRunStatus, status)) throw evolutionError(409, 'EVOLUTION_INVALID_TRANSITION', '任务阶段变更无效')
      if (status === 'succeeded') throw evolutionError(409, 'EVOLUTION_CANDIDATE_REQUIRED', '成功结果必须与候选和独立评估事务提交')
      if (status === 'cancelled' && !row.cancelRequestedAt) throw evolutionError(409, 'EVOLUTION_CANCEL_NOT_REQUESTED', '任务尚未请求取消')
      await tx.update(runs).set({ ...accountEvolutionTime(row, now), status, stage: status, updatedAt: now,
        ...(checkpoint === undefined ? {} : { checkpoint }),
        ...(terminal ? { leaseOwner: null, leaseExpiresAt: null, timeAccountedAt: null } : {}) }).where(eq(runs.id, row.id))
      await appendRunEvent(tx, row, status, { attempt: row.attempt })
    })
  }

  async revokeExpired(now = new Date(), kind?: EvolutionKind) {
    return db.transaction(async (tx) => {
      const expired = await tx.select().from(runs).where(and(inArray(runs.status, activeStatuses), lte(runs.leaseExpiresAt, now), kindFilter(kind)))
        .limit(20).for('update', { skipLocked: true })
      for (const row of expired) {
        await tx.update(runs).set({ stage: 'terminating', leaseToken: row.leaseToken + 1, leaseOwner: null, leaseExpiresAt: null, updatedAt: now }).where(eq(runs.id, row.id))
        await appendRunEvent(tx, row, 'lease_revoked', { attempt: row.attempt, reason: 'heartbeat_timeout' })
      }
      return expired.map((row) => ({ ...row, leaseToken: row.leaseToken + 1, stage: 'terminating' }))
    })
  }

  async listPendingTermination(kind?: EvolutionKind) {
    return db.select().from(runs).where(and(eq(runs.stage, 'terminating'), isNull(runs.leaseOwner), kindFilter(kind))).limit(20)
  }

  async revokeRun(identity: EvolutionLeaseIdentity, error: { code: string; message: string }, now = new Date()) {
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(runs).where(eq(runs.id, identity.runId)).for('update')
      if (!row || row.attempt !== identity.attempt || row.leaseToken !== identity.leaseToken || row.inputHash !== identity.inputHash
        || !activeStatuses.includes(row.status) || row.stage === 'terminating') throw evolutionError(409, 'EVOLUTION_STALE_EXECUTOR', '执行权已撤销')
      await tx.update(runs).set({ stage: 'terminating', leaseToken: row.leaseToken + 1, leaseOwner: null, leaseExpiresAt: null,
        error: { code: error.code.slice(0, 128), message: error.message.slice(0, 2000) }, updatedAt: now }).where(eq(runs.id, row.id))
      await appendRunEvent(tx, row, 'lease_revoked', { attempt: row.attempt, reason: error.code })
      return { ...row, leaseToken: row.leaseToken + 1 }
    })
  }

  /** Host calls only after confirming that the task environment no longer exists. */
  async confirmTermination(runId: string, revokedToken: number, now = new Date()) {
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update')
      if (!row || row.stage !== 'terminating' || row.leaseToken !== revokedToken) throw evolutionError(409, 'EVOLUTION_STALE_EXECUTOR', '终止确认已失效')
      const status = row.cancelRequestedAt ? 'cancelled' : row.error && row.error.code !== 'EVOLUTION_SHUTDOWN' ? 'failed' : 'interrupted'
      await tx.update(runs).set({ ...accountEvolutionTime(row, now), timeAccountedAt: null, status, stage: status, updatedAt: now }).where(eq(runs.id, runId))
      await appendRunEvent(tx, row, status, { reason: 'environment_termination_confirmed' })
    })
  }

  async findProposal(userId: string, id: string) {
    const [row] = await db.select().from(proposals).where(and(eq(proposals.id, id), eq(proposals.ownerUserId, userId))).limit(1)
    return row ?? null
  }

  async listProposalRuns(userId: string, proposalId: string) {
    return db.select().from(runs).where(and(eq(runs.ownerUserId, userId), eq(runs.proposalId, proposalId)))
      .orderBy(desc(runs.createdAt), desc(runs.id)).limit(20)
  }

  async listProposals(userId: string, limit: number, offset: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100_000) {
      throw evolutionError(400, 'EVOLUTION_INVALID_PAGINATION', '分页参数无效')
    }
    return db.select().from(proposals).where(eq(proposals.ownerUserId, userId)).orderBy(desc(proposals.createdAt), desc(proposals.id)).limit(limit).offset(offset)
  }

  async listProposalActivity(userId: string, proposalIds: string[]) {
    if (!proposalIds.length) return {} as Record<string, { runStatus?: string; candidateStatus?: string }>
    const runRows = await db.select({ proposalId: runs.proposalId, status: runs.status, createdAt: runs.createdAt, id: runs.id })
      .from(runs).where(and(eq(runs.ownerUserId, userId), inArray(runs.proposalId, proposalIds)))
      .orderBy(desc(runs.createdAt), desc(runs.id))
    const candidateRows = await db.select({ proposalId: runs.proposalId, status: candidates.status,
      createdAt: candidates.createdAt, id: candidates.id }).from(candidates).innerJoin(runs, eq(runs.id, candidates.runId))
      .where(and(eq(runs.ownerUserId, userId), inArray(runs.proposalId, proposalIds)))
      .orderBy(desc(candidates.createdAt), desc(candidates.id))
    const result: Record<string, { runStatus?: string; candidateStatus?: string }> = {}
    for (const row of runRows) (result[row.proposalId] ??= {}).runStatus ??= row.status
    for (const row of candidateRows) (result[row.proposalId] ??= {}).candidateStatus ??= row.status
    return result
  }

  async createProposal(userId: string, spec: EvolutionSpec, idempotencyKey: string) {
    const inputHash = evolutionContentHash(spec)
    // The unique key serializes concurrent identical submissions; the no-op update never changes content.
    return db.transaction(async (tx) => {
      const id = randomUUID()
      await tx.insert(proposals).values({
        id, ownerUserId: userId, kind: spec.kind, spec, specHash: inputHash,
        status: evolutionProposalReadiness(spec), idempotencyKey, createInputHash: inputHash,
      }).onDuplicateKeyUpdate({ set: { id: sql`${proposals.id}` } })
      const [row] = await tx.select().from(proposals).where(and(eq(proposals.ownerUserId, userId), eq(proposals.idempotencyKey, idempotencyKey))).for('update')
      if (!row || row.createInputHash !== inputHash) throw evolutionError(409, 'EVOLUTION_IDEMPOTENCY_CONFLICT', '幂等键已用于不同内容')
      if (row.id === id) await audit(tx, userId, id, 'proposal_created', inputHash)
      return row
    })
  }

  async editProposal(userId: string, id: string, revision: number, spec: EvolutionSpec) {
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(proposals).where(and(eq(proposals.id, id), eq(proposals.ownerUserId, userId))).for('update')
      if (!row) throw missing()
      if (row.revision !== revision || !['draft', 'ready', 'needs_input'].includes(row.status)) throw conflict()
      const update = { spec, kind: spec.kind, specHash: evolutionContentHash(spec), status: evolutionProposalReadiness(spec), revision: revision + 1, updatedAt: new Date() }
      await tx.update(proposals).set(update).where(eq(proposals.id, id))
      await audit(tx, userId, id, 'proposal_edited', update.specHash)
      return { ...row, ...update }
    })
  }

  async decideProposal(userId: string, id: string, revision: number, decision: 'rejected' | 'deferred') {
    return db.transaction(async tx => {
      const [row] = await tx.select().from(proposals).where(and(eq(proposals.id, id), eq(proposals.ownerUserId, userId))).for('update')
      if (!row) throw missing()
      if (row.revision !== revision || !['draft', 'ready', 'needs_input'].includes(row.status)) throw conflict()
      const status = decision === 'rejected' ? 'rejected' : 'draft'
      const update = { status, revision: revision + 1, updatedAt: new Date() }
      await tx.update(proposals).set(update).where(eq(proposals.id, id))
      await audit(tx, userId, id, decision === 'rejected' ? 'proposal_rejected' : 'proposal_deferred', row.specHash)
      return { ...row, ...update }
    })
  }

  /** Caller rechecks authorization first and passes the exact authorized spec hash. */
  async enqueue(userId: string, proposalId: string, revision: number, authorizedSpecHash: string, idempotencyKey: string) {
    return db.transaction(async (tx) => {
      const [proposal] = await tx.select().from(proposals).where(and(eq(proposals.id, proposalId), eq(proposals.ownerUserId, userId))).for('update')
      if (!proposal) throw missing()
      const requestHash = evolutionContentHash({ proposalId, revision, specHash: authorizedSpecHash })
      const [existing] = await tx.select().from(runs).where(and(eq(runs.ownerUserId, userId), eq(runs.idempotencyKey, idempotencyKey))).for('update')
      if (existing) {
        if (existing.inputHash !== requestHash) throw evolutionError(409, 'EVOLUTION_IDEMPOTENCY_CONFLICT', '幂等键已用于不同执行请求')
        return existing
      }
      if (proposal.revision !== revision || proposal.specHash !== authorizedSpecHash || proposal.status !== 'ready') throw conflict()
      const id = randomUUID()
      await tx.insert(runs).values({
        id, proposalId, ownerUserId: userId, inputHash: requestHash, frozenSpec: proposal.spec, idempotencyKey,
        status: 'queued', stage: 'queued', budget: proposal.spec.budget, nextEventSequence: 2,
      })
      await tx.insert(events).values({ id: randomUUID(), runId: id, sequence: 1, eventType: 'queued', payload: { schemaVersion: 1 } })
      await tx.update(proposals).set({ status: 'approved', revision: revision + 1, updatedAt: new Date() }).where(eq(proposals.id, proposalId))
      await audit(tx, userId, proposalId, 'execution_authorized', authorizedSpecHash)
      const [created] = await tx.select().from(runs).where(eq(runs.id, id))
      return created
    })
  }

  async findRun(userId: string, id: string) {
    const [row] = await db.select().from(runs).where(and(eq(runs.id, id), eq(runs.ownerUserId, userId))).limit(1)
    return row ?? null
  }

  async resumeInterrupted(userId: string, id: string, expectedAttempt: number, now = new Date()) {
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(runs).where(and(eq(runs.id, id), eq(runs.ownerUserId, userId))).for('update')
      if (!row) throw missing()
      if (row.attempt !== expectedAttempt) throw conflict()
      if (row.status === 'queued' && row.stage === 'resume_queued') return row
      if (row.status !== 'interrupted' || row.stage !== 'interrupted' || row.leaseOwner || row.leaseExpiresAt || row.timeAccountedAt || row.cancelRequestedAt) {
        throw evolutionError(409, 'EVOLUTION_NOT_RESUMABLE', '仅可继续已确认环境停止的中断任务')
      }
      const calls = await tx.select().from(modelCalls).where(eq(modelCalls.runId, row.id))
      const committed = calls.reduce((sum, call) => sum + (call.actualTokens ?? call.reservedTokens), 0)
      if (row.elapsedSeconds >= row.budget.maxDurationSeconds || committed >= row.budget.maxModelTokens || row.repairRounds > row.budget.maxRepairRounds) {
        throw evolutionError(409, 'EVOLUTION_BUDGET_EXCEEDED', '原任务预算已耗尽，不能继续')
      }
      const update = { status: 'queued', stage: 'resume_queued', error: null, updatedAt: now }
      await tx.update(runs).set(update).where(eq(runs.id, id))
      await appendRunEvent(tx, row, 'resume_requested', { previousAttempt: row.attempt, elapsedSeconds: row.elapsedSeconds, committedModelTokens: committed })
      await audit(tx, userId, row.proposalId, 'execution_resume_authorized', row.inputHash)
      return { ...row, ...update, nextEventSequence: row.nextEventSequence + 1 }
    })
  }

  async listEvents(userId: string, runId: string, afterSequence: number) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw evolutionError(400, 'EVOLUTION_INVALID_SEQUENCE', '事件序号无效')
    if (!await this.findRun(userId, runId)) throw missing()
    return db.select().from(events).where(and(eq(events.runId, runId), gt(events.sequence, afterSequence))).orderBy(asc(events.sequence)).limit(100)
  }

  async requestCancel(userId: string, id: string) {
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(runs).where(and(eq(runs.id, id), eq(runs.ownerUserId, userId))).for('update')
      if (!row) throw missing()
      if (row.cancelRequestedAt || ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(row.status)) return row
      const now = new Date()
      await tx.update(runs).set({ cancelRequestedAt: now, nextEventSequence: row.nextEventSequence + 1, updatedAt: now }).where(eq(runs.id, id))
      await tx.insert(events).values({ id: randomUUID(), runId: id, sequence: row.nextEventSequence, eventType: 'cancel_requested', payload: { schemaVersion: 1 } })
      await audit(tx, userId, row.proposalId, 'cancel_requested', row.inputHash)
      // No cancelled status until the executor (or queued-task coordinator) confirms termination.
      return { ...row, cancelRequestedAt: now, nextEventSequence: row.nextEventSequence + 1, updatedAt: now }
    })
  }
}
