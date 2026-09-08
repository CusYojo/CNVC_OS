import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { aiEvolutionSkillApplications as applications, aiEvolutionSkillVersions as versions } from '../../db/schema.js'
import { evolutionSkillTaskSnapshotSchema } from '../../contracts/aiEvolutionSkillApplicationContract.js'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { parseEvolutionSkillPackage } from '../../runtime/evolution/evolutionSkillPackage.js'
import type { AiEvolutionArtifactStore } from '../../services/aiEvolutionArtifactStore.js'

const contextSchema = z.object({ ownerUserId: z.string().uuid(), taskId: z.string().min(1).max(128), taskType: z.string().min(1).max(100),
  conversationId: z.string().uuid().nullable(), businessProjectId: z.string().uuid().nullable() }).strict()
type Context = z.infer<typeof contextSchema>

export class MySqlAiEvolutionSkillApplicationRepository {
  /** Task owner/context must be authorized by the host before calling. Source access is rechecked for every saved version. */
  async read(contextInput: Context, authorize: (version: { capabilityId: string; versionId: string; ownerUserId: string;
    runId: string; candidateId: string | null }) => Promise<void>, store: Pick<AiEvolutionArtifactStore, 'read'>) {
    const context = contextSchema.parse(contextInput)
    // Saved snapshots and version packages are immutable. Do not hold a pool
    // connection across authorization callbacks or artifact IO.
    return (async () => {
      const tx = db
      const [saved] = await tx.select().from(applications).where(and(eq(applications.ownerUserId, context.ownerUserId), eq(applications.taskId, context.taskId)))
      if (!saved) return null
      if (saved.contextHash !== evolutionContentHash(context)) throw evolutionError(409, 'EVOLUTION_APPLICATION_CONTEXT_CONFLICT', '任务技能快照上下文已变化')
      const snapshot = evolutionSkillTaskSnapshotSchema.parse(saved.snapshot)
      if (evolutionContentHash(snapshot) !== saved.snapshotHash) throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '任务快照摘要不一致')
      const packages = []
      for (const entry of snapshot.entries) {
        if (entry.status === 'baseline') {
          if (entry.ownerUserId !== context.ownerUserId) throw evolutionError(403, 'EVOLUTION_SCOPE_FORBIDDEN', '基线技能快照归属不一致')
          const bundle = parseEvolutionSkillPackage(JSON.parse((await store.read(entry.sourceTaskId, entry.artifact)).toString('utf8')))
          if (bundle.version.capabilityId !== entry.capabilityId || bundle.contentHash !== entry.contentHash
            || bundle.packageHash !== entry.packageHash || bundle.contentHash !== bundle.runtimeSnapshot.contentHash) {
            throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '基线技能包与任务快照不一致')
          }
          packages.push({ versionId: `baseline:${bundle.contentHash}`, bundle })
          continue
        }
        if (entry.status !== 'selected') continue
        const selected = entry.selection
        if (selected.scope.type === 'user' ? selected.scope.key !== context.ownerUserId : selected.scope.key !== context.businessProjectId) {
          throw evolutionError(403, 'EVOLUTION_SCOPE_FORBIDDEN', '保存的技能快照与任务作用域不一致')
        }
        const [version] = await tx.select().from(versions).where(eq(versions.id, selected.versionId))
        if (!version || version.capabilityId !== entry.capabilityId || version.contentHash !== selected.contentHash || version.packageHash !== selected.packageHash) {
          throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '保存的技能版本引用不一致')
        }
        const source = { capabilityId: version.capabilityId, versionId: version.id, ownerUserId: version.ownerUserId,
          runId: version.runId, candidateId: version.candidateId }
        await authorize(source)
        const bundle = parseEvolutionSkillPackage(JSON.parse((await store.read(version.runId, version.packageArtifact)).toString('utf8')))
        if (bundle.contentHash !== selected.contentHash || bundle.packageHash !== selected.packageHash
          || evolutionContentHash(version.content) !== selected.contentHash) throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '保存的技能包摘要不一致')
        await authorize(source)
        packages.push({ versionId: version.id, bundle })
      }
      return { applicationId: saved.id, snapshot, snapshotHash: saved.snapshotHash, packages }
    })()
  }

  /** Caller verifies task ownership, scopes and selected source permissions. Empty snapshots are intentionally durable. */
  async freeze(contextInput: Context, snapshotInput: unknown) {
    const context = contextSchema.parse(contextInput), contextHash = evolutionContentHash(context)
    const snapshot = evolutionSkillTaskSnapshotSchema.parse(snapshotInput), snapshotHash = evolutionContentHash(snapshot)
    return db.transaction(async tx => {
      for (const entry of snapshot.entries) {
        if (entry.status === 'baseline' && entry.ownerUserId !== context.ownerUserId) {
          throw evolutionError(403, 'EVOLUTION_SCOPE_FORBIDDEN', '基线技能快照归属不一致')
        }
        if (entry.status !== 'selected') continue
        const selected = entry.selection
        if (selected.scope.type === 'user' ? selected.scope.key !== context.ownerUserId : selected.scope.key !== context.businessProjectId) {
          throw evolutionError(403, 'EVOLUTION_SCOPE_FORBIDDEN', '技能快照与任务作用域不一致')
        }
        const [version] = await tx.select().from(versions).where(eq(versions.id, selected.versionId))
        if (!version || version.capabilityId !== entry.capabilityId || version.contentHash !== selected.contentHash
          || version.packageHash !== selected.packageHash || evolutionContentHash(version.content) !== selected.contentHash) {
          throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '任务引用的技能版本不一致')
        }
      }
      await tx.insert(applications).values({ id: randomUUID(), ...context, contextHash, snapshot, snapshotHash })
        .onDuplicateKeyUpdate({ set: { id: sql`${applications.id}` } })
      const [saved] = await tx.select().from(applications).where(and(eq(applications.ownerUserId, context.ownerUserId), eq(applications.taskId, context.taskId))).for('update')
      if (!saved || saved.contextHash !== contextHash) throw evolutionError(409, 'EVOLUTION_APPLICATION_CONTEXT_CONFLICT', '任务技能快照上下文已变化')
      if (evolutionContentHash(evolutionSkillTaskSnapshotSchema.parse(saved.snapshot)) !== saved.snapshotHash) {
        throw evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '持久技能快照摘要不一致')
      }
      return saved
    })
  }
}
