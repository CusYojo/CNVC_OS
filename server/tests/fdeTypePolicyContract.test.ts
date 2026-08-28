import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { FDE_NON_INVESTMENT_TYPES, previewTypePlan, typePolicyCommand, typePolicyDefinition } from '../src/contracts/fdeTypePolicyContract.js'
import { DEFAULT_FDE_WORKFLOW_POLICY, fdeWorkflowPolicySchema } from '../src/contracts/fdeWorkflowPolicyContract.js'
import { typePolicyFixture } from '../src/scripts/fdeTypePolicyFixture.js'
import { forgetTypePolicyPending, markerForTypePolicy, readTypePolicyPending, rememberTypePolicyPending, typePolicyPendingKey, validateTypePolicyReceipt, validateTypePolicyRecovery } from '../../src/lib/fdeTypePolicyRecovery.js'

test('non-investment catalogue is distinct and never accepted as investment eight-stage configuration', () => {
  assert.equal(FDE_NON_INVESTMENT_TYPES.length, 7)
  for (const type of FDE_NON_INVESTMENT_TYPES) assert.equal(typePolicyDefinition.safeParse(typePolicyFixture(type.code)).success, true)
  assert.equal(typePolicyDefinition.safeParse({ ...typePolicyFixture(), type: 'investment' }).success, false)
  assert.equal(typePolicyDefinition.safeParse(DEFAULT_FDE_WORKFLOW_POLICY).success, false)
  assert.equal(fdeWorkflowPolicySchema.safeParse(typePolicyFixture()).success, false)
  assert.equal(fdeWorkflowPolicySchema.safeParse({ ...DEFAULT_FDE_WORKFLOW_POLICY, cycleDays: [50] }).success, false)
})
test('type definition requires stable unique phases, valid materials and ordered deliverable actions', () => {
  const invalid = [
    (v: ReturnType<typeof typePolicyFixture>) => { v.stages[1].key = v.stages[0].key },
    (v: ReturnType<typeof typePolicyFixture>) => { v.stages[1].name = v.stages[0].name },
    (v: ReturnType<typeof typePolicyFixture>) => { v.stages[0].approvals = [] },
    (v: ReturnType<typeof typePolicyFixture>) => { v.stages[0].materials.push(v.stages[0].materials[0]) },
    (v: ReturnType<typeof typePolicyFixture>) => { v.actions[0].stageKey = 'missing_stage' },
    (v: ReturnType<typeof typePolicyFixture>) => { v.actions[1].position = 40 },
    (v: ReturnType<typeof typePolicyFixture>) => { v.actions[1].key = v.actions[0].key },
    (v: ReturnType<typeof typePolicyFixture>) => { v.actions.reverse() },
  ]
  for (const mutate of invalid) { const value = typePolicyFixture(); mutate(value); assert.equal(typePolicyDefinition.safeParse(value).success, false) }
})
test('natural-day preview retains exact configured interval and final target without persistence', () => {
  const value = previewTypePlan({ configuration: typePolicyFixture(), cycleDays: 15, targetDate: '2026-08-31' })
  assert.equal(value.startDate, '2026-08-16'); assert.equal(value.actions[0].dueDate, '2026-08-23'); assert.equal(value.actions[1].dueDate, '2026-08-31'); assert.equal(value.persisted, false)
  assert.throws(() => previewTypePlan({ configuration: typePolicyFixture(), cycleDays: 20, targetDate: '2026-08-31' }))
  assert.throws(() => previewTypePlan({ configuration: typePolicyFixture(), cycleDays: 15, targetDate: '2026-02-30' }))
})
test('working-day preview uses explicit holidays and extra days and never silently moves target', () => {
  const configuration = typePolicyFixture(); configuration.calendar = { basis: 'working', workingWeekdays: [1, 2, 3, 4, 5], holidays: ['2026-08-28'], extraWorkingDates: ['2026-08-29'] }
  assert.equal(previewTypePlan({ configuration, cycleDays: 15, targetDate: '2026-08-31' }).startDate, '2026-08-10')
  assert.throws(() => previewTypePlan({ configuration, cycleDays: 15, targetDate: '2026-08-30' }))
  configuration.calendar.extraWorkingDates.push('2026-08-28'); assert.equal(typePolicyDefinition.safeParse(configuration).success, false)
  configuration.calendar = { basis: 'working', workingWeekdays: [], holidays: [], extraWorkingDates: [] }; assert.equal(typePolicyDefinition.safeParse(configuration).success, false)
})
test('commands reject actor/source/status injection and expose no activation shortcut', () => {
  const valid = { commandId: randomUUID(), reason: '合成测试模板版本', action: 'create', expectedPolicyVersion: 0, configuration: typePolicyFixture() }
  assert.equal(typePolicyCommand.safeParse(valid).success, true)
  for (const extra of [{ actorId: randomUUID() }, { status: 'published' }, { enabled: true }, { approvedBy: randomUUID() }]) assert.equal(typePolicyCommand.safeParse({ ...valid, ...extra }).success, false)
  assert.equal(typePolicyCommand.safeParse({ ...valid, action: 'toggle' }).success, false)
})
test('recovery stores only actor-separated minimal markers and protects other pending commands', () => {
  const data = new Map<string, string>(), store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
  const command = typePolicyCommand.parse({ commandId: randomUUID(), action: 'create', expectedPolicyVersion: 0, reason: '不能存入浏览器正文', configuration: typePolicyFixture() }), marker = markerForTypePolicy(command), key = typePolicyPendingKey(randomUUID())
  rememberTypePolicyPending(store, key, marker); assert.deepEqual(readTypePolicyPending(store, key), marker); assert.doesNotMatch(data.get(key)!, /configuration|不能存入/)
  assert.throws(() => rememberTypePolicyPending(store, key, { ...marker, commandId: randomUUID() })); assert.throws(() => forgetTypePolicyPending(store, key, { ...marker, commandId: randomUUID() }))
  assert.equal(readTypePolicyPending(store, typePolicyPendingKey(randomUUID())), null); forgetTypePolicyPending(store, key, marker); assert.equal(data.size, 0)
})
test('write and recovery receipts must match command action status and exact version target', () => {
  const marker = markerForTypePolicy({ commandId: randomUUID(), action: 'approve', policyId: randomUUID(), versionId: randomUUID(), expectedVersion: 1, reason: '独立审核测试' })
  const receipt = { commandId: marker.commandId, action: marker.action, policyId: marker.policyId, versionId: marker.versionId, policyVersion: 2, version: 2, status: 'approved' }
  assert.deepEqual(validateTypePolicyReceipt(receipt, marker), receipt)
  for (const patch of [{ status: 'published' }, { versionId: randomUUID() }, { commandId: randomUUID() }, { policyId: randomUUID() }, { version: 0 }]) assert.throws(() => validateTypePolicyReceipt({ ...receipt, ...patch }, marker))
  assert.equal(validateTypePolicyRecovery({ state: 'committed', receipt }, marker).state, 'committed')
  assert.throws(() => validateTypePolicyRecovery({ state: 'not_committed', receipt }, marker))
})
