import type { AiEvolutionArtifactStore } from '../../services/aiEvolutionArtifactStore.js'
import type { EvolutionCandidateManifest } from '../../contracts/aiEvolutionEvaluationContract.js'
import type { EvolutionExecutionControl } from './evolutionRunCoordinator.js'

type Locator = { click(options: { timeout: number }): Promise<void>; waitFor(options: { state: 'visible'; timeout: number }): Promise<void>; innerText(): Promise<string> }
type Page = { goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>; locator(selector: string): Locator;
  evaluate<T>(callback: () => T): Promise<T>;
  screenshot(options: { fullPage: boolean }): Promise<Buffer>; on(event: 'pageerror', listener: (error: Error) => void): void }
type Route = { request(): { url(): string; method(): string }; abort(): Promise<void>;
  fulfill(input: { status: number; contentType: string; body: string | Buffer; headers?: Record<string, string> }): Promise<void> }
export type EvolutionBrowser = { newContext(options: { serviceWorkers: 'block'; acceptDownloads: false; viewport: { width: number; height: number } }): Promise<{
  route(pattern: string, handler: (route: Route) => Promise<void>): Promise<void>
  routeWebSocket(pattern: string, handler: (socket: { close(): void }) => void): Promise<void>
  newPage(): Promise<Page>; close(): Promise<void>
}> }
export type EvolutionPageScenario = { path: string; viewport: { width: number; height: number };
  fixtures: Record<string, unknown>; actions: { selector: string; action: 'click' | 'visible' | 'text'; expectedText?: string }[] }

/** Scenario is frozen platform configuration. Candidate and model never supply selectors or fixtures. */
export async function runEvolutionBrowserGate(input: {
  browser: EvolutionBrowser; store: Pick<AiEvolutionArtifactStore, 'read'>; control: EvolutionExecutionControl;
  files: (EvolutionCandidateManifest['artifacts'][number] & { path: string })[]; scenario: EvolutionPageScenario
}) {
  const origin = 'https://evolution-preview.invalid'
  const scenario = structuredClone(input.scenario)
  if (!scenario.path.startsWith('/') || scenario.path.startsWith('//') || !scenario.actions.length) throw Error('Invalid frozen page scenario')
  input.control.signal.throwIfAborted()
  await input.control.assertCanContinue()
  const context = await input.browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: scenario.viewport })
  let closing: Promise<void> | undefined
  const close = () => closing ??= context.close()
  const onAbort = () => { void close().catch(() => {}) }
  input.control.signal.addEventListener('abort', onAbort, { once: true })
  const errors: string[] = [], blocked: string[] = []
  try {
    input.control.signal.throwIfAborted()
    await context.routeWebSocket('**/*', (socket) => { blocked.push('websocket'); socket.close() })
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin !== origin || request.method() !== 'GET') { blocked.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort(); return }
      const key = `${url.pathname}${url.search}`
      if (Object.hasOwn(scenario.fixtures, key)) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(scenario.fixtures[key]) }); return
      }
      if (url.pathname.startsWith('/api/')) { blocked.push(`unregistered fixture ${url.pathname}`); await route.abort(); return }
      const name = `dist${url.pathname}`
      const file = input.files.find((item) => item.path === name)
        ?? (!/\.[^/]+$/.test(url.pathname) ? input.files.find((item) => item.path === 'dist/index.html') : undefined)
      if (!file) { blocked.push(`missing asset ${url.pathname}`); await route.abort(); return }
      const contentType = file.path.endsWith('.html') ? 'text/html; charset=utf-8' : file.path.endsWith('.js') ? 'application/javascript' : file.path.endsWith('.css') ? 'text/css' : file.path.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream'
      const bytes = await input.store.read(input.control.identity.runId, file)
      const body = file.path.endsWith('.html') ? bytes.toString('utf8').replace('</body>', '<div id="evolution-fixture-label" style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#fff3cd;color:#664d03;padding:6px;text-align:center;font:12px sans-serif">隔离候选预览 · 测试数据</div></body>') : bytes
      await route.fulfill({ status: 200, contentType, body, headers: { 'Cache-Control': 'no-store' } })
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message.slice(0, 1000)))
    try {
      await page.goto(`${origin}${scenario.path}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      for (const action of scenario.actions) {
        await input.control.assertCanContinue()
        const locator = page.locator(action.selector)
        if (action.action === 'click') await locator.click({ timeout: 10000 })
        else {
          await locator.waitFor({ state: 'visible', timeout: 10000 })
          if (action.action === 'text' && (action.expectedText === undefined || !(await locator.innerText()).includes(action.expectedText))) throw Error(`页面内容不匹配：${action.selector}`)
        }
      }
    } catch (error) { errors.push(error instanceof Error ? error.message.slice(0, 1000) : '页面验收失败') }
    await input.control.assertCanContinue()
    try { await page.locator('#evolution-fixture-label').waitFor({ state: 'visible', timeout: 1000 }) }
    catch { errors.push('缺少隔离测试数据标识') }
    const layout = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }))
    if (layout.content > layout.viewport + 1) errors.push(`页面横向溢出：内容 ${layout.content}px，视口 ${layout.viewport}px`)
    const screenshot = await page.screenshot({ fullPage: true })
    input.control.signal.throwIfAborted()
    await input.control.assertCanContinue()
    return { verdict: errors.length || blocked.length ? 'FAIL' as const : 'PASS' as const, screenshot,
      evidence: JSON.stringify({ fixtureData: true, actions: scenario.actions.length, viewport: scenario.viewport, layout, errors, blocked }) }
  } catch (error) {
    input.control.signal.throwIfAborted()
    throw error
  } finally {
    input.control.signal.removeEventListener('abort', onAbort)
    await close()
  }
}
