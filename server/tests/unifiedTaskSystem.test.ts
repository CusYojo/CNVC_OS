import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  TASK_CATEGORY_LABELS, TASK_PRIMARY_ACTIONS, TASK_SOURCE_LABELS,
  TASK_STATUS_LABELS, normalizeTaskStatus,
} from '../src/contracts/unifiedTaskContract.js'

const source = (relative: string) => readFile(new URL(relative, import.meta.url), 'utf8')

test('task language exposes four views while plan and directives remain source labels', () => {
  assert.deepEqual(Object.values(TASK_CATEGORY_LABELS), ['个人事项', '我的任务', '项目任务', '审批待办'])
  assert.equal(TASK_SOURCE_LABELS.plan, '倒排计划')
  assert.equal(TASK_SOURCE_LABELS.workflow, '流程行动')
  assert.equal(TASK_SOURCE_LABELS.directive, '领导批示')
})

test('canonical task statuses have exactly one primary action', () => {
  assert.deepEqual(Object.values(TASK_STATUS_LABELS), ['未开始', '进行中', '待验收', '已退回', '已完成', '已取消'])
  assert.deepEqual(Object.values(TASK_PRIMARY_ACTIONS), ['开始任务', '提交成果', '验收', '重新提交', '查看成果', '查看记录'])
  assert.equal(normalizeTaskStatus('已关闭'), 'completed')
  assert.equal(normalizeTaskStatus('待确认'), 'not_started')
})

test('approved plans create one execution row and project pages share task components', async () => {
  const [service, projectPanel, collaboration, calendar, dashboard] = await Promise.all([
    source('../src/services/fdeTaskService.ts'), source('../../src/components/FdeTaskPanel.tsx'),
    source('../../src/components/FdeCollaborationWeekly.tsx'), source('../../src/components/FdeCalendarPanel.tsx'),
    source('../../src/pages/DashboardPage.tsx'),
  ])
  assert.doesNotMatch(service, /title: lead \? action\.title : `协同：/)
  assert.match(service, /participantUserIds: participantIds/)
  assert.match(projectPanel, /TaskCard/)
  assert.match(collaboration, /PrimaryAction/)
  for (const content of [projectPanel, collaboration, calendar, dashboard]) assert.match(content, /TaskDrawer/)
})

test('admin pages require explicit admin roles on client and server', async () => {
  const [guard, middleware, layout] = await Promise.all([
    source('../../src/App.tsx'), source('../src/middleware/requireAuth.ts'), source('../../src/layout/AppLayout.tsx'),
  ])
  assert.match(guard, /isAiPlatformAdminRole/)
  assert.match(middleware, /isAiPlatformAdminRole\(req\.user\.role\)/)
  assert.match(layout, /navigate\('\/system'\)/)
  assert.doesNotMatch(layout, /permissionCodes\.includes\('ai\.configure'\)/)
})
