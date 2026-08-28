import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { responsibilityCommand, responsibilityCountedPoints, responsibilityDeadline, responsibilityQuery, responsibilityReviewPoints } from '../src/contracts/fdeResponsibilityContract.js'

test('responsibility commands reject invented scores, actor identities and automatic proposals', () => {
  const body = { commandId: randomUUID(), action: 'propose', reason: '真实来源需要独立责任确认', taskId: randomUUID(), expectedTaskVersion: 1, eventCode: 'major_risk', sourceId: randomUUID(), relatedSourceId: null, evidence: [{ fileId: randomUUID(), version: 1 }] }
  assert.equal(responsibilityCommand.parse(body).action, 'propose')
  for (const change of [{ points: 8 }, { actorId: randomUUID() }, { eventCode: 'on_time' }, { evidence: [] }, { reason: ' ' }, { expectedTaskVersion: 0 }]) assert.throws(() => responsibilityCommand.parse({ ...body, ...change }))
})
test('responsibility date-only uses current task end-of-day contract in Shanghai', () => {
  assert.equal(responsibilityDeadline('2026-08-27', null).toISOString(), '2026-08-27T15:59:59.999Z')
  assert.equal(responsibilityDeadline('2026-08-27', '18:00').toISOString(), '2026-08-27T10:00:00.000Z')
  assert.throws(() => responsibilityDeadline('2026-02-30', null))
})
test('pending and revoked projections never silently count as final scores', () => {
  const excluded = { appealAggregation: 'exclude_pending' as const }, retained = { appealAggregation: 'retain_pending' as const }
  for (const status of ['pending_confirmation', 'revoked', 'exempted']) assert.equal(responsibilityCountedPoints(status, -4, retained), 0)
  assert.equal(responsibilityCountedPoints('appealing', -4, excluded), 0)
  assert.equal(responsibilityCountedPoints('appealing', -4, retained), -4)
  assert.equal(responsibilityCountedPoints('effective', 2, excluded), 2)
})
test('review does not worsen negative responsibility or turn it into a reward', () => {
  const allowed = { allowAdjustment: true, allowExemption: true }, denied = { allowAdjustment: false, allowExemption: false }
  assert.equal(responsibilityReviewPoints(-5, -5, 'adjust', -2, allowed), -2)
  assert.equal(responsibilityReviewPoints(-5, -5, 'uphold', null, denied), -5)
  assert.equal(responsibilityReviewPoints(-5, -5, 'revoke', null, denied), 0)
  assert.equal(responsibilityReviewPoints(-5, -5, 'exempt', null, allowed), 0)
  for (const points of [-6, 1, 0.5, null]) assert.throws(() => responsibilityReviewPoints(-5, -5, 'adjust', points, allowed))
  assert.throws(() => responsibilityReviewPoints(-5, -5, 'adjust', -2, denied))
  assert.throws(() => responsibilityReviewPoints(-5, -5, 'exempt', null, denied))
  assert.throws(() => responsibilityReviewPoints(-5, -5, 'revoke', 0, allowed))
})
test('queries are bounded and only expose explicit authorized views', () => {
  assert.deepEqual(responsibilityQuery.parse({}), { view: 'mine', page: 1, pageSize: 20 })
  assert.equal(responsibilityQuery.parse({ view: 'assignment' }).view, 'assignment')
  for (const query of [{ view: 'all' }, { pageSize: 51 }, { page: 0 }, { page: 1.5 }, { userId: randomUUID() }]) assert.throws(() => responsibilityQuery.parse(query))
})
test('reroute never accepts a client-selected reviewer or changes responsibility', () => {
  const body = { commandId: randomUUID(), action: 'reroute', reason: '请求系统核对当前独立处理人', recordId: randomUUID(), expectedVersion: 1 }
  assert.equal(responsibilityCommand.parse(body).action, 'reroute')
  for (const fields of [{ reviewerId: randomUUID() }, { subjectId: randomUUID() }, { effectivePoints: 0 }, { decision: 'confirm' }, { expectedVersion: 0 }]) assert.throws(() => responsibilityCommand.parse({ ...body, ...fields }))
})
