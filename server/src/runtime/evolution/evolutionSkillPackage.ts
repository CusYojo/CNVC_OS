import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { captureEvolutionSkill } from './evolutionSkillSnapshot.js'
import type { EvolutionSkillVersion } from './evolutionSkillEvaluation.js'
import type { AiEvolutionArtifactStore } from '../../services/aiEvolutionArtifactStore.js'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { safeEvolutionSourcePath, isForbiddenEvolutionSource } from './evolutionSourceSnapshot.js'
import { referencedAiSkillMarkdownFiles } from '../../services/aiSkillService.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const versionSchema = z.object({ capabilityId: z.string().min(1).max(128), instructions: z.string().min(1).max(100000),
  references: z.array(z.object({ name: z.string().min(1).max(240), content: z.string().max(100000) }).strict()).max(100),
  dependencies: z.array(z.object({ name: z.string().min(1).max(240), contentHash: hash }).strict()).max(1000), toolPermissionHash: hash }).strict()
const schema = z.object({ schemaVersion: z.literal(1), version: versionSchema, contentHash: hash, packageHash: hash,
  runtimeSnapshot: z.object({ version: versionSchema, contentHash: hash, packageHash: hash,
    manifest: z.array(z.object({ name: z.string(), bytes: z.number().int().nonnegative(), contentHash: hash }).strict()).max(2000),
    files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative().max(8 * 1024 * 1024), sha256: hash,
      contentBase64: z.string().max(12 * 1024 * 1024) }).strict()).max(2000) }).strict(),
}).strict()

/** A logical skill override plus its complete frozen runtime package; no current host file is needed to reconstruct it. */
export function parseEvolutionSkillPackage(raw: unknown) {
  const value = schema.parse(raw), snapshot = value.runtimeSnapshot
  const invalid = () => evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '技能版本包不完整或内容摘要不一致')
  if (evolutionContentHash(value.version) !== value.contentHash || evolutionContentHash(snapshot.version) !== snapshot.contentHash
    || evolutionContentHash(snapshot.manifest) !== snapshot.packageHash
    || evolutionContentHash({ contentHash: value.contentHash, runtimePackageHash: snapshot.packageHash }) !== value.packageHash
    || value.version.capabilityId !== snapshot.version.capabilityId || value.version.toolPermissionHash !== snapshot.version.toolPermissionHash
    || evolutionContentHash(value.version.dependencies) !== evolutionContentHash(snapshot.version.dependencies)
    || snapshot.files.length !== snapshot.manifest.length || !snapshot.files.some(file => file.path === 'SKILL.md')
    || new Set(snapshot.files.map(file => file.path.toLowerCase())).size !== snapshot.files.length
    || new Set(value.version.references.map(ref => ref.name)).size !== value.version.references.length
    || snapshot.files.reduce((total, file) => total + file.bytes, 0) > 16 * 1024 * 1024) throw invalid()
  for (const [index, file] of snapshot.files.entries()) {
    const row = snapshot.manifest[index], bytes = Buffer.from(file.contentBase64, 'base64')
    if (!safeEvolutionSourcePath(file.path) || isForbiddenEvolutionSource(file.path) || file.path !== row.name
      || file.bytes !== row.bytes || file.sha256 !== row.contentHash || bytes.length !== file.bytes
      || bytes.toString('base64') !== file.contentBase64 || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw invalid()
  }
  return value
}

export async function saveEvolutionSkillPackage(input: { runId: string; snapshot: Awaited<ReturnType<typeof captureEvolutionSkill>>;
  version: EvolutionSkillVersion }, store: Pick<AiEvolutionArtifactStore, 'put'>) {
  const contentHash = evolutionContentHash(input.version)
  const packageHash = evolutionContentHash({ contentHash, runtimePackageHash: input.snapshot.packageHash })
  const bundle = parseEvolutionSkillPackage({ schemaVersion: 1, version: input.version, contentHash, packageHash, runtimeSnapshot: input.snapshot })
  reconstructEvolutionSkillRuntime(bundle)
  const artifact = await store.put(input.runId, Buffer.from(JSON.stringify(bundle)), 'content')
  return { contentHash, packageHash, artifact }
}

/** Rebuild execution bytes from the stored bundle only; never consult the live skill directory. */
export function reconstructEvolutionSkillRuntime(raw: unknown) {
  const bundle = parseEvolutionSkillPackage(raw)
  const invalid = () => evolutionError(409, 'EVOLUTION_SKILL_PACKAGE_INVALID', '技能正文与参考资料不能安全重建')
  const files = new Map(bundle.runtimeSnapshot.files.map(file => [file.path, Buffer.from(file.contentBase64, 'base64')]))
  const source = new TextDecoder('utf-8', { fatal: true }).decode(files.get('SKILL.md')!)
  const frontmatter = source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0]
  if (!frontmatter) throw invalid()
  const baselineNames = new Set(bundle.runtimeSnapshot.version.references.map(ref => ref.name))
  const referenced = referencedAiSkillMarkdownFiles(bundle.version.instructions)
  const names = bundle.version.references.map(ref => ref.name)
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length
    || referenced.length !== names.length || referenced.some(name => !names.includes(name))) throw invalid()
  for (const name of baselineNames) files.delete(name)
  const reserved = new Set([...files.keys()].map(name => name.toLowerCase()))
  for (const ref of bundle.version.references) {
    if (!safeEvolutionSourcePath(ref.name) || isForbiddenEvolutionSource(ref.name)
      || !ref.name.endsWith('.md') || reserved.has(ref.name.toLowerCase())) throw invalid()
    files.set(ref.name, Buffer.from(ref.content))
  }
  files.set('SKILL.md', Buffer.from(`${frontmatter}${frontmatter.endsWith('\n') ? '' : '\n'}${bundle.version.instructions}`))
  const paths = [...files.keys()]
  if (paths.some(name => paths.some(other => other !== name && other.toLowerCase().startsWith(`${name.toLowerCase()}/`)))) throw invalid()
  const runtimeFiles = [...files].map(([path, bytes]) => ({ path, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') }))
  if (runtimeFiles.some(file => file.bytes > 8 * 1024 * 1024)
    || runtimeFiles.reduce((sum, file) => sum + file.bytes, 0) > 16 * 1024 * 1024) throw invalid()
  return { version: bundle.version, contentHash: bundle.contentHash, packageHash: bundle.packageHash,
    runtimeHash: evolutionContentHash(runtimeFiles.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))), files: runtimeFiles }
}
