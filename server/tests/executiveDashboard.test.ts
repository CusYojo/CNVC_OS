import assert from 'node:assert/strict'
import test from 'node:test'
import { executiveViews, executiveViewFromLocation, isExecutiveRole } from '../../src/lib/executiveDashboard'
import {
  executiveKeyNodes, executiveProjectStatus, executiveTeam, executiveWeekLogs, isInExecutiveWeek,
  executivePortfolio, executiveOwnDirectives, executiveProjectUpdate, executiveTypeWorkflow,
  loadExecutiveDetails, loadExecutiveProjects, rankExecutiveProjects,
  type ExecutiveDirective, type ExecutiveProjectDetail, type ExecutiveRead, type ExecutiveTask,
} from '../../src/lib/executiveDashboardData'
import type { Project, WorkflowLog } from '../../src/types'
import type { TypeRuntimeView } from '../src/contracts/fdeTypeRuntimeContract'

const project = (id: string, fields: Partial<Project> = {}): Project => ({
  id, name: id, owner: '负责人', ownerUserId: 'owner', stage: '尽调', classification: 'normal', lifecycle: 'active',
  workflowModel: 'fde-v1', leaderPriority: '中', progress: 40, riskLevel: '低', createdAt: '2026-09-21T01:00:00Z',
  updatedAt: '2026-09-21T01:00:00Z', ...fields,
} as Project)

test('executive classification selects an agenda perspective, never homepage admission', () => {
  for (const role of ['董事长', '总裁', '合伙人']) assert.equal(isExecutiveRole(role), true)
  for (const role of ['投资经理', '项目负责人', '系统管理员', 'AI平台管理员', '法务', '', undefined]) assert.equal(isExecutiveRole(role), false)
})

test('unified workbench retains personal tools alongside the executive views', () => {
  assert.equal(executiveViewFromLocation('?view=personal'), 'personal')
  assert.deepEqual(executiveViews.map(view => view.id), ['overview', 'personal', 'projects', 'directives', 'risks', 'team'])
  assert.equal(executiveViewFromLocation('?view=unknown'), 'overview')
})

test('project totals paginate and do not publish a truncated or failed result', async () => {
  const calls: string[] = []
  const read: ExecutiveRead = async <T,>(path: string) => {
    calls.push(path)
    return { list: path.includes('page=1&') ? [project('a'), project('deleted', { lifecycle: 'deleted' })] : [project('b')], pageSize: 2, total: 3 } as T
  }
  assert.deepEqual((await loadExecutiveProjects(read)).map(p => p.id), ['a', 'b'])
  assert.equal(calls.length, 2)
  await assert.rejects(loadExecutiveProjects(async <T,>(path: string) => {
    if (path.includes('page=2')) throw new Error('offline')
    return { list: [project('a')], total: 2, pageSize: 1 } as T
  }), /offline/)
})

test('key projects sort first; historical and lead-pool projects are not in-flight', () => {
  assert.deepEqual(rankExecutiveProjects([
    project('normal', { leaderPriority: '高' }), project('key', { classification: 'key' }),
    project('closed', { lifecycle: 'closed' }), project('pool', { classification: 'pool' }), project('exit', { stage: '退出' }),
  ]).map(p => p.id), ['key', 'normal'])
})

test('week boundaries use Shanghai time and count real stage passes only once', () => {
  assert.equal(isInExecutiveWeek('2026-09-20T16:00:00Z', '2026-09-21'), true)
  assert.equal(isInExecutiveWeek('2026-09-20T15:59:59Z', '2026-09-21'), false)
  const log = { id: '1', requestId: 'request', projectId: 'p', fromStage: '立项', toStage: '尽调计划制定', source: 'OA审批', createdAt: '2026-09-21T00:00:00Z' } as WorkflowLog
  assert.equal(executiveWeekLogs([log, { ...log, id: '2' }, { ...log, id: '3', requestId: 'seed', source: '系统初始化' }, { ...log, id: '4', requestId: 'same', fromStage: log.toStage }], '2026-09-21').length, 1)
})

