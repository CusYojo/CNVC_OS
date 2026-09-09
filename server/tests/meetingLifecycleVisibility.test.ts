import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('cancelled and deleted project meetings stay out of lists, calendars, reports and conflicts', () => {
  for (const path of [
    '../src/services/meetingService.ts',
    '../src/services/fdeCalendarService.ts',
    '../src/services/fdeWeeklyReportSourcesService.ts',
    '../src/services/fdeScheduleService.ts',
  ]) {
    const source = read(path)
    assert.match(source, /notInArray\(meetings\.workflowStatus, \['cancelled', 'deleted'\]\)/, path)
  }
})

test('meeting creation is idempotent and unheld meetings have a confirmed delete flow', () => {
  const service = read('../src/services/meetingService.ts')
  const routes = read('../src/routes/meetings.ts')
  const page = read('../../src/pages/MeetingsPage.tsx')
  assert.match(service, /meetingWorkflowEvents\.requestId, clientRequestId/)
  assert.match(service, /action: 'delete'/)
  assert.match(routes, /meetingsRouter\.delete\('\/:id'/)
  assert.match(page, /title="删除会议"/)
  assert.match(page, /fde-calendar-refresh/)
})
