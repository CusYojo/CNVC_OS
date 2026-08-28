// Isolated visual fixture. No .env, database, business proxy or successful writes.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import ts from 'typescript'
import tailwindConfig from '../tailwind.config.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), referenceRoot = resolve(root, '../赛智伯乐FDE')
const uid = '00000000-0000-4000-8000-000000000001'
const user = { id: uid, name: '陈斌', email: 'visual@example.invalid', role: '机构领导', department: '视觉夹具' }
const labels = { leader: ['风险项目', '今日需出场', '待配置时间', '待我审批', '待反馈材料'], lead: ['负责项目', '待确认计划', '待验收成果', '资源冲突', '待升级问题'], member: ['我的行动', '待反馈', '参与项目', '当前阻塞', '即将到期'], secretary: ['推进项目', '今日催办', '成员未反馈', '周五例会', '时间需求'], coordinator: ['时间需求', '待汇总', '日程冲突', '已确认时长', '待补信息'], specialist: ['待法务审核', '法务行动', '相关项目', '合同风险', '待归档协议'], admin: ['在职成员', '权限策略', '临时授权', '安全事件'] }
const projects = ['星澜机器人', '智芯微电子', '云岚新材料', '嘉禾生物'].map((name, i) => ({ id: `project-${i}`, name, owner: '周亦航', ownerUserId: uid, secretary: '沈嘉言', secretaryId: uid, classification: 'key', health: ['存在风险', '需关注', '正常', '正常'][i], priority: `P${Math.min(i, 2)}`, targetDate: '2026-09-18', related: true, done: i, total: 3, leaderParticipation: i === 0 ? '今日 1 项' : '无需参与' }))
const actions = projects.flatMap((p, i) => ['完成财务敏感性分析复核', '回收核心客户访谈纪要', '形成法务问题闭环清单'].map((title, j) => ({ id: `action-${i}-${j}`, projectId: p.id, projectName: p.name, title, ownerUserId: uid, dueDate: '2026-08-28', status: j < i ? '已完成' : '进行中', to: `/projects/${p.id}?tab=tasks`, owner: user.name, due: '8月28日' })))
projects.forEach(p => { p.actions = actions.filter(a => a.projectId === p.id) })
const attention = [{ id: 'approval-1', title: '确认智芯微电子投决材料', detail: '智芯微电子 · 终审', icon: '审', to: '/workflow?view=pending' }, { id: 'time-1', title: '参加星澜机器人专项讨论', detail: '星澜机器人 · 2026-08-28 14:00 · 60 分钟', icon: '时', to: '/collaboration?view=time', status: '待确认' }]
function payload(view, scenario) {
  return { actorId: uid, name: user.name, view, perspective: ({ leader: '机构领导', lead: '项目负责人', member: '项目成员', secretary: '推进秘书', specialist: '法务', coordinator: '时间协调', admin: '配置权限', unassigned: '未绑定业务角色' })[view] + '视角', specialty: '法务', asOf: '2026-08-28T06:32:00Z', today: '2026-08-28', weekStart: '2026-08-24', metrics: (labels[view] ?? []).map((label, i) => ({ label, value: scenario === 'empty' ? 0 : i === 4 ? null : [4, 1, 3, 2][i], note: '隔离视觉样本；非业务统计', tone: ['danger', 'success', 'warning', 'info', 'purple'][i], to: '/collaboration' })), projects: scenario === 'empty' || ['admin', 'coordinator', 'unassigned'].includes(view) ? [] : projects, actions: scenario === 'empty' ? [] : actions.filter(a => a.status !== '已完成').slice(0, 6), attention: scenario === 'empty' ? [] : attention, capacity: { requested: 240, confirmed: 120, pending: 2, conflicts: 1 }, warnings: view === 'unassigned' ? ['尚未绑定有效 FDE 角色，请联系管理员核对角色映射。'] : [] }
}
const source = await readFile(resolve(referenceRoot, 'site.js'), 'utf8')
const ast = ts.createSourceFile('site.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const wanted = new Set(['badge', 'pageHeading', 'metricCard', 'projectActionMatrix', 'statusTone', 'roleWorkbenchPage'])
const renderer = ast.statements.flatMap(statement => {
  if (ts.isFunctionDeclaration(statement) && wanted.has(statement.name?.text)) return [statement.getText(ast)]
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.filter(d => wanted.has(d.name.getText(ast))).map(d => `const ${d.getText(ast)};`)
  return []
}).join('\n')
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
function reference(view) {
  const data = payload(view), role = { key: view === 'specialist' ? 'finance' : view, name: user.name, perspective: data.perspective }
  const p = projects.map(row => ({ ...row, logo: row.name.slice(0, 1), healthTone: row.health === '存在风险' ? 'danger' : row.health === '需关注' ? 'warning' : 'success', leaderPriority: row.priority, groupLead: row.owner, finalDate: row.targetDate, weeklyDone: row.done, weeklyTotal: row.total, memberNames: [user.name], nextWeekly: '推进本周工作' }))
  const time = [{ id: 'time-1', title: attention[1].title, projectId: p[0].id, leader: user.name, preferred: '周五 14:00', scheduledStart: '2026-08-28T14:00', duration: 60, status: '待确认', priority: 'P0', conflict: '', submittedBy: user.name }]
  const sandbox = { roles: [role], state: { roleIndex: 0, accessRequests: [] }, currentIdentity: () => ({ name: user.name, perspective: data.perspective }), visibleProjects: () => p, projects: p, weeklyActions: actions, canAccessProject: () => true, projectForId: id => p.find(p => p.id === id), actionRecordClosed: () => false, actionBelongsToCurrentWorkWeek: () => true, visibleApprovals: () => [{ ...attention[0], projectId: p[1].id, node: '终审', status: '待审批', tone: 'warning', amount: '授权审核事项', duration: '今天' }], canApproveApproval: () => true, leadershipRequests: time, leadershipRequestInCurrentWeek: () => true, leadershipRequestClosed: () => false, leaderTodayRequests: () => time, currentWeekLeaderRequests: () => time, materialSubmissions: [], pendingDirectivesForRole: () => [], ensureMaterialRecipientState: () => [], leadershipSummary: () => ({ pending: time, requestedMinutes: 60, conflicts: [] }), authState: { account: { specialty: 'legal' } }, directives: [], can: () => false, organizationPeople: Array(4).fill({}), actionsForProject: id => actions.filter(a => a.projectId === id), PRODUCT_WEEK_START: '2026-08-24', PRODUCT_WEEK_END: '2026-08-30', CURRENT_WEEKDAY: '周五', escapeHtml, projectLogo: (p, tone) => `<span class="project-logo ${tone}">${p.logo}</span>`, shortDate: () => '9月18日', finalCountdownLabel: () => '剩余 21 天' }
  sandbox.escapeAttr = escapeHtml
  return vm.runInNewContext(renderer + '\nroleWorkbenchPage()', sandbox, { timeout: 1000 })
}
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import{DashboardPage}from'./src/pages/DashboardPage';import{useAuthStore}from'./src/store/useAuthStore';useAuthStore.getState().setAuth({user:${JSON.stringify(user)}});createRoot(document.getElementById('root')).render(<BrowserRouter><div className="fde-app"><main className="fde-page-content"><DashboardPage/></main></div></BrowserRouter>);`
const bundle = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root }, bundle: true, write: false, outdir: '/visual-fixture', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' })
const js = bundle.outputFiles.find(f => f.path.endsWith('.js')).text
const baseCss = (await postcss([tailwindcss({ ...tailwindConfig, content: [resolve(root, 'src/**/*.{ts,tsx}')] }), autoprefixer]).process(await readFile(resolve(root, 'src/styles.css'), 'utf8'), { from: resolve(root, 'src/styles.css') })).css
const css = baseCss + await readFile(resolve(root, 'src/layout/fde-shell.css'), 'utf8') + bundle.outputFiles.filter(f => f.path.endsWith('.css')).map(f => f.text).join('\n')
const referenceCss = await readFile(resolve(referenceRoot, 'site.css'), 'utf8')
const metricsJs = `if(location.pathname==='/compare'){addEventListener('message',e=>{if(e.origin!==location.origin||e.data?.kind!=='workbench-layout')return;let p=document.querySelector('pre[data-name="'+e.data.name+'"]');if(!p){p=document.createElement('pre');p.dataset.name=e.data.name;document.body.append(p)}p.textContent=JSON.stringify(e.data)})}else{const report=()=>{const grid=document.querySelector('.workspace-grid');if(!grid)return;parent.postMessage({kind:'workbench-layout',name:location.pathname==='/reference'?'reference':'current',viewport:innerWidth,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,columns:getComputedStyle(grid).gridTemplateColumns,items:[...document.querySelectorAll('h1,.compact-metric,.card')].map(e=>({text:e.tagName,x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height,font:getComputedStyle(e).fontSize}))},location.origin)};addEventListener('load',()=>setTimeout(report,1000))}`
const fixtureStyle = 'html,body{min-width:0;margin:0}body{padding-bottom:0}.fixture-frame{margin-left:244px;padding-top:64px}.fixture-label{position:fixed;bottom:8px;right:10px;z-index:9999;background:#fff9df;padding:4px 8px;font:11px system-ui;color:#756020}@media(max-width:900px){.fixture-frame{margin-left:0}}'
let requests = 0, rejectedWrites = 0
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1'), path = url.pathname
  const send = (status, type, body) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'" }); res.end(body) }
  if (!['GET', 'HEAD'].includes(req.method)) { rejectedWrites++; return send(503, 'application/json', JSON.stringify({ message: '视觉夹具禁止写入' })) }
  if (path.startsWith('/api/')) {
    requests++
    const params = new URL(req.headers.referer ?? '/', 'http://127.0.0.1').searchParams, scenario = params.get('fixture'), view = labels[params.get('view')] || params.get('view') === 'unassigned' ? params.get('view') : 'leader'
    if (path === '/api/auth/me') return send(200, 'application/json', JSON.stringify({ user: scenario === 'changed-account' ? { ...user, id: 'another-account' } : user }))
    if (path === '/api/workbench' && scenario !== 'error') return send(200, 'application/json', JSON.stringify(payload(view, scenario)))
    return send(503, 'application/json', JSON.stringify({ message: '隔离视觉夹具：接口暂不可用' }))
  }
  if (path === '/app.js') return send(200, 'text/javascript', js)
  if (path === '/app.css') return send(200, 'text/css', css)
  if (path === '/reference.css') return send(200, 'text/css', referenceCss)
  if (path === '/metrics.js') return send(200, 'text/javascript', metricsJs)
  const view = labels[url.searchParams.get('view')] ? url.searchParams.get('view') : 'leader'
  if (path === '/compare') {
    const width = Math.max(320, Math.min(1920, Number(url.searchParams.get('width')) || 390))
    return send(200, 'text/html', `<!doctype html><html><meta charset="utf-8"><title>工作台响应式对照</title><script src="/metrics.js"></script><body style="margin:0"><iframe title="迁移版" src="/?view=${view}" style="width:${width}px;height:1000px;border:0"></iframe><iframe title="原版" src="/reference?view=${view}" style="width:${width}px;height:1000px;border:0"></iframe></body></html>`)
  }
  const isReference = path === '/reference'
  try { return send(200, 'text/html', `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>工作台 · ${isReference ? 'FDE原版' : '迁移版'}隔离视觉夹具</title><link rel="stylesheet" href="${isReference ? '/reference.css' : '/app.css'}"><style>${fixtureStyle}</style><script src="/metrics.js"></script><body><div class="fixture-frame">${isReference ? '<main id="pageContent">' + reference(view) + '</main>' : '<div id="root"></div>'}</div><div class="fixture-label">隔离视觉夹具 · 非业务数据</div>${isReference ? '' : '<script type="module" src="/app.js"></script>'}</body></html>`) }
  catch (error) { return send(500, 'text/plain', error.message) }
})
for (const view of Object.keys(labels)) reference(view)
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, pid: process.pid, database: 'none', writes: 'always rejected' })))
const stop = () => server.close(() => { console.log(JSON.stringify({ stopped: true, requests, rejectedWrites })); process.exit(0) })
process.on('SIGTERM', stop); process.on('SIGINT', stop)
