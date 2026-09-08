import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { evolutionError } from './aiEvolutionPolicyService.js'

const schema = z.object({ schemaVersion: z.literal(1), targets: z.array(z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), label: z.string().trim().min(1).max(120),
  repositoryId: z.string().uuid(), root: z.string().refine(path.isAbsolute),
  baseRef: z.string().regex(/^(?!-)[a-zA-Z0-9_./-]{1,160}$/),
  allowedUserIds: z.array(z.string().uuid()).max(1000),
}).strict()).max(20) }).strict()

export function parseAiEvolutionReleaseTargets(value: unknown) { return schema.parse(value) }

export class AiEvolutionReleaseRegistry {
  constructor(private readonly load: () => Promise<unknown>) {}
  async list(userId: string, repositoryId: string) {
    const { targets } = parseAiEvolutionReleaseTargets(await this.load())
    if (new Set(targets.map((target) => target.id)).size !== targets.length) throw evolutionError(503, 'EVOLUTION_RELEASE_REGISTRY_INVALID', '发布环境编号重复')
    return targets.filter((target) => target.repositoryId === repositoryId && target.allowedUserIds.includes(userId))
  }
  async resolve(userId: string, repositoryId: string, targetId: string) {
    const target = (await this.list(userId, repositoryId)).find((item) => item.id === targetId)
    if (!target) throw evolutionError(403, 'EVOLUTION_RELEASE_FORBIDDEN', '没有该仓库到目标环境的明确发布权限')
    return target
  }
}

export async function loadAiEvolutionReleaseTargetsFile() {
  const file = process.env.AI_EVOLUTION_RELEASE_TARGETS_FILE?.trim()
  if (!file) return { schemaVersion: 1 as const, targets: [] }
  if (!path.isAbsolute(file)) throw Error('Release targets configuration must use an absolute path')
  const bytes = await readFile(file)
  if (bytes.length > 128 * 1024) throw Error('Release targets configuration too large')
  return parseAiEvolutionReleaseTargets(JSON.parse(bytes.toString('utf8')))
}
export const aiEvolutionReleaseRegistry = new AiEvolutionReleaseRegistry(loadAiEvolutionReleaseTargetsFile)