test('limited concurrent reads keep available data and expose partial failures', async () => {
  let active = 0, peak = 0, updates = 0
  const read: ExecutiveRead = async <T,>(path: string) => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
    if (path.includes('/a/directives')) throw new Error('unavailable')
    return { tasks: [], list: [], timeline: [], members: [] } as T
  }
  const rows = await loadExecutiveDetails([project('a'), project('b'), project('c')], read, () => updates++, new AbortController().signal)
  assert.ok(peak <= 4)
  assert.ok(updates > 1)
  assert.deepEqual(rows[0].tasks, [])
  assert.equal(rows[0].directives, undefined)
  assert.deepEqual(rows[0].errors, ['督办'])
})

test('cancelled requests do not start another project read', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await loadExecutiveDetails([project('a')], async <T,>() => { calls++; return {} as T }, () => {}, controller.signal)
  assert.equal(calls, 0)
})

test('missing workflow configuration stays incomplete and is distinct from retryable network errors', async () => {
  const rows = await loadExecutiveDetails([project('fund', { projectType: '基金募资项目' })], async <T,>(path: string) => {
    if (path.endsWith('/type-execution')) throw Object.assign(new Error('internal detail'), { code: 'TYPE_RUNTIME_POLICY_INVALID' })
    return { tasks: [], list: [] } as T
  }, () => {}, new AbortController().signal)
  assert.equal(rows[0].workflowNeedsConfiguration, true)
  assert.equal(rows[0].workflow, undefined)
  assert.deepEqual(rows[0].errors, ['节点'])
})

test('nodes exclude completed work and busy/private calendar projections, and deduplicate meetings', () => {
  const details: ExecutiveProjectDetail[] = [{ project: project('p'), errors: [], workflow: { members: [], timeline: [
    { stage: '尽调', date: '2026-09-21', basis: 'approved' },
    { stage: '立项', date: '2026-09-21', basis: 'approved', actualDate: '2026-09-21' },
  ] }, tasks: [] }]
  const meeting = { id: 'm', key: 'meeting:m', source: 'meeting', title: '会议', ownerName: '', startsAt: '2026-09-21T01:00:00Z', target: '/projects/p?tab=collaboration' }
  const rows = executiveKeyNodes(details, [meeting, meeting, { ...meeting, key: 'busy', source: 'busy', id: null }], '2026-09-21')
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.id === 'meeting:m')?.to, '/meetings?meeting=m')
})

test('team summaries use stable owner IDs, accessible projects and dated feedback, not duplicate names', () => {
  const p = project('p')
  const task = { id: 't', title: '核实客户合同', ownerUserId: 'owner', executionModel: 'fde-v1', status: '进行中', dueDate: '2026-09-21', feedbacks: [{ result: '已核实两份合同', submittedBy: 'owner', submittedAt: '2026-09-21T01:00:00Z', blocker: '' }] } as ExecutiveTask
  const team = executiveTeam([p], [{ project: p, tasks: [task], errors: [] }], [
    { id: 'owner', name: '同名员工', department: '投资部' }, { id: 'other', name: '同名员工', department: '法务部' },
  ], '2026-09-21')
  assert.equal(team.length, 1)
  assert.match(team[0].summary, /已核实两份合同/)
})

test('risk state is never shown as normal when a high risk or deadline breach exists', () => {
  assert.equal(executiveProjectStatus(project('p', { healthStatus: '正常', riskLevel: '高' }), [], '2026-09-21').label, '高风险')
  assert.equal(executiveProjectStatus(project('p', { targetDate: '2026-09-20' }), [], '2026-09-21').label, '已逾期')
  assert.equal(executiveProjectStatus(project('p', { stage: '投后', targetDate: '2026-09-20' }), [], '2026-09-21').label, '正常')
})

test('focused views support refresh links, old section links, and safe fallbacks', () => {
  assert.equal(executiveViewFromLocation('?view=directives'), 'directives')
  assert.equal(executiveViewFromLocation('', '#projects'), 'projects')
  assert.equal(executiveViewFromLocation('', '#oversight'), 'overview')
  assert.equal(executiveViewFromLocation('?view=team', '#risks'), 'team')
  assert.equal(executiveViewFromLocation('?view=invalid'), 'overview')
})

