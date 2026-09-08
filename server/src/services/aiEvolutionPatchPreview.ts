import { z } from 'zod'
import { safeEvolutionSourcePath } from '../runtime/evolution/evolutionSourceSnapshot.js'
import { evolutionError } from './aiEvolutionPolicyService.js'
import { createHash } from 'node:crypto'
import { previewEvolutionSkillPatch } from './aiEvolutionSkillPatchPreview.js'

const file = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(0).max(4 * 1024 * 1024), contentBase64: z.string().max(6_000_000) }).strict().nullable()
const schema = z.object({ schemaVersion: z.literal(1), repositoryId: z.string(), baseCommit: z.string(), baselineHash: z.string(), candidateHash: z.string(),
  changes: z.array(z.object({ path: z.string().refine(safeEvolutionSourcePath), operation: z.enum(['add', 'modify', 'delete']), before: file, after: file }).strict()).min(1).max(400),
}).strict()

export function previewEvolutionPatch(content: Buffer, expected: { patchHash: string; sourceHash: string; baseRef: string }) {
  if (createHash('sha256').update(content).digest('hex') !== expected.patchHash) throw evolutionError(409, 'EVOLUTION_PATCH_BASELINE', '差异文件哈希不匹配')
  const value: unknown = JSON.parse(content.toString('utf8'))
  if (value && typeof value === 'object' && 'kind' in value && value.kind === 'skill') return previewEvolutionSkillPatch(value, expected)
  const patch = schema.parse(value)
  if (patch.baseCommit !== expected.baseRef || patch.candidateHash !== expected.sourceHash
    || new Set(patch.changes.map((item) => item.path)).size !== patch.changes.length) throw evolutionError(409, 'EVOLUTION_PATCH_BASELINE', '差异文件未绑定当前候选')
  let remaining = 200_000
  const preview = (value: z.infer<typeof file>) => {
    if (!value) return null
    const bytes = Buffer.from(value.contentBase64, 'base64')
    if (bytes.length !== value.bytes || createHash('sha256').update(bytes).digest('hex') !== value.sha256) throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '差异内容校验失败')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.includes('\0')) throw Error('binary') }
    catch { return { sha256: value.sha256, bytes: value.bytes, binary: true, text: '', truncated: false } }
    const shown = text.slice(0, Math.min(remaining, 50_000))
    remaining -= shown.length
    return { sha256: value.sha256, bytes: value.bytes, binary: false, text: shown, truncated: shown.length !== text.length }
  }
  return { baseRef: patch.baseCommit, sourceHash: patch.candidateHash, changes: patch.changes.map((change) => {
    if ((change.operation === 'add' && (change.before || !change.after)) || (change.operation === 'delete' && (!change.before || change.after))
      || (change.operation === 'modify' && (!change.before || !change.after))) throw evolutionError(409, 'EVOLUTION_PATCH_BASELINE', '差异操作与文件状态不一致')
    return { path: change.path, operation: change.operation, before: preview(change.before), after: preview(change.after) }
  }) }
}
