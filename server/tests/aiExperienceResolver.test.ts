import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveAiExperiences, type ExperienceForResolution } from '../src/services/aiExperienceResolver.js'
import type { EvolutionSpec } from '../src/contracts/aiEvolutionContract.js'

const spec: EvolutionSpec = { schemaVersion: 1, kind: 'experience', title: '来源', objective: '有来源', scope: { type: 'user', key: 'user' },
  sourceRefs: [{ type: 'message', id: 'message' }], questions: [], acceptanceCriteria: ['待核验'], budget: { maxDurationSeconds: 60, maxModelTokens: 1000, maxRepairRounds: 0 },
  target: { type: 'experience', rule: '缺少来源标待核验', exceptions: [], taskTypes: ['chat'], replacesVersionIds: [] } }
const record: ExperienceForResolution = { versionId: 'version', experienceId: 'experience', status: 'active', spec, contentHash: 'hash' }
const input = { userId: 'user', taskType: 'chat', maxCharacters: 4000, records: [record] }

test('source revocation is explained in the snapshot without loading inaccessible content', () => {
  const revoked: ExperienceForResolution = { access: 'revoked', experienceId: 'revoked-rule' }
  const result = resolveAiExperiences({ ...input, records: [revoked] })
  assert.deepEqual(result.snapshot.loaded, [])
  assert.deepEqual(result.snapshot.excluded, [{ experienceId: 'revoked-rule', reason: 'source_access_revoked' }])
  assert.equal(result.prompt, '')
  assert.equal(JSON.stringify(result.snapshot).includes('versionId'), false)
  const mixed = resolveAiExperiences({ ...input, records: [revoked, record] })
  assert.equal(mixed.snapshot.loaded.length, 1)
  assert.equal(mixed.hash, resolveAiExperiences({ ...input, records: [record, revoked] }).hash)
  assert.notEqual(mixed.hash, resolveAiExperiences(input).hash)
})

test('resolver applies scoped versions and records exclusions without rewriting old snapshot', () => {
  const first = resolveAiExperiences(input)
  assert.equal(first.snapshot.loaded.length, 1)
  const disabled = resolveAiExperiences({ ...input, records: [{ ...record, status: 'disabled' }] })
  assert.equal(disabled.snapshot.loaded.length, 0)
  assert.equal(disabled.snapshot.excluded[0].reason, 'disabled')
  assert.equal(first.snapshot.loaded[0].versionId, 'version')
  assert.notEqual(first.hash, disabled.hash)
  assert.equal(resolveAiExperiences({ ...input, userId: 'other' }).snapshot.excluded[0].reason, 'scope_mismatch')
  assert.equal(resolveAiExperiences({ ...input, taskType: 'report' }).snapshot.excluded[0].reason, 'task_type_mismatch')
  assert.equal(resolveAiExperiences({ ...input, maxCharacters: 0 }).snapshot.excluded[0].reason, 'prompt_budget')
})
