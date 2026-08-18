import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, authSessions, projectMembers, projects, users } from '../db/schema.js'
import { hashNewPassword } from '../security/passwordPolicy.js'
import { redactSensitiveText } from '../security/redactSecrets.js'

const baselineCommit = '0a43c7d2d7eca0c55630a77c1ae29b02cf0d367d'
const entry = 'server-dist/index.js'
const apiPort = 4100
const allowedOrigin = 'https://legacy-compat.example.invalid'
const evidenceDirectory = path.resolve('.runtime/migration-evidence/legacy-api-compatibility')
const routeFiles = [
  'server/src/routes/aiTasks.ts',
  'server/src/routes/auth.ts',
  'server/src/routes/conversations.ts',
  'server/src/routes/index.ts',
  'server/src/routes/internal.ts',
  'server/src/routes/meetings.ts',
  'server/src/routes/meta.ts',
  'server/src/routes/projects.ts',
  'server/src/routes/risks.ts',
  'server/src/routes/workspace.ts',
] as const

const routerPrefixes: Record<string, string> = {
  apiRouter: '/api',
  authRouter: '/api/auth',
  projectsRouter: '/api/projects',
  meetingsRouter: '/api/meetings',
  todosRouter: '/api/todos',
  risksRouter: '/api/risks',
  metaRouter: '/api',
  aiRouter: '/api/ai',
  aiTasksRouter: '/api/ai',
  conversationsRouter: '/api/conversations',
  workspaceRouter: '/api/workspace',
  internalRouter: '/api/internal',
}

type Route = { file: string; router: string; method: string; localPath: string; fullPath: string; key: string }

function joinRoute(prefix: string, localPath: string) {
  if (localPath === '/') return prefix
  return `${prefix}${localPath}`.replace(/\/+/g, '/')
}

function extractRoutes(file: string, source: string): Route[] {
  const routes: Route[] = []
  const matcher = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(matcher)) {
    const [, router, rawMethod, localPath] = match
    const prefix = routerPrefixes[router]
    if (!prefix) continue
    const method = rawMethod.toUpperCase()
    routes.push({
      file,
      router,
      method,
      localPath,
      fullPath: joinRoute(prefix, localPath),
      key: `${file}|${router}|${method}|${localPath}`,
    })
  }
  return routes
}

const retired = new Map<string, string>([
  ['server/src/routes/index.ts|apiRouter|POST|/materials/generate-internal', 'fixed shared-secret authentication bypass'],
  ['server/src/routes/internal.ts|internalRouter|POST|/search-docs', 'retired Flue localhost callback'],
  ['server/src/routes/internal.ts|internalRouter|POST|/collect-intel', 'retired Flue localhost callback'],
  ['server/src/routes/meetings.ts|aiRouter|POST|/project-summary', 'superseded non-authoritative summary path'],
  ['server/src/routes/meetings.ts|aiRouter|POST|/bp-parse', 'placeholder parser returned manufactured success'],
  ['server/src/routes/meetings.ts|aiRouter|GET|/jobs/:id', 'placeholder job returned fixed success'],
  ['server/src/routes/projects.ts|projectsRouter|POST|/files', 'metadata-only upload accepted no authoritative bytes'],
  ['server/src/routes/projects.ts|projectsRouter|POST|/files/:id/parse-finish', 'placeholder parse completion returned fixed success'],
])

function baselineSource(file: string) {
  return execFileSync('git', ['show', `${baselineCommit}:${file}`], { encoding: 'utf8' })
}

