import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { assertEvolutionSkillTrial, evolutionSkillTrialTarget } from '../src/services/aiEvolutionSkillTrialPolicy.js'
import { EVOLUTION_REQUIRED_CHECKS } from '../src/contracts/aiEvolutionEvaluationContract.js'

function fixture(): Parameters<typeof assertEvolutionSkillTrial>[0] {
  const target = evolutionSkillTrialTarget({ capabilityId: randomUUID(), versionId: randomUUID(), fallbackVersionId: randomUUID(),
    expectedRevision: 0, scope: { type: 'user', key: 'owner' }, trialExpiresAt: '2026-09-07T01:00:00.000Z' })
  return { target, version: { id: target.versionId, capabilityId: target.capabilityId, contentHash: 'candidate-source' },
    fallback: { id: target.fallbackVersionId, capabilityId: target.capabilityId, contentHash: 'baseline-source' }, binding: null, maxTrialSeconds: 3600,
    release: { candidate: { id: 'candidate', kind: 'skill', status: 'approved', contentHash: 'candidate-record', sourceHash: 'candidate-source',
      baseRef: 'baseline-source', scope: target.scope },
      evaluation: { candidateHash: 'candidate-record', hash: 'evaluation', report: { suiteVersion: 'v1', candidateHash: 'candidate-source', verdict: 'PASS',
        checks: [...EVOLUTION_REQUIRED_CHECKS.skill, 'improvement'].map(id => ({ id, verdict: 'PASS', evidence: 'fixture' })) } },
      authorization: { purpose: 'release', candidateId: 'candidate', candidateHash: 'candidate-record', evaluationHash: 'evaluation',
        actorUserId: 'owner', scope: target.scope, targetEnvironment: target.environment, decision: 'approved', expiresAt: new Date('2026-09-07T00:30:00Z') },
      actor: { userId: 'owner', enabled: true, targetEnvironmentGrant: true }, targetEnvironment: target.environment,
      currentBaseRef: 'baseline-source', now: new Date('2026-09-07T00:00:00Z') } }
}

test('trial approval binds versions, revision, scope and expiry and rejects substituted values', () => {
  assert.doesNotThrow(() => assertEvolutionSkillTrial(fixture()))
  const cases: ((input: ReturnType<typeof fixture>) => void)[] = [
    input => { input.target.trialExpiresAt = '2026-09-07T02:00:00.000Z' },
    input => { input.target.fallbackVersionId = randomUUID() },
    input => { input.target.scope = { type: 'project', key: 'other' } },
    input => { input.target.expectedRevision = 1 },
    input => { input.version.capabilityId = randomUUID() },
    input => { input.release.actor.targetEnvironmentGrant = false },
    input => { input.release.authorization.expiresAt = input.release.now },
    input => { input.release.evaluation.report.checks.pop() },
    input => { input.maxTrialSeconds = 60 },
    input => { input.binding = { revision: 1, activeVersionId: input.target.fallbackVersionId, trialExpiresAt: null } },
  ]
  for (const mutate of cases) { const input = fixture(); mutate(input); assert.throws(() => assertEvolutionSkillTrial(input)) }
  const existing = fixture()
  existing.target = evolutionSkillTrialTarget({ capabilityId: existing.target.capabilityId, versionId: existing.target.versionId,
    fallbackVersionId: existing.target.fallbackVersionId, expectedRevision: 2, scope: existing.target.scope, trialExpiresAt: existing.target.trialExpiresAt })
  existing.release.targetEnvironment = existing.target.environment; existing.release.authorization.targetEnvironment = existing.target.environment
  existing.binding = { revision: 2, activeVersionId: existing.target.fallbackVersionId, trialExpiresAt: null }
  assert.doesNotThrow(() => assertEvolutionSkillTrial(existing))
  existing.binding.trialExpiresAt = new Date(existing.release.now.getTime() + 60000)
  assert.throws(() => assertEvolutionSkillTrial(existing), { code: 'EVOLUTION_REVISION_CONFLICT' })
  existing.binding.trialExpiresAt = existing.release.now
  assert.throws(() => assertEvolutionSkillTrial(existing), { code: 'EVOLUTION_REVISION_CONFLICT' })
})
