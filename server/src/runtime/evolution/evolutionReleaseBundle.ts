import { z } from 'zod'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { buildManifestSchema } from './evolutionBuildArtifacts.js'
import { safeEvolutionSourcePath } from './evolutionSourceSnapshot.js'
import type { EvolutionCandidateManifest } from '../../contracts/aiEvolutionEvaluationContract.js'
import type { AiEvolutionArtifactStore } from '../../services/aiEvolutionArtifactStore.js'

const indexSchema = z.object({ schemaVersion: z.literal(1), build: buildManifestSchema,
  files: z.array(z.object({ path: z.string().refine(safeEvolutionSourcePath), storageKey: z.string(), sha256: z.string(),
    bytes: z.number().int().min(0), kind: z.enum(['web', 'server']) }).strict()).min(1).max(4900),
}).strict()

/** Decode only the content-addressed path index belonging to this reviewed candidate. */
export function parseEvolutionReleaseIndex(raw: unknown, manifest: EvolutionCandidateManifest, baseRef: string) {
  const index = indexSchema.parse(raw)
  if (index.build.baseCommit !== baseRef || index.build.patchHash !== manifest.patchHash || index.build.lockHash !== manifest.dependencyLockHash
    || index.files.length !== index.build.artifacts.length || new Set(index.files.map((file) => file.path.toLowerCase())).size !== index.files.length
    || index.files.reduce((sum, file) => sum + file.bytes, 0) > 256 * 1024 * 1024) throw Error('Release build index binding mismatch')
  for (const file of index.files) {
    const expectedKind = file.path.startsWith('dist/') ? 'web' : file.path.startsWith('server-dist/') ? 'server' : null
    if (file.kind !== expectedKind || !index.build.artifacts.some((item) => item.path === file.path && item.bytes === file.bytes && item.sha256 === file.sha256)
      || !manifest.artifacts.some((item) => item.storageKey === file.storageKey && item.sha256 === file.sha256 && item.bytes === file.bytes && item.kind === file.kind)) throw Error('Release file outside approved build manifest')
  }
  if (!index.files.some((file) => file.path === 'dist/index.html') || !index.files.some((file) => file.path === 'server-dist/index.js')) throw Error('Release entry missing')
  return index
}

export async function findEvolutionReleaseIndexArtifact(input: { runId: string; baseRef: string;
  manifest: EvolutionCandidateManifest; store: Pick<AiEvolutionArtifactStore, 'read'>; authorize: () => Promise<void> }) {
  for (const artifact of input.manifest.artifacts.filter(item => item.kind === 'report')) {
    await input.authorize()
    try {
      const bytes = await input.store.read(input.runId, artifact)
      parseEvolutionReleaseIndex(JSON.parse(bytes.toString('utf8')), input.manifest, input.baseRef)
      return artifact
    } catch (error) {
      if ((error as { code?: string }).code === 'EVOLUTION_ARTIFACT_INTEGRITY') throw error
    }
  }
  throw Error('Approved candidate has no valid release build index')
}

export async function materializeEvolutionReleaseBundle(input: {
  runId: string; baseRef: string; manifest: EvolutionCandidateManifest; indexArtifact: EvolutionCandidateManifest['artifacts'][number];
  store: Pick<AiEvolutionArtifactStore, 'read'>; authorize: () => Promise<void>;
}) {
  await input.authorize()
  if (!input.manifest.artifacts.some((item) => item.kind === 'report' && item.storageKey === input.indexArtifact.storageKey && item.sha256 === input.indexArtifact.sha256 && item.bytes === input.indexArtifact.bytes)) throw Error('Release index is not an approved artifact')
  const bytes = await input.store.read(input.runId, input.indexArtifact)
  const index = parseEvolutionReleaseIndex(JSON.parse(bytes.toString('utf8')), input.manifest, input.baseRef)
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-release-bundle-'))
  try {
    for (const file of index.files) {
      await input.authorize()
      const content = await input.store.read(input.runId, file)
      const output = path.join(root, file.path)
      await mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
      await writeFile(output, content, { flag: 'wx', mode: 0o600 })
    }
    await input.authorize()
    const build = Buffer.from(JSON.stringify(index.build))
    await writeFile(path.join(root, 'manifest.json'), build, { flag: 'wx', mode: 0o600 })
    return { root, manifestHash: createHash('sha256').update(build).digest('hex'),
      dispose: () => rm(root, { recursive: true, force: true }) }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}
