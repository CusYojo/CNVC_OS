import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculateAiEvolutionMetrics } from '../src/services/aiEvolutionMetricsService.js'

test('metrics expose exact numerators, denominators, samples and unknown evidence', () => {
  const metrics = calculateAiEvolutionMetrics({ applications: [
    { snapshot: { loaded: [{ versionId: 'a' }], excluded: [] }, checkStatus: 'PASS' },
    { snapshot: { loaded: [{ versionId: 'b' }], excluded: [] }, checkStatus: 'not_checked' },
    { snapshot: { loaded: [], excluded: [{ reason: 'prompt_budget' }] }, checkStatus: 'not_checked' },
    { snapshot: { loaded: [], excluded: [{ reason: 'scope_mismatch' }] }, checkStatus: 'not_checked' },
  ], candidates: [{ report: { verdict: 'PASS' } }, { report: { verdict: 'FAIL' } }, { report: null }] })
  assert.deepEqual(metrics[0], { key: 'application_rate', label: '应用率', numerator: 2, denominator: 3,
    value: 2 / 3, sampleSize: 4, notEvaluated: 1 })
  assert.deepEqual(metrics[1], { key: 'compliance_rate', label: '遵守率', numerator: 1, denominator: 1,
    value: 1, sampleSize: 2, notEvaluated: 1 })
  assert.equal(metrics[2].value, null); assert.match(metrics[2].unavailableReason!, /具体经验版本/)
  assert.deepEqual(metrics[3], { key: 'candidate_pass_rate', label: '候选通过率', numerator: 1, denominator: 2,
    value: 0.5, sampleSize: 3, notEvaluated: 1 })
  assert.equal(metrics[4].value, null); assert.match(metrics[4].unavailableReason!, /回归确认/)
})
