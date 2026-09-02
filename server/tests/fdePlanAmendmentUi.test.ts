import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (relativeUrl: string) => readFile(new URL(relativeUrl, import.meta.url), 'utf8')

test('approved investment plans remain editable without changing the approved baseline', async () => {
  const [service, panel] = await Promise.all([
    source('../src/services/fdeWorkflowService.ts'),
    source('../../src/components/FdeWorkflowPanel.tsx'),
  ])
  assert.match(service, /amendApprovedFdePlan/)
  assert.match(service, /FDE_APPROVED_BASELINE_CHANGE/)
  assert.match(service, /materializeFdePlanTasks\(tx, project\.id, plan\.id\)/)
  assert.match(service, /duty, 'concerned_leader'/)
  assert.match(service, /type: '通知'/)
  assert.match(panel, /已通过·可修订/)
  assert.match(panel, /保存修订/)
  assert.match(panel, /setPlanExpanded\(true\)/)
})

test('calendar task blocks keep project identity while the top-right inbox only carries messages and warnings', async () => {
  const [calendar, grid, layout] = await Promise.all([
    source('../src/services/fdeCalendarService.ts'),
    source('../../src/components/FdeTimeGrid.tsx'),
    source('../../src/layout/AppLayout.tsx'),
  ])
  assert.match(calendar, /projectName: row\.projectName \?\? '个人任务'/)
  assert.match(grid, /row\.source === 'task'/)
  assert.match(grid, /row\.projectName \|\| '个人任务'/)
  assert.match(layout, /item\.ownerUserId === currentUser\.id/)
  assert.match(layout, /item\.type === '通知'/)
  assert.match(layout, /request\.status !== '审批中'/)
  assert.match(layout, /risk\.level === '高'/)
  assert.match(layout, /title="消息与预警"/)
  assert.doesNotMatch(layout, /title="我的待办"/)
})