async function staticCompatibility() {
  const baselineRoutes = routeFiles.flatMap((file) => extractRoutes(file, baselineSource(file)))
  const currentRoutes = (
    await Promise.all(routeFiles.filter((file) => existsSync(file)).map(async (file) => extractRoutes(file, await readFile(file, 'utf8'))))
  ).flat()
  const baselineKeys = new Set(baselineRoutes.map((route) => route.key))
  const currentKeys = new Set(currentRoutes.map((route) => route.key))
  const missingClassification = baselineRoutes.filter((route) => !currentKeys.has(route.key) && !retired.has(route.key))
  const unexpectedlyRetained = [...retired.keys()].filter((key) => currentKeys.has(key))
  const retiredOutsideBaseline = [...retired.keys()].filter((key) => !baselineKeys.has(key))
  assert.deepEqual(missingClassification, [], 'legacy routes must be retained or explicitly retired')
  assert.deepEqual(unexpectedlyRetained, [], 'unsafe/placeholder legacy routes must not be reintroduced')
  assert.deepEqual(retiredOutsideBaseline, [], 'retirement entries must bind to the recorded baseline')
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineCommit,
    'compatibility baseline must remain bound to the recorded pre-migration commit')
  return {
    baselineRoutes,
    retainedRoutes: baselineRoutes.filter((route) => currentKeys.has(route.key)),
    retiredRoutes: baselineRoutes.filter((route) => retired.has(route.key)),
  }
}

function portOpen(port: number): Promise<boolean> {
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
    AUTH_SESSION_SECRET: 'legacy-api-acceptance-session-0123456789abcdef',
    JWT_SECRET: 'legacy-api-acceptance-jwt-0123456789abcdef',
    AUTH_COOKIE_SECURE: 'true',
    AUTH_COOKIE_SAME_SITE: 'lax',
    AUTH_ALLOWED_ORIGINS: allowedOrigin,
    AUTH_ALLOW_LEGACY_BEARER: 'false',
    SEED_DEMO_USERS: 'false',
    MODEL_CREDENTIAL_ENCRYPTION_KEY: '33'.repeat(32),
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: '3c'.repeat(32),
    MODEL_PROVIDER_ALLOWED_HOSTS: 'skill.zeelin.cn',
    RADAR_SYNC_ENABLED: 'false',
    RADAR_AUTO_CRAWL_ENABLED: 'false',
    RADAR_WECHAT_DAILY_ENABLED: 'false',
    DAILY_INTAKE_ENABLED: 'false',
  }
}

function setCookieLines(headers: Headers): string[] {
  const enhanced = headers as Headers & { getSetCookie?: () => string[] }
  return enhanced.getSetCookie?.() ?? [headers.get('set-cookie') || '']
}

function cookieValue(lines: string[], name: string): string {
  const match = lines.join(',').match(new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`))
  if (!match?.[1]) throw new Error(`missing ${name} cookie`)
  return decodeURIComponent(match[1])
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  return Promise.race([
    new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code))),
    delay(timeoutMs).then(() => null),
  ])
}

async function waitForReady(child: ChildProcess, output: () => string) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`app exited before ready: ${redactSensitiveText(output())}`)
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`).catch(() => null)
    if (response?.ok) return
    await delay(250)
  }
  throw new Error(`app did not become ready: ${redactSensitiveText(output())}`)
}

function objectBody(value: unknown, label: string): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must return an object`)
  return value as Record<string, unknown>
}

async function jsonRequest(urlPath: string, cookie?: string) {
  const response = await fetch(`http://127.0.0.1:${apiPort}${urlPath}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  })
  const body = objectBody(await response.json(), urlPath)
  return { response, body }
}

async function assertListShape(urlPath: string, cookie: string, extraKeys: string[] = []) {
  const { response, body } = await jsonRequest(urlPath, cookie)
  assert.equal(response.status, 200, `${urlPath} returned HTTP ${response.status}`)
  assert(Array.isArray(body.list), `${urlPath} must retain list response shape`)
  for (const key of extraKeys) assert(Object.hasOwn(body, key), `${urlPath} is missing legacy response key ${key}`)
}

