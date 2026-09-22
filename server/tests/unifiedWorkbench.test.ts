import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { executiveKeyNodes, type ExecutiveCalendarItem } from '../../src/lib/executiveDashboardData'

const source = (file: string) => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8')
const today = '2026-09-22'
const item = (id: string, fields: Partial<ExecutiveCalendarItem> = {}): ExecutiveCalendarItem => ({
  id, key: `personal:${id}`, source: 'personal', title: id, ownerName: '本人',
  startsAt: `${today}T01:00:00Z`, target: null, ...fields,
})

test('all authenticated accounts share the work screen without a legacy home or rollout fallback', () => {
  const app = source('App.tsx'), page = source('pages/ExecutiveDashboardPage.tsx')
  assert.doesNotMatch(app, /import \{ DashboardPage \}|<DashboardPage\b|canUseExecutiveDashboard/)
  assert.match(app, /<Route index element=\{<WorkspaceHome \/>\}/)
  assert.match(app, /if \(!authenticated\) return <Navigate to="\/login"/)
  assert.doesNotMatch(page, /canUseExecutiveDashboard/)
  assert.match(page, /key=\{[^}]*user\.id[^}]*\}/)
  assert.doesNotMatch(source('lib/executiveDashboard.ts'), /VITE_EXECUTIVE_DASHBOARD_ENABLED/)
})

test('staff agenda contains own calendar tasks and personal arrangements, not colleagues project nodes', () => {
  const calendar = [item('note'), item('task', { source: 'task', target: '/projects/p?tab=tasks&task=t', projectName: '项目甲' }),
    item('hidden', { id: null, source: 'busy', title: '已占用' }), item('tomorrow', { startsAt: '2026-09-23T01:00:00Z' })]
  const rows = executiveKeyNodes([], calendar, today, 'personal')
  assert.deepEqual(rows.map(row => row.title).sort(), ['note', 'task'])
  assert.equal(rows.find(row => row.title === 'note')?.to, '/?view=personal')
  assert.equal(rows.find(row => row.title === 'task')?.to, '/projects/p?tab=tasks&task=t')
})

test('personal agenda handles meetings, multi-day approved travel and invalid times without duplicates', () => {
  const meeting = item('m', { source: 'meeting', target: '/projects/p?tab=collaboration' })
  const rows = executiveKeyNodes([], [meeting, meeting,
    item('trip', { source: 'office', startsAt: '2026-09-21T10:00:00Z', endsAt: '2026-09-23T10:00:00Z', target: '/workflow?office=o' }),
    item('invalid', { startsAt: 'invalid' }), item('past', { startsAt: '2026-09-21T10:00:00Z', endsAt: '2026-09-21T11:00:00Z' }),
  ], today, 'personal')
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.title === 'm')?.to, '/meetings?meeting=m')
  assert.equal(rows.find(row => row.title === 'trip')?.time, '全天')
})

test('administration guards and authenticated API boundaries remain in place', () => {
  const app = source('App.tsx'), page = source('pages/ExecutiveDashboardPage.tsx')
  assert.match(app, /isSystemAdminRole\(user\?\.role/)
  assert.match(app, /isAiPlatformAdminRole\(user\?\.role/)
  assert.match(page, /\/oa\/center\?view=pending/)
  assert.match(page, /loadExecutiveProjects/)
  assert.doesNotMatch(page, /useAuthStore\.setState|permissionCodes\s*=/)
})

test('the embedded personal screen keeps calendars and personal todos available to every account', () => {
  const page = source('pages/DashboardPage.tsx')
  assert.match(page, /\(embedded \|\| current\.view !== 'admin' && current\.view !== 'unassigned'\)/)
  assert.match(page, /\{embedded \? <PersonalScheduleSidebar/)
})
