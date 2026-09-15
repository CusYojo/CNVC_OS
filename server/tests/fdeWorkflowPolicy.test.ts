import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_FDE_WORKFLOW_POLICY, fdeWorkflowPolicySchema, fdeWorkflowPolicySnapshotSchema } from '../src/contracts/fdeWorkflowPolicyContract.js'

test('FDE default policy preserves investment stages, materials and duties', () => {
  assert.equal(fdeWorkflowPolicySchema.safeParse(DEFAULT_FDE_WORKFLOW_POLICY).success, true)
  assert.equal(DEFAULT_FDE_WORKFLOW_POLICY.stages.length, 9)
  assert.deepEqual(DEFAULT_FDE_WORKFLOW_POLICY.stages.map((stage) => stage.stage), [
    '入库', '立项', '尽调计划制定', '尽调计划审核', '尽调', '内核', '投决', '打款', '投后',
  ])
  assert.deepEqual(DEFAULT_FDE_WORKFLOW_POLICY.stages.map((stage) => stage.approvals.map((node) => [node.duty, node.mode])), [
    [['boss', '或签']], [['boss', '或签']], [['boss', '或签']], [], [['boss', '或签']],
    [['finance', '或签'], ['legal', '或签'], ['boss', '或签']],
    [['chairman', '会签'], ['president', '会签']], [['finance', '或签']], [],
  ])
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
  const missingEstablishmentApprover = structuredClone(DEFAULT_FDE_WORKFLOW_POLICY)
  missingEstablishmentApprover.stages[1].approvals = []
  assert.equal(fdeWorkflowPolicySchema.safeParse(missingEstablishmentApprover).success, false)
  const missingFund = structuredClone(DEFAULT_FDE_WORKFLOW_POLICY)
  missingFund.stages[5].requiresFund = false
  assert.equal(fdeWorkflowPolicySchema.safeParse(missingFund).success, false)
})

test('FDE historical snapshots remain readable without satisfying current baseline', () => {
  const historical = structuredClone(DEFAULT_FDE_WORKFLOW_POLICY)
  historical.stages[1].approvals = []
  assert.equal(fdeWorkflowPolicySnapshotSchema.safeParse(historical).success, true)
  assert.equal(fdeWorkflowPolicySchema.safeParse(historical).success, false)
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
