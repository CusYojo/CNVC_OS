import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { approvalCenterQuery, approvalCenterReturnPath, approvalCenterViews, approvalCenterDetailPath, approvalNoticeReadPath } from '../src/contracts/fdeApprovalCenterContract.js'

test('type review links bind project and review, preserve only safe center filters, and never target legacy approval writes', () => {
  const id = randomUUID(), projectId = randomUUID(), row = { id, projectId, businessType: 'type_execution' }
  const url = new URL(approvalCenterDetailPath(row, 'view=processed&page=3&kind=非投资计划审核&q=核对&next=https://evil.invalid'), 'http://localhost')
  assert.equal(url.pathname, `/projects/${projectId}`); assert.equal(url.searchParams.get('typeReview'), id)
  assert.equal(url.searchParams.get('tab'), 'workflow'); assert.ok(!url.searchParams.get('center')!.includes('next'))
  assert.equal(new URLSearchParams(url.searchParams.get('center')!).get('page'), '3')
  assert.throws(() => approvalCenterDetailPath({ ...row, projectId: null }))
  assert.throws(() => approvalCenterDetailPath({ ...row, id: '../outside' }))
  assert.equal(approvalNoticeReadPath(row, id), `/oa/type-notices/${id}/read`)
  assert.equal(approvalNoticeReadPath({ businessType: 'office' }, id), `/oa/office/notices/${id}/read`)
  assert.ok(approvalCenterDetailPath({ id, businessType: 'project_stage' }).startsWith('/workflow?view=project&request='))
})

test('approval center accepts real project/OA types and normalizes optional filters', () => {
  assert.deepEqual(approvalCenterQuery.parse({}), { view: 'pending', page: 1, pageSize: 20, q: '' })
  assert.equal(approvalCenterQuery.parse({ kind: '' }).kind, undefined)
  for (const kind of ['立项审批', '任务延期', '出差', '用印', '报销', '请假', '合同']) {
    assert.equal(approvalCenterQuery.parse({ kind, page: '2', pageSize: '20' }).kind, kind)
  }
  assert.equal(approvalCenterViews.length, 6)
})

test('approval center rejects unbounded pagination and malformed filters', () => {
  for (const input of [{ page: 0 }, { page: 1.5 }, { page: 1_000_001 }, { pageSize: 101 }, { pageSize: 0 }, { kind: ['合同'] }, { q: 'x'.repeat(101) }, { view: 'everything' }, { userId: 'other' }]) {
    assert.equal(approvalCenterQuery.safeParse(input).success, false)
  }
  assert.equal(approvalCenterQuery.parse({ q: '  原件%_  ' }).q, '原件%_')
})

test('project detail returns to validated filters without open redirects or detail loops', () => {
  const path = approvalCenterReturnPath('view=mine&page=2&kind=任务延期&q=项目&request=private&next=https://example.invalid')
  const result = new URL(path, 'http://localhost')
  assert.equal(result.pathname, '/workflow'); assert.equal(result.searchParams.get('view'), 'mine')
  assert.equal(result.searchParams.get('page'), '2'); assert.equal(result.searchParams.get('kind'), '任务延期')
  assert.equal(result.searchParams.has('request'), false); assert.equal(result.searchParams.has('next'), false)
  assert.equal(approvalCenterReturnPath('view=project'), '/workflow')
  assert.equal(approvalCenterReturnPath('page=-1'), '/workflow')
})
