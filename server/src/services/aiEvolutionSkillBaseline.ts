import { z } from 'zod'
import type { AiCapabilityRecord } from '../repositories/aiConfigurationRepository.js'
import type { AiEvolutionSkillRegistry } from './aiEvolutionSkillRegistry.js'
import { AI_BUSINESS_SKILLS, AI_PPT_WORKFLOW_SKILLS, getAiSkillDirectory, getAiSkillRoot } from './aiSkillService.js'
import { captureEvolutionSkill } from '../runtime/evolution/evolutionSkillSnapshot.js'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'
import type { EvolutionSkillVersion } from '../runtime/evolution/evolutionSkillEvaluation.js'

const configuration = (row: AiCapabilityRecord | null) => row && ({ id: row.id, kind: row.kind, source: row.source,
  capabilityKey: row.capabilityKey, version: row.version, enabled: row.enabled, allowedRoles: row.allowedRoles,
  config: row.config, toolNames: row.toolNames, dependencyNames: row.dependencyNames, packageVersion: row.packageVersion })

export function createEvolutionSkillBaselineLoader(deps: {
  registry: Pick<AiEvolutionSkillRegistry, 'resolve'>
  capability: (id: string) => Promise<AiCapabilityRecord | null>
}) {
  return async (userId: string, capabilityId: string) => {
    const grant = structuredClone(await deps.registry.resolve(userId, capabilityId))
    const capability = structuredClone(await deps.capability(capabilityId))
    const configurationHash = evolutionContentHash(configuration(capability))
    if (!capability || capability.id !== grant.capabilityId || capability.version !== grant.capabilityRevision
      || capability.capabilityKey !== grant.capabilityKey || capability.source !== grant.source || capability.kind !== 'skill' || !capability.enabled) {
      throw evolutionError(409, 'EVOLUTION_AUTHORIZATION_CHANGED', '技能配置已变化')
    }
    let version: EvolutionSkillVersion, packageHash: string
    if (capability.source === 'builtin') {
      if (![...AI_BUSINESS_SKILLS, ...AI_PPT_WORKFLOW_SKILLS].some(row => row.name === capability.capabilityKey)) {
        throw evolutionError(403, 'EVOLUTION_CAPABILITY_FORBIDDEN', '技能不属于平台批准的能力目录')
      }
      const captured = await captureEvolutionSkill({ capabilityId, capabilityKey: capability.capabilityKey,
        directory: getAiSkillDirectory(capability.capabilityKey), allowedRoot: getAiSkillRoot(),
        toolNames: capability.toolNames, dependencyNames: capability.dependencyNames, config: capability.config })
      version = captured.version; packageHash = captured.packageHash
    } else {
      const config = z.object({ runtime: z.literal('uploaded-skill'), instructions: z.string().trim().min(1).max(100_000) }).strict().parse(capability.config)
      if (capability.toolNames.length || capability.dependencyNames.length) {
        throw evolutionError(409, 'EVOLUTION_SEPARATE_REVIEW_REQUIRED', '上传技能附带工具或依赖，需要代码级检查')
      }
      version = { capabilityId, instructions: config.instructions, references: [], dependencies: [],
        toolPermissionHash: evolutionContentHash({ runtime: config.runtime, toolNames: [], dependencyNames: [] }) }
      packageHash = evolutionContentHash({ version, packageVersion: capability.packageVersion })
    }
    const latest = await deps.registry.resolve(userId, capabilityId)
    const current = await deps.capability(capabilityId)
    if (latest.authorizationHash !== grant.authorizationHash || evolutionContentHash(configuration(current)) !== configurationHash) {
      throw evolutionError(409, 'EVOLUTION_AUTHORIZATION_CHANGED', '读取技能期间授权或能力配置已变化')
    }
    return { version, contentHash: evolutionContentHash(version), packageHash,
      capabilityRevision: grant.capabilityRevision, grantRevision: grant.grantRevision,
      authorizationHash: evolutionContentHash({ grantHash: grant.authorizationHash, packageHash }) }
  }
}
