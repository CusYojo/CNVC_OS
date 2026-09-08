import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { aiEvolutionSkillVersions as versions, aiEvolutionCandidates as candidates, aiEvolutionRuns as runs,
  aiEvolutionEvaluations as evaluations, aiEvolutionAudits as audits } from '../../db/schema.js'
import type { AiEvolutionArtifactStore } from '../../services/aiEvolutionArtifactStore.js'
import type { EvolutionCandidateManifest } from '../../contracts/aiEvolutionEvaluationContract.js'
import { evaluationHasRequiredEvidence } from '../../contracts/aiEvolutionEvaluationContract.js'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { parseEvolutionSkillPackage, reconstructEvolutionSkillRuntime } from '../../runtime/evolution/evolutionSkillPackage.js'

export class MySqlAiEvolutionSkillVersionRepository {
  async findForOwner(userId: string, versionId: string) {
    const [version] = await db.select().from(versions).where(and(eq(versions.id, versionId), eq(versions.ownerUserId, userId)))
    return version ?? null
  }
  /** Caller revalidates actor/source permissions. Registration never changes any active binding. */
  async registerCandidatePackage(userId: string, candidateId: string, artifact: EvolutionCandidateManifest['artifacts'][number],
    store: Pick<AiEvolutionArtifactStore, 'read'>, assertAuthorized?: () => Promise<void>) {
    await assertAuthorized?.()
      const [row] = await db.select({ candidate: candidates, run: runs, evaluation: evaluations }).from(candidates)
        .innerJoin(runs, eq(runs.id, candidates.runId)).innerJoin(evaluations, eq(evaluations.candidateId, candidates.id))
        .where(and(eq(candidates.id, candidateId), eq(runs.ownerUserId, userId)))
      if (!row) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '候选不存在或无权访问')
      const invalid = () => evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '版本包未绑定有效技能候选')
      if (row.candidate.kind !== 'skill' || row.run.frozenSpec.target.type !== 'skill' || row.run.status !== 'succeeded'
        || !['awaiting_approval', 'approved', 'active', 'rolled_back'].includes(row.candidate.status)
        || !evaluationHasRequiredEvidence('skill', row.evaluation.report)
        || !row.evaluation.report.checks.some(check => check.id === 'improvement' && check.verdict === 'PASS')
        || evolutionContentHash({ kind: row.candidate.kind, baseRef: row.candidate.baseRef,
          manifest: row.candidate.manifest, summary: row.candidate.summary }) !== row.candidate.contentHash
        || row.evaluation.candidateHash !== row.candidate.contentHash
        || evolutionContentHash({ candidateHash: row.candidate.contentHash, report: row.evaluation.report }) !== row.evaluation.evaluationHash
        || row.evaluation.report.candidateHash !== row.candidate.manifest.sourceHash
        || artifact.kind !== 'content' || artifact.bytes > 32 * 1024 * 1024
        || !row.candidate.manifest.artifacts.some(ref => evolutionContentHash(ref) === evolutionContentHash(artifact))) throw invalid()
      const bundle = parseEvolutionSkillPackage(JSON.parse((await store.read(row.run.id, artifact)).toString('utf8')))
      reconstructEvolutionSkillRuntime(bundle)
      if (bundle.version.capabilityId !== row.run.frozenSpec.target.capabilityId
        || bundle.runtimeSnapshot.contentHash !== row.candidate.baseRef
        || ![row.candidate.baseRef, row.candidate.manifest.sourceHash].includes(bundle.contentHash)) throw invalid()
      const match = and(eq(versions.capabilityId, bundle.version.capabilityId), eq(versions.contentHash, bundle.contentHash), eq(versions.packageHash, bundle.packageHash))
      const id = randomUUID()
      await assertAuthorized?.()
    // File IO and application authorization may use other pool connections. Finish
    // both before holding a transaction connection, then lock and recheck the input.
    return db.transaction(async tx => {
      const [current] = await tx.select({ candidate: candidates, run: runs, evaluation: evaluations }).from(candidates)
        .innerJoin(runs, eq(runs.id, candidates.runId)).innerJoin(evaluations, eq(evaluations.candidateId, candidates.id))
        .where(and(eq(candidates.id, candidateId), eq(runs.ownerUserId, userId))).for('update')
      if (!current || current.run.status !== 'succeeded'
        || evolutionContentHash({ ...current.candidate, createdAt: current.candidate.createdAt.toISOString() })
          !== evolutionContentHash({ ...row.candidate, createdAt: row.candidate.createdAt.toISOString() })
        || evolutionContentHash({ ...current.evaluation, createdAt: current.evaluation.createdAt.toISOString() })
          !== evolutionContentHash({ ...row.evaluation, createdAt: row.evaluation.createdAt.toISOString() })
        || evolutionContentHash(current.run.frozenSpec) !== evolutionContentHash(row.run.frozenSpec)) {
        throw evolutionError(409, 'EVOLUTION_INPUT_CHANGED', '登记期间候选或评估内容已变化')
      }
      // Unique content key arbitrates concurrent registrations. Never replace saved content or provenance.
      await tx.insert(versions).values({ id, ownerUserId: userId, capabilityId: bundle.version.capabilityId,
        runId: row.run.id, candidateId, contentHash: bundle.contentHash, content: bundle.version,
        packageHash: bundle.packageHash, packageArtifact: artifact }).onDuplicateKeyUpdate({ set: { id: sql`${versions.id}` } })
      const [saved] = await tx.select().from(versions).where(match)
      if (!saved || saved.ownerUserId !== userId || evolutionContentHash(saved.content) !== bundle.contentHash) {
        throw evolutionError(409, 'EVOLUTION_SKILL_VERSION_CONFLICT', '技能版本登记存在归属或内容冲突')
      }
      if (saved.id === id) await tx.insert(audits).values({ id: randomUUID(), actorUserId: userId,
        proposalId: row.run.proposalId, action: 'skill_version_registered', contentHash: bundle.contentHash })
      return { versionId: saved.id, contentHash: saved.contentHash, packageHash: saved.packageHash, duplicate: saved.id !== id }
    })
  }
}
