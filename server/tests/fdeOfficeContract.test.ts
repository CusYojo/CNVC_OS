import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { officeAction, officeCents, officeDefinition, officePolicyConfig, officeRoute, validateOfficeSubmission } from '../src/contracts/fdeOfficeContract.js'
import { approveNodeTransition } from '../src/contracts/approvalNodeTransition.js'

const role = randomUUID(), department = randomUUID()
const node = { key: 'finance', name: '财务审核', roleIds: [role], scope: 'institution', mode: '或签', fixedUserIds: [], allowTransfer: true }
const policy = officePolicyConfig.parse({ kind: '报销', requiredFields: ['items'], attachmentRequired: false, rejectResubmission: false, routes: [{ key: 'large', when: { currency: 'CNY', minimum: '100.00', departmentIds: [department] }, nodes: [node] }, { key: 'default', when: {}, nodes: [node] }] })
const definition = officeDefinition.parse({ title: '报销申请', reason: '完整事由说明', priority: '普通', projectId: null, attachmentIds: [], details: { kind: '报销', amount: '100.00', currency: 'CNY', items: [{ id: randomUUID(), date: '2026-08-27', category: '交通', description: '合成测试费用', amount: '100.00' }] } })
test('OA exact decimal arithmetic and ordered currency/department routing', () => {
  assert.equal(officeCents('0.1') + officeCents('0.20'), 30n)
  for (const amount of ['-1', '1e5', '01', 'NaN', '1.001']) assert.throws(() => officeCents(amount))
  assert.equal(officeRoute(definition, policy, [department]).key, 'large')
  assert.equal(officeRoute(definition, policy, []).key, 'default')
  assert.equal(officeRoute({ ...definition, details: { ...definition.details, kind: '报销', amount: '100', currency: 'USD', items: [] } }, policy, [department]).key, 'default')
  assert.deepEqual(validateOfficeSubmission(definition, policy), [])
})
test('OA date, typed fields, immutable command input and invoice totals', () => {
  assert.throws(() => officeDefinition.parse({ ...definition, targetStage: '投决' }))
  assert.throws(() => officeDefinition.parse({ ...definition, details: { kind: '出差', startDate: '2026-02-30' } }))
  assert.throws(() => officeAction.parse({ clientRequestId: randomUUID(), expectedVersion: 1, reason: '明确提交申请', action: 'submit', expectedRouteHash: 'invalid' }))
  const bad = officeDefinition.parse({ ...definition, details: { kind: '报销', amount: '99', currency: 'CNY', items: [] } })
  assert.ok(validateOfficeSubmission(bad, policy).includes('报销明细与总额不一致'))
  const item = definition.details.kind === '报销' ? definition.details.items[0] : null
  assert.ok(item)
  const duplicate = officeDefinition.parse({ ...definition, details: { kind: '报销', amount: '200', currency: 'CNY', items: [{ ...item, invoiceNumber: 'same' }, { ...item, invoiceNumber: 'same' }] } })
  assert.ok(validateOfficeSubmission(duplicate, policy).includes('本申请内票据编号重复'))
  assert.ok(validateOfficeSubmission(duplicate, policy).includes('费用明细标识重复'))
})
test('OA policy forbids untyped requirements, missing final rule and money without currency', () => {
  assert.throws(() => officePolicyConfig.parse({ ...policy, requiredFields: ['unknown'] }))
  assert.throws(() => officePolicyConfig.parse({ ...policy, routes: policy.routes.slice(0, 1) }))
  assert.throws(() => officePolicyConfig.parse({ ...policy, routes: [{ ...policy.routes[0], when: { minimum: '1' } }, policy.routes[1]] }))
})
test('shared node engine preserves sequential business handlers and all/any signatures', () => {
  const input = { mode: '会签', approverUserIds: ['a', 'b'], approvedByUserIds: [], actorId: 'a' }
  assert.deepEqual(approveNodeTransition(input), { approvedIds: ['a'], completed: false, remainingIds: ['b'] })
  assert.equal(approveNodeTransition({ ...input, actorId: 'b', approvedByUserIds: ['a'] }).completed, true)
  assert.equal(approveNodeTransition({ ...input, mode: '或签' }).completed, true)
  assert.throws(() => approveNodeTransition({ ...input, actorId: 'stranger' }), /OA_NODE_ACTOR_INVALID/)
  assert.throws(() => approveNodeTransition({ ...input, approvedByUserIds: ['a'] }), /OA_ALREADY_APPROVED/)
  assert.throws(() => approveNodeTransition({ ...input, approverUserIds: [] }), /OA_NODE_CONFIGURATION_INVALID/)
  assert.equal(approveNodeTransition({ ...input, actorId: 'legacy-admin', override: true }).completed, true)
})
