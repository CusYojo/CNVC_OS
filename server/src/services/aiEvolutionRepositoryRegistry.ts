import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { safeEvolutionSourcePath, type EvolutionRepositoryRegistration } from '../runtime/evolution/evolutionSourceSnapshot.js'
import { evolutionError } from './aiEvolutionPolicyService.js'

const sourcePath = z.string().refine(safeEvolutionSourcePath)
const registrySchema = z.object({ schemaVersion: z.literal(1), repositories: z.array(z.object({
  id: z.string().uuid(), root: z.string().refine(path.isAbsolute),
  readablePaths: z.array(sourcePath).min(1).max(100), editablePaths: z.array(sourcePath).min(1).max(100),
  protectedPaths: z.array(sourcePath).max(100), allowedUserIds: z.array(z.string().uuid()).max(1000),
  contextPaths: z.array(sourcePath).max(100).optional(),
}).strict()).max(20) }).strict()

export function parseEvolutionRepositoryRegistry(value: unknown) {
  const result = registrySchema.parse(value)
  if (new Set(result.repositories.map((row) => row.id)).size !== result.repositories.length) {
    throw evolutionError(503, 'EVOLUTION_REGISTRY_INVALID', '仓库注册编号重复')
  }
  for (const row of result.repositories) {
    if (row.contextPaths?.some((context) => !row.readablePaths.some((readable) => context === readable || context.startsWith(`${readable}/`)))) {
      throw evolutionError(503, 'EVOLUTION_REGISTRY_INVALID', '模型参考路径必须位于可读取范围内')
    }
    if (row.editablePaths.some((editable) => !row.readablePaths.some((readable) => editable === readable || editable.startsWith(`${readable}/`)))) {
      throw evolutionError(503, 'EVOLUTION_REGISTRY_INVALID', '可修改路径必须位于可读取范围内')
    }
  }
  return result
}

export class AiEvolutionRepositoryRegistry {
  constructor(private readonly load: () => Promise<unknown>) {}
  async resolve(userId: string, repositoryId: string): Promise<EvolutionRepositoryRegistration> {
    const { repositories } = parseEvolutionRepositoryRegistry(await this.load())
    const row = repositories.find((item) => item.id === repositoryId && item.allowedUserIds.includes(userId))
    if (!row) throw evolutionError(403, 'EVOLUTION_REPOSITORY_FORBIDDEN', '缺少已注册仓库的明确开发授权')
    return { id: row.id, root: row.root, readablePaths: row.readablePaths, editablePaths: row.editablePaths, contextPaths: row.contextPaths,
      protectedPaths: [...new Set([...row.protectedPaths, 'server/tests', 'server/src/scripts', 'server/drizzle', '.github', 'AGENTS.md'])] }
  }
  async canDevelop(userId: string, repositoryId: string) {
    try { await this.resolve(userId, repositoryId); return true }
    catch (error) { if ((error as { code?: string }).code === 'EVOLUTION_REPOSITORY_FORBIDDEN') return false; throw error }
  }
}

export const aiEvolutionRepositoryRegistry = new AiEvolutionRepositoryRegistry(async () => {
  const file = process.env.AI_EVOLUTION_REPOSITORIES_FILE?.trim()
  if (!file) return { schemaVersion: 1, repositories: [] }
  if (!path.isAbsolute(file)) throw evolutionError(503, 'EVOLUTION_REGISTRY_INVALID', '仓库注册配置必须使用服务端绝对路径')
  const bytes = await readFile(file)
  if (bytes.length > 128 * 1024) throw evolutionError(503, 'EVOLUTION_REGISTRY_INVALID', '仓库注册配置超出大小限制')
  return JSON.parse(bytes.toString('utf8'))
})
