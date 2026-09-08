import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AiExperienceApplicationService } from '../src/services/aiExperienceApplicationService.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'
import type { MySqlAiExperienceRepository } from '../src/repositories/mysql/mysqlAiExperienceRepository.js'

test('application reads authorize frozen versions and keep loaded separate from checked', async () => {
  const snapshot = { schemaVersion: 1, taskType: 'chat', businessProjectId: null,
    loaded: [{ versionId: 'version', experienceId: 'experience', contentHash: 'hash', rule: '保留来源', exceptions: [] }], excluded: [] }
  const row = { id: 'application', taskType: 'chat', businessProjectId: null, conversationId: null,
    snapshot, snapshotHash: evolutionContentHash(snapshot), checkStatus: 'not_checked', checkResult: null }
  const repository = { findApplication: async () => row } as unknown as Pick<MySqlAiExperienceRepository, 'findApplication' | 'recordApplication'>
  const service = new AiExperienceApplicationService(repository, async () => [])
  const context = { userId: 'user', taskId: 'task', taskType: 'chat' }
  const value = await service.read(context, async (id, hash) => { assert.equal(id, 'version'); assert.equal(hash, 'hash') })
  assert.equal(value?.snapshot.loaded.length, 1)
  assert.equal(value?.checkStatus, 'not_checked')
  assert.equal(value?.checkResult, null)
  assert.equal('ownerUserId' in value!, false)
  await assert.rejects(service.read(context, async () => { throw Error('source revoked') }), /source revoked/)
  row.checkStatus = 'PASS'
  await assert.rejects(service.read(context, async () => {}), { code: 'EVOLUTION_APPLICATION_CORRUPT' })
})

test('a matching hash does not authorize malformed or cross-scope snapshot content', async () => {
  const loaded = { versionId: 'version', experienceId: 'experience', contentHash: 'hash', rule: '保留来源', exceptions: [] }
  const valid = { schemaVersion: 1, taskType: 'chat', businessProjectId: null, loaded: [loaded], excluded: [] }
  for (const snapshot of [
    { ...valid, taskType: 'report' },
    { ...valid, businessProjectId: 'other-project' },
    { ...valid, loaded: [{ ...loaded, rule: { command: 'untrusted' } }] },
    { ...valid, loaded: [{ ...loaded, systemInstruction: 'untrusted' }] },
    { ...valid, loaded: [loaded, loaded] },
    { ...valid, excluded: [{ experienceId: 'revoked', reason: 'source_access_revoked', rule: 'private content' }] },
  ]) {
    const repository = { findApplication: async () => ({ id: 'application', taskType: 'chat', businessProjectId: null,
      conversationId: null, snapshot, snapshotHash: evolutionContentHash(snapshot) })
    } as unknown as Pick<MySqlAiExperienceRepository, 'findApplication' | 'recordApplication'>
    const service = new AiExperienceApplicationService(repository, async () => { throw Error('must not reload') })
    await assert.rejects(service.freeze({ userId: 'user', taskId: 'task', taskType: 'chat' }), { code: 'EVOLUTION_APPLICATION_CORRUPT' })
  }
})

test('a new task persists the source-revocation explanation with no rule in its prompt', async () => {
  let recorded: Record<string, unknown> | undefined
  const repository = {
    findApplication: async () => null,
    recordApplication: async (input: { snapshot: Record<string, unknown> }) => {
      recorded = input.snapshot
      return { id: 'application', taskType: 'chat', conversationId: null, businessProjectId: null,
        snapshot: input.snapshot, snapshotHash: evolutionContentHash(input.snapshot) }
    },
  } as unknown as Pick<MySqlAiExperienceRepository, 'findApplication' | 'recordApplication'>
  const service = new AiExperienceApplicationService(repository, async () => [{ access: 'revoked', experienceId: 'owned-rule' }])
  const result = await service.freeze({ userId: 'user', taskId: 'task', taskType: 'chat' })
  assert.deepEqual(recorded?.excluded, [{ experienceId: 'owned-rule', reason: 'source_access_revoked' }])
  assert.deepEqual(result.snapshot.loaded, [])
  assert.equal(result.prompt, '')
  assert.equal(result.hash, evolutionContentHash(recorded))
})

test('new retry task records its own application with the original frozen rules', async () => {
  const snapshot = { schemaVersion: 1, taskType: 'report', businessProjectId: 'project', loaded: [{ versionId: 'original', experienceId: 'experience', contentHash: 'hash', rule: '保留来源', exceptions: [] }], excluded: [] }
  const parent = { id: 'parent-application', taskType: 'report', businessProjectId: 'project', conversationId: null, snapshot, snapshotHash: evolutionContentHash(snapshot) }
  let recordedTask = ''
  const repository = {
    findApplication: async (_userId: string, taskId: string) => taskId === 'parent' ? parent : null,
    recordApplication: async (input: { taskId: string; snapshot: Record<string, unknown> }) => {
      recordedTask = input.taskId
      assert.deepEqual(input.snapshot, snapshot)
      return { ...parent, id: 'retry-application', snapshot: input.snapshot }
    },
  } as unknown as Pick<MySqlAiExperienceRepository, 'findApplication' | 'recordApplication'>
  const service = new AiExperienceApplicationService(repository, async () => { throw Error('retry must not load changed rules') })
  const result = await service.freeze({ userId: 'user', taskId: 'retry', taskType: 'report', businessProjectId: 'project' }, 8000, 'parent')
  assert.equal(recordedTask, 'retry')
  assert.equal(result.id, 'retry-application')
  assert.equal(result.hash, parent.snapshotHash)
})

test('retry retains the frozen task snapshot and rejects reuse in another context', async () => {
  const snapshot = { schemaVersion: 1, taskType: 'chat', businessProjectId: null, loaded: [{ versionId: 'old', experienceId: 'experience', contentHash: 'hash', rule: '保留来源', exceptions: [] }], excluded: [] }
  const row = { id: 'application', taskType: 'chat', businessProjectId: null, conversationId: 'conversation', snapshot, snapshotHash: evolutionContentHash(snapshot) }
  let loads = 0
  const repository = {
    findApplication: async () => row,
    recordApplication: async () => { throw Error('must not overwrite') },
  } as unknown as Pick<MySqlAiExperienceRepository, 'findApplication' | 'recordApplication'>
  const service = new AiExperienceApplicationService(repository, async () => { loads++; return [] })
  const context = { userId: 'user', taskId: 'task', taskType: 'chat', conversationId: 'conversation' }
  assert.match((await service.freeze(context)).prompt, /保留来源/)
  assert.equal(loads, 0)
  await assert.rejects(service.freeze({ ...context, conversationId: 'other' }), { code: 'EVOLUTION_APPLICATION_CONTEXT_CONFLICT' })
  row.snapshotHash = 'tampered'
  await assert.rejects(service.freeze(context), { code: 'EVOLUTION_APPLICATION_CORRUPT' })
})
