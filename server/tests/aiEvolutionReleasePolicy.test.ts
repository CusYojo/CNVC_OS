import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertEvolutionReleaseBinding } from '../src/services/aiEvolutionReleasePolicy.js'
import { EVOLUTION_REQUIRED_CHECKS } from '../src/contracts/aiEvolutionEvaluationContract.js'

function fixture(): Parameters<typeof assertEvolutionReleaseBinding>[0] {
  return {
    candidate: { id: 'candidate', kind: 'code', status: 'approved', contentHash: 'candidate-hash', sourceHash: 'source-hash', baseRef: 'base', scope: { type: 'user', key: 'owner' } },
    evaluation: { candidateHash: 'candidate-hash', hash: 'evaluation-hash', report: { suiteVersion: 'v1', candidateHash: 'source-hash', verdict: 'PASS',
      checks: EVOLUTION_REQUIRED_CHECKS.code.map((id) => ({ id, verdict: 'PASS', evidence: 'verified evidence' })) } },
    authorization: { purpose: 'release', candidateId: 'candidate', candidateHash: 'candidate-hash', evaluationHash: 'evaluation-hash', actorUserId: 'publisher',
      scope: { type: 'user', key: 'owner' }, targetEnvironment: 'staging', expiresAt: new Date('2026-01-01T01:00:00Z'), decision: 'approved' },
    actor: { userId: 'publisher', enabled: true, targetEnvironmentGrant: true }, targetEnvironment: 'staging', currentBaseRef: 'base', now: new Date('2026-01-01T00:00:00Z'),
  }
}

test('release requires matching live grant, separate approval, current baseline and complete evaluation', () => {
  assert.doesNotThrow(() => assertEvolutionReleaseBinding(fixture()))
  const cases: [string, (input: ReturnType<typeof fixture>) => void][] = [
    ['EVOLUTION_RELEASE_FORBIDDEN', (f) => { f.actor.targetEnvironmentGrant = false }],
    ['EVOLUTION_RELEASE_FORBIDDEN', (f) => { f.actor.enabled = false }],
    ['EVOLUTION_RELEASE_APPROVAL_REQUIRED', (f) => { f.authorization.expiresAt = f.now }],
    ['EVOLUTION_RELEASE_BINDING', (f) => { f.targetEnvironment = 'production' }],
    ['EVOLUTION_RELEASE_BINDING', (f) => { f.candidate.contentHash = 'changed' }],
    ['EVOLUTION_RELEASE_BINDING', (f) => { f.evaluation.report.checks.pop() }],
    ['EVOLUTION_REEVALUATION_REQUIRED', (f) => { f.currentBaseRef = 'new-baseline' }],
  ]
  for (const [code, mutate] of cases) { const input = fixture(); mutate(input); assert.throws(() => assertEvolutionReleaseBinding(input), { code }) }
})
