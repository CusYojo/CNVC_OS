import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFdeIdentityImportPlan, FDE_IDENTITY_SOURCE, type FdeIdentitySnapshot, type FdeSourceAccount } from '../src/contracts/fdeIdentityImportContract.js'
import { parseFdeSeedAccounts } from '../src/scripts/lib/fdeIdentitySource.js'

const account = (patch: Partial<FdeSourceAccount> = {}): FdeSourceAccount => ({ id: 'test-member', username: '测试人员', displayName: '测试人员', displayRole: '投资经理', department: '投资部', policyKey: 'member', specialty: 'investment_manager', status: 'active', ...patch })
function fixture(): FdeIdentitySnapshot {
  const definitions = [
    ['FDE_CHAIRMAN', '董事长', 'institution_leader', 'all'], ['FDE_PRESIDENT', '总裁', 'institution_leader', 'all'],
    ['FDE_PROJECT_LEAD', '项目负责人', 'project_lead', 'self'], ['FDE_SECRETARY', '推进秘书', 'secretary', 'self'],
    ['FDE_COORDINATOR', '时间协调人', 'coordinator', 'self'], ['FDE_LEGAL', '法务', 'specialist', 'self'],
    ['RISK_LEGAL', '风控与法务', 'specialist', 'self'], ['INVESTMENT_MANAGER', '投资经理', 'member', 'self'],
  ]
  const roles = definitions.map(([code, name, fdeCategory, dataScope]) => ({ id: code, code, name, fdeCategory, dataScope, status: '启用' }))
  return { users: [], roles, departments: [{ id: 'investment', code: 'INVESTMENT', name: '投资部', status: '启用' }], permissions: [{ id: 'read', code: 'fde.project.read' }], rolePermissions: roles.map(r => ({ roleId: r.id, permissionId: 'read' })), userRoles: [], userDepartments: [], mappings: [] }
}

test('name login imports use reserved non-deliverable identifiers, not invented work mailboxes', () => {
  const before = fixture(), untouched = structuredClone(before)
  const plan = buildFdeIdentityImportPlan([account()], before)
  assert.deepEqual(before, untouched)
  assert.deepEqual(plan.conflicts, [])
  assert.equal(plan.users[0].email, 'fde.test-member@accounts.invalid')
  assert.equal(plan.users[0].action, 'create')
  assert.deepEqual(plan.users[0].roleCodes, ['INVESTMENT_MANAGER'])
})

test('secretary managers preserve their job title and get an additional duty category', () => {
  const plan = buildFdeIdentityImportPlan([account({ policyKey: 'secretary' })], fixture())
  assert.equal(plan.users[0].role, '投资经理')
  assert.deepEqual(plan.users[0].roleCodes, ['INVESTMENT_MANAGER', 'FDE_SECRETARY'])
})

test('partner, risk and board secretary titles map to canonical business roles without administrator rights', () => {
  for (const [displayRole, policyKey, specialty, primary, canonical] of [
    ['合伙人', 'lead', 'partner', 'FDE_PARTNER', 'FDE_PROJECT_LEAD'],
    ['风控', 'finance', 'risk', 'FDE_RISK', 'RISK_LEGAL'],
    ['董秘', 'coordinator', 'board_secretary', 'FDE_BOARD_SECRETARY', 'FDE_COORDINATOR'],
  ]) {
    const plan = buildFdeIdentityImportPlan([account({ displayRole, policyKey, specialty })], fixture())
    assert.deepEqual(plan.conflicts, [])
    assert.deepEqual(plan.users[0].roleCodes, [primary, canonical])
    assert.equal(plan.rolesToCreate[0].dataScope, 'self')
    assert.deepEqual(plan.rolesToCreate[0].permissionCodes, ['fde.project.read'])
  }
})

test('chairman and president retain distinct canonical executive roles', () => {
  for (const [displayRole, specialty, code] of [['董事长', 'chairman', 'FDE_CHAIRMAN'], ['总裁', 'president', 'FDE_PRESIDENT']]) {
    const plan = buildFdeIdentityImportPlan([account({ displayRole, policyKey: 'leader', specialty })], fixture())
    assert.deepEqual(plan.conflicts, [])
    assert.deepEqual(plan.users[0].roleCodes, [code])
  }
})

test('disabled source accounts are not silently enabled', () => {
  assert.equal(buildFdeIdentityImportPlan([account({ status: 'disabled' })], fixture()).users[0].status, '禁用')
})

test('same-name accounts are conflicts, never adopted or overwritten', () => {
  const before = fixture()
  before.users.push({ id: 'existing', name: ' 测试人员 ', email: 'existing@example.invalid', role: '系统管理员', department: '投资部', status: '禁用' })
  assert.match(buildFdeIdentityImportPlan([account()], before).conflicts.join(), /目标姓名或导入标识冲突/)
})

test('repeat imports skip mapped accounts and preserve later password/role changes', () => {
  const before = fixture()
  before.users.push({ id: 'existing', name: '测试人员', email: 'fde.test-member@accounts.invalid', role: '后来配置的角色', department: '投资部', status: '禁用' })
  before.mappings.push({ sourceSystem: FDE_IDENTITY_SOURCE, sourceUserId: 'test-member', targetUserId: 'existing' })
  const plan = buildFdeIdentityImportPlan([account()], before)
  assert.deepEqual(plan.conflicts, [])
  assert.equal(plan.users[0].action, 'skip')
  assert.equal(plan.rolesToCreate.length + plan.departmentsToCreate.length, 0)
})

test('source duplicates, unknown role combinations and missing source rows block import', () => {
  assert.match(buildFdeIdentityImportPlan([account(), account()], fixture()).conflicts.join(), /重复/)
  assert.match(buildFdeIdentityImportPlan([account({ policyKey: 'admin' })], fixture()).conflicts.join(), /未确认/)
  assert.match(buildFdeIdentityImportPlan([], fixture()).conflicts.join(), /为空/)
})

test('disabled roles, broadened data scopes and elevated permission templates block import', () => {
  for (const patch of [{ status: '禁用' }, { dataScope: 'all' }, { fdeCategory: 'system_admin' }]) {
    const before = fixture()
    Object.assign(before.roles.find(r => r.code === 'INVESTMENT_MANAGER')!, patch)
    assert.match(buildFdeIdentityImportPlan([account()], before).conflicts.join(), /不匹配或已禁用/)
  }
  const before = fixture()
  before.permissions.push({ id: 'admin', code: 'system.manage' })
  before.rolePermissions.push({ roleId: 'INVESTMENT_MANAGER', permissionId: 'admin' })
  assert.match(buildFdeIdentityImportPlan([account()], before).conflicts.join(), /非业务管理权限/)
})

test('static source reading excludes credential material and never evaluates scripts', () => {
  const source = `throw new Error('must not execute'); export const COMPANY_ACCOUNTS = Object.freeze([{id:"one",username:"某人",displayName:"某人",displayRole:"投资经理",department:"投资部",policyKey:"member",specialty:"investment_manager",salt:"secret",passwordHash:"private"}]);`
  const parsed = parseFdeSeedAccounts(source)
  assert.equal(parsed[0].displayName, '某人')
  assert.equal(parsed[0].status, 'active')
  assert.doesNotMatch(JSON.stringify(parsed), /secret|private|salt|passwordHash/)
  assert.throws(() => parseFdeSeedAccounts('export const COMPANY_ACCOUNTS = loadAccounts();'))
  assert.throws(() => parseFdeSeedAccounts('export const COMPANY_ACCOUNTS = Object.freeze([{...process.env}]);'))
})
