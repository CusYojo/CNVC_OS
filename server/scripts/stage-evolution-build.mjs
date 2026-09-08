import path from 'node:path'
import { constants } from 'node:fs'
import { lstat, open, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const check = (condition, message) => { if (!condition) throw Error(`[evolution-import] ${message}`) }
function safeName(name) {
  return typeof name === 'string' && /^(dist|server-dist)\//.test(name) && !/[\\:\x00-\x1f]/.test(name)
    && name.split('/').every((part) => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && !/^\.env(?:\.|$)/i.test(part))
}
async function readRegular(root, name, maximum) {
  const parts = name.split('/')
  let parent = root
  for (const part of ['', ...parts.slice(0, -1)]) {
    parent = path.join(parent, part)
    const info = await lstat(parent)
    check(info.isDirectory() && !info.isSymbolicLink(), 'directory must not be a symlink')
  }
  const file = await open(path.join(root, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try { const info = await file.stat(); check(info.isFile() && info.size <= maximum, 'file size/type invalid'); return await file.readFile() }
  finally { await file.close() }
}
export async function verifyImportedEvolutionFiles(root, artifacts) {
  check(Array.isArray(artifacts) && artifacts.length > 0 && artifacts.length <= 5000, 'invalid artifact list')
  const paths = new Set(); let total = 0
  for (const artifact of artifacts) {
    check(safeName(artifact.path) && !paths.has(artifact.path.toLowerCase()), 'invalid or duplicate artifact path')
    paths.add(artifact.path.toLowerCase())
    check(Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && artifact.bytes <= 128 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(artifact.sha256), 'invalid artifact descriptor')
    total += artifact.bytes; check(total <= 256 * 1024 * 1024, 'artifact size budget exceeded')
    const bytes = await readRegular(root, artifact.path, artifact.bytes)
    check(bytes.length === artifact.bytes && hash(bytes) === artifact.sha256, 'artifact content mismatch')
  }
}
export async function stageEvolutionBuild(source, destination, expectedManifestHash) {
  check(path.isAbsolute(source) && /^[a-f0-9]{64}$/.test(expectedManifestHash), 'absolute input root and manifest hash required')
  const bytes = await readRegular(source, 'manifest.json', 4 * 1024 * 1024)
  check(hash(bytes) === expectedManifestHash, 'manifest hash mismatch')
  const manifest = JSON.parse(bytes.toString('utf8'))
  check(manifest.schemaVersion === 1 && manifest.activated === false && /^[a-f0-9]{40}$/.test(manifest.baseCommit)
    && /^[a-f0-9]{64}$/.test(manifest.patchHash) && /^[a-f0-9]{64}$/.test(manifest.lockHash), 'invalid build provenance')
  await verifyImportedEvolutionFiles(source, manifest.artifacts)
  for (const artifact of manifest.artifacts) {
    const content = await readRegular(source, artifact.path, artifact.bytes)
    check(content.length === artifact.bytes && hash(content) === artifact.sha256, 'artifact changed during import')
    const output = path.join(destination, artifact.path)
    await mkdir(path.dirname(output), { recursive: true, mode: 0o755 })
    await writeFile(output, content, { flag: 'wx', mode: 0o644 })
  }
  return manifest
}
