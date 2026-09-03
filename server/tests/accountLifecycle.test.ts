import assert from 'node:assert/strict'
import test from 'node:test'
import bcrypt from 'bcryptjs'
import type {
  AuditRecord,
  IdentityRepositoryProvider,
  UserRecord,
  UserRepository,
} from '../src/repositories/identityRepository.js'
import {
  changeOwnPassword,
  requestUserRegistration,
  updateManagedUser,
} from '../src/services/identityAdministrationService.js'
import { AccountRegistrationSchema, ChangeOwnPasswordSchema } from '../src/schemas/account.js'

const now = new Date('2026-09-03T00:00:00.000Z')

function record(patch: Partial<UserRecord>): UserRecord {
  return {
    id: patch.id ?? 'user-1',
    email: patch.email ?? 'person@example.invalid',
    name: patch.name ?? '测试用户',
    role: patch.role ?? '投资经理',
    department: patch.department ?? '投资部',
    passwordHash: patch.passwordHash ?? 'hash',
    status: patch.status ?? '启用',
    lastLogin: null,
    createdAt: now,
  }
}

function fakeIdentity(initial: UserRecord[]) {
  const records = new Map(initial.map((item) => [item.id, item]))
  const audits: AuditRecord[] = []
  const synchronized: string[] = []
  const revoked: string[] = []
  const users: UserRepository = {
    findById: async (id) => records.get(id) ?? null,
    findByEmail: async (email) => [...records.values()].find((item) => item.email === email) ?? null,
    findManyByIds: async (ids) => ids.flatMap((id) => records.get(id) ?? []),
    findByTrimmedName: async (name, limit = 3) => [...records.values()].filter((item) => item.name.trim() === name).slice(0, limit),
    findEnabledByRoles: async (roles) => [...records.values()].filter((item) => item.status === '启用' && roles.includes(item.role)),
    isActiveRoleName: async (name) => ['投资经理', '法务', '系统管理员'].includes(name),
    isActiveDepartmentName: async (name) => ['投资部', '法务部'].includes(name),
    listPermissionCodes: async (id) => records.get(id)?.role === '系统管理员' ? ['system.manage'] : [],
    roleHasPermission: async (role, permission) => role === '系统管理员' && permission === 'system.manage',
    listSafe: async () => [...records.values()].map(({ passwordHash: _passwordHash, ...item }) => item),
    lockById: async (id) => records.get(id) ?? null,
    create: async (input) => {
      const created = record({ ...input, id: `created-${records.size + 1}` })
      records.set(created.id, created)
      return created
    },
    update: async (id, patch) => {
      const current = records.get(id)
      if (!current) return null
      const updated = { ...current, ...patch }
      records.set(id, updated)
      return updated
    },
    updatePasswordHash: async (id, passwordHash) => {
      const current = records.get(id)
      if (!current) return false
      records.set(id, { ...current, passwordHash })
      return true
    },
    touchLastLogin: async () => {},
    revokeActiveSessions: async (id) => { revoked.push(id); return 2 },
    synchronizeAdministrationBindings: async (id) => { synchronized.push(id) },
  }
  const provider: IdentityRepositoryProvider = {
    users,
    permissions: {
      findProjectById: async () => null,
      lockProjectById: async () => null,
      listProjectMembers: async () => [],
      listProjectMemberBindings: async () => [],
      replaceProjectMembers: async () => {},
    },
    audits: { append: async (entry) => { audits.push(entry) } },
    transaction: async (work) => work(provider),
  }
  return { provider, records, audits, synchronized, revoked }
}

test('public registration accepts only complete account input', () => {
  const valid = { name: '新员工', email: 'new@example.invalid', role: '投资经理', department: '投资部', password: 'Secure!Password9' }
  assert.deepEqual(AccountRegistrationSchema.parse(valid), valid)
  for (const patch of [{ email: 'bad' }, { role: '' }, { department: '' }, { password: '' }, { extra: true }]) {
    assert.equal(AccountRegistrationSchema.safeParse({ ...valid, ...patch }).success, false)
  }
  assert.equal(ChangeOwnPasswordSchema.safeParse({ currentPassword: 'old', newPassword: 'new' }).success, true)
})

test('registration creates a pending user without exposing it to the active personnel directory', async () => {
  const fixture = fakeIdentity([])
  const result = await requestUserRegistration({
    name: '新员工', email: 'new@example.invalid', role: '投资经理', department: '投资部', password: 'Secure!Password9',
  }, fixture.provider)
  assert.equal(result.status, '待审核')
  const created = fixture.records.get(result.id)!
  assert.equal(created.status, '待审核')
  assert.equal(await bcrypt.compare('Secure!Password9', created.passwordHash), true)
  assert.deepEqual(fixture.synchronized, [])
  assert.equal(fixture.audits[0].action, '提交账号注册申请')
  await assert.rejects(
    requestUserRegistration({ name: '管理员', email: 'admin2@example.invalid', role: '系统管理员', department: '投资部', password: 'Secure!Password9' }, fixture.provider),
    (error: Error & { code?: string }) => error.code === 'REGISTRATION_ROLE_FORBIDDEN',
  )
})

test('administrator approval activates and synchronizes the pending account', async () => {
  const administrator = record({ id: 'admin', name: '系统管理员', email: 'admin@example.invalid', role: '系统管理员' })
  const pending = record({ id: 'pending', status: '待审核' })
  const fixture = fakeIdentity([administrator, pending])
  const approved = await updateManagedUser('pending', { status: '启用' }, { userId: administrator.id, userName: administrator.name }, fixture.provider)
  assert.equal(approved.status, '启用')
  assert.deepEqual(fixture.synchronized, ['pending'])
  assert.deepEqual(fixture.revoked, ['pending'])
  assert.equal(fixture.audits.at(-1)?.action, '通过账号注册')
})

test('an enabled user can change their own password and revoke existing sessions', async () => {
  const currentHash = await bcrypt.hash('Current!Password9', 12)
  const current = record({ id: 'self', passwordHash: currentHash })
  const fixture = fakeIdentity([current])
  const result = await changeOwnPassword({ userId: current.id, currentPassword: 'Current!Password9', newPassword: 'Another!Password8' }, fixture.provider)
  assert.equal(result.revokedSessions, 2)
  assert.equal(await bcrypt.compare('Another!Password8', fixture.records.get(current.id)!.passwordHash), true)
  assert.equal(fixture.audits.at(-1)?.action, '用户修改登录密码')
  await assert.rejects(
    changeOwnPassword({ userId: current.id, currentPassword: 'wrong', newPassword: 'Third!Password7' }, fixture.provider),
    (error: Error & { code?: string }) => error.code === 'CURRENT_PASSWORD_INVALID',
  )
})
