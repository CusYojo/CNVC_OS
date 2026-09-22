// Isolated meeting UI acceptance: synthetic in-memory data only, no .env or API proxy.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile } from 'node:fs/promises'

const uid = '00000000-0000-4000-8000-000000000001'
const actor = { id: uid, name: '会议验收账号', email: 'meeting@example.invalid', role: '投资经理', department: '投资部', status: '启用', permissionCodes: [] }
const projects = ['项目甲', '项目乙'].map((name, i) => ({ id: `project-${i}`, name, companyName: name, version: 1, classification: 'normal', lifecycle: 'active', workflowModel: 'fde-v1', ownerUserId: uid, owner: actor.name, collaborators: [], tags: [], stage: '尽调', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }))
let scenario = 'normal', meetings = [], calls = []
function reset() {
  calls = []
  meetings = ['A', 'B'].map((name, i) => ({ id: name, projectId: projects[i].id, projectName: projects[i].name, title: `独立验收会议 ${name}`, version: 1, meetingTime: '2090-01-01T01:00:00Z', meetingEndTime: '2090-01-01T02:00:00Z', participants: [actor.name], host: actor.name, type: '项目沟通会', status: '待开始', purpose: '仅供内存验收', requirements: '', summary: '', conclusions: [], rawText: '', todoCount: 0, contributions: [], unreadNoticeId: `notice-${name}`, canContribute: true, canManage: true, canDelete: true, minutesConfirmedAt: null }))
}
reset()
const plugin = { name: 'isolated-meeting-preview', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    const url = new URL(req.url, 'http://127.0.0.1:5176')
    const json = (body, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)) }
    if (url.pathname === '/__fixture') { scenario = url.searchParams.get('scenario') || 'normal'; reset(); res.writeHead(302, { Location: '/meetings?meeting=A' }); res.end(); return }
    if (url.pathname === '/__evidence') { json({ calls, meetings }); return }
    if (!url.pathname.startsWith('/api/')) {
      if (req.headers.accept?.includes('text/html')) { const html = (await readFile('index.html', 'utf8')).replace('<title>', '<title>【隔离会议验收】'); res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await server.transformIndexHtml(req.url, html)); return }
      next(); return
    }
    const path = url.pathname.slice(4)
    if (req.method === 'GET') {
      if (path === '/auth/me') { json({ user: actor }); return }
      if (path === '/projects') { json({ list: projects }); return }
      if (path === '/meetings') { json({ list: meetings }); return }
      const match = path.match(/^\/meetings\/([^/]+)$/)
      if (match) { const meeting = meetings.find(item => item.id === match[1]); if (!meeting || scenario === 'missing' && match[1] === 'B') json({ code: 'NOT_FOUND', message: '会议不存在或已删除' }, 404); else json(meeting); return }
      if (path.endsWith('/members')) { json({ list: [{ userId: uid, name: actor.name, role: '项目负责人', status: '启用' }] }); return }
      if (path === '/todos') { json({ list: [{ id: 'directive-task', projectId: 'project-0', title: '已撤回的批示仍有提醒', owner: actor.name, ownerUserId: uid, status: '已取消', directiveId: 'directive', directiveNoticeId: calls.some(call => call.path.includes('directive-notices')) ? null : 'directive-notice', type: '待办', version: 1 }] }); return }
      json({ list: [], total: 0 }); return
    }
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    calls.push({ method: req.method, path, body })
    const readMatch = path.match(/^\/meetings\/([^/]+)\/notices\/([^/]+)\/read$/)
    if (readMatch) { if (scenario === 'read-fails') { json({ code: 'TEMPORARY', message: '暂时无法标记已读' }, 503); return }; const meeting = meetings.find(item => item.id === readMatch[1]); if (meeting) meeting.unreadNoticeId = null; json({ read: true }); return }
    const contribution = path.match(/^\/meetings\/([^/]+)\/contributions$/)
    if (contribution) {
      const meeting = meetings.find(item => item.id === contribution[1])
      if (!meeting || body.expectedVersion !== meeting.version) { json({ code: 'VERSION_CONFLICT', message: '会议已变更' }, 409); return }
      meeting.contributions.push({ id: `entry-${calls.length}`, authorId: uid, authorName: actor.name, content: body.content, files: [], createdAt: new Date().toISOString() }); meeting.version += 1
      json(meeting); return
    }
    if (path.includes('/directive-notices/') || path === '/audit-logs') { json({ ok: true }); return }
    json({ message: '隔离验收不支持此写入' }, 405)
  })
} }
const server = await createServer({ configFile: false, envFile: false, cacheDir: 'node_modules/.vite-meeting-preview', plugins: [react(), plugin], server: { host: '127.0.0.1', port: 5176, strictPort: true } })
await server.listen()
console.log('Isolated meeting UI: http://127.0.0.1:5176/__fixture (memory only)')
process.on('SIGINT', async () => { await server.close(); process.exit(0) })
