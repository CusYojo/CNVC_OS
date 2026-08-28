// Read-only visual fixture: no .env, DB, business proxy or successful write endpoint.
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const referenceRoot = resolve(root, '../赛智伯乐FDE')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const user = { id: id(1), name: '沈嘉言', email: 'visual@example.invalid', role: '投资经理', department: '视觉夹具' }
const samples = [
  ['行业资讯', '工业机器人高精度减速器产业跟踪', '汇总产能、国产化率与头部客户验证进度，可作为机器人项目赛道判断的共享参考。', '沈嘉言', 4.8, 12],
  ['方法论', '早期科技项目内核材料清单', '由三个已结案项目复盘沉淀的内核材料模板，包含风险闭环、条款边界与委员意见回复要求。', '周亦航', 4.9, 18],
  ['新闻链接', '天津智能制造专项政策更新', '政策原文与项目申报窗口整理，供产业合作与政府落地项目查阅。', '顾清越', 4.6, 7],
]
const entries = samples.map(([kind, title, summary, authorName, rating, ratings], index) => ({ id: id(index + 10), authorId: id(index + 1), authorName, kind, title, summary, link: '', audience: 'company', status: 'published', version: 1, updatedAt: '2026-08-28T03:26:00Z', rating, ratings, commentCount: 0, file: null, capabilities: { edit: index === 0, manageAudience: index === 0, publish: false, archive: index === 0, interact: true, download: true } }))
const archives = ['商业计划书.pdf', '内核材料清单.docx', '访谈纪要.pdf'].map((name, index) => ({ id: id(index + 20), projectId: id(30), projectName: '星澜科技', workflowModel: 'investment', name, type: index === 1 ? 'DOCX' : 'PDF', category: index === 1 ? '内核材料' : '项目材料', uploader: samples[index][3], uploadedAt: '2026-08-28T03:26:00Z', byteSize: 1048576, sha256: null, version: 1, accessVersion: 1, parseStatus: 'pending', hasOriginal: true, canDownload: index !== 2, canAudit: false }))
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const source = await readFile(resolve(referenceRoot, 'site.js'), 'utf8')
const ast = ts.createSourceFile('site.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const wanted = new Set(['badge', 'pageHeading', 'insightsKnowledgeView', 'insightsArchiveView', 'insightsScoreView', 'insightsPage'])
const renderSource = ast.statements.flatMap(statement => {
  if (ts.isFunctionDeclaration(statement) && wanted.has(statement.name?.text)) return [statement.getText(ast)]
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.filter(d => wanted.has(d.name.getText(ast))).map(d => `const ${d.getText(ast)};`)
  return []
}).join('\n')
const referenceCss = await readFile(resolve(referenceRoot, 'site.css'), 'utf8')
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {BrowserRouter} from 'react-router-dom';
import {ToastProvider} from './src/components/Toast'; import {DataKnowledgePage} from './src/pages/DataKnowledgePage';
import {useAuthStore} from './src/store/useAuthStore';
useAuthStore.getState().setAuth({user:${JSON.stringify(user)}});
createRoot(document.getElementById('root')).render(<BrowserRouter><ToastProvider><div className="fde-app"><main className="fde-page-content"><DataKnowledgePage/></main></div></ToastProvider></BrowserRouter>);`
const bundled = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root }, bundle: true, write: false, outdir: '/visual-fixture', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' })
const js = bundled.outputFiles.find(file => file.path.endsWith('.js')).text
const baseCss = (await postcss([tailwindcss({ ...tailwindConfig, content: [resolve(root, 'src/**/*.{ts,tsx}')] }), autoprefixer]).process(await readFile(resolve(root, 'src/styles.css'), 'utf8'), { from: resolve(root, 'src/styles.css') })).css
const css = baseCss + '\n' + await readFile(resolve(root, 'src/layout/fde-shell.css'), 'utf8') + '\n' + bundled.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n')
const metricsJs = `if (location.pathname === '/compare') {
  addEventListener('message', event => { if (event.origin !== location.origin || event.data?.kind !== 'visual-layout') return; let output = document.querySelector('pre[data-name="'+event.data.name+'"]'); if (!output) { output = document.createElement('pre'); output.dataset.name = event.data.name; document.body.append(output); } output.textContent = JSON.stringify(event.data); });
} else {
  const report = () => { const grid = document.querySelector('.fde-knowledge-grid,.knowledge-grid'); if (!grid) return;
    parent.postMessage({kind:'visual-layout',name:location.pathname === '/reference'?'reference':'current',viewport:innerWidth,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,columns:getComputedStyle(grid).gridTemplateColumns,items:[...document.querySelectorAll('h1,.fde-workspace-tabs,.workspace-tabs,.fde-knowledge-card,.knowledge-card')].map(e=>({text:e.tagName,x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height,font:getComputedStyle(e).fontSize}))},location.origin); };
  addEventListener('load',()=>setTimeout(report,800));
}`
let requests = 0, rejectedWrites = 0
const fixtureStyle = 'html,body{min-width:0;margin:0}body{padding-bottom:0}.fixture-frame{margin-left:244px;padding-top:64px}.fixture-label{position:fixed;bottom:8px;right:10px;z-index:9999;background:#fff9df;padding:4px 8px;font:11px system-ui;color:#756020;border:1px solid #dacda8;border-radius:4px}@media(max-width:900px){.fixture-frame{margin-left:0}}'
function renderReference(view) {
  const sandbox = { roles: [{ key: 'leader', name: user.name }], state: { roleIndex: 0, insightsView: view === 'archives' ? '项目档案' : view === 'responsibility' ? '管理参考' : '公司知识库' }, can: () => true, escapeHtml: escape, escapeAttr: escape, fileIndexNotice: () => '', canAccessFile: () => true, canUseFile: file => file.canDownload, fileCategory: file => file.category,
    knowledgeItems: entries.map(e => ({ ...e, author: e.authorName, updated: '2026/8/28', scope: '公司业务成员可见', editableBy: [] })),
    files: archives.map(f => ({ ...f, project: f.projectName, owner: f.uploader, meta: `${f.type} · 1.0 MB · V1` })), scoreLedger: [], scoreRules: [] }
  return vm.runInNewContext(renderSource + '\ninsightsPage()', sandbox, { timeout: 1000 })
}
function result(path, params, scenario) {
  if (path === '/api/auth/me') return { user }
  if (path === '/api/data-knowledge/capabilities') return { company: scenario !== 'denied', archives: true, upload: false, input: false, meetings: false, uploadProjectIds: [] }
  if (path === '/api/responsibility/overview') return { management: scenario !== 'denied', assignmentAccess: false, assignment: 0, mine: 0, review: 0, unread: 0 }
  if (scenario === 'error') throw new Error('视觉夹具：接口加载失败（503）')
  if (path === '/api/company-knowledge/options') return { people: [{ id: user.id, name: user.name, department: '视觉夹具' }], files: [] }
  if (path === '/api/company-knowledge') return { list: scenario === 'empty' ? [] : entries.filter(e => (!params.get('keyword') || e.title.includes(params.get('keyword'))) && (!params.get('kind') || e.kind === params.get('kind'))), total: scenario === 'empty' ? 0 : entries.length, canCreate: scenario !== 'denied' }
  if (path.startsWith('/api/company-knowledge/')) {
    const entry = entries.find(e => e.id === path.split('/').at(-1))
    if (!entry) throw new Error('视觉夹具：未定义知识')
    return { entry, readerIds: [], editorIds: [], ownRating: null, comments: [], commentTotal: 0, history: [], historyTotal: 0, page: 1, historyPage: 1, pageSize: 20 }
  }
  if (path === '/api/project-archives') return { list: scenario === 'empty' ? [] : archives, total: scenario === 'empty' ? 0 : archives.length, page: 1, pageSize: 6, canAudit: false, categories: [{ name: '项目材料', count: 2 }, { name: '内核材料', count: 1 }], projects: [{ id: id(30), name: '星澜科技' }], types: ['PDF', 'DOCX'] }
  if (path.startsWith('/api/project-archives/')) return { file: archives.find(f => f.id === path.split('/').at(-1)), versions: [], total: 0, page: 1, pageSize: 20 }
  if (path === '/api/responsibility') return { list: [], total: 0, page: 1, pageSize: 20 }
  if (path === '/api/responsibility-policies/current') return { policy: null, activeVersion: null, capabilities: { manage: false, approve: false } }
  throw new Error('视觉夹具：未定义的只读接口')
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1'), path = url.pathname
  const send = (status, type, body) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'" }); res.end(body) }
  if (!['GET', 'HEAD'].includes(req.method)) { rejectedWrites++; return send(503, 'application/json', JSON.stringify({ message: '隔离视觉夹具禁止所有写操作' })) }
  if (path.startsWith('/api/')) {
    requests++
    try { const referer = new URL(req.headers.referer ?? '/', 'http://127.0.0.1'); return send(200, 'application/json', JSON.stringify(result(path, url.searchParams, referer.searchParams.get('fixture')))) }
    catch (error) { return send(503, 'application/json', JSON.stringify({ message: error.message })) }
  }
  if (path === '/app.js') return send(200, 'text/javascript', js)
  if (path === '/app.css') return send(200, 'text/css', css)
  if (path === '/reference.css') return send(200, 'text/css', referenceCss)
  if (path === '/metrics.js') return send(200, 'text/javascript', metricsJs)
  if (path === '/compare') {
    const width = Math.max(320, Math.min(1920, Number(url.searchParams.get('width')) || 390))
    const view = ['company', 'archives', 'responsibility'].includes(url.searchParams.get('view')) ? url.searchParams.get('view') : 'company'
    return send(200, 'text/html', `<!doctype html><html><meta charset="utf-8"><title>隔离响应式对照</title><script src="/metrics.js"></script><body style="margin:0;background:#f5f7f9"><iframe title="迁移版" src="/?view=${view}" style="width:${width}px;height:1100px;border:0"></iframe><iframe title="原版" src="/reference?view=${view}" style="width:${width}px;height:1100px;border:0"></iframe></body></html>`)
  }
  const reference = path === '/reference'
  return send(200, 'text/html', `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FDE 数据与知识 · ${reference ? '原版' : '迁移版'}视觉夹具</title><link rel="stylesheet" href="${reference ? '/reference.css' : '/app.css'}"><style>${fixtureStyle}</style><script src="/metrics.js"></script><body><div class="fixture-frame">${reference ? '<main id="pageContent">' + renderReference(url.searchParams.get('view')) + '</main>' : '<div id="root"></div>'}</div><div class="fixture-label">${reference ? '原版' : '迁移版'} · 隔离视觉夹具 · 非业务数据</div>${reference ? '' : '<script type="module" src="/app.js"></script>'}</body></html>`)
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, pid: process.pid, database: 'none', writes: 'always rejected' })))
const stop = () => server.close(() => { console.log(JSON.stringify({ stopped: true, requests, rejectedWrites })); process.exit(0) })
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
