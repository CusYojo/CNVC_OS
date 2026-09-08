import { createHash } from 'node:crypto'
import { z } from 'zod'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const version = z.object({ capabilityId: z.string().min(1).max(128), instructions: z.string().min(1).max(100_000),
  references: z.array(z.object({ name: z.string().min(1).max(240), content: z.string().max(100_000) }).strict()).max(100),
  dependencies: z.array(z.object({ name: z.string().min(1).max(240), contentHash: hash }).strict()).max(1000),
  toolPermissionHash: hash,
}).strict()
const schema = z.object({ schemaVersion: z.literal(1), kind: z.literal('skill'), baseHash: hash, candidateHash: hash,
  baseline: version, candidate: version }).strict()

/** Converts immutable skill contents to the same text comparison DTO used by code candidates. */
export function previewEvolutionSkillPatch(value: unknown, expected: { sourceHash: string; baseRef: string }) {
  const patch = schema.parse(value)
  if (patch.baseHash !== expected.baseRef || patch.candidateHash !== expected.sourceHash
    || evolutionContentHash(patch.baseline) !== patch.baseHash || evolutionContentHash(patch.candidate) !== patch.candidateHash
    || patch.baseline.capabilityId !== patch.candidate.capabilityId) {
    throw evolutionError(409, 'EVOLUTION_PATCH_BASELINE', '技能差异未绑定当前候选及基线')
  }
  if (patch.baseline.toolPermissionHash !== patch.candidate.toolPermissionHash
    || evolutionContentHash(patch.baseline.dependencies) !== evolutionContentHash(patch.candidate.dependencies)) {
    throw evolutionError(409, 'EVOLUTION_SEPARATE_REVIEW_REQUIRED', '技能依赖或工具权限变化必须转入代码级检查')
  }
  for (const skill of [patch.baseline, patch.candidate]) {
    if (new Set(skill.references.map(item => item.name)).size !== skill.references.length) {
      throw evolutionError(409, 'EVOLUTION_PATCH_BASELINE', '技能参考资料名称重复')
    }
  }
  const before = new Map(patch.baseline.references.map(item => [`参考资料/${item.name}`, item.content]))
  const after = new Map(patch.candidate.references.map(item => [`参考资料/${item.name}`, item.content]))
  before.set('技能正文', patch.baseline.instructions)
  after.set('技能正文', patch.candidate.instructions)
  let remaining = 200_000
  const preview = (text: string | undefined) => {
    if (text === undefined) return null
    const shown = text.slice(0, Math.min(remaining, 50_000))
    remaining -= shown.length
    return { sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text, 'utf8'),
      binary: false, text: shown, truncated: shown.length !== text.length }
  }
  const changes = [...new Set(['技能正文', ...before.keys(), ...after.keys()])]
    .filter(name => before.get(name) !== after.get(name)).map(name => ({ path: name,
      operation: !before.has(name) ? 'add' as const : !after.has(name) ? 'delete' as const : 'modify' as const,
      before: preview(before.get(name)), after: preview(after.get(name)),
    }))
  if (!changes.length) throw evolutionError(409, 'EVOLUTION_NO_CHANGE', '技能候选没有可审阅的内容变化')
  return { baseRef: patch.baseHash, sourceHash: patch.candidateHash, changes }
}
