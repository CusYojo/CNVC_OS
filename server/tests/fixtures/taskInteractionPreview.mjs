// Isolated in-memory task UI acceptance. No env files, database, or upstream proxy.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const actor = { id: id(1), name: '任务验收账号', role: '投资经理', department: '隔离验收', status: '启用', permissionCodes: [] }
const project = { id: id(10), name: '隔离任务验收项目', workflowModel: 'fde-v1', lifecycle: 'active', targetDate: '2026-12-31' }
const file = { id: id(30), name: '客户访谈记录.txt', version: 2 }
let scenario = 'normal', tasks, writes, downloads, conflict
function reset() {
  writes = []; downloads = []; conflict = false
  tasks = ['开始执行样本', '核对客户访谈成果', '更新项目研究进度'].map((title, index) => ({ id: id(20 + index), title, owner: index === 1 && scenario !== 'owner' ? '成果提交人' : actor.name, ownerUserId: index === 1 && scenario !== 'owner' ? id(2) : actor.id, participantUserIds: [actor.id], participants: [{ id: actor.id, name: actor.name }], dueDate: '2026-12-01', dueTime: '17:00', version: 1, status: ['未开始', '待验收', '进行中'][index], progress: index === 1 ? 100 : 0, executionModel: 'fde-v1', deliverable: '提交访谈记录与核对结论', timelineSource: null, planActionId: null, directiveId: null, extensions: [], feedbacks: index === 1 ? [{ id: id(40), kind: 'submission', result: '已完成三家客户访谈，订单金额已逐笔核对。', blocker: '', progress: 100, submittedAt: '2026-09-22T01:00:00Z', evidence: [{ fileId: file.id, version: 1 }], acceptance: null }] : [] }))
}
function caps(task) { return { canFeedback: task.ownerUserId === actor.id && ['未开始', '进行中', '已退回'].includes(task.status), canAccept: task.ownerUserId !== actor.id && task.status === '待验收', canExtend: task.ownerUserId === actor.id && !['已完成', '已取消'].includes(task.status), canCancel: task.status !== '已取消' } }
const data = () => ({ tasks: tasks.map(task => ({ ...task, capabilities: caps(task) })), members: [actor], reviewers: [{ id: id(2), name: '验收领导' }], canAssign: true, canSyncPlan: false, planSyncIssue: { count: 0, items: [] }, canSyncTimeline: false, timelinePending: { count: 0, items: [] } })
reset()
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';import {ToastProvider} from '/src/components/Toast';import {TaskActionHost} from '/src/components/TaskActionHost';import {FdeTaskPanel} from '/src/components/FdeTaskPanel';import {useAuthStore} from '/src/store/useAuthStore';import {openTaskAction} from '/src/lib/taskWorkspace';import '/src/styles.css';import '/src/layout/fde-shell.css';useAuthStore.getState().setAuth({user:${JSON.stringify(actor)}});const project=${JSON.stringify(project)};createRoot(document.getElementById('root')).render(<BrowserRouter><ToastProvider><main className="page-wrap"><h1 className="mb-5 text-xl font-semibold">独立任务验收 · 仅内存数据</h1><div className="mb-5 flex flex-wrap gap-3">${[['开始一次', 20, 'start'], ['验收成果', 21, 'accept'], ['查看待验收任务', 21, 'view'], ['填写进度', 22, 'progress']].map(([label, n, action]) => `<button className="button" onClick={()=>openTaskAction(project.id,'${id(n)}','${action}')}>${label}</button>`).join('')}</div><FdeTaskPanel project={project} files={[${JSON.stringify(file)}]} onChanged={async()=>{}}/><TaskActionHost/></main></ToastProvider></BrowserRouter>);`
const plugin = {
  name: 'isolated-task-interaction-preview',
  resolveId(source) { if (source === '/__task_fixture.tsx') return source },
  load(source) { if (source === '/__task_fixture.tsx') return entry },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://127.0.0.1:5175')
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
      if (url.pathname === '/__fixture') { scenario = url.searchParams.get('scenario') || 'normal'; reset(); res.writeHead(302, { Location: '/' }); res.end(); return }
      if (url.pathname === '/__state') return send(200, { scenario, writes, downloads, tasks })
      if (!url.pathname.startsWith('/api/')) {
        if (req.headers.accept?.includes('text/html')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await server.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>独立任务验收（非业务数据）</title></head><body><div id="root"></div><script type="module" src="/__task_fixture.tsx"></script></body></html>')); return }
        next(); return
      }
      const path = url.pathname.slice(4)
      const task = tasks.find(item => path.includes(item.id))
      if (req.method === 'GET') {
        if (path === '/auth/me') return send(200, { user: actor })
        if (path === `/projects/${project.id}`) return send(200, project)
        if (path === `/projects/${project.id}/files`) return send(200, { list: [file] })
        if (path.endsWith('/fde-tasks')) return send(200, data())
        if (path === `/projects/files/${file.id}/versions/1/download`) { downloads.push(path); res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="evidence.txt"' }); res.end('隔离成果提交版本 1；不是当前文件版本 2。'); return }
        if (task && path.startsWith('/tasks/')) {
          const status = ({ 未开始: 'not_started', 进行中: 'in_progress', 待验收: 'pending_acceptance', 已完成: 'completed', 已退回: 'returned' })[task.status]
          return send(200, { ...task, rawStatus: task.status, status, source: 'project', category: 'project', sourceLabel: '项目分配', primaryAction: status, primaryActionLabel: ({ not_started: '开始任务', in_progress: '提交成果', pending_acceptance: '验收', completed: '查看成果', returned: '重新提交' })[status], project, owner: { id: task.ownerUserId, name: task.owner }, feedbacks: task.feedbacks.map(feedback => ({ ...feedback, evidence: feedback.evidence.map(evidence => ({ ...evidence, name: file.name })) })), history: [], attachments: [], calendar: null, acceptance: null, capabilities: { ...caps(task), canStart: caps(task).canFeedback && status === 'not_started', canSubmit: caps(task).canFeedback } })
        }
        return send(404, { message: '夹具未定义此只读接口' })
      }
      if (req.method !== 'POST' || !task || !path.startsWith(`/projects/${project.id}/fde-tasks/`)) return send(405, { message: '隔离夹具不支持此操作' })
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw), action = path.split('/').at(-1)
      writes.push({ action, taskId: task.id, body })
      if (scenario === 'conflict' && action === 'feedback' && !conflict) { conflict = true; task.version++; return send(409, { code: 'VERSION_CONFLICT', message: '任务已被其他人更新' }) }
      if (body.expectedVersion !== task.version) return send(409, { code: 'VERSION_CONFLICT', message: '版本已变化' })
      if (action === 'start' && caps(task).canFeedback && task.status === '未开始') { task.status = '进行中'; task.progress = 1 }
      else if (action === 'acceptance' && caps(task).canAccept && ['accept', 'return'].includes(body.action) && body.reason.trim().length >= 2) { task.status = body.action === 'return' ? '已退回' : '已完成'; task.feedbacks[0].acceptance = { decision: body.action, reason: body.reason } }
      else if (action === 'feedback' && caps(task).canFeedback) { task.status = body.kind === 'submission' ? '待验收' : '进行中'; task.feedbacks.unshift({ ...body, id: id(50 + writes.length), submittedAt: new Date().toISOString(), evidence: body.evidence ?? [], acceptance: null }) }
      else return send(403, { message: '当前角色不能进行此操作' })
      task.version++; return send(200, data())
    })
  },
}
const server = await createServer({ configFile: false, envFile: false, plugins: [react(), plugin], server: { host: '127.0.0.1', port: 5175, strictPort: true } })
await server.listen()
console.log('Task fixture: http://127.0.0.1:5175/__fixture — isolated in-memory only')
