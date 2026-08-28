import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { typePolicyFixture } from '../src/scripts/fdeTypePolicyFixture.js'
import { beginRegistrationRecheck, editRegistrationDraft, emptyRegistrationDraft, initialRegistrationDraft, invalidateRegistrationDraft, readRegistrationRecheck, settleRegistrationRecheck } from '../../src/lib/fdeTypeRegistrationDraft.js'

// Synthetic rules and identities for pure state tests only; not approved business configuration.
function fixture() {
  const uid = randomUUID(), policy = { policyId: randomUUID(), versionId: randomUUID(), policyVersion: 4, sha256: 'a'.repeat(64), name: '合成登记模板', configuration: typePolicyFixture() }
  const options = { policies: [policy] }, initial = beginRegistrationRecheck(initialRegistrationDraft(uid))
  const ready = settleRegistrationRecheck(initial, initial.generation, { actorId: uid, options })
  const state = editRegistrationDraft(ready, { open: true, selected: policy.policyId, name: '合成未提交项目', targetDate: '2026-10-30', cycleDays: 15, reason: '合成未提交理由，无真实业务数据', ack: true })
  return { uid, policy, options, state }
}

test('focus recheck locks immediately without destroying the in-memory draft', () => {
  const { state } = fixture(), checking = beginRegistrationRecheck(state)
  assert.equal(checking.phase, 'checking'); assert.strictEqual(checking.draft, state.draft)
  assert.strictEqual(editRegistrationDraft(checking, { name: '不可编辑', ack: true }), checking)
})
test('unchanged account, permission and exact template restore every draft field and open state', () => {
  const { state, uid, options } = fixture(), checking = beginRegistrationRecheck(state)
  const result = settleRegistrationRecheck(checking, checking.generation, { actorId: uid, options: structuredClone(options) })
  assert.equal(result.phase, 'ready'); assert.equal(result.error, '')
  assert.deepEqual(result.draft, state.draft); assert.equal(result.draft.ack, true)
})
test('closed modal stays closed while its unchanged draft is preserved', () => {
  const { state, uid, options } = fixture(), closed = editRegistrationDraft(state, { open: false }), checking = beginRegistrationRecheck(closed)
  assert.deepEqual(settleRegistrationRecheck(checking, checking.generation, { actorId: uid, options }).draft, closed.draft)
})
test('unselected draft remains unselected; refreshed policies never auto-select a new template', () => {
  const { state, uid, options } = fixture(), unselected = editRegistrationDraft(state, { selected: '', ack: false }), checking = beginRegistrationRecheck(unselected)
  assert.deepEqual(settleRegistrationRecheck(checking, checking.generation, { actorId: uid, options }).draft, unselected.draft)
})
test('revoked or disabled selected template clears all fields, including date, cycle and acknowledgment', () => {
  const { state, uid } = fixture(), checking = beginRegistrationRecheck(state)
  const result = settleRegistrationRecheck(checking, checking.generation, { actorId: uid, options: { policies: [] } })
  assert.deepEqual(result.draft, emptyRegistrationDraft()); assert.deepEqual(result.options, { policies: [] })
  assert.match(result.error, /停用|权限/)
})
for (const field of ['versionId', 'policyVersion', 'sha256', 'configuration'] as const) {
  test(`changed ${field} discards the old draft even if policyId is unchanged`, () => {
    const { state, uid, options } = fixture(), fresh = structuredClone(options), checking = beginRegistrationRecheck(state)
    switch (field) {
      case 'versionId': fresh.policies[0].versionId = randomUUID(); break
      case 'policyVersion': fresh.policies[0].policyVersion++; break
      case 'sha256': fresh.policies[0].sha256 = 'b'.repeat(64); break
      case 'configuration': fresh.policies[0].configuration.cycleDays = [30]; break
    }
    const result = settleRegistrationRecheck(checking, checking.generation, { actorId: uid, options: fresh })
    assert.deepEqual(result.draft, emptyRegistrationDraft()); assert.match(result.error, /精确版本已变化/)
    assert.deepEqual(result.options, fresh)
  })
}
test('a replacement authorized template cannot inherit a revoked template draft', () => {
  const { state, uid, options } = fixture(), replacement = structuredClone(options), checking = beginRegistrationRecheck(state)
  replacement.policies[0].policyId = randomUUID()
  const result = settleRegistrationRecheck(checking, checking.generation, { actorId: uid, options: replacement })
  assert.deepEqual(result.draft, emptyRegistrationDraft()); assert.equal(result.phase, 'ready')
})
test('account change or expired session removes options and draft and blocks registration', () => {
  for (const actorId of [randomUUID(), '']) {
    const { state, options } = fixture(), checking = beginRegistrationRecheck(state)
    const result = settleRegistrationRecheck(checking, checking.generation, { actorId, options })
    assert.equal(result.phase, 'blocked'); assert.equal(result.options, null); assert.match(result.error, /账号已变化或失效/)
    assert.deepEqual(result.draft, emptyRegistrationDraft()); assert.strictEqual(editRegistrationDraft(result, { ack: true }), result)
  }
})
test('refresh failures clear protected state and later success never resurrects it', () => {
  const { state, uid, options } = fixture(), checking = beginRegistrationRecheck(state)
  const failed = settleRegistrationRecheck(checking, checking.generation, { error: 'synthetic 503' })
  assert.equal(failed.phase, 'blocked'); assert.equal(failed.options, null); assert.match(failed.error, /核对失败.*草稿已清理.*503/)
  assert.deepEqual(failed.draft, emptyRegistrationDraft())
  const retry = beginRegistrationRecheck(failed)
  assert.deepEqual(settleRegistrationRecheck(retry, retry.generation, { actorId: uid, options }).draft, emptyRegistrationDraft())
})
test('overlapping focus requests ignore stale success and stale failure responses', () => {
  const { state, uid, options } = fixture(), first = beginRegistrationRecheck(state), second = beginRegistrationRecheck(first)
  assert.strictEqual(settleRegistrationRecheck(second, first.generation, { actorId: uid, options }), second)
  const final = settleRegistrationRecheck(second, second.generation, { error: 'newest failure' })
  assert.strictEqual(settleRegistrationRecheck(final, first.generation, { actorId: uid, options }), final)
  assert.strictEqual(settleRegistrationRecheck(final, first.generation, { error: 'older failure' }), final)
})
test('unmount/StrictMode cleanup clears sensitive memory and invalidates pre-cleanup requests', () => {
  const { state, uid, options } = fixture(), before = beginRegistrationRecheck(state), disposed = invalidateRegistrationDraft(before), remount = beginRegistrationRecheck(disposed)
  assert.deepEqual(disposed.draft, emptyRegistrationDraft()); assert.equal(disposed.options, null)
  assert.ok(remount.generation > before.generation)
  assert.strictEqual(settleRegistrationRecheck(remount, before.generation, { actorId: uid, options }), remount)
})
test('recheck read sequence always authenticates before and after fresh server options', async () => {
  const { uid, options } = fixture(), paths: string[] = []
  const result = await readRegistrationRecheck(uid, async path => { paths.push(path); return path === '/auth/me' ? { user: { id: uid } } : options })
  assert.deepEqual(paths, ['/auth/me', '/fde-type-registration/options', '/auth/me']); assert.equal(result.actorId, uid)
  assert.deepEqual(result.options, options)
})
test('first account mismatch never fetches protected options', async () => {
  const { uid } = fixture(), other = randomUUID(), paths: string[] = []
  const result = await readRegistrationRecheck(uid, async path => { paths.push(path); return { user: { id: other } } })
  assert.deepEqual(paths, ['/auth/me']); assert.equal(result.actorId, other); assert.deepEqual(result.options, { policies: [] })
})
test('account switch during options fetch discards the returned options', async () => {
  const { uid, options } = fixture(), other = randomUUID(); let request = 0
  const result = await readRegistrationRecheck(uid, async () => [ { user: { id: uid } }, options, { user: { id: other } } ][request++])
  assert.equal(result.actorId, other); assert.deepEqual(result.options, { policies: [] })
})
test('authentication, options transport and malformed response failures reject the recheck', async () => {
  const { uid, options } = fixture()
  for (const index of [0, 1, 2]) {
    let request = 0
    await assert.rejects(readRegistrationRecheck(uid, async path => { if (request++ === index) throw new Error(`synthetic failure ${index}`); return path === '/auth/me' ? { user: { id: uid } } : options }), /synthetic failure/)
  }
  await assert.rejects(readRegistrationRecheck(uid, async () => ({ user: {} })))
  await assert.rejects(readRegistrationRecheck(uid, async path => path === '/auth/me' ? { user: { id: uid } } : { policies: [{ invalid: true }] }))
})
test('draft module remains memory-only and panel fetches uncached auth/options with synchronous submit guard', () => {
  const helper = readFileSync(new URL('../../src/lib/fdeTypeRegistrationDraft.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(helper, /localStorage|sessionStorage|indexedDB/)
  const panel = readFileSync(new URL('../../src/components/FdeTypeRegistrationPanel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /cache: 'no-store'/); assert.match(panel, /snapshot.phase !== 'ready'/)
  assert.match(panel, /open=\{open && view.phase === 'ready'\}/)
})
