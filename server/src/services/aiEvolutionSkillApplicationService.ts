import { z } from 'zod'
import type { MySqlAiEvolutionSkillApplicationRepository } from '../repositories/mysql/mysqlAiEvolutionSkillApplicationRepository.js'
import type { MySqlAiEvolutionSkillBindingRepository } from '../repositories/mysql/mysqlAiEvolutionSkillBindingRepository.js'
import type { EvolutionSkillTaskSnapshot } from '../contracts/aiEvolutionSkillApplicationContract.js'
import type { AiEvolutionArtifactStore } from './aiEvolutionArtifactStore.js'
import { evolutionError } from './aiEvolutionPolicyService.js'
import { reconstructEvolutionSkillRuntime } from '../runtime/evolution/evolutionSkillPackage.js'

type Applications = Pick<MySqlAiEvolutionSkillApplicationRepository, 'read' | 'freeze'>
type Context = Parameters<Applications['read']>[0]
type Source = Parameters<Parameters<Applications['read']>[1]>[0]
type Scope = { type: 'user' | 'project'; key: string }

/** Host service: authorization callbacks come from the application, never request JSON. */
export function createEvolutionSkillApplicationService(deps: {
  applications: Applications
  bindings: Pick<MySqlAiEvolutionSkillBindingRepository, 'resolveForScope'>
  store: Pick<AiEvolutionArtifactStore, 'read'>
  authorizeContext: (context: Context, capabilityIds: string[]) => Promise<void>
  authorizeSource: (context: Context, source: Source) => Promise<void>
  authorizeRetry?: (context: Context, original: Context) => Promise<void>
  captureBaseline?: (context: Context, capabilityId: string) => Promise<Extract<EvolutionSkillTaskSnapshot['entries'][number], { status: 'baseline' }>>
}) {
  return async (context: Context, capabilityIds: string[], scopes: Scope[], retryOfTaskId?: string) => {
    // Copy caller-owned input before awaiting authorization.
    context = structuredClone(context)
    capabilityIds = z.array(z.string().uuid()).max(100).parse(capabilityIds)
    scopes = z.array(z.object({ type: z.enum(['user', 'project']), key: z.string().min(1).max(128) }).strict()).max(2).parse(scopes)
    if (new Set(capabilityIds).size !== capabilityIds.length || new Set(scopes.map(s => s.type)).size !== scopes.length
      || scopes.some(s => s.key !== (s.type === 'user' ? context.ownerUserId : context.businessProjectId))) {
      throw evolutionError(403, 'EVOLUTION_SCOPE_FORBIDDEN', '任务技能选择的作用域或能力不一致')
    }
    const authorize = (source: Source) => deps.authorizeSource(context, source)
    const read = async (readContext = context) => {
      await deps.authorizeContext(readContext, capabilityIds)
      const saved = await deps.applications.read(readContext, source => deps.authorizeSource(readContext, source), deps.store)
      if (saved) {
        const actual = saved.snapshot.entries.map(entry => entry.capabilityId)
        if (actual.length !== capabilityIds.length || actual.some(id => !capabilityIds.includes(id))) {
          throw evolutionError(409, 'EVOLUTION_APPLICATION_CONTEXT_CONFLICT', '恢复任务的能力集合已变化')
        }
      }
      await deps.authorizeContext(readContext, capabilityIds)
      return saved ? { ...saved, packages: saved.packages.map(item => ({ ...item,
        runtime: reconstructEvolutionSkillRuntime(item.bundle) })) } : null
    }
    const saved = await read()
    if (saved) return saved
    let snapshot: EvolutionSkillTaskSnapshot = { schemaVersion: 1, entries: [] }
    if (retryOfTaskId !== undefined) {
      z.string().min(1).max(128).parse(retryOfTaskId)
      if (retryOfTaskId === context.taskId || !deps.authorizeRetry) {
        throw evolutionError(403, 'EVOLUTION_SCOPE_FORBIDDEN', '任务重试关系未经授权')
      }
      const original = { ...context, taskId: retryOfTaskId }
      await deps.authorizeRetry(context, original)
      const parent = await read(original)
      if (!parent) throw evolutionError(409, 'EVOLUTION_APPLICATION_CONTEXT_CONFLICT', '原任务技能快照不存在，不能重新选择版本')
      // The repository validates the original task type, conversation and project.
      snapshot = structuredClone(parent.snapshot)
      await deps.authorizeRetry(context, original)
    }
    for (const capabilityId of retryOfTaskId === undefined ? capabilityIds : []) {
      let selection: Extract<EvolutionSkillTaskSnapshot['entries'][number], { status: 'selected' }>['selection'] | undefined
      // Precedence is explicit host policy; an authorization failure must not fall through.
      for (const scope of scopes) {
        await deps.authorizeContext(context, capabilityIds)
        const resolved = await deps.bindings.resolveForScope({ capabilityId, scope },
          source => authorize({ ...source, capabilityId }), deps.store)
        if (resolved) { selection = resolved.snapshot; break }
      }
      snapshot.entries.push(selection ? { capabilityId, status: 'selected', selection }
        : deps.captureBaseline ? await deps.captureBaseline(context, capabilityId)
        : { capabilityId, status: 'unmatched', reason: 'no_binding' })
    }
    await deps.authorizeContext(context, capabilityIds)
    await deps.applications.freeze(context, snapshot)
    // Concurrent first callers may choose differently. Only return the durable winner.
    const frozen = await read()
    if (!frozen) throw evolutionError(409, 'EVOLUTION_APPLICATION_CONTEXT_CONFLICT', '任务技能快照未保存')
    return frozen
  }
}
