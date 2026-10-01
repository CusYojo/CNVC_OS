import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildSaiAgentPrompt,
  buildSaiDiscoverySnapshot,
  buildSaiReviewSnapshot,
  buildSaiWorkspaceSnapshot,
  extractSaiPromptGoal,
  getSaiAgentActions,
  getSaiConversationScopeKey,
  resolveSaiAgentContext,
  resolveSaiNavigationAction,
  resolveSaiUploadAction,
} from '../../src/lib/saiAgent.js'

const projects = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: '星河半导体',
    companyName: '星河半导体科技有限公司',
    stage: '尽调',
    lifecycle: 'active',
  },
]

test('小赛在项目页打开对应资料上传窗口，其他页面打开知识库上传窗口', () => {
  const project = resolveSaiAgentContext(`/projects/${projects[0].id}`, '?tab=files', projects)
  const workspace = resolveSaiAgentContext('/', '', projects)
  const discovery = resolveSaiAgentContext('/projects', '?view=discover', projects)
  const review = resolveSaiAgentContext('/projects', '?view=reviews', projects)
  assert.equal(resolveSaiUploadAction(project, '帮我上传项目材料'), `/projects/${projects[0].id}?tab=files&saiUpload=1`)
  assert.equal(resolveSaiUploadAction(workspace, '我要上传文件'), '/knowledge?view=archives&archiveTool=upload')
  assert.equal(resolveSaiUploadAction(discovery, '帮我上传项目 BP'), '/projects?view=discover&saiUpload=1')
  assert.equal(resolveSaiUploadAction(review, '上传项目资料'), '/projects?view=discover&saiUpload=1')
  assert.equal(resolveSaiUploadAction(project, '请分析这份材料'), null)
  assert.equal(resolveSaiUploadAction(project, '不要上传文件，只分析已有材料'), null)
})

test('小赛把明确的页面操作路由到现有工作区', () => {
  assert.equal(resolveSaiNavigationAction('打开待我审批'), 'approvals')
  assert.equal(resolveSaiNavigationAction('帮我打开知识库'), '/knowledge')
  assert.equal(resolveSaiNavigationAction('请帮我打开知识库'), '/knowledge')
  assert.equal(resolveSaiNavigationAction('进入任务日历'), '/collaboration')
  assert.equal(resolveSaiNavigationAction('请分析待审事项'), null)
})

test('小赛能从项目路由安全解析当前项目', () => {
  const context = resolveSaiAgentContext(
    '/projects/11111111-1111-4111-8111-111111111111',
    '?tab=files',
    projects,
  )

  assert.equal(context.kind, 'project')
  assert.equal(context.label, '星河半导体')
  assert.equal(context.projectId, projects[0].id)
  assert.equal(context.projectName, projects[0].name)
  assert.equal(context.detail, '尽调 · 项目材料')
})

test('非 UUID 路由不会被错认为可授权项目上下文', () => {
  const context = resolveSaiAgentContext('/projects/boss-dashboard', '', projects)

  assert.equal(context.kind, 'workspace')
  assert.equal(context.projectId, undefined)
  assert.equal(context.label, '管理驾驶舱')
})

test('项目发现和尽调工作台获得不同的情景快捷动作', () => {
  const discovery = resolveSaiAgentContext('/projects', '?view=discover', projects)
  const dueDiligence = resolveSaiAgentContext('/due-diligence', '', projects)

  assert.equal(discovery.kind, 'discovery')
  assert.deepEqual(
    getSaiAgentActions(discovery).map((action) => action.id),
    ['screen-candidates', 'compare-leads', 'open-ai'],
  )
  assert.deepEqual(
    getSaiAgentActions(dueDiligence).map((action) => action.id),
    ['dd-checklist', 'evidence-conflicts', 'open-knowledge'],
  )
})

