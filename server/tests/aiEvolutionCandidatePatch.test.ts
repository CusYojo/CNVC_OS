import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createEvolutionCandidatePatch } from '../src/runtime/evolution/evolutionCandidatePatch.js'
import type { EvolutionSourceSnapshot } from '../src/runtime/evolution/evolutionSourceSnapshot.js'
import { previewEvolutionPatch } from '../src/services/aiEvolutionPatchPreview.js'

test('structured patch records additions, deletions and exact replacement bytes deterministically', () => {
  const file = (path: string, text: string) => ({ path, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), contentBase64: Buffer.from(text).toString('base64') })
  const baseline: EvolutionSourceSnapshot = { schemaVersion: 1, repositoryId: 'repo', baseCommit: 'a'.repeat(40), contentHash: 'baseline',
    files: [file('src/remove.ts', 'old'), file('src/change.ts', 'before'), file('src/keep.ts', 'same')] }
  const candidate = { ...baseline, contentHash: 'candidate', files: [file('src/keep.ts', 'same'), file('src/change.ts', 'after'), file('src/add.ts', 'new')] }
  const result = createEvolutionCandidatePatch(baseline, candidate)
  assert.deepEqual(result.patch.changes.map((item) => item.operation), ['add', 'modify', 'delete'])
  assert.equal(Buffer.from(result.patch.changes[1].before!.contentBase64, 'base64').toString(), 'before')
  assert.equal(Buffer.from(result.patch.changes[1].after!.contentBase64, 'base64').toString(), 'after')
  assert.equal(result.sha256, createEvolutionCandidatePatch({ ...baseline, files: [...baseline.files].reverse() }, candidate).sha256)
  const expected = { patchHash: result.sha256, sourceHash: candidate.contentHash, baseRef: baseline.baseCommit }
  const preview = previewEvolutionPatch(result.content, expected)
  assert.equal(preview.changes[1].before!.text, 'before')
  assert.equal(preview.changes[1].after!.text, 'after')
  assert.throws(() => previewEvolutionPatch(result.content, { ...expected, sourceHash: 'other' }), { code: 'EVOLUTION_PATCH_BASELINE' })
  assert.throws(() => createEvolutionCandidatePatch(baseline, baseline), { code: 'EVOLUTION_EMPTY_PATCH' })
  assert.throws(() => createEvolutionCandidatePatch(baseline, { ...candidate, baseCommit: 'b'.repeat(40) }), { code: 'EVOLUTION_PATCH_BASELINE' })
})
