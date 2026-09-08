import { randomUUID } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { aiEvolutionApplications as applications, aiEvolutionCandidates as candidates,
  aiEvolutionFeedback as feedback, aiEvolutionRuns as runs } from '../../db/schema.js'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'

export type EvolutionFeedbackInput = {
  candidateId?: string; applicationId?: string; feedbackType: string; comment: string
  evidenceRefs: Array<{ type: string; id: string }>; idempotencyKey: string
}

export class MySqlAiEvolutionFeedbackRepository {
  async findApplicationSubject(ownerUserId: string, applicationId: string) {
    const [row] = await db.select({ id: applications.id, taskId: applications.taskId }).from(applications)
      .where(and(eq(applications.id, applicationId), eq(applications.ownerUserId, ownerUserId)))
    return row ?? null
  }

  async create(ownerUserId: string, input: EvolutionFeedbackInput) {
    const inputHash = evolutionContentHash({ candidateId: input.candidateId ?? null, applicationId: input.applicationId ?? null,
      feedbackType: input.feedbackType, comment: input.comment, evidenceRefs: input.evidenceRefs })
    return db.transaction(async tx => {
      const [existing] = await tx.select().from(feedback).where(and(eq(feedback.ownerUserId, ownerUserId),
        eq(feedback.idempotencyKey, input.idempotencyKey))).for('update')
      if (existing) {
        if (existing.contentHash !== inputHash) throw evolutionError(409, 'EVOLUTION_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同反馈')
        return existing
      }
      if (input.candidateId) {
        const [owned] = await tx.select({ id: candidates.id }).from(candidates).innerJoin(runs, eq(runs.id, candidates.runId))
          .where(and(eq(candidates.id, input.candidateId), eq(runs.ownerUserId, ownerUserId)))
        if (!owned) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '反馈候选不存在或不可访问')
      } else {
        const [owned] = await tx.select({ id: applications.id }).from(applications)
          .where(and(eq(applications.id, input.applicationId!), eq(applications.ownerUserId, ownerUserId)))
        if (!owned) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '反馈应用记录不存在或不可访问')
      }
      const proposedId = randomUUID()
      await tx.insert(feedback).values({ id: proposedId, ownerUserId, candidateId: input.candidateId ?? null,
        applicationId: input.applicationId ?? null, feedbackType: input.feedbackType, comment: input.comment,
        evidenceRefs: input.evidenceRefs, contentHash: inputHash, idempotencyKey: input.idempotencyKey })
        .onDuplicateKeyUpdate({ set: { id: sql`${feedback.id}` } })
      const [stored] = await tx.select().from(feedback).where(and(eq(feedback.ownerUserId, ownerUserId),
        eq(feedback.idempotencyKey, input.idempotencyKey))).for('update')
      if (!stored || stored.contentHash !== inputHash) throw evolutionError(409, 'EVOLUTION_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同反馈')
      return stored
    })
  }

  async list(ownerUserId: string, subject: { candidateId?: string; applicationId?: string }, limit: number, offset: number) {
    const subjectFilter = subject.candidateId ? eq(feedback.candidateId, subject.candidateId) : eq(feedback.applicationId, subject.applicationId!)
    return db.select().from(feedback).where(and(eq(feedback.ownerUserId, ownerUserId), subjectFilter))
      .orderBy(desc(feedback.createdAt), desc(feedback.id)).limit(limit).offset(offset)
  }
}
