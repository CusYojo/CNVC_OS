import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { typePolicyFixture } from '../src/scripts/fdeTypePolicyFixture.js'
import { typePolicyCommand, typePolicyDefinition, typePolicyReceipt } from '../src/contracts/fdeTypePolicyContract.js'
import { prepareTypeRegistration, typeBoundVersionMayAdvance, typeRegistrationCommand } from '../src/contracts/fdeTypeRegistrationContract.js'
import { forgetRegistrationPending, readRegistrationPending, registrationMarker, rememberRegistrationPending, typeRegistrationPendingKey, validateRegistrationReceipt, validateRegistrationRecovery } from '../../src/lib/fdeTypeRegistrationRecovery.js'
import { markerForTypePolicy, validateTypePolicyReceipt } from '../../src/lib/fdeTypePolicyRecovery.js'

function fixture() {
  const config = typePolicyFixture()
  config.planApprovals = [{ duty: 'concerned_leader', name: '合成独立计划审核', mode: '会签' }]
  config.registration = { roleIds: [randomUUID()], ownership: 'registrar', classification: 'normal', onDisable: 'continue_bound_version', ruleReference: '仅合成测试明确选择的规则，不是正式业务授权' }
  return config
}
const command = () => typeRegistrationCommand.parse({ commandId: randomUUID(), policyId: randomUUID(), versionId: randomUUID(), expectedPolicyVersion: 4, expectedSha256: 'a'.repeat(64), name: '合成登记', cycleDays: 15, targetDate: '2026-10-30', reason: '合成测试登记，不是正式业务' })

