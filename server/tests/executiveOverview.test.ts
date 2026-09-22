import assert from 'node:assert/strict'
import test from 'node:test'
import { executiveFocusProjects, executiveAgendaAction } from '../../src/lib/executiveOverview'
import { executivePortfolio } from '../../src/lib/executiveDashboardData'
import type { Project } from '../../src/types'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const project = (n: number, fields: Partial<Project> = {}) => ({
  id: id(n), name: `项目${n}`, classification: 'key', lifecycle: 'active', stage: '尽调',
  riskLevel: '低', updatedAt: '2026-09-22', progress: 40, ...fields,
} as Project)

test('overview shows only active key projects with attention items first without mutating portfolio', () => {
  const portfolio = executivePortfolio([
    project(1), project(2, { riskLevel: '高' }), project(3, { classification: 'normal', riskLevel: '高' }),
    project(4, { lifecycle: 'deleted' }), project(5, { stage: '退出' }),
  ], [], '2026-09-22')
  const before = structuredClone(portfolio)
  assert.deepEqual(executiveFocusProjects(portfolio).map(row => row.project.id), [id(2), id(1)])
  assert.deepEqual(portfolio, before)
  assert.deepEqual(executiveFocusProjects([]), [])
  assert.deepEqual(executiveFocusProjects(executivePortfolio([project(6, { classification: 'normal' })], [], '2026-09-22')), [])
})

test('agenda tasks, project nodes and project meetings open local detail targets', () => {
  assert.deepEqual(executiveAgendaAction({ to: `/projects/${id(1)}?tab=tasks&task=${id(2)}` }), { kind: 'task', projectId: id(1), taskId: id(2), action: 'view' })
  assert.deepEqual(executiveAgendaAction({ to: `/projects/${id(1)}?tab=workflow` }), { kind: 'project', id: id(1) })
  assert.deepEqual(executiveAgendaAction({ to: `/meetings?meeting=${id(3)}` }), { kind: 'meeting', id: id(3) })
})

test('agenda preserves specialised routes and does not treat invalid or external links as local drawers', () => {
  for (const to of ['/committee?meeting=abc', '/meetings?meeting=invalid', '/projects/invalid?tab=workflow', '/projects/' + id(1) + '?tab=materials', 'https://example.org/meetings?meeting=' + id(3), 'http://[invalid']) {
    assert.deepEqual(executiveAgendaAction({ to }), { kind: 'link', to })
  }
})
