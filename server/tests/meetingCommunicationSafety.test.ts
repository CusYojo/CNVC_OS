import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertMeetingMutation } from '../src/contracts/meetingMutationContract.js'
import { meetingSelection, updateMeetingDraft, clearSentMeetingDraft, hasUnreadDirective, acknowledgeNotice } from '../../src/lib/meetingWorkspace.js'

const meeting = { workflowKind: 'legacy', workflowStatus: 'scheduled', confirmedAt: null, createdBy: 'host', hostUserId: 'host', version: 3, startedAt: new Date('2026-10-01T08:00:00Z'), endsAt: new Date('2026-10-01T09:00:00Z') }
const code = (operation: () => unknown, expected: string) => assert.throws(operation, (error: unknown) => (error as { code: string }).code === expected)

test('meeting edits require an explicit manager identity and current version', () => {
  code(() => assertMeetingMutation(meeting, 'member', 3, 'edit'), 'MEETING_MANAGE_FORBIDDEN')
  code(() => assertMeetingMutation(meeting, undefined, 3, 'edit'), 'MEETING_MANAGE_FORBIDDEN')
  code(() => assertMeetingMutation(meeting, 'host', 2, 'edit'), 'VERSION_CONFLICT')
  code(() => assertMeetingMutation(meeting, 'host', undefined, 'edit'), 'VERSION_CONFLICT')
  assert.doesNotThrow(() => assertMeetingMutation(meeting, 'host', 3, 'edit'))
})

test('deleted and cancelled meetings cannot be revived or receive contributions', () => {
  for (const action of ['edit', 'contribute', 'start', 'end', 'finalize'] as const) {
    code(() => assertMeetingMutation({ ...meeting, workflowStatus: 'deleted' }, 'host', 3, action), 'MEETING_NOT_FOUND')
    code(() => assertMeetingMutation({ ...meeting, workflowStatus: 'cancelled' }, 'host', 3, action), 'MEETING_LIFECYCLE_INVALID')
  }
  code(() => assertMeetingMutation({ ...meeting, confirmedAt: new Date() }, 'host', 3, 'edit'), 'MEETING_MINUTES_IMMUTABLE')
  code(() => assertMeetingMutation({ ...meeting, workflowKind: 'friday' }, 'host', 3, 'edit'), 'FDE_MEETING_WORKFLOW_REQUIRED')
  assert.doesNotThrow(() => assertMeetingMutation({ ...meeting, workflowStatus: 'cancelled' }, 'host', 3, 'delete'))
})

test('meeting lifecycle only permits valid transitions', () => {
  const before = new Date('2026-10-01T07:00:00Z').getTime()
  const after = new Date('2026-10-01T10:00:00Z').getTime()
  code(() => assertMeetingMutation(meeting, 'host', 3, 'end', before), 'MEETING_NOT_STARTED')
  code(() => assertMeetingMutation(meeting, 'host', 3, 'finalize', before), 'MEETING_NOT_ENDED')
  code(() => assertMeetingMutation({ ...meeting, workflowStatus: 'completed' }, 'host', 3, 'start'), 'MEETING_LIFECYCLE_INVALID')
  assert.doesNotThrow(() => assertMeetingMutation(meeting, 'host', 3, 'start', before))
  assert.doesNotThrow(() => assertMeetingMutation(meeting, 'host', 3, 'end', after))
  assert.doesNotThrow(() => assertMeetingMutation(meeting, 'host', 3, 'finalize', after))
})

test('explicit meeting URLs never silently fall back to another meeting', () => {
  const list = [{ id: 'a' }, { id: 'b' }]
  assert.equal(meetingSelection(list, 'b')?.id, 'b')
  assert.equal(meetingSelection(list, 'missing'), undefined)
  assert.equal(meetingSelection(list, null)?.id, 'a')
  assert.equal(meetingSelection([], null), undefined)
})

test('meeting drafts and attachments remain isolated, including late submission success', () => {
  const a = { text: 'A only', files: [{ name: 'a.pdf' }] }
  const first = updateMeetingDraft({}, 'a', a)
  const second = updateMeetingDraft(first, 'b', { text: 'B only', files: [] })
  assert.deepEqual(second.a, a)
  assert.equal(second.b.text, 'B only')
  assert.deepEqual(clearSentMeetingDraft(second, 'a', a), { b: second.b })
  const edited = updateMeetingDraft(second, 'a', { ...a, text: 'A newer' })
  assert.equal(clearSentMeetingDraft(edited, 'a', a).a.text, 'A newer')
})

test('terminal directive updates stay unread; failed reads do not clear messages', async () => {
  for (const status of ['未开始', '已完成', '已取消', '已关闭', '已归档']) assert.equal(hasUnreadDirective({ directiveId: 'd', directiveNoticeId: 'n', status }), true)
  assert.equal(hasUnreadDirective({ directiveId: 'd', directiveNoticeId: null }), false)
  let cleared = 0
  await assert.rejects(acknowledgeNotice(async () => { throw new Error('offline') }, () => { cleared += 1 }))
  assert.equal(cleared, 0)
  await acknowledgeNotice(async () => {}, () => { cleared += 1 })
  assert.equal(cleared, 1)
})

test('meeting handlers wire access, state and route guards into actual callers', () => {
  const source = readFileSync(new URL('../src/services/meetingService.ts', import.meta.url), 'utf8')
  const routes = readFileSync(new URL('../src/routes/meetings.ts', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../../src/pages/MeetingsPage.tsx', import.meta.url), 'utf8')
  assert.match(routes, /updateMeeting\(existing\.id, patch, expectedVersion, req\.user!\.uid\)/)
  assert.match(source, /async function lockWritableMeeting/)
  assert.match(source, /projectAccessCondition\(\{ uid: actor\.id, name: actor\.name, role: actor\.role \}\)/)
  assert.match(page, /apiGet<Meeting>\(`\/meetings\/\$\{encodeURIComponent\(requestedMeetingId\)\}`\)/)
  assert.match(page, /clearSentMeetingDraft/)
})

test('message center excludes stale project approvals without suppressing office entries', () => {
  const layout = readFileSync(new URL('../../src/layout/AppLayout.tsx', import.meta.url), 'utf8')
  assert.match(layout, /request\.actionBlockedReason \|\| request\.projectLifecycle && request\.projectLifecycle !== 'active'/)
})
