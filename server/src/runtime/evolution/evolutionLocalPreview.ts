import { createServer, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AiEvolutionArtifactStore } from '../../services/aiEvolutionArtifactStore.js'
import type { EvolutionCandidateManifest } from '../../contracts/aiEvolutionEvaluationContract.js'
import type { EvolutionPageScenario } from './evolutionBrowserGate.js'

const host = '127.0.0.2' // Distinct cookie host from the business service on localhost/127.0.0.1.
const policy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-same-origin"
type File = EvolutionCandidateManifest['artifacts'][number] & { path: string }

/** Local-machine preview only. Production requires a separately deployed preview origin. */
export async function startEvolutionLocalPreview(input: {
  runId: string; files: File[]; scenario: EvolutionPageScenario; store: Pick<AiEvolutionArtifactStore, 'read'>;
  authorize: () => Promise<void>; lifetimeMs?: number;
}) {
  const lifetime = input.lifetimeMs ?? 10 * 60_000
  if (!Number.isSafeInteger(lifetime) || lifetime < 100 || lifetime > 10 * 60_000) throw Error('Invalid preview lifetime')
  await input.authorize()
  const files = structuredClone(input.files), scenario = structuredClone(input.scenario)
  if (!scenario.path.startsWith('/') || scenario.path.startsWith('//')) throw Error('Invalid preview entry path')
  const secret = randomBytes(32).toString('hex'), cookieName = `evolution_preview_${randomBytes(8).toString('hex')}`
  const expiresAt = Date.now() + lifetime
  let origin = '', stopped = false
  const server: Server = createServer((req, res) => {
    void (async () => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', policy)
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
      const reject = (status: number) => { res.statusCode = status; res.end('Preview unavailable') }
      if (stopped || Date.now() >= expiresAt) { reject(410); return }
      if (req.headers.host !== new URL(origin).host || req.method !== 'GET') { reject(403); return }
      const url = new URL(req.url || '/', origin)
      const supplied = url.pathname === '/__open' ? url.searchParams.get('token') :
        req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
      if (!supplied || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))) { reject(403); return }
      try { await input.authorize() } catch { reject(403); return }
      if (url.pathname === '/__open') {
        res.setHeader('Set-Cookie', `${cookieName}=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(lifetime / 1000)}`)
        res.statusCode = 303; res.setHeader('Location', scenario.path); res.end(); return
      }
      const key = `${url.pathname}${url.search}`
      if (Object.hasOwn(scenario.fixtures, key)) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(scenario.fixtures[key])); return
      }
      if (url.pathname.startsWith('/api/')) { reject(404); return }
      const file = files.find((item) => item.path === `dist${url.pathname}`)
        ?? (!/\.[^/]+$/.test(url.pathname) ? files.find((item) => item.path === 'dist/index.html') : undefined)
      if (!file) { reject(404); return }
      const content = await input.store.read(input.runId, file)
      try { await input.authorize() } catch { reject(403); return }
      if (stopped || Date.now() >= expiresAt) { reject(410); return }
      const types: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'application/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', woff2: 'font/woff2' }
      res.setHeader('Content-Type', types[file.path.split('.').at(-1)!] || 'application/octet-stream')
      res.end(file.path.endsWith('.html') ? content.toString('utf8').replace('</body>', '<div style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#fff3cd;color:#664d03;padding:6px;text-align:center;font:12px sans-serif">隔离候选预览 · 测试数据 · 不会修改业务数据</div></body>') : content)
    })().catch(() => { if (!res.headersSent) res.statusCode = 500; res.end('Preview unavailable') })
  })
  server.on('upgrade', (_req, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, () => { server.removeListener('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Preview failed to bind')
  origin = `http://${host}:${address.port}`
  const close = async () => {
    if (stopped) return
    stopped = true; clearTimeout(timer)
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections() })
  }
  const timer = setTimeout(() => { void close().catch(() => {}) }, lifetime)
  timer.unref()
  return { url: `${origin}/__open?token=${secret}`, expiresAt: new Date(expiresAt).toISOString(), close }
}
