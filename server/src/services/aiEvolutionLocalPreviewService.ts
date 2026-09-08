import { z } from 'zod'
import { startEvolutionLocalPreview } from '../runtime/evolution/evolutionLocalPreview.js'
import { evolutionLeadPageScenario } from '../runtime/evolution/evolutionLeadPageScenario.js'
import { aiEvolutionArtifactStore, getAiEvolutionCandidateForUser } from './aiEvolutionApplicationService.js'
import { evolutionError } from './aiEvolutionPolicyService.js'

const indexSchema = z.object({ schemaVersion: z.literal(1), build: z.object({ baseCommit: z.string(), patchHash: z.string(), lockHash: z.string() }),
  files: z.array(z.object({ path: z.string().startsWith('dist/'), storageKey: z.string(), sha256: z.string(), bytes: z.number().int().min(0), kind: z.literal('web') })).min(1).max(5000) })
const previews = new Set<Awaited<ReturnType<typeof startEvolutionLocalPreview>>>()
let pending = 0

export async function createAiEvolutionLocalPreview(userId: string, candidateId: string) {
  if (process.env.AI_EVOLUTION_LOCAL_PREVIEW_ENABLED !== 'true' || process.env.NODE_ENV === 'production') {
    throw evolutionError(503, 'EVOLUTION_PREVIEW_UNAVAILABLE', '本机隔离预览尚未启用；生产环境需配置独立预览域名')
  }
  if (previews.size + pending >= 4) throw evolutionError(429, 'EVOLUTION_PREVIEW_LIMIT', '同时预览数量已达上限，请等待旧预览过期')
  pending++
  try {
    const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
    const authorize = async () => {
      const current = await getAiEvolutionCandidateForUser(userId, candidateId)
      if (current.contentHash !== candidate.contentHash || ['retired', 'failed'].includes(current.status)) throw evolutionError(403, 'EVOLUTION_PREVIEW_REVOKED', '候选已失效')
    }
    let files: z.infer<typeof indexSchema>['files'] | undefined
    for (const artifact of candidate.manifest.artifacts.filter((item) => item.kind === 'report')) {
      const bytes = await aiEvolutionArtifactStore.read(candidate.runId, artifact)
      let raw: { schemaVersion?: number; build?: unknown; files?: unknown }
      try { raw = JSON.parse(bytes.toString('utf8')) } catch { continue }
      if (!raw?.build || !Array.isArray(raw.files)) continue
      const index = indexSchema.parse({ ...raw, files: raw.files.filter((file) => file && typeof file === 'object' && 'kind' in file && file.kind === 'web') })
      if (files || index.build.baseCommit !== candidate.baseRef || index.build.patchHash !== candidate.manifest.patchHash || index.build.lockHash !== candidate.manifest.dependencyLockHash) throw Error('Preview index binding mismatch')
      if (index.files.some((file) => !candidate.manifest.artifacts.some((item) => item.kind === 'web' && item.storageKey === file.storageKey && item.sha256 === file.sha256 && item.bytes === file.bytes))) throw Error('Preview artifact outside candidate manifest')
      files = index.files
    }
    if (!files) throw evolutionError(409, 'EVOLUTION_PREVIEW_INDEX_MISSING', '候选缺少已验证的页面构建索引')
    const preview = await startEvolutionLocalPreview({ runId: candidate.runId, files, scenario: evolutionLeadPageScenario(), store: aiEvolutionArtifactStore, authorize })
    previews.add(preview)
    const timer = setTimeout(() => previews.delete(preview), Math.max(0, Date.parse(preview.expiresAt) - Date.now()) + 100)
    timer.unref()
    return { url: preview.url, expiresAt: preview.expiresAt, candidateHash: candidate.contentHash }
  } finally { pending-- }
}

export async function stopAiEvolutionLocalPreviews() {
  await Promise.all([...previews].map((preview) => preview.close()))
  previews.clear()
}
