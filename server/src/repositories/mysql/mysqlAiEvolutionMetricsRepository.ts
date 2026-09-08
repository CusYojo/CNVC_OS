import { and, desc, eq, gte } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { aiEvolutionApplications as applications, aiEvolutionCandidates as candidates,
  aiEvolutionEvaluations as evaluations, aiEvolutionRuns as runs } from '../../db/schema.js'

export class MySqlAiEvolutionMetricsRepository {
  async observe(ownerUserId: string, since: Date, limit = 10_001) {
    const [applicationRows, candidateRows] = await Promise.all([
      db.select({ snapshot: applications.snapshot, checkStatus: applications.checkStatus }).from(applications)
        .where(and(eq(applications.ownerUserId, ownerUserId), gte(applications.injectedAt, since)))
        .orderBy(desc(applications.injectedAt)).limit(limit),
      db.select({ report: evaluations.report }).from(evaluations)
        .innerJoin(candidates, eq(candidates.id, evaluations.candidateId)).innerJoin(runs, eq(runs.id, candidates.runId))
        .where(and(eq(runs.ownerUserId, ownerUserId), gte(evaluations.createdAt, since)))
        .orderBy(desc(evaluations.createdAt)).limit(limit),
    ])
    return { applicationRows, candidateRows, truncated: applicationRows.length >= limit || candidateRows.length >= limit }
  }
}