test('项目提示词带入当前上下文，并明确先计划再写入', () => {
  const context = resolveSaiAgentContext(
    '/projects/11111111-1111-4111-8111-111111111111',
    '?tab=files',
    projects,
  )
  const prompt = buildSaiAgentPrompt(context, '找出当前材料的主要风险')

  assert.match(prompt, /星河半导体/)
  assert.match(prompt, /11111111-1111-4111-8111-111111111111/)
  assert.match(prompt, /项目材料/)
  assert.match(prompt, /默认只读/)
  assert.match(prompt, /等待用户确认/)
  assert.match(prompt, /找出当前材料的主要风险/)
})

test('全局提示词不夹带无关项目标识', () => {
  const context = resolveSaiAgentContext('/', '', projects)
  const prompt = buildSaiAgentPrompt(context, '帮我梳理今天的事')

  assert.match(prompt, /全局工作台/)
  assert.doesNotMatch(prompt, /11111111-1111-4111-8111-111111111111/)
})

test('对话气泡只回显用户目标，不暴露 Agent 上下文指令', () => {
  const context = resolveSaiAgentContext('/', '', projects)
  const prompt = buildSaiAgentPrompt(context, '帮我梳理今天的事') + buildSaiWorkspaceSnapshot({
    projects: [], todos: [{ title: '核对财务资料', projectName: '星河半导体', priority: '高', status: '进行中', dueDate: '2026-10-01' }],
    meetings: [], risks: [], approvals: [],
  })

  assert.equal(extractSaiPromptGoal(prompt), '帮我梳理今天的事')
  assert.match(prompt, /核对财务资料/)
  assert.equal(extractSaiPromptGoal('这是普通历史消息'), '这是普通历史消息')
})

test('项目主记录尚未加载时仍保持项目作用域', () => {
  const current = resolveSaiAgentContext('/projects/11111111-1111-4111-8111-111111111111', '?tab=files', [])
  assert.equal(current.kind, 'project')
  assert.equal(current.projectId, projects[0].id)
  assert.equal(getSaiConversationScopeKey(current), `project:${projects[0].id}`)
  assert.match(current.detail, /正在加载或当前账号无权访问/)
})

test('工作台摘要保留总数，并优先呈现到期任务', () => {
  const snapshot = buildSaiWorkspaceSnapshot({
    projects: [],
    todos: [
      { title: '低优先级', projectName: '项目甲', priority: '低', status: '进行中', dueDate: '2026-10-03' },
      { title: '已完成任务', projectName: '项目甲', priority: '高', status: '已完成', dueDate: '2026-10-01' },
      { title: '高优先级', projectName: '项目乙', priority: '高', status: '待办', dueDate: '2026-10-01' },
    ],
    meetings: [], risks: [], approvals: [],
    now: new Date('2026-10-01T08:00:00'),
  })
  const parsed = JSON.parse(snapshot.slice(snapshot.indexOf('{')))
  assert.equal(parsed.counts.todos, 2)
  assert.ok(snapshot.indexOf('高优先级') < snapshot.indexOf('低优先级'))
  assert.doesNotMatch(snapshot, /已完成任务/)
})

test('工作台摘要截断列表时仍报告完整任务数', () => {
  const snapshot = buildSaiWorkspaceSnapshot({
    projects: [], meetings: [], risks: [], approvals: [],
    todos: Array.from({ length: 8 }, (_, index) => ({ title: `任务${index}`, projectName: '项目', priority: '中', status: '待办', dueDate: '2026-10-01' })),
    now: new Date('2026-10-01T08:00:00'),
  })
  const parsed = JSON.parse(snapshot.slice(snapshot.indexOf('{')))
  assert.equal(parsed.counts.todos, 8)
  assert.equal(parsed.todos.length, 6)
  assert.match(snapshot, /不要把列表长度说成总数/)
})

test('项目发现摘要只包含当前筛选列表，并区分加载失败与无候选', () => {
  const visible = [{ id: 'lead-1', name: '原始名称', companyName: '星河公司', region: '杭州', radarProfile: { channel: '公众号', profile: { discoveryCardEdits: { name: '编辑后的项目', summary: '待核实的公开线索' } } } }]
  const snapshot = buildSaiDiscoverySnapshot(visible, false, '')
  assert.match(snapshot, /编辑后的项目/)
  assert.match(snapshot, /待核实的公开线索/)
  assert.match(snapshot, /未经核实/)
  assert.doesNotMatch(snapshot, /原始名称/)
  assert.match(buildSaiDiscoverySnapshot([], true, ''), /正在加载/)
  assert.match(buildSaiDiscoverySnapshot([], false, '请求失败'), /读取失败/)
})

