// Isolated visual acceptance server. No .env, database, proxies, or business writes.
// Run from the repository root: node server/tests/fixtures/executiveDashboardPreview.mjs
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile } from 'node:fs/promises'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
const stamp = `${today}T01:00:00Z`
const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10)
let role = '董事长', scenario = 'normal'
const roles = ['董事长', '合伙人', '投资经理', '总裁', '法务', '风控', '董秘', '财务', '出纳', '系统管理员', 'AI平台管理员', '运营管理员', '未分配岗位']
const handled = new Map()
const calendarWeeks = new Map()
let personalTodos = null, nextTodoId = 500, conflictSent = false
const calendarDate = (week, offset) => new Date(Date.parse(`${week}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
const instant = value => new Date(value.length === 16 ? `${value}:00+08:00` : value).toISOString()
function calendarRows(week) {
  if (!calendarWeeks.has(week)) {
    const rows = ['材料复核', '投资团队沟通', '项目进展会议', '客户访谈', '本周复盘'].map((title, i) => {
      const hour = [9, 11, 14, 16, 18][i], day = calendarDate(week, i)
      return { id: id(200 + i), key: `calendar:${i}`, source: 'personal', title, detail: '仅用于独立界面验收', projectName: '', ownerId: actor().id, ownerName: actor().name, startsAt: instant(`${day}T${String(hour).padStart(2, '0')}:00`), endsAt: instant(`${day}T${String(hour + 1).padStart(2, '0')}:00`), allDay: false, version: 1, editable: true, visibility: 'private', target: null }
    })
    const add = (title, from, to, extra = {}) => rows.push({ ...rows[0], id: id(200 + rows.length), key: `calendar:${rows.length}`, title, startsAt: instant(from), endsAt: instant(to), ...extra })
    add('短事项甲', `${week}T10:30`, `${week}T10:45`)
    add('短事项乙', `${week}T10:45`, `${week}T11:00`)
    add('待交付资料', `${week}T00:00`, `${week}T23:59`, { allDay: true, editable: false })
    add('只读项目会议', `${calendarDate(week, 2)}T15:00`, `${calendarDate(week, 2)}T16:00`, { source: 'meeting', editable: false, target: `/projects/${projects[2].id}?tab=collaboration` })
    if (scenario === 'calendar-extremes') {
      add('早间出行', `${week}T06:30`, `${week}T07:30`)
      add('晚间电话沟通', `${calendarDate(week, 4)}T21:00`, `${calendarDate(week, 4)}T22:15`)
      add('跨日行程', `${calendarDate(week, 1)}T19:00`, `${calendarDate(week, 2)}T08:00`)
    }
    calendarWeeks.set(week, rows)
  }
  return calendarWeeks.get(week)
}
const actor = () => ({ id: id(roles.indexOf(role) + 1), name: '验收账号', email: 'preview@example.invalid', role, department: '投资部', status: '启用', permissionCodes: [] })
function todoRows() {
  personalTodos ??= (scenario.startsWith('calendar') ? ['确认本周出行安排', '整理项目访谈提纲', '联系合作伙伴', ...(scenario === 'calendar-busy' ? Array.from({ length: 24 }, (_, i) => `独立验收待办 ${i + 1}`) : [])] : []).map((title, i) => ({
    id: id(400 + i), title, projectId: null, projectName: null, owner: actor().name, ownerUserId: actor().id,
    dueDate: i === 2 ? yesterday : today, priority: i === 0 ? '高' : '中', status: '未开始', type: '待办', approvalRequestId: null, version: 1,
  }))
  return personalTodos
}
const projects = ['具身智能项目', '半导体设备项目', '商业航天项目', ...Array.from({ length: 9 }, (_, i) => `独立验收项目 ${i + 4}`)].map((name, i) => ({
  id: id(10 + i), version: 1, name, companyName: `${name}公司`, industry: '硬科技', round: 'A 轮', stage: ['尽调', '投决', '立项'][i % 3],
  classification: i < 2 ? 'key' : 'normal', lifecycle: 'active', workflowModel: 'fde-v1', ownerUserId: id(20 + i), owner: ['张经理', '李经理', '王经理'][i % 3],
  collaborators: [], source: '团队推荐', financing: '', valuation: '', riskLevel: ['低', '高', '中'][i % 3], healthStatus: ['正常', '存在风险', '需关注'][i % 3],
  summary: '', score: 80, createdAt: stamp, updatedAt: stamp, tags: [], businessModel: '', market: '', team: '', progress: [42, 76, 18][i % 3], targetDate: today, leaderPriority: ['高', '高', '中'][i % 3],
}))
const tasks = p => [{ id: id(100 + projects.indexOf(p)), title: '完成核心客户访谈与尽调材料核验', owner: p.owner, ownerUserId: p.ownerUserId, dueDate: today, dueTime: '17:30', status: '进行中', version: 1, progress: 65, executionModel: 'fde-v1', directiveId: null, planActionId: 'plan', participantUserIds: [p.ownerUserId], participants: [{ id: p.ownerUserId, name: p.owner }], timelineSource: null, feedbacks: [{ result: '已完成两家重点客户访谈，待复核订单与回款证据。', blocker: '', submittedBy: p.ownerUserId, submittedAt: stamp }], extensions: [], capabilities: {} }]
const approvals = projects.map((p, i) => ({ id: id(40 + i), title: `${p.name} · 尽调计划审批`, requestNo: '', kind: '项目审批', businessType: 'project_stage', status: '审批中', applicantId: p.ownerUserId, applicantName: p.owner, projectName: p.name, currentNodeName: '领导审批', priority: i === 0 ? '紧急' : '普通', version: 1, revision: 1, updatedAt: stamp, submittedAt: stamp, projectId: p.id }))
const risks = projects.map((p, i) => ({ id: id(60 + i), version: 1, projectId: p.id, projectName: p.name, type: '项目风险', level: ['低', '高', '中'][i % 3], description: ['下轮客户沟通需提前确认', '关键技术指标验证未达预期，需补充第三方测试报告', '合同关键条款仍待法务确认'][i % 3], status: '待确认', owner: p.owner, occurredAt: today }))
const officeRow = () => ({ ...approvals[0], id: id(90), title: '独立验收请假申请', kind: '请假', businessType: 'office', projectId: null, projectName: '', applicantName: '验收申请人' })
const projectApproval = row => ({ ...row, type: '尽调计划审核', lockVersion: handled.has(row.id) ? 2 : 1, applicant: row.applicantName, applicantUserId: row.applicantId, department: '投资部', reason: '请核对尽调任务安排后审批', fromStage: '尽调计划审核', targetStage: '尽调', status: handled.get(row.id) || row.status,
  ...(scenario === 'approval-deleted' && row.id === id(40) ? {projectLifecycle:'deleted',actionBlockedReason:'所属项目已删除，此审批仅供查阅'} : {projectLifecycle:'active'}),
  currentNodeId: id(99), checklist: [], attachments: [], revisions: [], records: [], nodes: [{ id: id(99), name: '领导审批', status: handled.get(row.id) || '待审批', approver: actor().name, approverRole: actor().role, approverUserIds: [actor().id], mode: '或签', approvedByUserIds: [] }],
  planReview: { revision: 1, cycleDays: 15, targetDate: today, actions: [] },
})
const officeDetail = () => ({ ...officeRow(), status: handled.get(id(90)) || '审批中', version: handled.has(id(90)) ? 2 : 1, currentNodeId: id(99),
  definition: { title: '独立验收请假申请', reason: '家中有事申请事假', projectId: null, priority: '普通', attachmentIds: [], details: { kind: '请假', leaveType: '事假', startAt: today + 'T09:00', endAt: today + 'T18:00', hours: '8', handoverUserId: null } },
  nodes: [{ id: id(99), name: '上级审批', mode: '或签', approverNames: [actor().name], approvedByNames: [], status: handled.get(id(90)) || '待审批' }], attachments: [], history: [], revisions: [], capabilities: { author: false, review: !handled.has(id(90)), withdraw: false, transfer: false, edit: false, delete: false },
})

const fixturePlugin = { name: 'isolated-executive-preview', configureServer(server) {
server.middlewares.use(async (req, res, next) => {
  const url = new URL(req.url, 'http://127.0.0.1:5174')
  if (url.pathname === '/__fixture') {
    role = roles.includes(url.searchParams.get('role')) ? url.searchParams.get('role') : '董事长'
    scenario = url.searchParams.get('scenario') || 'normal'
    handled.clear()
    calendarWeeks.clear()
    personalTodos = null
    nextTodoId = 500
    conflictSent = false
    res.writeHead(302, { Location: url.searchParams.get('home') ? '/' : '/projects/boss-dashboard' }); res.end(); return
  }
  if (!url.pathname.startsWith('/api/')) {
    // Keep the test-data disclosure visible without adding styling to the product.
    if (req.headers.accept?.includes('text/html')) {
      const html = (await readFile('index.html', 'utf8')).replace('<title>', '<title>【独立验收·虚拟数据】')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(await server.transformIndexHtml(req.url, html)); return
    }
    next(); return
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (req.method !== 'GET') {
    if (scenario.startsWith('calendar') && url.pathname.startsWith('/api/todos')) {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}, rows = todoRows()
      if (url.pathname === '/api/todos/personal/completed' && req.method === 'DELETE') {
        personalTodos = rows.filter(row => !(row.status === '已完成' && row.dueDate < url.searchParams.get('before')))
        res.end(JSON.stringify({ ok: true, archived: rows.length - personalTodos.length })); return
      }
      if (url.pathname === '/api/todos' && req.method === 'POST') {
        if (scenario === 'calendar-todo-error') { res.statusCode = 503; res.end(JSON.stringify({ message: '待办暂时无法保存，请重试' })); return }
        const row = { ...body, id: id(nextTodoId++), version: 1, approvalRequestId: null }
        rows.push(row); res.end(JSON.stringify(row)); return
      }
      const match = url.pathname.match(/^\/api\/todos\/([^/]+)$/), index = rows.findIndex(row => row.id === match?.[1])
      if (index >= 0 && req.method === 'DELETE') { rows.splice(index, 1); res.end(JSON.stringify({ ok: true })); return }
      if (index >= 0 && req.method === 'PATCH' && body.expectedVersion === rows[index].version) {
        const { expectedVersion, ...changes } = body
        rows[index] = { ...rows[index], ...changes, version: expectedVersion + 1 }
        res.end(JSON.stringify(rows[index])); return
      }
      res.statusCode = 409; res.end(JSON.stringify({ message: '待办已被更新' })); return
    }
    if (scenario.startsWith('calendar') && url.pathname.startsWith('/api/calendar/')) {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw), match = url.pathname.match(/^\/api\/calendar\/([^/]+)\/(save|cancel)$/)
      if (url.pathname === '/api/calendar/tasks') {
        if (scenario === 'calendar-sync') {
          todoRows().push({ id: id(nextTodoId++), title: body.title, detail: body.detail, startsAt: instant(body.startsAt), endsAt: instant(body.endsAt), dueDate: body.startsAt.slice(0,10), priority: '中', status: '未开始', projectId: null, projectName: null, owner: actor().name, ownerUserId: actor().id, type: '待办', approvalRequestId: null, version: 1, scheduleVersion: 1 })
          res.end(JSON.stringify({ ok: true })); return
        }
        const day = body.startsAt.slice(0, 10), week = new Date(Date.parse(`${day}T00:00:00Z`) - ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10)
        const rows = calendarRows(week)
        rows.push({ ...rows[0], id: id(300 + rows.length), key: `created:${rows.length}`, title: body.title, detail: body.detail, startsAt: instant(body.startsAt), endsAt: instant(body.endsAt) })
        res.end(JSON.stringify({ ok: true })); return
      }
      const taskMatch = url.pathname.match(/^\/api\/calendar\/tasks\/([^/]+)\/(schedule|cancel)$/)
      if (scenario === 'calendar-sync' && taskMatch) {
        const task = todoRows().find(row => row.id === taskMatch[1])
        if (!task || (body.sourceVersion ?? body.expectedTaskVersion) !== task.version || (body.expectedVersion ?? body.expectedScheduleVersion) !== (task.scheduleVersion ?? 0)) { res.statusCode = 409; res.end(JSON.stringify({message:'事项已更新，请核对'})); return }
        if (taskMatch[2] === 'cancel') personalTodos = todoRows().filter(row => row !== task)
        else Object.assign(task, { startsAt: instant(body.startsAt), endsAt: instant(body.endsAt), dueDate: body.startsAt.slice(0,10), scheduleVersion: (task.scheduleVersion ?? 0) + 1 })
        res.end(JSON.stringify({ok:true})); return
      }
      for (const rows of calendarWeeks.values()) {
        const index = rows.findIndex(row => row.id === match?.[1])
        if (index < 0) continue
        const row = rows[index]
        if (scenario === 'calendar-conflict' && !conflictSent) { conflictSent = true; row.version++; row.title = '其他成员已更新的安排'; res.statusCode = 409; res.end(JSON.stringify({message:'安排已被更新'})); return }
        if (!row.editable || row.version !== body.expectedVersion) { res.statusCode = 409; res.end(JSON.stringify({ message: '安排已被更新' })); return }
        if (match[2] === 'cancel') rows.splice(index, 1)
        else Object.assign(row, { ...body.definition, startsAt: instant(body.definition.startsAt), endsAt: instant(body.definition.endsAt), version: row.version + 1 })
        res.end(JSON.stringify({ ok: true })); return
      }
      res.statusCode = 400; res.end(JSON.stringify({ message: '独立验收未找到此安排' })); return
    }
    // Explicit synthetic scenario only. These writes change in-memory fixtures, never a database.
    const match = url.pathname.match(/^\/api\/oa\/(?:office\/)?requests\/([^/]+)\/actions$/)
    if (scenario.startsWith('approval') && match) {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw), row = [...approvals, officeRow()].find(row => row.id === match[1])
      if (!row || body.expectedVersion !== 1 || handled.has(row.id) || scenario === 'approval-conflict' || scenario === 'approval-deleted' && row.id === id(40)) { res.statusCode = 409; res.end(JSON.stringify({ code: 'VERSION_CONFLICT', message: '审批已被其他人更新' })); return }
      if (!['approve', 'return', 'reject'].includes(body.action) || String(body.comment || body.reason || '').trim().length < (body.action === 'return' ? 5 : 2)) { res.statusCode = 400; res.end(JSON.stringify({ message: '请填写审批意见' })); return }
      handled.set(row.id, body.action === 'approve' ? '已通过' : body.action === 'return' ? '已退回' : '已拒绝')
      res.end(JSON.stringify(row.businessType === 'office' ? { id: row.id, version: 2 } : { request: projectApproval(row) })); return
    }
    res.statusCode = 405; res.end(JSON.stringify({ message: '独立验收不支持此写入' })); return
  }
  const path = url.pathname.slice(4)
  if (scenario === 'calendar-error' && path === '/calendar') { res.statusCode = 503; res.end(JSON.stringify({ message: '日历暂时无法加载，请重试' })); return }
  if (scenario === 'error' && ['/projects', '/oa/center', '/risks', '/calendar', '/oa/workflow-logs'].includes(path)) {
    res.statusCode = 503; res.end(JSON.stringify({ message: '独立验收：服务不可用' })); return
  }
  if (scenario === 'partial' && path.endsWith('/directives')) { res.statusCode = 503; res.end(JSON.stringify({ message: '独立验收：督办暂不可用' })); return }
  const rows = scenario === 'empty' ? [] : scenario === 'many' ? projects : projects.slice(0, 3)
  let body = { list: [], total: 0 }
  if (path === '/auth/me') {
    if (scenario === 'logged-out') { res.statusCode = 401; res.end(JSON.stringify({ message: '请登录' })); return }
    body = { user: actor() }
  }
  else if (path === '/todos') body = { list: todoRows().filter(row => (!url.searchParams.has('dateFrom') || row.dueDate >= url.searchParams.get('dateFrom')) && (!url.searchParams.has('dateTo') || row.dueDate <= url.searchParams.get('dateTo')) && (url.searchParams.get('includeCompleted') === 'true' || row.status !== '已完成')) }
  else if (path === '/projects') body = { list: rows, total: rows.length, pageSize: 100, page: 1, counts: { normal: 1, key: 2 } }
  else if (path === '/projects/creation-roster') body = { people: rows.map((p, i) => ({ id: p.ownerUserId, name: p.owner, department: i < 2 ? '投资部' : '法务部' })) }
  else if (path === '/oa/requests') body = { list: approvals.slice(0, rows.length).map(projectApproval) }
  else if (path === `/oa/office/requests/${id(90)}`) body = officeDetail()
  else if (path.endsWith('/executions')) body = { canRecord: false, blockedReason: '本申请无待办理事项', records: [], hiddenRecords: 0, fields: [], requiredFields: [], latestId: null, hasMore: false }
  else if (path === '/oa/center') {
    const all = [...approvals.slice(0, rows.length).filter(row => scenario !== 'approval-deleted' || row.id !== id(40)), ...(scenario.startsWith('approval') ? [officeRow()] : [])]
    const list = all.filter(row => url.searchParams.get('view') === 'pending' ? !handled.has(row.id) : handled.has(row.id))
    const page = Number(url.searchParams.get('page') || 1), pageSize = Number(url.searchParams.get('pageSize') || 5)
    body = { list: list.slice((page - 1) * pageSize, page * pageSize), total: list.length, page, pageSize, counts: { pending: all.filter(row => !handled.has(row.id)).length }, kinds: [], canCreateOffice: false }
  }
  else if (path === '/risks') body = { list: risks.slice(0, rows.length) }
  else if (path === '/oa/workflow-logs') body = { list: rows.map(p => ({ id: `${p.id}-log`, requestId: p.id, projectId: p.id, fromStage: '立项', toStage: p.stage, operator: p.owner, comment: '', source: 'OA审批', createdAt: stamp })) }
  else if (path === '/calendar') body = { items: scenario.startsWith('calendar') ? calendarRows(url.searchParams.get('weekStart') || today) : rows.length ? [{ id: id(70), key: 'meeting:1', source: 'meeting', title: '商业航天项目沟通会', projectId: projects[2].id, projectName: projects[2].name, startsAt: `${today}T06:00:00Z`, target: `/projects/${projects[2].id}?tab=collaboration`, ownerName: '验收账号' }] : [] }
  else if (path === `/meetings/${id(70)}`) {
    if (scenario === 'meeting-error') { res.statusCode = 403; res.end(JSON.stringify({ message: '无权查看会议' })); return }
    body = { id: id(70), version: 1, title: '商业航天项目沟通会', projectId: projects[2].id, projectName: projects[2].name, meetingTime: `${today}T06:00:00Z`, meetingEndTime: `${today}T07:00:00Z`, participants: ['验收账号', '王经理'], type: '项目沟通会', status: '待开始', purpose: '确认本轮尽调进展与需要协调的问题。', requirements: '请准备关键技术测试结果。', summary: '', conclusions: [], todoCount: 0 }
  }
  else if (path === '/workbench') body = { actorId: actor().id, name: actor().name, view: role === '系统管理员' ? 'admin' : role === '未分配岗位' ? 'unassigned' : ['董事长', '合伙人', '总裁'].includes(role) ? 'leader' : 'member', perspective: '验收', specialty: '', asOf: stamp, today, weekStart: today, metrics: [], projects: [], actions: scenario.startsWith('calendar') ? projects.slice(0, 2).map((p, i) => ({ id: tasks(p)[0].id, title: tasks(p)[0].title, projectId: p.id, projectName: p.name, ownerUserId: actor().id, dueDate: calendarDate(today, i + 1), status: '进行中', to: `/projects/${p.id}?tab=tasks` })) : [], attention: [], capacity: null, warnings: [] }
  else {
    const p = projects.find(p => path === `/projects/${p.id}` || path.startsWith(`/projects/${p.id}/`))
    if (p && path === `/projects/${p.id}`) body = p
    if (p && path.endsWith('/fde-tasks')) body = { tasks: tasks(p).map(task => ({ ...task, capabilities: { canFeedback: true, canAccept: false, canExtend: true, canCancel: false } })), members: [], reviewers: [{ id: actor().id, name: actor().name }], canAssign: false, canSyncPlan: false, planSyncIssue: { count: 0, items: [] }, canSyncTimeline: false }
    const taskProject = projects.find(p => path === `/tasks/${tasks(p)[0].id}`)
    if (taskProject) {
      const task = tasks(taskProject)[0]
      body = { ...task, category: 'project', source: 'plan', sourceLabel: '倒排计划', status: 'in_progress', statusLabel: '进行中', rawStatus: task.status, primaryAction: 'in_progress', primaryActionLabel: '提交成果', project: { id: taskProject.id, name: taskProject.name }, owner: { id: task.ownerUserId, name: task.owner }, feedbacks: [], attachments: [], history: [], acceptance: null, calendar: null, capabilities: { canStart: false, canSubmit: true, canAccept: false, canFeedback: true, canExtend: true, canCancel: false, canEditParticipants: false } }
    }
    if (p && path.endsWith('/fde-workflow')) body = { timeline: [{ stage: p.stage, date: today, basis: 'approved' }], members: [{ id: p.ownerUserId, name: p.owner }] }
    if (p && path.endsWith('/directives')) body = { list: [{ id: `${p.id}-directive`, issuerId: actor().id, content: '跟进关键问题并反馈处理结果', createdAt: stamp, withdrawnAt: null, task: { ...tasks(p)[0], title: '跟进关键问题并反馈处理结果', dueDate: projects.indexOf(p) === 0 ? yesterday : today, status: projects.indexOf(p) === 2 ? '已完成' : '进行中', progress: projects.indexOf(p) === 2 ? 100 : 65 } }] }
  }
  if (path === '/calendar' && scenario === 'calendar-sync') {
    const week = url.searchParams.get('weekStart') || today
    body.items = [...body.items, ...todoRows().filter(row => row.dueDate >= week && row.dueDate < calendarDate(week,7) && row.status !== '已完成').map(row => ({id:row.id,key:`task:${row.id}`,source:'task',title:row.title,detail:row.detail || '',projectId:null,ownerId:actor().id,ownerName:actor().name,startsAt:row.startsAt || instant(`${row.dueDate}T09:00`),endsAt:row.endsAt || instant(`${row.dueDate}T10:00`),allDay:false,version:row.scheduleVersion??0,sourceVersion:row.version,editable:true,target:null}))]
  }
  res.end(JSON.stringify(body))
})
} }
const server = await createServer({
  configFile: false, envFile: false, plugins: [react(), fixturePlugin],
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
})
await server.listen()
console.log('Isolated fixture UI: http://127.0.0.1:5174/__fixture — no database connection or business writes')
