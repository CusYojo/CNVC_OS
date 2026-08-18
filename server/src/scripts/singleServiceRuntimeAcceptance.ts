import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { redactSensitiveText } from '../security/redactSecrets.js'

const entry = 'server-dist/index.js'
const apiPort = 4100
const retiredPorts = [3584, 8121]
const observeExisting = process.argv.includes('--observe-existing')
const execFileAsync = promisify(execFile)
const requiredComponents = [
  'jw-agent-runtime',
  'agent-socket',
  'ai-runtime-telemetry',
  'radar-typescript-collector',
  'radar-mysql-source',
  'mysql-runtime-jobs',
  'mysql-lead-score-jobs',
  'mysql-lead-bp-jobs',
  'mysql-project-score-jobs',
  'mysql-ai-tasks',
  'supervised-child-processes',
  'mysql-auth-sessions',
] as const

if (!existsSync(entry)) throw new Error('single-service runtime acceptance requires a current build; run npm run build first')

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = (open: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function productionEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    API_PORT: String(apiPort),
    AUTH_SESSION_SECRET: 'single-service-acceptance-session-0123456789abcdef',
    JWT_SECRET: 'single-service-acceptance-jwt-0123456789abcdef',
    AUTH_COOKIE_SECURE: 'true',
    AUTH_COOKIE_SAME_SITE: 'lax',
    AUTH_ALLOWED_ORIGINS: 'https://single-service.example.invalid',
    AUTH_ALLOW_LEGACY_BEARER: 'false',
    SEED_DEMO_USERS: 'false',
    MODEL_CREDENTIAL_ENCRYPTION_KEY: '22'.repeat(32),
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: '2a'.repeat(32),
    MODEL_PROVIDER_ALLOWED_HOSTS: 'skill.zeelin.cn',
    RADAR_SYNC_ENABLED: 'false',
    RADAR_AUTO_CRAWL_ENABLED: 'false',
    RADAR_WECHAT_DAILY_ENABLED: 'false',
    DAILY_INTAKE_ENABLED: 'false',
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  return Promise.race([
    new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code))),
    delay(timeoutMs).then(() => null),
  ])
}