async function writeEvidence(report: Record<string, unknown>) {
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
  await chmod(evidenceDirectory, 0o700)
  const reportFile = path.join(evidenceDirectory, 'report.json')
  const summaryFile = path.join(evidenceDirectory, 'summary.md')
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(summaryFile, [
    '# Legacy API compatibility acceptance',
    '',
    `- Baseline routes: ${String(report.baselineRouteCount)}`,
    `- Retained routes: ${String(report.retainedRouteCount)}`,
    `- Explicitly retired routes: ${String(report.retiredRouteCount)}`,
    `- Live response-shape checks: ${String(report.liveShapeCheckCount)}`,
    '- Synthetic fixture rows remaining: 0',
    '',
  ].join('\n'), { mode: 0o600 })
  await chmod(reportFile, 0o600)
  await chmod(summaryFile, 0o600)
}

async function main() {
  if (!existsSync(entry)) throw new Error('legacy API acceptance requires a current build; run npm run build first')
  const staticResult = await staticCompatibility()
  if (await portOpen(apiPort)) throw new Error(`legacy API acceptance requires port ${apiPort} to be free`)

  const marker = randomUUID()
  const email = `legacy-api-${marker}@example.invalid`
  const password = `Legacy-A9!-${marker}`
  const name = `旧API验收-${marker.slice(0, 8)}`
  const [user] = await db.insert(users).values({
    email,
    name,
    role: '系统管理员',
    department: '验收部',
    passwordHash: await hashNewPassword(password),
  }).$returningId()
  const [project] = await db.insert(projects).values({
    name: `旧API兼容项目-${marker.slice(0, 8)}`,
    companyName: `旧API兼容公司-${marker.slice(0, 8)}`,
    industry: '软件与信息服务',
    owner: name,
    ownerUserId: user.id,
    collaborators: [],
    stage: '初筛',
    stageSource: '旧API兼容验收',
    createdBy: user.id,
  }).$returningId()
  await db.insert(projectMembers).values({ projectId: project.id, userId: user.id, memberRole: 'owner', sourceName: name })

  const child = spawn(process.execPath, ['--env-file-if-exists=.env', entry], {
    cwd: process.cwd(), env: productionEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const append = (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-40_000) }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  let completed = false
  try {
    await waitForReady(child, () => output)
    const unauthenticated = await jsonRequest('/api/projects')
    assert.equal(unauthenticated.response.status, 401, 'retained business routes must remain authenticated')
    for (const key of ['code', 'message', 'details', 'requestId']) assert(Object.hasOwn(unauthenticated.body, key))

    const login = await fetch(`http://127.0.0.1:${apiPort}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: allowedOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, remember: false }),
    })
    assert.equal(login.status, 200, `legacy login path returned HTTP ${login.status}`)
    const loginBody = objectBody(await login.json(), '/api/auth/login')
    assert.equal((loginBody.user as { id?: string } | undefined)?.id, user.id, 'legacy login response identity changed')
    assert(!Object.hasOwn(loginBody, 'token'), 'legacy login must not reintroduce bearer tokens')
    const cookies = setCookieLines(login.headers)
    const sessionToken = cookieValue(cookies, 'cybernaut_session')
    const csrfToken = cookieValue(cookies, 'cybernaut_csrf')
    const cookie = `cybernaut_session=${encodeURIComponent(sessionToken)}; cybernaut_csrf=${encodeURIComponent(csrfToken)}`

    const me = await jsonRequest('/api/auth/me', cookie)
    assert.equal(me.response.status, 200)
    assert.equal(((me.body.user as { id?: string } | undefined)?.id), user.id)

    const projectList = await jsonRequest('/api/projects?page=1&pageSize=20', cookie)
    assert.equal(projectList.response.status, 200)
    assert(Array.isArray(projectList.body.list))
    for (const key of ['total', 'page', 'pageSize']) assert(Object.hasOwn(projectList.body, key))
    assert((projectList.body.list as Array<{ id?: string }>).some((row) => row.id === project.id))
    const projectDetail = await jsonRequest(`/api/projects/${project.id}`, cookie)
    assert.equal(projectDetail.response.status, 200)
    assert.equal(projectDetail.body.id, project.id)

    await assertListShape('/api/meetings', cookie)
    await assertListShape('/api/todos', cookie, ['counts'])
    await assertListShape('/api/risks', cookie, ['summary'])
    await assertListShape('/api/users', cookie, ['total', 'page', 'pageSize'])
    await assertListShape('/api/audit-logs', cookie, ['total'])
    await assertListShape('/api/templates', cookie, ['total'])
    await assertListShape('/api/leads?page=1&pageSize=1', cookie, ['total', 'page', 'pageSize', 'totalPages'])
    const leadStats = await jsonRequest('/api/leads/stats', cookie)
    assert.equal(leadStats.response.status, 200)
    await assertListShape('/api/ai-summaries', cookie)
    await assertListShape('/api/conversations', cookie)
    await assertListShape('/api/ai/task-types', cookie)
    await assertListShape('/api/ai/skills', cookie)
    await assertListShape('/api/ai/templates', cookie)
    await assertListShape('/api/ai/tasks', cookie)
    await assertListShape('/api/ai/artifacts', cookie)

    for (const route of staticResult.retiredRoutes) {
      const livePath = route.fullPath.replace(':id', randomUUID())
      const response = await fetch(`http://127.0.0.1:${apiPort}${livePath}`, {
        method: route.method,
        headers: {
          Cookie: cookie,
          Origin: allowedOrigin,
          'X-CSRF-Token': csrfToken,
          'Content-Type': 'application/json',
        },
        ...(route.method === 'GET' ? {} : { body: '{}' }),
      })
      assert.equal(response.status, 404, `${route.method} ${route.fullPath} must remain retired`)
      const body = objectBody(await response.json(), route.fullPath)
      assert.equal(body.code, 'NOT_FOUND')
      assert.equal(body.details, null)
      assert.equal(typeof body.message, 'string')
      assert.equal(typeof body.requestId, 'string')
    }

    const report = {
      ok: true,
      schemaVersion: '1.0',
      baselineCommit,
      baselineRouteCount: staticResult.baselineRoutes.length,
      retainedRouteCount: staticResult.retainedRoutes.length,
      retiredRouteCount: staticResult.retiredRoutes.length,
      liveShapeCheckCount: 18,
      unauthenticatedRetainedRouteRejected: true,
      retiredRoutesReturnAuthenticatedJson404: true,
      secretsAndFixtureIdentitiesExcluded: true,
      syntheticFixtureRowsRemaining: 0,
    }
    await writeEvidence(report)
    console.log(JSON.stringify(report))
    completed = true
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    let exitCode = await waitForExit(child, 20_000)
    if (exitCode === null) {
      child.kill('SIGKILL')
      exitCode = await waitForExit(child, 5_000)
    }
    await db.delete(projectMembers).where(eq(projectMembers.projectId, project.id))
    await db.delete(projects).where(eq(projects.id, project.id))
    await db.delete(auditLogs).where(eq(auditLogs.userId, user.id))
    await db.delete(authSessions).where(eq(authSessions.userId, user.id))
    await db.delete(users).where(eq(users.id, user.id))
    const remainingUsers = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id))
    const remainingProjects = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, project.id))
    if (remainingUsers.length || remainingProjects.length) throw new Error('legacy API acceptance fixture cleanup left database rows')
    if (exitCode !== 0) throw new Error(`app did not stop cleanly (exit=${String(exitCode)}): ${redactSensitiveText(output)}`)
    if (await portOpen(apiPort)) throw new Error(`port ${apiPort} remained open after acceptance`)
    if (!completed) throw new Error(`legacy API acceptance failed: ${redactSensitiveText(output)}`)
  }
}

await main().finally(async () => pool.end())