test('待复核摘要保留筛选总数，只提供有限的当前记录与所选证据', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    id: `review-${index}`, reason: '主体待确认',
    event: { sourceType: 'radar', payload: { source: 'weixin_link', title: `文件${index}`, article_text: '证据内容'.repeat(200) } },
    triggerDecision: { subjectName: `候选${index}` },
  }))
  const snapshot = buildSaiReviewSnapshot({ source: 'weixin_file', status: 'pending', total: 42, rows, selected: rows[0], loading: false, error: '' })
  const parsed = JSON.parse(snapshot.slice(snapshot.indexOf('{')))
  assert.equal(parsed.rows.length, 8)
  assert.equal(parsed.selected.id, 'review-0')
  assert.ok(parsed.selected.excerpt.length <= 600)
  assert.match(snapshot, /匹配总数 42/)
  assert.doesNotMatch(snapshot, /文件9/)
  assert.match(buildSaiReviewSnapshot({ source: 'weixin_file', status: 'pending', total: 0, rows: [], loading: true, error: '' }), /正在加载/)
})

test('跨项目或项目与全局之间切换时隔离 Agent 会话', () => {
  const projectFiles = resolveSaiAgentContext('/projects/11111111-1111-4111-8111-111111111111', '?tab=files', projects)
  const projectTasks = resolveSaiAgentContext('/projects/11111111-1111-4111-8111-111111111111', '?tab=tasks', projects)
  const workspace = resolveSaiAgentContext('/', '', projects)

  assert.equal(getSaiConversationScopeKey(projectFiles), getSaiConversationScopeKey(projectTasks))
  assert.notEqual(getSaiConversationScopeKey(projectFiles), getSaiConversationScopeKey(workspace))
})

test('主要业务页面都能获得完整的情境标签与操作', () => {
  const scenarios = [
    ['/projects/11111111-1111-4111-8111-111111111111', '', 'project'],
    ['/projects', '?view=leads', 'discovery'],
    ['/institutions', '', 'institution'],
    ['/institutions/example', '', 'institution'],
    ['/meetings', '', 'collaboration'],
    ['/committee', '', 'committee'],
    ['/workflow', '', 'workflow'],
    ['/risks', '', 'risk'],
    ['/projects', '?view=reviews', 'review'],
    ['/knowledge', '', 'knowledge'],
    ['/settings/weixin-ai', '', 'settings'],
    ['/system/ai/models', '', 'system'],
    ['/ai', '', 'ai'],
  ] as const

  for (const [pathname, search, expectedKind] of scenarios) {
    const current = resolveSaiAgentContext(pathname, search, projects)
    assert.equal(current.kind, expectedKind)
    assert.equal(getSaiAgentActions(current).length, 3)
  }
})

test('小赛不会把待复核、风险或投委会页面误称为工作台', () => {
  assert.equal(resolveSaiAgentContext('/projects', '?view=reviews', projects).label, '线索人工复核')
  assert.equal(resolveSaiAgentContext('/risks', '', projects).label, '风险预警')
  assert.equal(resolveSaiAgentContext('/committee', '', projects).label, '投委会')
})

test('全局布局挂载小赛，并尊重减少动效设置', async () => {
  const [layoutSource, styleSource] = await Promise.all([
    readFile(new URL('../../src/layout/AppLayout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/components/SaiUnicornAgent.css', import.meta.url), 'utf8'),
  ])

  assert.match(layoutSource, /<SaiUnicornAgent/)
  assert.match(styleSource, /prefers-reduced-motion:\s*reduce/)
  assert.match(styleSource, /safe-area-inset-bottom/)
})
