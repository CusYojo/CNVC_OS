import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { previewEvolutionPatch } from '../src/services/aiEvolutionPatchPreview.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'

function fixture() {
  const baseline = { capabilityId: 'skill', instructions: '原正文', references: [{ name: 'old.md', content: '旧资料' },
    { name: 'same.md', content: '保留资料' }], dependencies: [], toolPermissionHash: 'a'.repeat(64) }
  const candidate = { ...baseline, instructions: '候选正文', references: [{ name: 'new.md', content: '' }, baseline.references[1]] }
  return { schemaVersion: 1, kind: 'skill', baseline, candidate, baseHash: evolutionContentHash(baseline), candidateHash: evolutionContentHash(candidate) }
}
function preview(patch: ReturnType<typeof fixture>, expected?: { sourceHash: string; baseRef: string }) {
  const bytes = Buffer.from(JSON.stringify(patch))
  return previewEvolutionPatch(bytes, { patchHash: createHash('sha256').update(bytes).digest('hex'),
    sourceHash: patch.candidateHash, baseRef: patch.baseHash, ...expected })
}

test('skill candidates expose verified instructions and reference additions/deletions in the existing comparison DTO', () => {
  const result = preview(fixture())
  assert.deepEqual(result.changes.map(row => [row.path, row.operation]), [['技能正文', 'modify'], ['参考资料/old.md', 'delete'], ['参考资料/new.md', 'add']])
  assert.equal(result.changes[0].before?.text, '原正文')
  assert.equal(result.changes[0].after?.text, '候选正文')
  assert.equal(result.changes[2].before, null)
  assert.equal(result.changes[2].after?.text, '')
})

test('skill patch review rejects changed bytes, unbound versions, capability swaps and permission changes', () => {
  const patch = fixture()
  const bytes = Buffer.from(JSON.stringify(patch))
  assert.throws(() => previewEvolutionPatch(bytes, { patchHash: '0'.repeat(64), sourceHash: patch.candidateHash, baseRef: patch.baseHash }))
  assert.throws(() => preview(patch, { sourceHash: '0'.repeat(64), baseRef: patch.baseHash }))
  patch.candidate.instructions = '篡改正文'
  assert.throws(() => preview(patch))
  patch.candidateHash = evolutionContentHash(patch.candidate)
  patch.candidate.capabilityId = 'another'
  patch.candidateHash = evolutionContentHash(patch.candidate)
  assert.throws(() => preview(patch))
  const permissions = fixture()
  permissions.candidate.toolPermissionHash = 'b'.repeat(64)
  permissions.candidateHash = evolutionContentHash(permissions.candidate)
  assert.throws(() => preview(permissions), { code: 'EVOLUTION_SEPARATE_REVIEW_REQUIRED' })
})

test('duplicate references cannot hide changes and large text is explicitly truncated', () => {
  const patch = fixture()
  patch.candidate.references.push(patch.candidate.references[0])
  patch.candidateHash = evolutionContentHash(patch.candidate)
  assert.throws(() => preview(patch))
  const large = fixture()
  large.candidate.instructions = '文'.repeat(60_000)
  large.candidateHash = evolutionContentHash(large.candidate)
  const row = preview(large).changes[0].after!
  assert.equal(row.truncated, true)
  assert.equal(row.text.length, 50_000)
  assert.equal(row.bytes, 180_000)
  assert.equal(row.sha256, createHash('sha256').update(large.candidate.instructions).digest('hex'))
})
