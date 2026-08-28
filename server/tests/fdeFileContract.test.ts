import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { fileLifecycleCommand, filePermissionCommand, fileWorkspaceQuery, normalizeFileGrants } from '../src/contracts/fdeFileContract.js'

test('download selects view, view never implicitly selects download', () => {
  const id = randomUUID()
  assert.deepEqual(normalizeFileGrants([{ userId: id, canView: false, canDownload: true }]), [{ userId: id, canView: true, canDownload: true }])
  assert.equal(normalizeFileGrants([{ userId: id, canView: true, canDownload: false }])[0].canDownload, false)
})
test('permission mutations require stable identity, unique grants, version, request and reason', () => {
  const payload = { clientRequestId: randomUUID(), expectedVersion: 1, reason: '审核当前文件授权', grants: [{ userId: randomUUID(), canView: true, canDownload: false }] }
  assert.equal(filePermissionCommand.parse(payload).expectedVersion, 1)
  for (const extra of [{ expectedVersion: 0 }, { reason: '' }, { actorId: randomUUID() }, { grants: [...payload.grants, ...payload.grants] }, { clientRequestId: 'name' }]) assert.equal(filePermissionCommand.safeParse({ ...payload, ...extra }).success, false)
})
test('lifecycle permits only soft trash and controlled restore', () => {
  const payload = { clientRequestId: randomUUID(), expectedVersion: 1, reason: '材料失效后移入回收站', action: 'trash' }
  assert.ok(fileLifecycleCommand.safeParse(payload).success)
  assert.ok(fileLifecycleCommand.safeParse({ ...payload, action: 'restore' }).success)
  assert.equal(fileLifecycleCommand.safeParse({ ...payload, action: 'purge' }).success, false)
})
test('workspace queries bound pagination and reject unknown hidden views', () => {
  assert.equal(fileWorkspaceQuery.parse({}).pageSize, 20)
  for (const input of [{ pageSize: 999 }, { page: 0 }, { view: 'all' }, { userId: randomUUID() }]) assert.equal(fileWorkspaceQuery.safeParse(input).success, false)
})
