import type { EvolutionSkillVersion } from '../runtime/evolution/evolutionSkillEvaluation.js'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'

/** Frozen instructions remain stable; current capability permissions must still match. */
export function assertEvolutionSkillRuntimePermissions(version: EvolutionSkillVersion, current: {
  id: string; kind: string; enabled: boolean; toolNames: string[]; dependencyNames: string[]; config: Record<string, unknown>
}) {
  const dependencies = version.dependencies.filter(item => item.name === 'capability-dependencies')
  if (current.id !== version.capabilityId || current.kind !== 'skill' || !current.enabled
    || version.toolPermissionHash !== evolutionContentHash({ toolNames: current.toolNames, config: current.config })
    || dependencies.length !== 1 || dependencies[0].contentHash !== evolutionContentHash(current.dependencyNames)) {
    throw evolutionError(403, 'EVOLUTION_SKILL_PERMISSIONS_CHANGED', '技能工具权限或依赖配置已变化，不能继续使用原任务快照')
  }
}
