import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { workbenchActionCounts, workbenchActions, workbenchProjectRank, workbenchTargetLabel, workbenchTone, workbenchView, type WorkbenchAction, type WorkbenchProject } from '../src/contracts/fdeWorkbenchContract.js'
import { shanghaiToday, weekStartFor } from '../src/contracts/fdeWeeklyPlanContract.js'

const action = (fields: Partial<WorkbenchAction> = {}): WorkbenchAction => ({ id: 'task-1', projectId: 'p1', projectName: '项目', title: '行动', ownerUserId: 'alice', dueDate: '2026-08-28', status: '进行中', to: '/collaboration', ...fields })
const project = (fields: Partial<WorkbenchProject> = {}): WorkbenchProject => ({ id: 'p1', name: '项目', owner: '同名人员', ownerUserId: 'alice', secretary: '秘书', secretaryId: null, classification: 'key', health: '正常', priority: 'P2', targetDate: null, stage: '立项', stageSource: null, updatedAt: '2026-08-28T00:00:00.000Z', related: true, actions: [], done: 0, total: 0, leaderParticipation: null, ...fields })
for (const [category, expected] of Object.entries({ institution_leader: 'leader', project_lead: 'lead', secretary: 'secretary', member: 'member', coordinator: 'coordinator', specialist: 'specialist', system_admin: 'admin' })) {
  test(`current role category maps ${category}`, () => assert.equal(workbenchView([{ category }]), expected))
}
test('unknown or missing binding does not infer authority from a title', () => {
  assert.equal(workbenchView([]), 'unassigned'); assert.equal(workbenchView([{ category: '董事长' }]), 'unassigned')
})
test('admin mixed with business keeps explicitly bound business perspective', () => {
  assert.equal(workbenchView([{ category: 'system_admin', primary: true }, { category: 'member' }]), 'member')
})
test('primary business binding is preferred', () => {
  assert.equal(workbenchView([{ category: 'institution_leader' }, { category: 'specialist', primary: true }]), 'specialist')
})
test('my actions use stable identity, not same-name/unbound rows', () => {
  const rows = [action(), action({ id: 'other', ownerUserId: 'bob' }), action({ id: 'legacy', ownerUserId: null })]
  assert.deepEqual(workbenchActionCounts(rows, 'alice', '2026-08-28').own.map(t => t.id), ['task-1'])
})
test('completed and closed rows are not personal pending work', () => {
  const rows = ['已完成', '已关闭', '已取消', '已归档'].map(status => action({ status }))
  assert.equal(workbenchActionCounts(rows, 'alice', '2026-08-28').count, 0)
})
test('dashboard actions retain the previous day plus today and the following three-day preview', () => {
  const rows = [action(), action({ id: 'overdue', dueDate: '2026-08-27' }), action({ id: 'done', status: '已完成' }), action({ id: 'day-two', dueDate: '2026-08-30' }), action({ id: 'future', dueDate: '2026-08-31' }), action({ id: 'undated', dueDate: null })]
  assert.deepEqual(workbenchActions(rows, '2026-08-28').map(t => t.id), ['overdue', 'task-1', 'day-two', 'future'])
})
test('completed work is not shown in the three-day dashboard window', () => assert.equal(workbenchActions([action({ status: '已完成' })], '2026-08-28').length, 0))
test('upcoming count has inclusive today to two-days boundary', () => {
  const rows = ['2026-08-27', '2026-08-28', '2026-08-30', '2026-08-31'].map(dueDate => action({ dueDate }))
  assert.equal(workbenchActionCounts(rows, 'alice', '2026-08-28').dueSoon, 2)
})
test('counts are computed before display limits, including beyond 20 and 100', () => {
  assert.equal(workbenchActionCounts(Array.from({ length: 125 }, (_, i) => action({ id: String(i) })), 'alice', '2026-08-28').count, 125)
})
test('key classification is explicit; scores do not promote normal projects', () => {
  assert.deepEqual(workbenchProjectRank([project({ id: 'normal', classification: 'normal', health: '紧急抢救' }), project()]).map(p => p.id), ['p1'])
})
test('matrix prioritizes health then leader priority and does not mutate source', () => {
  const input = [project({ id: 'normal' }), project({ id: 'risk', health: '存在风险' }), project({ id: 'stalled', health: '已停滞' })]
  assert.deepEqual(workbenchProjectRank(input).map(p => p.id), ['stalled', 'risk', 'normal']); assert.equal(input[0].id, 'normal')
})
test('matrix returns at most eight after ranking', () => assert.equal(workbenchProjectRank(Array.from({ length: 25 }, (_, i) => project({ id: String(i) }))).length, 8))
test('target countdown uses dates, not static FDE prototype week', () => {
  assert.equal(workbenchTargetLabel('2026-08-30', '2026-08-28'), '剩余 2 天')
  assert.equal(workbenchTargetLabel('2026-08-28', '2026-08-28'), '今天到期')
  assert.equal(workbenchTargetLabel('2026-08-27', '2026-08-28'), '已逾期 1 天')
  assert.equal(workbenchTargetLabel(null, '2026-08-28'), '未配置目标日')
})
test('Shanghai date and Monday switch at local midnight', () => {
  assert.equal(shanghaiToday(new Date('2026-08-30T16:00:00Z')), '2026-08-31')
  assert.equal(weekStartFor('2026-08-30'), '2026-08-24'); assert.equal(weekStartFor('2026-08-31'), '2026-08-31')
})
test('health tone is independent of business stage', () => { assert.equal(workbenchTone('存在风险'), 'danger'); assert.equal(workbenchTone('尽调'), 'neutral') })
const source = readFileSync(new URL('../src/services/fdeWorkbenchService.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('../../src/pages/DashboardPage.tsx', import.meta.url), 'utf8')
const shell = readFileSync(new URL('../../src/layout/fde-shell.css', import.meta.url), 'utf8')
const layout = readFileSync(new URL('../../src/layout/AppLayout.tsx', import.meta.url), 'utf8')
const todoRoutes = readFileSync(new URL('../src/routes/meetings.ts', import.meta.url), 'utf8')
const todoService = readFileSync(new URL('../src/services/meetingService.ts', import.meta.url), 'utf8')
test('read-only service reuses both authoritative ACLs and fails on capacity, never returns truncated totals', () => {
  assert.match(source, /projectAccessCondition\(/); assert.match(source, /todoAccessCondition\(/)
  assert.match(source, /accessMode: 'read only'/); assert.match(source, /WORKBENCH_PROJECT_LIMIT/); assert.match(source, /WORKBENCH_TASK_LIMIT/)
  assert.doesNotMatch(source, /\.(insert|update|delete|execute)\(/)
})
test('configuration-only branch exits before business queries', () => {
  const start = source.indexOf("if (view === 'admin')"), end = source.indexOf('let scoped:')
  assert.match(source.slice(start, end), /system\.manage/); assert.match(source.slice(start, end), /return result/)
  assert.doesNotMatch(source.slice(start, end), /from\(projects\)|listLeaderTimes\(|listApprovalCenter\(/)
})
test('workbench uses persistent personal todo APIs and renders the four daily regions without metric cards', () => {
  assert.doesNotMatch(page, /useAppStore|score\s*-/)
  assert.match(page, /apiPost<PersonalTodo>\('\/todos'/); assert.match(page, /apiPatch<PersonalTodo>/); assert.match(page, /apiDelete/)
  for (const label of ['任务时间轴', '今日待办', '未来三天', '重点项目风险']) assert.match(page, new RegExp(label))
  assert.doesNotMatch(page, /metric\.value \?\? '—'|className="metric-grid"/)
  assert.match(source, /project\.classification === 'key'/)
})
test('previous personal work remains visible, completed rows remain deletable, and the history group is visually distinct', () => {
  assert.match(page, /includeCompleted=true/)
  assert.match(page, /historicalTodos/)
  assert.match(page, /todo-history-section/)
  assert.match(page, /todo-completed-mark/)
  assert.match(page, /apiDelete/)
  assert.match(todoRoutes, /includeCompleted: z\.enum\(\['true'\]\)/)
  assert.match(todoService, /personal\.includeCompleted/)
})
test('sidebar includes a low-contrast non-interactive horse silhouette', () => {
  assert.match(layout, /function SidebarHorse\(\)/)
  assert.match(layout, /src="\/fde-sidebar-horse\.png"/)
  assert.match(layout, /aria-hidden="true"/)
  assert.match(shell, /\.fde-sidebar-horse \{[^}]*opacity: \.44;[^}]*pointer-events: none;/)
  assert.match(shell, /\.fde-sidebar-horse img \{[^}]*object-fit: contain;[^}]*scale\(1\.42\)/)
  assert.doesNotMatch(layout, /fde-horse-(?:tail|body|mane|leg)/)
  assert.match(shell, /@media \(max-height: 720px\) \{ \.fde-sidebar-horse \{[^}]*width: 205px;/)
  assert.doesNotMatch(shell, /max-height: 720px\)[^{]*\{[^}]*display: none/)
})
test('reload clears data and gates late responses and changed identity', () => {
  assert.match(page, /setData\(null\)/); assert.match(page, /token === generation\.current/)
  assert.match(page, /value\.actorId !== userId/); assert.match(page, /after\.user\.id !== userId/)
  assert.match(page, /addEventListener\('focus'/); assert.match(page, /cache: 'no-store'/)
})
test('correct destination contracts remain linked for materials and weekly plans', () => {
  assert.match(source, /tab=files&material=/); assert.match(source, /view=weekly&project=/); assert.match(source, /approvalCenterDetailPath\(a\)/)
})
test('mobile matrix keeps the full-width tbody grid and accessible hidden-metric alternative', () => {
  const css = readFileSync(new URL('../../src/pages/DashboardPage.css', import.meta.url), 'utf8')
  assert.match(css, /\.action-matrix tbody \{ display: grid; gap: 10px; padding: 10px; \}/)
  assert.match(css, /\.fde-page-content:has\(> \.fde-dashboard\)/)
  assert.match(page, /更多工作入口/)
})
