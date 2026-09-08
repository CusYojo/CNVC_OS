import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkAiExperienceOutput } from '../src/services/aiExperienceOutputCheck.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'
const snapshot = { schemaVersion: 1, taskType: 'chat', businessProjectId: null,
  loaded: [{ versionId: 'version', experienceId: 'experience', contentHash: 'hash', rule: '区分计划与已完成融资', exceptions: [] }], excluded: [] }
const output = '融资计划：拟融资一亿元。已完成融资：尚无证据。'
const check = { versionId: 'version', verdict: 'PASS', explanation: '分别列出融资计划和已完成融资', excerpts: ['融资计划：拟融资一亿元。', '已完成融资：尚无证据。'] }
const input = { snapshot, snapshotHash: evolutionContentHash(snapshot), output, checkerVersion: 'reviewer-v1', assertAuthorized: async () => {} }

test('adherence binds the exact output and frozen versions and never edits the source snapshot', async () => {
  const result = await checkAiExperienceOutput({ ...input, assess: async ({ rules }) => { rules[0].rule = 'mutation'; return [check] } })
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.outputHash, evolutionContentHash({ output }))
  assert.equal(snapshot.loaded[0].rule, '区分计划与已完成融资')
  assert.equal(result.snapshotHash, input.snapshotHash)
})

test('missing rules, fabricated excerpts and skipped checks cannot produce PASS', async () => {
  for (const checks of [[], [check, check], [{ ...check, versionId: 'other' }], [{ ...check, excerpts: [] }], [{ ...check, excerpts: ['已完成一亿元融资'] }]]) {
    await assert.rejects(checkAiExperienceOutput({ ...input, assess: async () => checks }), { code: 'EVOLUTION_OUTPUT_CHECK_EVIDENCE' })
  }
  const skipped = await checkAiExperienceOutput({ ...input, assess: async () => [{ ...check, verdict: 'SKIPPED', excerpts: [] }] })
  assert.equal(skipped.verdict, 'BLOCKED')
  const failed = await checkAiExperienceOutput({ ...input, assess: async () => [{ ...check, verdict: 'FAIL', excerpts: [] }] })
  assert.equal(failed.verdict, 'FAIL')
})

test('no loaded rules remains NOT_RUN; revocation or cancellation prevents accepting the check', async () => {
  const empty = { ...snapshot, loaded: [] }
  assert.equal((await checkAiExperienceOutput({ ...input, snapshot: empty, snapshotHash: evolutionContentHash(empty), assess: async () => assert.fail('no model call') })).verdict, 'NOT_RUN')
  const controller = new AbortController()
  await assert.rejects(checkAiExperienceOutput({ ...input, signal: controller.signal, assess: async () => { controller.abort(Error('cancelled')); return [check] } }), /cancelled/)
  let authorized = true
  await assert.rejects(checkAiExperienceOutput({ ...input, assertAuthorized: async () => { if (!authorized) throw Error('revoked') }, assess: async () => { authorized = false; return [check] } }), /revoked/)
})
