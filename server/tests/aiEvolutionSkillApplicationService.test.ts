import test from 'node:test'
import assert from 'node:assert/strict'
import { createEvolutionSkillApplicationService } from '../src/services/aiEvolutionSkillApplicationService.js'

const user = '11111111-1111-4111-8111-111111111111'
const cap = '22222222-2222-4222-8222-222222222222'
const context = { ownerUserId: user, taskId: 'task', taskType: 'report', conversationId: null, businessProjectId: null }
const scopes = [{ type: 'user' as const, key: user }]
type Deps = Parameters<typeof createEvolutionSkillApplicationService>[0]
function fixture() {
  let saved: Awaited<ReturnType<Deps['applications']['read']>> = null
  let resolves = 0, reads = 0, denied = false
  const deps: Deps = {
    applications: {
      async read() { reads++; return saved },
      async freeze(_context, snapshot) {
        saved = { applicationId: user, snapshot: snapshot as NonNullable<typeof saved>['snapshot'], snapshotHash: 'a'.repeat(64), packages: [] }
        return {} as Awaited<ReturnType<Deps['applications']['freeze']>>
      },
    },
    bindings: { async resolveForScope() { resolves++; return null } },
    store: { async read() { throw Error('Unexpected artifact read') } },
    async authorizeContext() { if (denied) throw Error('revoked') },
    async authorizeSource() {},
  }
  return { deps, run: createEvolutionSkillApplicationService(deps), counts: () => ({ resolves, reads }), deny: () => { denied = true } }
}

test('empty selection is durable and recovery never resolves current bindings', async () => {
  const f = fixture()
  const first = await f.run(context, [cap], scopes)
  assert.deepEqual(first.snapshot.entries, [{ capabilityId: cap, status: 'unmatched', reason: 'no_binding' }])
  const second = await f.run(context, [cap], scopes)
  assert.equal(second.applicationId, first.applicationId)
  assert.equal(f.counts().resolves, 1)
  await assert.rejects(f.run(context, [], scopes), /能力集合已变化/)
})

test('context revocation and foreign scopes prevent repository access', async () => {
  const f = fixture()
  await assert.rejects(f.run(context, [cap], [{ type: 'project', key: user }]), /作用域/)
  assert.equal(f.counts().reads, 0)
  f.deny()
  await assert.rejects(f.run(context, [cap], scopes), /revoked/)
  assert.equal(f.counts().reads, 0)
})

test('returns persisted winner rather than locally selected snapshot', async () => {
  const f = fixture()
  const original = f.deps.applications.freeze
  f.deps.applications.freeze = async (ctx, snapshot) => {
    await original(ctx, snapshot)
    f.deps.applications.read = async () => ({ applicationId: cap, snapshot: { schemaVersion: 1,
      entries: [{ capabilityId: cap, status: 'unmatched', reason: 'no_binding' }] }, snapshotHash: 'b'.repeat(64), packages: [] })
    return {} as Awaited<ReturnType<Deps['applications']['freeze']>>
  }
  assert.equal((await f.run(context, [cap], scopes)).applicationId, cap)
})

test('authorized retry inherits original snapshot without resolving current bindings', async () => {
  const f = fixture()
  const records = new Map<string, NonNullable<Awaited<ReturnType<Deps['applications']['read']>>>>()
  records.set('original', { applicationId: user, snapshot: { schemaVersion: 1,
    entries: [{ capabilityId: cap, status: 'unmatched', reason: 'no_binding' }] }, snapshotHash: 'c'.repeat(64), packages: [] })
  f.deps.applications.read = async ctx => records.get(ctx.taskId) ?? null
  f.deps.applications.freeze = async (ctx, snapshot) => {
    records.set(ctx.taskId, { applicationId: cap, snapshot: snapshot as NonNullable<Awaited<ReturnType<Deps['applications']['read']>>>['snapshot'],
      snapshotHash: 'c'.repeat(64), packages: [] })
    return {} as Awaited<ReturnType<Deps['applications']['freeze']>>
  }
  let retryChecks = 0
  f.deps.authorizeRetry = async (current, original) => {
    assert.equal(current.taskId, 'task')
    assert.equal(original.taskId, 'original')
    retryChecks++
  }
  const result = await f.run(context, [cap], scopes, 'original')
  assert.deepEqual(result.snapshot, records.get('original')!.snapshot)
  assert.equal(f.counts().resolves, 0)
  assert.equal(retryChecks, 2)
})

test('retry without a relationship grant or original snapshot never selects a fresh version', async () => {
  const f = fixture()
  await assert.rejects(f.run(context, [cap], scopes, 'original'), /未经授权/)
  f.deps.authorizeRetry = async () => {}
  await assert.rejects(f.run(context, [cap], scopes, 'original'), /原任务技能快照不存在/)
  await assert.rejects(f.run(context, [cap], scopes, context.taskId), /未经授权/)
  assert.equal(f.counts().resolves, 0)
})
