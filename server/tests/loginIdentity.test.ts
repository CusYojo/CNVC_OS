import assert from 'node:assert/strict'
import test from 'node:test'
import type { UserRecord } from '../src/repositories/identityRepository.js'
import { resolveLoginIdentity } from '../src/security/loginIdentity.js'
import { LoginSchema } from '../src/schemas/login.js'
import { validateNewPassword } from '../src/security/passwordPolicy.js'

const user: UserRecord = { id: 'one', email: 'person@example.invalid', name: '测试用户', role: '投资经理', department: '投资部', status: '启用', passwordHash: 'not-a-real-hash', lastLogin: null, createdAt: new Date(0) }

test('login accepts trimmed names and retains legacy email API clients', () => {
  assert.deepEqual(LoginSchema.parse({ identifier: ' 测试用户 ', password: '123456' }), { identifier: '测试用户', password: '123456', remember: false })
  assert.equal(LoginSchema.parse({ email: 'person@example.invalid', password: 'x' }).identifier, 'person@example.invalid')
  assert.equal(LoginSchema.parse({ identifier: '测试用户', password: 'x', remember: true }).remember, true)
})

test('login rejects empty, conflicting and overlong identities without changing password whitespace', () => {
  for (const input of [{}, { identifier: ' ' }, { email: 'not-email' }, { identifier: 'x'.repeat(256) }, { identifier: '测试用户', email: 'person@example.invalid' }]) assert.equal(LoginSchema.safeParse({ password: 'x', ...input }).success, false)
  assert.equal(LoginSchema.safeParse({ identifier: '测试用户', password: 'x'.repeat(129) }).success, false)
  assert.equal(LoginSchema.parse({ identifier: '测试用户', password: ' x ' }).password, ' x ')
})

test('name login resolves one exact repository match with a bounded ambiguity query', async () => {
  const result = await resolveLoginIdentity(' 测试用户 ', {
    findByEmail: async () => { throw new Error('must not search email') },
    findByTrimmedName: async (name, limit) => { assert.equal(name, '测试用户'); assert.equal(limit, 2); return [user] },
  })
  assert.equal(result?.id, user.id)
})

test('email login normalizes email and never falls back to a same-text display name', async () => {
  let calls = 0
  assert.equal(await resolveLoginIdentity(' PERSON@EXAMPLE.INVALID ', {
    findByEmail: async email => { calls++; assert.equal(email, user.email); return null },
    findByTrimmedName: async () => { throw new Error('must not use display name fallback') },
  }), null)
  assert.equal(calls, 1)
})

test('duplicate names fail closed even when one namesake is disabled', async () => {
  await assert.rejects(resolveLoginIdentity(user.name, {
    findByEmail: async () => null,
    findByTrimmedName: async () => [user, { ...user, id: 'two', status: '禁用' }],
  }), { code: 'AUTH_AMBIGUOUS_NAME' })
})

test('missing names stay missing and disabled status is preserved for authService rejection', async () => {
  assert.equal(await resolveLoginIdentity('不存在', { findByEmail: async () => null, findByTrimmedName: async () => [] }), null)
  const disabled = await resolveLoginIdentity(user.name, { findByEmail: async () => null, findByTrimmedName: async () => [{ ...user, status: '禁用' }] })
  assert.equal(disabled?.status, '禁用')
})

test('daily password policy still rejects the user-requested weak import password', () => {
  assert.ok(validateNewPassword('123456', { email: user.email, name: user.name }).length > 0)
})