async function main() {
  const occupied: number[] = []
  for (const port of [apiPort, ...retiredPorts]) if (await portOpen(port)) occupied.push(port)
  if (observeExisting) {
    if (!occupied.includes(apiPort)) throw new Error('[single service runtime] existing service is not listening on 4100')
    const openRetired = retiredPorts.filter((port) => occupied.includes(port))
    if (openRetired.length) throw new Error(`[single service runtime] retired ports already occupied: ${openRetired.join(',')}`)
    const healthResponse = await fetch(`http://127.0.0.1:${apiPort}/api/health/components`)
    const health = await healthResponse.json() as {
      ok?: boolean; service?: string; components?: Array<{ name?: string; ok?: boolean }>
    }
    if (!healthResponse.ok || !health.ok || health.service !== 'cybernaut-app') {
      throw new Error('[single service runtime] observed component health is not ready')
    }
    const baseHealthResponse = await fetch(`http://127.0.0.1:${apiPort}/api/health`)
    const baseHealth = await baseHealthResponse.json() as { ok?: boolean; service?: string }
    if (!baseHealthResponse.ok || !baseHealth.ok || baseHealth.service !== health.service) {
      throw new Error('[single service runtime] observed base/component health identities differ')
    }
    const unauthenticatedMetrics = await fetch(`http://127.0.0.1:${apiPort}/api/operations/metrics`)
    const unauthenticatedMetricsBody = await unauthenticatedMetrics.json() as { code?: string }
    if (unauthenticatedMetrics.status !== 401 || unauthenticatedMetricsBody.code !== 'AUTH_REQUIRED') {
      throw new Error('[single service runtime] observed operations metrics do not reject unauthenticated access')
    }
    const webResponse = await fetch(`http://127.0.0.1:${apiPort}/`)
    const webBody = await webResponse.text()
    if (!webResponse.ok || !webResponse.headers.get('content-type')?.includes('text/html') || !webBody.includes('<div id="root">')) {
      throw new Error('[single service runtime] observed unified listener does not serve the built Web SPA')
    }
    const components = new Map((health.components || []).map((item) => [item.name, item.ok]))
    const missing = requiredComponents.filter((name) => components.get(name) !== true)
    if (missing.length) throw new Error(`[single service runtime] observed missing/unhealthy components: ${missing.join(',')}`)
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${apiPort}`, '-sTCP:LISTEN', '-t'])
    const pids = [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]
    if (pids.length !== 1) throw new Error(`[single service runtime] expected one listener PID on 4100, found ${pids.length}`)
    console.log(JSON.stringify({
      ok: true,
      mode: 'observe-existing',
      observedServiceProcesses: 1,
      service: health.service,
      healthIdentityConsistent: true,
      businessPorts: [apiPort],
      retiredPortsClosed: retiredPorts,
      webSpaServed: true,
      operationsMetricsUnauthenticatedStatus: unauthenticatedMetrics.status,
      components: requiredComponents,
      listenerPidCount: pids.length,
      processMutation: false,
    }))
    return
  }
  if (occupied.length) throw new Error(`[single service runtime] preflight ports already occupied: ${occupied.join(',')}`)

  const child = spawn(process.execPath, ['--env-file-if-exists=.env', entry], {
    cwd: process.cwd(),
    env: productionEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const append = (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-40_000) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  try {
    let health: { ok?: boolean; service?: string; components?: Array<{ name?: string; ok?: boolean }> } | undefined
    for (let attempt = 0; attempt < 180; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`app exited before ready: ${redactSensitiveText(output)}`)
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/health/components`).catch(() => null)
      if (response?.ok) {
        health = await response.json() as typeof health
        break
      }
      await delay(250)
    }
    if (!health?.ok || health.service !== 'cybernaut-app') {
      throw new Error(`component health did not become ready: ${redactSensitiveText(output)}`)
    }
    const baseHealthResponse = await fetch(`http://127.0.0.1:${apiPort}/api/health`)
    const baseHealth = await baseHealthResponse.json() as { ok?: boolean; service?: string }
    if (!baseHealthResponse.ok || !baseHealth.ok || baseHealth.service !== 'cybernaut-app') {
      throw new Error('[single service runtime] base and component health endpoints must identify the same service')
    }
    const unauthenticatedMetrics = await fetch(`http://127.0.0.1:${apiPort}/api/operations/metrics`)
    const unauthenticatedMetricsBody = await unauthenticatedMetrics.json() as { code?: string }
    if (unauthenticatedMetrics.status !== 401 || unauthenticatedMetricsBody.code !== 'AUTH_REQUIRED') {
      throw new Error('[single service runtime] operations metrics must reject unauthenticated access')
    }
    const webResponse = await fetch(`http://127.0.0.1:${apiPort}/`)
    const webBody = await webResponse.text()
    if (!webResponse.ok || !webResponse.headers.get('content-type')?.includes('text/html') || !webBody.includes('<div id="root">')) {
      throw new Error('[single service runtime] built Web SPA is not served by the unified listener')
    }
    const components = new Map((health.components || []).map((item) => [item.name, item.ok]))
    const missing = requiredComponents.filter((name) => components.get(name) !== true)
    if (missing.length) throw new Error(`[single service runtime] missing/unhealthy components: ${missing.join(',')}`)
    if (!(await portOpen(apiPort))) throw new Error('[single service runtime] API port 4100 is not listening')
    for (const port of retiredPorts) {
      if (await portOpen(port)) throw new Error(`[single service runtime] retired port ${port} is listening`)
    }
    const records = output.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line) as Record<string, unknown> }
      catch { throw new Error(`[single service runtime] non-JSON application log: ${redactSensitiveText(line)}`) }
    })
    const invalidRecord = records.find((record) => (
      typeof record.time !== 'string'
      || !['info', 'warn', 'error'].includes(String(record.level))
      || record.service !== 'cybernaut-app'
      || !Object.prototype.hasOwnProperty.call(record, 'requestId')
    ))
    if (invalidRecord) throw new Error(`[single service runtime] invalid structured log record: ${redactSensitiveText(JSON.stringify(invalidRecord))}`)
    const httpRecord = records.find((record) => record.event === 'http_request' && typeof record.requestId === 'string')
    if (!httpRecord) throw new Error('[single service runtime] no request-correlated HTTP log was emitted')

    console.log(JSON.stringify({
      ok: true,
      serviceProcessesStarted: 1,
      service: health.service,
      healthIdentityConsistent: true,
      businessPorts: [apiPort],
      retiredPortsClosed: retiredPorts,
      webSpaServed: true,
      structuredLogRecords: records.length,
      requestCorrelatedLog: true,
      operationsMetricsUnauthenticatedStatus: unauthenticatedMetrics.status,
      components: requiredComponents,
      pid: child.pid,
    }))
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    let exitCode = await waitForExit(child, 20_000)
    if (exitCode === null) {
      child.kill('SIGKILL')
      exitCode = await waitForExit(child, 5_000)
    }
    if (exitCode !== 0) throw new Error(`app did not stop cleanly (exit=${String(exitCode)}): ${redactSensitiveText(output)}`)
    for (const port of [apiPort, ...retiredPorts]) {
      if (await portOpen(port)) throw new Error(`[single service runtime] port ${port} remained open after shutdown`)
    }
  }
}

await main()
