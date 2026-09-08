import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AiEvolutionSkillRegistry, parseEvolutionSkillRegistry } from '../src/services/aiEvolutionSkillRegistry.js'

const userId = '00000000-0000-4000-8000-000000000001'
const capabilityId = '00000000-0000-4000-8000-000000000002'
function fixture() {
  const actor = { id: userId, role: 'AI平台管理员', status: '启用' }
  const capability = { id: capabilityId, kind: 'skill', capabilityKey: 'draft-due-diligence-report',
    source: 'builtin', version: 2, enabled: true, allowedRoles: [] as string[] }
  const config = { schemaVersion: 1, capabilities: [{ capabilityId, capabilityKey: capability.capabilityKey,
    source: 'builtin', capabilityRevision: 2, grantRevision: 1, allowedUserIds: [userId] }] }
  const registry = new AiEvolutionSkillRegistry({ load: async () => config,
    actor: async () => actor, capability: async () => capability })
  return { actor, capability, config, registry }
}

test('skill execution requires explicit capability grants and observes revocation without restart', async () => {
  const { registry, config } = fixture()
  const authorization = await registry.resolve(userId, capabilityId)
  assert.equal(authorization.capabilityRevision, 2)
  assert.equal(authorization.grantRevision, 1)
  assert.match(authorization.authorizationHash, /^[a-f0-9]{64}$/)
  assert.equal('allowedUserIds' in authorization, false)
  config.capabilities[0].grantRevision++
  assert.notEqual((await registry.resolve(userId, capabilityId)).authorizationHash, authorization.authorizationHash)
  config.capabilities[0].allowedUserIds = []
  assert.equal(await registry.canManage(userId, capabilityId), false)
  config.capabilities = []
  assert.equal(await registry.canManage(userId, capabilityId), false)
})

test('admin status cannot bypass changed or disabled capability identity and role restrictions', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.actor.role = '投资经理' },
    (f: ReturnType<typeof fixture>) => { f.actor.status = '停用' },
    (f: ReturnType<typeof fixture>) => { f.actor.id = capabilityId },
    (f: ReturnType<typeof fixture>) => { f.capability.id = userId },
    (f: ReturnType<typeof fixture>) => { f.capability.kind = 'agent' },
    (f: ReturnType<typeof fixture>) => { f.capability.enabled = false },
    (f: ReturnType<typeof fixture>) => { f.capability.version++ },
    (f: ReturnType<typeof fixture>) => { f.capability.source = 'uploaded' },
    (f: ReturnType<typeof fixture>) => { f.capability.capabilityKey = 'another-skill' },
    (f: ReturnType<typeof fixture>) => { f.capability.allowedRoles = ['系统管理员'] },
  ]) {
    const f = fixture()
    change(f)
    assert.equal(await f.registry.canManage(userId, capabilityId), false)
  }
  const f = fixture()
  f.actor.role = '系统管理员'
  f.config.capabilities[0].allowedUserIds = []
  assert.equal(await f.registry.canManage(userId, capabilityId), false)
})

test('malformed grants fail closed and backend failures are not disguised as missing access', async () => {
  const { config } = fixture()
  assert.throws(() => parseEvolutionSkillRegistry({ ...config, publish: true }))
  assert.throws(() => parseEvolutionSkillRegistry({ ...config, capabilities: [config.capabilities[0], config.capabilities[0]] }))
  assert.throws(() => parseEvolutionSkillRegistry({ ...config, capabilities: [{ ...config.capabilities[0], allowedUserIds: [userId, userId] }] }))
  assert.throws(() => parseEvolutionSkillRegistry({ ...config, capabilities: [{ ...config.capabilities[0], capabilityKey: '../private' }] }))
  const registry = new AiEvolutionSkillRegistry({ load: async () => { throw Error('configuration unavailable') },
    actor: async () => ({ id: userId, role: '系统管理员', status: '启用' }), capability: async () => null })
  await assert.rejects(registry.canManage(userId, capabilityId), /configuration unavailable/)
})

test('publication needs a separate exact scope grant and observes its revocation', async () => {
  const f = fixture(), scope = { type: 'user' as const, key: userId }
  await assert.rejects(f.registry.resolvePublication(userId, capabilityId, scope), { code: 'EVOLUTION_RELEASE_FORBIDDEN' })
  const entry = f.config.capabilities[0] as typeof f.config.capabilities[number] & {
    publication?: { maxTrialSeconds: number; scopes: { type: 'user' | 'project'; key: string }[] }
  }
  entry.publication = { maxTrialSeconds: 3600, scopes: [scope] }
  assert.equal((await f.registry.resolvePublication(userId, capabilityId, scope)).maxTrialSeconds, 3600)
  await assert.rejects(f.registry.resolvePublication(userId, capabilityId, { type: 'project', key: userId }), { code: 'EVOLUTION_RELEASE_FORBIDDEN' })
  await assert.rejects(f.registry.resolvePublication(userId, capabilityId, { type: 'user', key: capabilityId }), { code: 'EVOLUTION_RELEASE_FORBIDDEN' })
  entry.publication.scopes.push(scope)
  assert.throws(() => parseEvolutionSkillRegistry(f.config), { code: 'EVOLUTION_SKILL_REGISTRY_INVALID' })
  delete entry.publication
  await assert.rejects(f.registry.resolvePublication(userId, capabilityId, scope), { code: 'EVOLUTION_RELEASE_FORBIDDEN' })
})