test('historical definitions keep identical JSON and never acquire registration authority', () => {
  const config = typePolicyFixture(), before = JSON.stringify(config)
  assert.equal(JSON.stringify(typePolicyDefinition.parse(config)), before)
  assert.equal(typePolicyDefinition.parse(config).registration, undefined)
  assert.throws(() => prepareTypeRegistration(config, command(), []), /缺少/)
})
test('registration requires explicit nonempty unique stable roles and supported ownership/disable choices', () => {
  const config = fixture()
  assert.equal(typePolicyDefinition.safeParse(config).success, true)
  for (const patch of [{ roleIds: [] }, { roleIds: ['系统管理员'] }, { roleIds: [config.registration!.roleIds[0], config.registration!.roleIds[0]] }, { classification: 'pool' }, { ownership: 'delegate' }, { onDisable: 'freeze' }, { ruleReference: '' }]) {
    assert.equal(typePolicyDefinition.safeParse({ ...config, registration: { ...config.registration, ...patch } }).success, false)
  }
})
test('unconfigured plan review and unauthorized roles cannot prepare registration', () => {
  const config = fixture(), input = command()
  assert.throws(() => prepareTypeRegistration(config, input, []), /授权/)
  assert.throws(() => prepareTypeRegistration(config, input, [randomUUID()]), /授权/)
  delete config.planApprovals
  assert.throws(() => prepareTypeRegistration(config, input, config.registration!.roleIds), /缺少/)
})
test('registration uses exact reviewed first stage, classification and explicit calendar, without generating tasks', () => {
  const config = fixture(), before = JSON.stringify(config)
  config.registration!.classification = 'key'
  const initial = prepareTypeRegistration(config, command(), config.registration!.roleIds)
  assert.deepEqual(initial, { stage: config.stages[0].name, classification: 'key', targetDate: '2026-10-30', cycleDays: 15 })
  assert.ok(!('tasks' in initial)); assert.ok(!('approved' in initial))
  config.registration!.classification = 'normal'; assert.equal(JSON.stringify(config), before)
  assert.throws(() => prepareTypeRegistration(config, { ...command(), cycleDays: 20 }, config.registration!.roleIds))
  config.calendar = { basis: 'working', workingWeekdays: [1, 2, 3, 4, 5], holidays: [], extraWorkingDates: [] }
  assert.throws(() => prepareTypeRegistration(config, { ...command(), targetDate: '2026-10-31' }, config.registration!.roleIds), /工作日/)
})
test('registration rejects actor, owner, project-state, task and lead-conversion injection', () => {
  for (const extra of [{ actorId: randomUUID() }, { ownerUserId: randomUUID() }, { stage: '投决' }, { lifecycle: 'closed' }, { classification: 'pool' }, { projectId: randomUUID() }, { sourceLeadId: randomUUID() }, { tasks: [] }, { approved: true }]) assert.equal(typeRegistrationCommand.safeParse({ ...command(), ...extra }).success, false)
  assert.equal(typeRegistrationCommand.safeParse({ ...command(), expectedPolicyVersion: 0 }).success, false)
  assert.equal(typeRegistrationCommand.safeParse({ ...command(), targetDate: '2026-02-30' }).success, false)
})
test('activation requires distinct strict commands and exact version, never create enabled=true', () => {
  const base = { commandId: randomUUID(), policyId: randomUUID(), versionId: randomUUID(), expectedVersion: 3, expectedPolicyVersion: 4, reason: '显式启停合成测试' }
  for (const action of ['activate', 'deactivate']) {
    assert.equal(typePolicyCommand.safeParse({ ...base, action }).success, true)
    assert.equal(typePolicyCommand.safeParse({ ...base, action, expectedPolicyVersion: undefined }).success, false)
    assert.equal(typePolicyCommand.safeParse({ ...base, action, enabled: true }).success, false)
  }
})
test('activation recovery requires correct action and enabled result, cannot reuse publication receipt', () => {
  const marker = markerForTypePolicy(typePolicyCommand.parse({ commandId: randomUUID(), policyId: randomUUID(), versionId: randomUUID(), expectedVersion: 3, expectedPolicyVersion: 4, action: 'activate', reason: '显式启用合成测试' }))
  const receipt = { ...marker, version: 3, policyVersion: 5, status: 'published', enabled: true }
  assert.equal(validateTypePolicyReceipt(receipt, marker).enabled, true)
  for (const patch of [{ enabled: false }, { enabled: undefined }, { status: 'approved' }, { action: 'publish' }]) assert.throws(() => validateTypePolicyReceipt({ ...receipt, ...patch }, marker))
  assert.equal(typePolicyReceipt.safeParse({ ...receipt, action: 'deactivate', enabled: false }).success, true)
})
test('published but never activated new rules cannot advance; explicitly approved continuation preserves bound version', () => {
  const old = typePolicyFixture(), current = fixture()
  assert.equal(typeBoundVersionMayAdvance(old, false, true), false)
  assert.equal(typeBoundVersionMayAdvance(old, true, false), true)
  assert.equal(typeBoundVersionMayAdvance(current, true, false), false)
  assert.equal(typeBoundVersionMayAdvance(current, false, false), false)
  assert.equal(typeBoundVersionMayAdvance(current, false, true), true)
  assert.equal(typeBoundVersionMayAdvance(current, true, true), true)
})
test('registration recovery is account-separated and stores no business body or rule definition', () => {
  const data = new Map<string, string>(), store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
  const key = typeRegistrationPendingKey(randomUUID()), marker = registrationMarker(command())
  rememberRegistrationPending(store, key, marker)
  assert.deepEqual(readRegistrationPending(store, key), marker)
  assert.doesNotMatch(data.get(key)!, /合成|name|reason|configuration|Sha256/)
  assert.equal(readRegistrationPending(store, typeRegistrationPendingKey(randomUUID())), null)
  assert.throws(() => rememberRegistrationPending(store, key, { ...marker, commandId: randomUUID() }))
  assert.throws(() => forgetRegistrationPending(store, key, { ...marker, commandId: randomUUID() }))
  forgetRegistrationPending(store, key, marker); assert.equal(data.size, 0)
  data.set(key, '{broken'); assert.throws(() => readRegistrationPending(store, key))
})
test('receipt and recovery must match exact registration target; no false success on response loss', () => {
  const marker = registrationMarker(command()), receipt = { ...marker, projectId: randomUUID(), version: 1 }
  assert.deepEqual(validateRegistrationReceipt(receipt, marker), receipt)
  for (const patch of [{ policyId: randomUUID() }, { versionId: randomUUID() }, { commandId: randomUUID() }, { version: 2 }]) assert.throws(() => validateRegistrationReceipt({ ...receipt, ...patch }, marker))
  assert.equal(validateRegistrationRecovery({ state: 'committed', receipt }, marker).state, 'committed')
  assert.equal(validateRegistrationRecovery({ state: 'not_committed', receipt: null }, marker).state, 'not_committed')
  assert.throws(() => validateRegistrationRecovery({ state: 'not_committed', receipt }, marker))
})
test('migration adds explicit commands without enabling policies or changing old data', () => {
  const migration = readFileSync(new URL('../drizzle/0085_add_fde_type_registration.sql', import.meta.url), 'utf8')
  assert.match(migration, /CREATE TABLE `sbl_fde_type_registration_commands`/)
  assert.match(migration, /'activate','deactivate'/)
  assert.doesNotMatch(migration, /UPDATE|DELETE FROM|INSERT INTO|DROP TABLE/i)
})
test('registration acceptance refuses business configuration before loading database modules', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', new URL('../src/scripts/fdeTypeRegistrationAcceptance.ts', import.meta.url).pathname], { encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, DB_DATABASE: 'business', DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USERNAME: 'fixture', DB_PASSWORD: 'fixture', DB_FREFIX: 'fde_accept_1234567890_', FDE_ACCEPTANCE_PREFIX: 'fde_accept_1234567890_', ALLOW_MYSQL_ACCEPTANCE_WRITES: '1' } })
  assert.ifError(result.error); assert.equal(result.status, 1)
  assert.match(result.stderr, /dedicated test\/acceptance MySQL database/)
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|ENOTFOUND|ER_ACCESS_DENIED/)
  assert.equal(result.stdout, '')
})
