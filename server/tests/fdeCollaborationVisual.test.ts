import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { collaborationTabs, collaborationView, weeklyActions, weeklySummary, mapCollaborationProjects, type CollaborationAction } from '../../src/lib/fdeCollaborationView'
import { calendarItemOnDay, type CompanyCalendarItem } from '../../src/components/FdeCompanyCalendar'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const action = (id: string, patch: Partial<CollaborationAction> = {}): CollaborationAction => ({ id, projectId: 'p', projectName: '星澜', projectType: '投资项目', title: id, owner: '成员', ownerUserId: 'u', dueDate: '2026-08-28', dueTime: null, status: '进行中', executionModel: 'fde-v1', directiveId: null, planActionId: null, timelineSource: null, feedbacks: [], extensions: [], capabilities: { canFeedback: true, canAccept: false, canExtend: true, canCancel: false }, needLeader: false, leaderLinked: false, ...patch })

test('three reference tabs preserve all historical deep-link destinations', () => {
  assert.deepEqual(collaborationTabs.map(item => item[1]), ['我的任务', '日历', '周报与例会'])
  for (const value of ['time','calendar']) assert.equal(collaborationView(value), 'calendar')
  for (const value of ['friday','reports','review','committee','meetings']) assert.equal(collaborationView(value), 'review')
  assert.equal(collaborationView('unknown'), 'weekly')
})

test('current week includes unfinished overdue work but excludes approvals, cancelled and missing-date tasks', () => {
  const items = [action('current'), action('prior', { dueDate: '2026-08-20' }), action('old-completed', { dueDate: '2026-08-20', status: '已完成' }), action('closed', { status: '已关闭' }), action('cancelled', { status: '已取消' }), action('approval', { executionModel: 'approval' }), action('undated', { dueDate: null }), action('future', { dueDate: '2026-08-31' })]
  assert.deepEqual(weeklyActions(items, '2026-08-24', 'date', '2026-08-28').map(item => item.id), ['prior', 'current'])
  assert.deepEqual(weeklyActions(items, '2026-08-31', 'date', '2026-08-28').map(item => item.id), ['future'])
})

test('all groupings keep the same task identities and use effective deadline ordering', () => {
  const rows = [action('a', { owner: '乙', dueTime: '15:00' }), action('b', { owner: '甲', dueTime: '09:00' }), action('c', { dueTime: null })]
  assert.deepEqual(weeklyActions(rows, '2026-08-24', 'date', '2026-08-28').map(item => item.id), ['b','a','c'])
  for (const group of ['project','person','date'] as const) assert.deepEqual(weeklyActions(rows, '2026-08-24', group, '2026-08-28').map(item=>item.id).sort(), ['a','b','c'])
})

test('completed metrics require formal completion, blockers and leader flags are evidence-backed', () => {
  const stats = weeklySummary([action('submitted', { status: '待验收', needLeader: true, leaderLinked: true }), action('done', { status: '已完成', feedbacks: [{ blocker: '历史阻塞' }] }), action('blocked', { dueDate: '2026-08-30', feedbacks: [{ blocker: '等待材料' }] })], '2026-08-28')
  assert.deepEqual(stats, { total: 3, completed: 1, urgent: 2, leaders: 1, linked: 1, timeline: 0 })
})

test('project reads have bounded concurrency, stable order and reject partial failures', async () => {
  let active = 0, maximum = 0
  const result = await mapCollaborationProjects(Array.from({ length: 13 }, (_, i) => i), async value => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return value })
  assert.equal(maximum, 4)
  assert.deepEqual(result, Array.from({ length: 13 }, (_, i) => i))
  await assert.rejects(mapCollaborationProjects([1,2], async value => { if (value === 2) throw new Error('forbidden'); return value }), /forbidden/)
})

test('company calendar uses Shanghai half-open intervals across days and week boundaries', () => {
  const item: CompanyCalendarItem = { key: 'busy', ownerId: 'u', ownerName: '同名', source: 'busy', title: '已占用', startsAt: '2026-08-23T15:00:00Z', endsAt: '2026-08-25T16:00:00Z', allDay: false }
  assert.equal(calendarItemOnDay(item, '2026-08-24'), true)
  assert.equal(calendarItemOnDay(item, '2026-08-25'), true)
  assert.equal(calendarItemOnDay(item, '2026-08-26'), false)
  assert.equal(calendarItemOnDay({ ...item, startsAt: '2026-08-24T16:00:00Z', endsAt: null }, '2026-08-24'), false)
  const source = read('src/components/FdeCompanyCalendar.tsx')
  assert.match(source, /\[item\.ownerId,/)
  assert.doesNotMatch(source, /apiPost|apiPatch|localStorage/)
})

test('all visual rules remain page-scoped; compact task table and responsive cards are retained', () => {
  const css = read('src/pages/CollaborationPage.css')
  postcss.parse(css).walkRules(rule => assert.match(rule.selector, /fde-collaboration-page/))
  assert.match(css, /repeat\(4,minmax\(0,1fr\)\)/)
  assert.match(css, /max-width: 760px/)
  assert.match(css, /\.fde-collab-table thead \{ display: none/)
  assert.ok(css.split('\n').every(line => !/[\t ]+$/.test(line)))
  const weekly = read('src/components/FdeCollaborationWeekly.tsx')
  for (const label of ['任务', '项目', '截止时间', '状态', '当前操作']) assert.match(weekly, new RegExp(`<th>${label}</th>`))
  assert.match(weekly, /collaborationDeadlineGroups/)
  assert.doesNotMatch(weekly, /<th>负责人<\/th>/)
})

test('entry uses fresh authorized scope, role-specific views and guarded canonical task operations', () => {
  const page = read('src/pages/CollaborationPage.tsx'), task = read('src/components/FdeTaskPanel.tsx')
  assert.match(page, /workbench\.actorId !== userId/)
  assert.match(page, /apiGet<\{ list: Project\[\] \}>\('\/projects'\)/)
  assert.match(page, /\['admin', 'coordinator'\]\.includes/)
  assert.match(task, /if \(allowed\) open\(action as Mode, task\)/)
  assert.match(task, /expectedVersion/)
  assert.match(task, /task\.capabilities\.canAccept/)
  assert.match(read('src/components/FdeCollaborationWeekly.tsx'), /PrimaryAction/)
  assert.doesNotMatch(read('src/components/FdeCollaborationWeekly.tsx'), /localStorage/)
})

test('visual fixture cannot access DB, proxy upstream or accept mutations', () => {
  const fixture = read('scripts/preview-fde-collaboration.mjs')
  assert.doesNotMatch(fixture, /from ['"].*(?:db\/|dotenv|mysql)|process\.env\.(?:DB_|MYSQL)|proxy:/)
  assert.match(fixture, /!\['GET','HEAD'\]\.includes\(req\.method\)/)
  assert.match(fixture, /隔离视觉夹具禁止所有写操作/)
  assert.match(fixture, /server\.listen\(0,'127\.0\.0\.1'/)
})
