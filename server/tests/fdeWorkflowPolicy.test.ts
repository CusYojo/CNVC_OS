import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_FDE_WORKFLOW_POLICY, fdeWorkflowPolicySchema } from '../src/contracts/fdeWorkflowPolicyContract.js'

test('FDE default policy preserves investment stages, materials and duties', () => {
  assert.equal(fdeWorkflowPolicySchema.safeParse(DEFAULT_FDE_WORKFLOW_POLICY).success, true)
  assert.equal(DEFAULT_FDE_WORKFLOW_POLICY.stages.length, 8)
  assert.deepEqual(DEFAULT_FDE_WORKFLOW_POLICY.stages[6].approvals.map((node) => node.duty), ['chairman', 'president'])
})

test('FDE malformed policy returns validation errors instead of throwing TypeError', () => {
  for (const stages of [[], [DEFAULT_FDE_WORKFLOW_POLICY.stages[0]], DEFAULT_FDE_WORKFLOW_POLICY.stages.slice(1), [null], 'invalid']) {
    assert.equal(fdeWorkflowPolicySchema.safeParse({ ...DEFAULT_FDE_WORKFLOW_POLICY, stages }).success, false)
  }
  for (const value of [null, {}, [], { schemaVersion: 2 }, undefined]) assert.equal(fdeWorkflowPolicySchema.safeParse(value).success, false)
})

test('FDE policy cannot remove baseline material, approval duty or fund gate', () => {
  const missingMaterial = structuredClone(DEFAULT_FDE_WORKFLOW_POLICY)
  missingMaterial.stages[1].materials = []
  assert.equal(fdeWorkflowPolicySchema.safeParse(missingMaterial).success, false)
  const missingApprover = structuredClone(DEFAULT_FDE_WORKFLOW_POLICY)
  missingApprover.stages[6].approvals.pop()
  assert.equal(fdeWorkflowPolicySchema.safeParse(missingApprover).success, false)
  const missingFund = structuredClone(DEFAULT_FDE_WORKFLOW_POLICY)
  missingFund.stages[5].requiresFund = false
  assert.equal(fdeWorkflowPolicySchema.safeParse(missingFund).success, false)
})

test('FDE policy supports stricter materials, waiver rules and allowed cycles', () => {
  const configuration = structuredClone(DEFAULT_FDE_WORKFLOW_POLICY)
  configuration.cycleDays = [30]
  configuration.stages[1].allowWaiver = false
  configuration.stages[1].materials.push({ key: 'extra_evidence', label: '额外核验证据' })
  assert.equal(fdeWorkflowPolicySchema.safeParse(configuration).success, true)
  configuration.stages[1].materials.push({ key: 'extra_evidence', label: '重复编号' })
  assert.equal(fdeWorkflowPolicySchema.safeParse(configuration).success, false)
})
