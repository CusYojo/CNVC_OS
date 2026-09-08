import path from 'node:path'
import { open } from 'node:fs/promises'
import { z } from 'zod'
import { isAiPlatformAdminRole } from '../contracts/adminRoleContract.js'
import type { AiCapabilityRecord } from '../repositories/aiConfigurationRepository.js'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'

const schema = z.object({ schemaVersion: z.literal(1), capabilities: z.array(z.object({
  capabilityId: z.string().uuid(), capabilityKey: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),
  source: z.enum(['builtin', 'uploaded']), capabilityRevision: z.number().int().positive(),
  grantRevision: z.number().int().positive(), allowedUserIds: z.array(z.string().uuid()).max(1000),
  publication: z.object({ maxTrialSeconds: z.number().int().min(60).max(30 * 24 * 3600),
    scopes: z.array(z.object({ type: z.enum(['user', 'project']), key: z.string().uuid() }).strict()).min(1).max(100),
  }).strict().optional(),
}).strict()).max(100) }).strict()

export function parseEvolutionSkillRegistry(input: unknown) {
  const value = schema.parse(input)
  if (new Set(value.capabilities.map(row => row.capabilityId)).size !== value.capabilities.length
    || value.capabilities.some(row => new Set(row.allowedUserIds).size !== row.allowedUserIds.length
      || (row.publication && new Set(row.publication.scopes.map(scope => `${scope.type}:${scope.key}`)).size !== row.publication.scopes.length))) {
    throw evolutionError(503, 'EVOLUTION_SKILL_REGISTRY_INVALID', '技能授权配置存在重复编号')
  }
  return value
}

type Capability = Pick<AiCapabilityRecord, 'id' | 'kind' | 'capabilityKey' | 'source' | 'version' | 'enabled' | 'allowedRoles'>
type Actor = { id: string; role: string; status: string }

/** Publication requires an additional explicit scope grant; execution grants alone never permit it. */
export class AiEvolutionSkillRegistry {
  constructor(private readonly dependencies: {
    load: () => Promise<unknown>
    actor: (userId: string) => Promise<Actor | null>
    capability: (capabilityId: string) => Promise<Capability | null>
  }) {}

  async resolve(userId: string, capabilityId: string) {
    const actor = await this.dependencies.actor(userId)
    const denied = () => evolutionError(403, 'EVOLUTION_CAPABILITY_FORBIDDEN', '缺少目标技能的明确管理授权')
    if (!actor || actor.id !== userId || actor.status !== '启用' || !isAiPlatformAdminRole(actor.role)) throw denied()
    const registry = parseEvolutionSkillRegistry(await this.dependencies.load())
    const grant = registry.capabilities.find(row => row.capabilityId === capabilityId && row.allowedUserIds.includes(userId))
    if (!grant) throw denied()
    const capability = await this.dependencies.capability(capabilityId)
    if (!capability || capability.id !== capabilityId || capability.kind !== 'skill' || !capability.enabled
      || capability.capabilityKey !== grant.capabilityKey || capability.source !== grant.source
      || capability.version !== grant.capabilityRevision
      || (capability.allowedRoles.length > 0 && !capability.allowedRoles.includes(actor.role))) throw denied()
    return { capabilityId, capabilityKey: capability.capabilityKey, source: capability.source,
      capabilityRevision: capability.version, grantRevision: grant.grantRevision,
      ...(grant.publication ? { publication: structuredClone(grant.publication) } : {}),
      authorizationHash: evolutionContentHash({ schemaVersion: 1, userId, role: actor.role, grant }) }
  }

  async resolvePublication(userId: string, capabilityId: string, scope: { type: 'user' | 'project'; key: string }) {
    const grant = await this.resolve(userId, capabilityId)
    if (!grant.publication?.scopes.some(item => item.type === scope.type && item.key === scope.key)) {
      throw evolutionError(403, 'EVOLUTION_RELEASE_FORBIDDEN', '缺少目标技能及作用域的明确发布授权')
    }
    return { capabilityId, scope: { ...scope }, maxTrialSeconds: grant.publication.maxTrialSeconds,
      authorizationHash: grant.authorizationHash, grantRevision: grant.grantRevision }
  }

  async canManage(userId: string, capabilityId: string) {
    try { await this.resolve(userId, capabilityId); return true }
    catch (error) { if ((error as { code?: string }).code === 'EVOLUTION_CAPABILITY_FORBIDDEN') return false; throw error }
  }
}

export async function loadEvolutionSkillRegistryFile() {
  const file = process.env.AI_EVOLUTION_SKILLS_FILE?.trim()
  if (!file) return { schemaVersion: 1, capabilities: [] }
  if (!path.isAbsolute(file)) throw evolutionError(503, 'EVOLUTION_SKILL_REGISTRY_INVALID', '技能授权配置必须使用服务端绝对路径')
  const handle = await open(file, 'r')
  try {
    const limit = 256 * 1024
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit) throw evolutionError(503, 'EVOLUTION_SKILL_REGISTRY_INVALID', '技能授权配置超出大小限制')
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > limit) throw evolutionError(503, 'EVOLUTION_SKILL_REGISTRY_INVALID', '技能授权配置超出大小限制')
    return JSON.parse(bytes.subarray(0, length).toString('utf8')) as unknown
  } finally { await handle.close() }
}
