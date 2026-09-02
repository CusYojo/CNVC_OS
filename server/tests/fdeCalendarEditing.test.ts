import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { calendarTaskCancelSchema, calendarTaskCreateSchema } from '../src/contracts/fdeTimeContract.js'

const source = (relativeUrl: string) => readFile(new URL(relativeUrl, import.meta.url), 'utf8')

test('calendar-created personal tasks require a valid 15-minute time range', () => {
  const valid = calendarTaskCreateSchema.safeParse({
    clientRequestId: '10000000-0000-4000-8000-000000000001',
    title: '整理项目材料', detail: '', startsAt: '2026-09-02T09:15', endsAt: '2026-09-02T10:30',
  })
  assert.equal(valid.success, true)
  assert.equal(calendarTaskCreateSchema.safeParse({ ...valid.data, startsAt: '2026-09-02T09:10' }).success, false)
  assert.equal(calendarTaskCreateSchema.safeParse({ ...valid.data, endsAt: '2026-09-02T09:00' }).success, false)
  assert.equal(calendarTaskCancelSchema.safeParse({
    clientRequestId: '10000000-0000-4000-8000-000000000002', expectedTaskVersion: 1, expectedScheduleVersion: 0, reason: '本人删除',
  }).success, true)
})

test('workbench and task center share the editable calendar interaction', async () => {
  const [dashboard, collaboration, panel, grid, routes, service] = await Promise.all([
    source('../../src/pages/DashboardPage.tsx'), source('../../src/pages/CollaborationPage.tsx'),
    source('../../src/components/FdeCalendarPanel.tsx'), source('../../src/components/FdeTimeGrid.tsx'),
    source('../src/routes/fdeTime.ts'), source('../src/services/fdeCalendarService.ts'),
  ])
  assert.match(dashboard, /<FdeCalendarPanel compact/)
  assert.match(collaboration, /<FdeCalendarPanel/)
  assert.match(grid, /onClick=\{event => \{/)
  assert.match(grid, /onPointerMove=\{movePointer\}/)
  assert.match(grid, /fde-time-resize-handle/)
  assert.match(panel, /单击空白时间新建任务/)
  assert.match(panel, /\/calendar\/tasks/)
  assert.match(routes, /calendarRouter\.post\('\/tasks'/)
  assert.match(routes, /calendarRouter\.post\('\/tasks\/:id\/cancel'/)
  assert.match(service, /createCalendarTask/)
  assert.match(service, /cancelPersonalCalendarTask/)
})
