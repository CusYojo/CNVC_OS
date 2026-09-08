import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { evolutionSkillPromotionTarget, assertEvolutionSkillPromotionBinding } from '../src/services/aiEvolutionSkillPromotionPolicy.js'

function fixture() {
  const target = evolutionSkillPromotionTarget({ bindingId: randomUUID(), capabilityId: randomUUID(), versionId: randomUUID(),
    fallbackVersionId: randomUUID(), expectedRevision: 1, scope: { type: 'user', key: randomUUID() } })
  const now = new Date('2026-09-07T00:00:00Z')
  return { target, now, binding: { id: target.bindingId, capabilityId: target.capabilityId, scopeType: target.scope.type,
    scopeKey: target.scope.key, revision: 1, activeVersionId: target.versionId, fallbackVersionId: target.fallbackVersionId,
    trialExpiresAt: new Date(now.getTime() + 60000) as Date | null } }
}

test('promotion binds a live trial and rejects expired, changed, foreign or already permanent bindings', () => {
  assert.doesNotThrow(() => assertEvolutionSkillPromotionBinding(fixture()))
  const mutations: Array<(input: ReturnType<typeof fixture>) => void> = [
    input => { input.binding.trialExpiresAt = input.now },
    input => { input.binding.trialExpiresAt = null },
    input => { input.binding.trialExpiresAt = new Date(NaN) },
    input => { input.binding.revision++ },
    input => { input.binding.activeVersionId = randomUUID() },
    input => { input.binding.fallbackVersionId = randomUUID() },
    input => { input.binding.scopeKey = randomUUID() },
    input => { input.binding.capabilityId = randomUUID() },
    input => { input.target.environment = 'skill-trial:old-approval' },
  ]
  for (const mutate of mutations) {
    const input = fixture(); mutate(input)
    assert.throws(() => assertEvolutionSkillPromotionBinding(input), { code: 'EVOLUTION_PROMOTION_BINDING' })
  }
})
