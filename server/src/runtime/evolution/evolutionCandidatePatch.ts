import { createHash } from 'node:crypto'
import type { EvolutionSourceSnapshot } from './evolutionSourceSnapshot.js'
import { evolutionError } from '../../services/aiEvolutionPolicyService.js'

/** Structured patch retains exact bytes for review and a later guarded release. */
export function createEvolutionCandidatePatch(baseline: EvolutionSourceSnapshot, candidate: EvolutionSourceSnapshot) {
  if (baseline.repositoryId !== candidate.repositoryId || baseline.baseCommit !== candidate.baseCommit) {
    throw evolutionError(409, 'EVOLUTION_PATCH_BASELINE', '候选与基线不属于同一仓库提交')
  }
  const before = new Map(baseline.files.map((file) => [file.path, file]))
  const after = new Map(candidate.files.map((file) => [file.path, file]))
  if (before.size !== baseline.files.length || after.size !== candidate.files.length) throw evolutionError(409, 'EVOLUTION_PATCH_BASELINE', '快照包含重复文件')
  const changes = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
    const oldFile = before.get(path), newFile = after.get(path)
    if (oldFile?.sha256 === newFile?.sha256) return []
    return [{ path, operation: !oldFile ? 'add' : !newFile ? 'delete' : 'modify',
      before: oldFile ? { sha256: oldFile.sha256, bytes: oldFile.bytes, contentBase64: oldFile.contentBase64 } : null,
      after: newFile ? { sha256: newFile.sha256, bytes: newFile.bytes, contentBase64: newFile.contentBase64 } : null }]
  })
  if (!changes.length) throw evolutionError(409, 'EVOLUTION_EMPTY_PATCH', '候选没有实际文件变化')
  const patch = { schemaVersion: 1, repositoryId: baseline.repositoryId, baseCommit: baseline.baseCommit,
    baselineHash: baseline.contentHash, candidateHash: candidate.contentHash, changes }
  const content = Buffer.from(JSON.stringify(patch))
  if (content.length > 128 * 1024 * 1024) throw evolutionError(413, 'EVOLUTION_ARTIFACT_LIMIT', '候选差异超出产物大小限制')
  return { patch, content, sha256: createHash('sha256').update(content).digest('hex') }
}
