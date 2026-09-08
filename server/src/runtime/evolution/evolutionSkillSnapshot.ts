import path from 'node:path'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parseAiSkillFile, referencedAiSkillMarkdownFiles } from '../../services/aiSkillService.js'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { isForbiddenEvolutionSource, safeEvolutionSourcePath } from './evolutionSourceSnapshot.js'
import type { EvolutionSkillVersion } from './evolutionSkillEvaluation.js'

/** Reads a host-registered package without executing scripts or changing live skill files. */
export async function captureEvolutionSkill(input: {
  capabilityId: string; capabilityKey: string; directory: string; allowedRoot: string;
  toolNames: string[]; dependencyNames: string[]; config: Record<string, unknown>;
}) {
  const root = path.resolve(input.allowedRoot), directory = path.resolve(input.directory)
  const unsafe = () => evolutionError(409, 'EVOLUTION_SKILL_SOURCE_INVALID', '技能包包含越界、链接或不支持的内容')
  if (!path.isAbsolute(input.directory) || !path.isAbsolute(input.allowedRoot) || !directory.startsWith(`${root}${path.sep}`)) throw unsafe()
  // Registered roots are administrator-owned; check every descendant before reading a file.
  if ((await realpath(root)) !== root || (await realpath(directory)) !== directory) throw unsafe()
  for (let current = directory; current !== root; current = path.dirname(current)) {
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe()
  }
  const files = new Map<string, Buffer>()
  const names = new Set<string>()
  let total = 0, entries = 0
  const visit = async (relative: string) => {
    const parent = path.join(directory, relative)
    for (const entry of (await readdir(parent, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (++entries > 2000 || !safeEvolutionSourcePath(name) || isForbiddenEvolutionSource(name)
        || entry.isSymbolicLink() || names.has(name.toLowerCase())) throw unsafe()
      names.add(name.toLowerCase())
      const filename = path.join(directory, name)
      if (await realpath(filename) !== filename) throw unsafe()
      if (entry.isDirectory()) { await visit(name); continue }
      if (!entry.isFile()) throw unsafe()
      const handle = await open(filename, 'r')
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || total + stat.size > 16 * 1024 * 1024) throw unsafe()
        const bytes = Buffer.alloc(stat.size + 1)
        let length = 0
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length)
          if (!read.bytesRead) break
          length += read.bytesRead
        }
        if (length !== stat.size || (await handle.stat()).mtimeMs !== stat.mtimeMs) throw unsafe()
        files.set(name, bytes.subarray(0, length)); total += length
      } finally { await handle.close() }
    }
  }
  await visit('')
  const decode = (name: string) => {
    const bytes = files.get(name)
    if (!bytes) throw unsafe()
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  const source = decode('SKILL.md')
  const parsed = parseAiSkillFile(source)
  if (parsed.name !== input.capabilityKey) throw unsafe()
  const referenceNames = referencedAiSkillMarkdownFiles(parsed.instructions)
  const references = referenceNames.map(name => ({ name, content: decode(name) }))
  if (parsed.instructions.length > 100_000 || references.length > 100 || references.some(row => row.content.length > 100_000)) throw unsafe()
  const manifest = [...files].map(([name, bytes]) => ({ name, bytes: bytes.length,
    contentHash: createHash('sha256').update(bytes).digest('hex') }))
  const version: EvolutionSkillVersion = { capabilityId: input.capabilityId, instructions: parsed.instructions, references,
    dependencies: [
      { name: 'capability-dependencies', contentHash: evolutionContentHash(input.dependencyNames) },
      { name: 'skill-frontmatter', contentHash: evolutionContentHash(source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)![0]) },
      ...manifest.filter(row => row.name !== 'SKILL.md' && !referenceNames.includes(row.name))
        .map(row => ({ name: `file:${row.name}`, contentHash: row.contentHash })),
    ], toolPermissionHash: evolutionContentHash({ toolNames: input.toolNames, config: input.config }) }
  if (version.dependencies.length > 1000) throw unsafe()
  return { version, contentHash: evolutionContentHash(version), manifest, packageHash: evolutionContentHash(manifest),
    files: manifest.map(row => ({ path: row.name, bytes: row.bytes, sha256: row.contentHash,
      contentBase64: files.get(row.name)!.toString('base64') })) }
}
