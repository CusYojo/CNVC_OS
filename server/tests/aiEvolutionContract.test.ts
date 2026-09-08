import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canTransitionEvolutionRun, evolutionProposalReadiness, type EvolutionSpec } from '../src/contracts/aiEvolutionContract.js'
import { evolutionSpecSchema, evolutionCreateSchema, evolutionDecisionSchema } from '../src/schemas/aiEvolutionSchema.js'
import { createEvolutionReevaluationSpec } from '../src/services/aiEvolutionReevaluationSpec.js'

test('human decisions require reviewed hashes and cannot supply actor or expiration', () => {
  const decision = { candidateHash: 'a'.repeat(64), evaluationHash: 'b'.repeat(64), scope: { type: 'user', key: 'owner' }, environment: 'isolated', decision: 'approved' }
  assert.equal(evolutionDecisionSchema.parse(decision).decision, 'approved')
  assert.equal(evolutionDecisionSchema.safeParse({ ...decision, actorUserId: 'other' }).success, false)
  assert.equal(evolutionDecisionSchema.safeParse({ ...decision, expiresAt: '2099-01-01' }).success, false)
  assert.equal(evolutionDecisionSchema.safeParse({ ...decision, candidateHash: '' }).success, false)
})

const spec: EvolutionSpec = {
  schemaVersion: 1, kind: 'code', title: '来源说明入口', objective: '展开已有来源信息',
  scope: { type: 'user', key: '00000000-0000-4000-8000-000000000001' },
  sourceRefs: [{ type: 'message', id: 'message-1' }], acceptanceCriteria: ['点击入口展示来源'],
  budget: { maxDurationSeconds: 600, maxModelTokens: 10_000, maxRepairRounds: 3 }, questions: [],
  target: { type: 'code', repositoryId: '00000000-0000-4000-8000-000000000002', baseCommit: 'a'.repeat(40), allowedPaths: ['src/pages/LeadDetailPage.tsx'], databaseChange: false, permissionChange: false },
}

test('accepts typed proposal and never accepts client-supplied identity or status', () => {
  assert.deepEqual(evolutionCreateSchema.parse({ spec }), { spec })
  for (const key of ['ownerUserId', 'status', 'approved', 'leaseToken']) {
    assert.equal(evolutionCreateSchema.safeParse({ spec, [key]: 'forged' }).success, false)
  }
})

test('changed baseline creates a new spec without weakening scope, budget, requirements or carrying approvals', () => {
  const next = createEvolutionReevaluationSpec(spec, 'b'.repeat(40))
  assert.deepEqual(next, { ...spec, target: { ...spec.target, baseCommit: 'b'.repeat(40) } })
  assert.equal(spec.target.type === 'code' && spec.target.baseCommit, 'a'.repeat(40))
  assert.throws(() => createEvolutionReevaluationSpec(spec, 'main'), { code: 'EVOLUTION_BASE_INVALID' })
  assert.throws(() => createEvolutionReevaluationSpec(spec, 'a'.repeat(40)), { code: 'EVOLUTION_BASE_UNCHANGED' })
  assert.throws(() => createEvolutionReevaluationSpec({ ...spec, approvalId: 'old-approval' }, 'b'.repeat(40)))
})

test('rejects kind mismatch, unbound project scopes, mutable git refs and path escapes', () => {
  assert.equal(evolutionSpecSchema.safeParse({ ...spec, kind: 'experience' }).success, false)
  assert.equal(evolutionSpecSchema.safeParse({ ...spec, scope: { type: 'project', key: 'other' } }).success, false)
  for (const value of ['../.env', '/etc/passwd', 'C:/Users', 'src/../../server', 'src\\file', '.env', 'src//file']) {
    assert.equal(evolutionSpecSchema.safeParse({ ...spec, target: { ...spec.target, allowedPaths: [value] } }).success, false, value)
  }
  assert.equal(evolutionSpecSchema.safeParse({ ...spec, target: { ...spec.target, baseCommit: 'main' } }).success, false)
})

test('unanswered questions prevent ready status; budget cannot create unlimited repair loops', () => {
  assert.equal(evolutionProposalReadiness(spec), 'ready')
  assert.equal(evolutionProposalReadiness({ ...spec, questions: [{ id: 'permission', question: '执行资格', options: ['白名单', '授权页面'] }] }), 'needs_input')
  assert.equal(evolutionSpecSchema.safeParse({ ...spec, budget: { ...spec.budget, maxRepairRounds: 4 } }).success, false)
})

test('execution success requires evaluation and cannot reopen or imply publication', () => {
  assert.equal(canTransitionEvolutionRun('executing', 'succeeded'), false)
  assert.equal(canTransitionEvolutionRun('executing', 'evaluating'), true)
  assert.equal(canTransitionEvolutionRun('evaluating', 'succeeded'), true)
  for (const terminal of ['failed', 'succeeded', 'cancelled', 'interrupted'] as const) {
    assert.equal(canTransitionEvolutionRun(terminal, 'executing'), false)
  }
})