test('portfolio puts real exceptions ahead of healthy key projects and excludes closed work', () => {
  const rows = executivePortfolio([
    project('key', { classification: 'key' }), project('risk', { riskLevel: '高' }),
    project('watch', { riskLevel: '中' }), project('closed', { lifecycle: 'closed' }),
  ], [], '2026-09-21')
  assert.deepEqual(rows.map(row => row.project.id), ['risk', 'watch', 'key'])
})

test('directive views isolate issuer, exclude withdrawn work, and prioritise overdue active tasks', () => {
  const directive = (id: string, status: string, dueDate: string): ExecutiveDirective => ({ id, issuerId: 'boss', content: id, withdrawnAt: null, createdAt: '2026-09-20', task: { id, title: id, owner: 'owner', ownerUserId: 'owner', dueDate, status, progress: 20 } })
  const details = [{ project: project('p'), errors: [], directives: [
    directive('today', '进行中', '2026-09-21'), directive('overdue', '进行中', '2026-09-20'), directive('done', '已完成', '2026-09-19'),
    directive('cancelled', '已取消', '2026-09-18'), { ...directive('other', '进行中', '2026-09-18'), issuerId: 'other' },
    { ...directive('withdrawn', '进行中', '2026-09-18'), withdrawnAt: '2026-09-20' },
  ] }]
  const rows = executiveOwnDirectives(details, 'boss', '2026-09-21')
  assert.deepEqual(rows.map(row => row.id), ['overdue', 'today', 'done'])
  assert.deepEqual(rows.filter(row => row.overdue).map(row => row.id), ['overdue'])
})

test('project update prefers the latest actual feedback over an older stage event', () => {
  const task = { feedbacks: [{ result: '新增两份客户确认函', submittedAt: '2026-09-21T03:00:00Z', submittedBy: 'owner', blocker: '' }] } as ExecutiveTask
  const details = [{ project: project('p'), errors: [], tasks: [task] }]
  const log = { id: 'log', requestId: 'r', projectId: 'p', fromStage: '立项', toStage: '尽调', source: 'OA审批', createdAt: '2026-09-21T01:00:00Z' } as WorkflowLog
  assert.equal(executiveProjectUpdate('p', details, [log], '2026-09-21'), '新增两份客户确认函')
  assert.equal(executiveProjectUpdate('p', details, [{ ...log, createdAt: '2026-09-21T04:00:00Z' }], '2026-09-21'), '推进至尽调')
  assert.equal(executiveProjectUpdate('unknown', details, [log], '2026-09-21'), '')
})

test('non-investment milestones use the approved type workflow and effective task dates', async () => {
  const runtime = { people: [{ id: 'owner', name: '负责人', duties: [] }], tasks: [{ actionKey: 'do', dueDate: '2026-09-24', dueTime: null }], instance: {
    status: 'active', stageKey: 'execute', plan: {
      configuration: { stages: [{ key: 'prepare', name: '筹备' }, { key: 'execute', name: '执行' }] },
      actions: [{ key: 'before', stageKey: 'prepare', dueDate: '2026-09-20', dueTime: null }, { key: 'do', stageKey: 'execute', dueDate: '2026-09-21', dueTime: null }],
    },
  } } as TypeRuntimeView
  assert.deepEqual(executiveTypeWorkflow(runtime).timeline, [{ stage: '执行', date: '2026-09-24', basis: 'approved' }])
  assert.deepEqual(executiveTypeWorkflow({ ...runtime, instance: { ...runtime.instance!, status: 'draft' } }).timeline, [])
  const calls: string[] = []
  const rows = await loadExecutiveDetails([project('fund', { projectType: '基金募资项目' })], async <T,>(path: string) => {
    calls.push(path)
    return (path.endsWith('/type-execution') ? runtime : { tasks: [], list: [] }) as T
  }, () => {}, new AbortController().signal)
  assert.ok(calls.includes('/projects/fund/type-execution'))
  assert.ok(!calls.some(path => path.endsWith('/fde-workflow')))
  assert.deepEqual(rows[0].errors, [])
})
