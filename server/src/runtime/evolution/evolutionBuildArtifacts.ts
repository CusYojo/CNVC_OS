import { z } from 'zod'
import type { DockerEvolutionEnvironment } from './dockerEvolutionEnvironment.js'
import type { AiEvolutionArtifactStore } from '../../services/aiEvolutionArtifactStore.js'
import type { EvolutionCandidateManifest } from '../../contracts/aiEvolutionEvaluationContract.js'
import { safeEvolutionSourcePath } from './evolutionSourceSnapshot.js'
import { evolutionError, type EvolutionLeaseIdentity } from '../../services/aiEvolutionPolicyService.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const buildManifestSchema = z.object({
  schemaVersion: z.literal(1), baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/), patchHash: hash, lockHash: hash,
  activated: z.literal(false), createdAt: z.string(), nodeVersion: z.string(),
  buildParameters: z.object({ mode: z.literal('production'), sourceEnvLoaded: z.literal(false), sourceViteConfigLoaded: z.literal(false) }).strict(),
  artifacts: z.array(z.object({ path: z.string().refine(safeEvolutionSourcePath), bytes: z.number().int().min(0).max(128 * 1024 * 1024), sha256: hash }).strict()).min(1).max(4900),
}).strict()

/** Export only verified build files; retain a path index for preview and later release assembly. */
export async function collectEvolutionBuildArtifacts(input: {
  identity: EvolutionLeaseIdentity; baseCommit: string; patchHash: string; lockHash: string; manifest: unknown
  environment: Pick<DockerEvolutionEnvironment, 'readOutputFile'> & Partial<Pick<DockerEvolutionEnvironment, 'readOutputFiles'>>
  store: Pick<AiEvolutionArtifactStore, 'put'>
  assertCanContinue: () => Promise<void>
}) {
  const build = buildManifestSchema.parse(input.manifest)
  if (build.baseCommit !== input.baseCommit || build.patchHash !== input.patchHash || build.lockHash !== input.lockHash
    || new Set(build.artifacts.map((file) => file.path.toLowerCase())).size !== build.artifacts.length
    || build.artifacts.reduce((sum, file) => sum + file.bytes, 0) > 256 * 1024 * 1024
    || !build.artifacts.some((file) => file.path === 'dist/index.html')
    || !build.artifacts.some((file) => file.path === 'server-dist/index.js')
    || build.artifacts.some((file) => !file.path.startsWith('dist/') && !file.path.startsWith('server-dist/'))) {
    throw evolutionError(409, 'EVOLUTION_BUILD_BINDING', '构建清单的基线、依赖、路径或体积不符合要求')
  }
  const artifacts: EvolutionCandidateManifest['artifacts'] = []
  const index = []
  let cursor = 0
  while (cursor < build.artifacts.length) {
    const batch = [build.artifacts[cursor++]]
    let size = batch[0].bytes
    while (cursor < build.artifacts.length && batch.length < 100 && size + build.artifacts[cursor].bytes <= 192 * 1024) {
      size += build.artifacts[cursor].bytes; batch.push(build.artifacts[cursor++])
    }
    const contents = input.environment.readOutputFiles && size <= 192 * 1024
      ? await input.environment.readOutputFiles(input.identity, batch, input.assertCanContinue)
      : await Promise.all(batch.map((file) => input.environment.readOutputFile(input.identity, file, input.assertCanContinue)))
    for (const [offset, file] of batch.entries()) {
    await input.assertCanContinue()
    const bytes = contents[offset]
    const artifact = await input.store.put(input.identity.runId, bytes, file.path.startsWith('dist/') ? 'web' : 'server')
    if (artifact.sha256 !== file.sha256 || artifact.bytes !== file.bytes) throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '保存的构建产物与清单不一致')
    index.push({ path: file.path, ...artifact })
    if (!artifacts.some((item) => item.storageKey === artifact.storageKey)) artifacts.push(artifact)
    }
  }
  const pathIndex = await input.store.put(input.identity.runId, Buffer.from(JSON.stringify({ schemaVersion: 1, build, files: index })), 'report')
  artifacts.push(pathIndex)
  return { artifacts, pathIndex, files: index }
}
