import assert from 'node:assert/strict'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { createServer as createPortProbe, type AddressInfo } from 'node:net'

// Read-only UI failure fixture: no DB module, credentials, auth impersonation,
// business server, successful API fixture, or production proxy is used here.
assert.ok(process.argv.includes('--ui-error-only'), 'explicit UI-only fixture mode required')
const entry = '/fde-registration-ui-check.js'
const probe = createPortProbe()
await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
const fixturePort = (probe.address() as AddressInfo).port
await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
const vite = await createServer({ configFile: false, envFile: false, root: process.cwd(),
  plugins: [react(), {
    name: 'fde-registration-read-only-failure-fixture',
    resolveId(id) { if (id === entry) return '\0fde-registration-ui-check.js' },
    load(id) { if (id === '\0fde-registration-ui-check.js') return `import React from 'react'; import {createRoot} from 'react-dom/client'; import {BrowserRouter} from 'react-router-dom'; import {FdeTypeRegistrationPanel} from '/src/components/FdeTypeRegistrationPanel.tsx'; import {FdeTypePolicyPanel} from '/src/components/FdeTypePolicyPanel.tsx'; import '/src/styles.css'; createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter,null,React.createElement('main',{className:'mx-auto max-w-5xl space-y-6 p-5'},React.createElement('h1',null,'非投资页面只读失败态验收：无数据库、未模拟成功'),React.createElement(FdeTypeRegistrationPanel),React.createElement(FdeTypePolicyPanel))));` },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/api/')) { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 'ISOLATED_DATABASE_UNAVAILABLE', message: '专用隔离数据库未配置，本页面不返回成功业务数据' })); return }
        if (req.url === '/') { void server.transformIndexHtml('/', `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>非投资只读失败态验收</title></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`).then(html => { res.setHeader('Content-Type', 'text/html'); res.end(html) }); return }
        next()
      })
    },
  }], server: { host: '127.0.0.1', port: fixturePort, strictPort: true, proxy: {} },
})
await vite.listen()
const address = vite.httpServer!.address() as { port: number }
console.log(JSON.stringify({ uiOnly: true, url: `http://127.0.0.1:${address.port}/`, pid: process.pid, database: 'not-used', successfulApiResponses: false }))
let closing = false
const close = async () => { if (closing) return; closing = true; await vite.close(); process.exit(0) }
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close())
