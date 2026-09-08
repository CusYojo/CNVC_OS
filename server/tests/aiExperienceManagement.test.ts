import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listManagedAiExperiences } from '../src/services/aiExperienceManagement.js'
import type { EvolutionSpec } from '../src/contracts/aiEvolutionContract.js'

const spec: EvolutionSpec = { schemaVersion: 1, kind: 'experience', title: 'private title', objective: 'private objective',
  scope: { type: 'user', key: 'owner' }, sourceRefs: [{ type: 'message', id: 'private source' }], questions: [],
  acceptanceCriteria: ['private criterion'], budget: { maxDurationSeconds: 60, maxModelTokens: 1000, maxRepairRounds: 0 },
  target: { type: 'experience', rule: 'private rule', exceptions: [], taskTypes: ['chat'], replacesVersionIds: [] } }
const row = { experience: { id: 'experience', ownerUserId: 'owner', revision: 3, status: 'active', updatedAt: new Date(0) },
  version: { id: 'private version', proposalId: 'private proposal', contentHash: 'private hash', spec } }

test('revoked sources leave only owner management metadata, including the revision required to disable', async () => {
  for (const status of [403, 404]) {
    const list = await listManagedAiExperiences('owner', [row], async (proposalId, savedSpec) => {
      assert.equal(proposalId, row.version.proposalId)
      assert.equal(savedSpec, spec)
      throw { status }
    })
    assert.deepEqual(list, [{ id: 'experience', revision: 3, status: 'active', updatedAt: new Date(0).toISOString(),
      access: 'revoked', spec: null, versionId: null, contentHash: null }])
    assert.equal(JSON.stringify(list).includes('private'), false)
    assert.equal(list.filter(item => item.access === 'available').length, 0)
  }
})

test('foreign ownership is hidden and unexpected authorization failures remain errors', async () => {
  assert.deepEqual(await listManagedAiExperiences('stranger', [row], async () => assert.fail('must not inspect foreign source')), [])
  const unavailable = Object.assign(Error('database unavailable'), { status: 503 })
  await assert.rejects(listManagedAiExperiences('owner', [row], async () => { throw unavailable }), error => error === unavailable)
  const [visible] = await listManagedAiExperiences('owner', [row], async () => {})
  assert.equal(visible.access, 'available')
  assert.equal(visible.spec, spec)
})
