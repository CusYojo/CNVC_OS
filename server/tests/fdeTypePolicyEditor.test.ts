import assert from 'node:assert/strict'
import test from 'node:test'
import { addTypeDraftAction, addTypeDraftStage, moveTypeDraftAction, moveTypeDraftStage, nextTypeDraftKey, reassignTypeDraftAction } from '../../src/lib/fdeTypePolicyEditor.js'
import { typePolicyFixture } from '../src/scripts/fdeTypePolicyFixture.js'
import { typePolicyDefinition } from '../src/contracts/fdeTypePolicyContract.js'

test('draft keys avoid deletion/reinsertion collisions without renumbering retained identities', () => {
  for (const prefix of ['stage', 'action', 'material'] as const) {
    const keys = [`${prefix}_1`, `${prefix}_3`]
    assert.equal(nextTypeDraftKey(prefix, keys), `${prefix}_2`)
    assert.deepEqual(keys, [`${prefix}_1`, `${prefix}_3`])
    assert.equal(nextTypeDraftKey(prefix, ['custom_key', `${prefix}_2`]), `${prefix}_1`)
  }
})
test('insert action into earlier stage retains existing data and follows stage order', () => {
  const original = typePolicyFixture(), snapshot = JSON.stringify(original)
  const next = addTypeDraftAction(original, 'objectives')
  assert.equal(next.actions.length, 3)
  assert.equal(next.actions[1].stageKey, 'objectives')
  assert.equal(next.actions[1].position, 50)
  assert.equal(next.actions[1].title, '')
  assert.deepEqual(next.actions[2], original.actions[1])
  next.actions[1] = { ...next.actions[1], title: '新增可核验行动', deliverable: '明确新增行动的成果证据' }
  assert.equal(typePolicyDefinition.safeParse(next).success, true)
  assert.equal(JSON.stringify(original), snapshot)
  assert.throws(() => addTypeDraftAction(original, 'unknown'))
})
test('stage reordering preserves IDs materials responsibilities and dates, never silently repairs invalid chronology', () => {
  const original = typePolicyFixture(), snapshot = JSON.stringify(original)
  const next = moveTypeDraftStage(original, 1, -1)
  assert.deepEqual(next.stages, [...original.stages].reverse())
  assert.deepEqual(next.actions, [...original.actions].reverse())
  assert.equal(typePolicyDefinition.safeParse(next).success, false, 'author must explicitly reconcile chronology')
  assert.deepEqual(moveTypeDraftStage(next, 0, 1), original)
  assert.equal(JSON.stringify(original), snapshot)
  assert.equal(moveTypeDraftStage(original, 0, -1), original)
})
test('action reordering is stage-local; reassignment preserves identity and keeps missing-stage validation visible', () => {
  const original = addTypeDraftAction(typePolicyFixture(), 'objectives')
  const reordered = moveTypeDraftAction(original, 1, -1)
  assert.equal(reordered.actions[0].key, original.actions[1].key)
  assert.equal(moveTypeDraftAction(original, 1, 1), original)
  const next = reassignTypeDraftAction(original, 0, 'delivery')
  assert.equal(next.actions[0].key, original.actions[1].key)
  assert.equal(next.actions[1].key, original.actions[0].key)
  assert.equal(next.actions[1].position, original.actions[0].position)
  assert.deepEqual(next.actions[2], original.actions[2], 'existing final-stage action retains its position and content')
  assert.deepEqual(new Set(next.actions.map(a => a.key)), new Set(original.actions.map(a => a.key)))
  assert.throws(() => reassignTypeDraftAction(original, 0, 'unknown'))
})
test('new stages have unique action identities and bounded draft-only additions', () => {
  const config = typePolicyFixture()
  config.actions[0].key = 'action_1'; config.actions[1].key = 'action_3'
  config.stages[0].key = 'stage_1'; config.stages[1].key = 'stage_3'
  config.actions[0].stageKey = 'stage_1'; config.actions[1].stageKey = 'stage_3'
  const next = addTypeDraftStage(config)
  assert.equal(next.stages.at(-1)!.key, 'stage_2'); assert.equal(next.actions.at(-1)!.key, 'action_2')
  assert.equal(config.stages.length, 2); assert.equal(config.actions.length, 2)
  assert.throws(() => addTypeDraftStage({ ...config, stages: Array(12).fill(config.stages[0]) }))
  assert.throws(() => addTypeDraftAction({ ...config, actions: Array(80).fill(config.actions[0]) }, 'stage_1'))
  assert.throws(() => addTypeDraftStage({ ...config, actions: Array(80).fill(config.actions[0]) }))
})
