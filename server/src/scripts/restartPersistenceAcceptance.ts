import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { and, eq } from 'drizzle-orm'
import type { RowDataPacket } from 'mysql2'
import { db, pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  agentConversations,
  agentMessageParts,
  agentMessages,
  aiTasks,
  auditLogs,
  chatConversations,
  projectMembers,
  projects,
  users,
} from '../db/schema.js'
import { hashPassword } from '../services/authService.js'
import { redactSensitiveText } from '../security/redactSecrets.js'

const entry = 'server-dist/index.js'
if (!existsSync(entry)) throw new Error('restart acceptance requires a current build; run npm run build first')
const runtimeJobsTable = quoteMysqlIdentifier(mysqlTableName('runtime_jobs'))

type RuntimeJobSnapshot = RowDataPacket & {
  id: string
  task: string
  enabled: number
  schedule_kind: string
  interval_seconds: number | null
  daily_hour: number | null
  daily_minute: number | null
  next_run_at: Date
  updated_at: Date
}

async function deferRuntimeJobsForAcceptance(): Promise<RuntimeJobSnapshot[]> {
  const [liveLeases] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) AS count FROM ${runtimeJobsTable} WHERE lease_expires_at >= NOW(3)`,
  )
  if (Number(liveLeases[0]?.count || 0) > 0) {
    throw new Error('restart acceptance requires an idle runtime scheduler')
  }
  const [rows] = await pool.query<RuntimeJobSnapshot[]>(
    `SELECT id, task, enabled, schedule_kind, interval_seconds, daily_hour, daily_minute,
       next_run_at, updated_at FROM ${runtimeJobsTable}`,
  )
  if (rows.length) {
    await pool.query(`UPDATE ${runtimeJobsTable} SET next_run_at=NOW(3) + INTERVAL 1 DAY`)
  }
  return rows
}

async function restoreRuntimeJobs(rows: RuntimeJobSnapshot[]): Promise<void> {
  for (const row of rows) {
    await pool.query(
      `UPDATE ${runtimeJobsTable}
       SET task=?, enabled=?, schedule_kind=?, interval_seconds=?, daily_hour=?, daily_minute=?,
         next_run_at=?, updated_at=?
       WHERE id=?`,
      [row.task, row.enabled, row.schedule_kind, row.interval_seconds, row.daily_hour,
        row.daily_minute, row.next_run_at, row.updated_at, row.id],
    )
  }
}

async function runtimeJobRunCount(): Promise<number> {
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) AS count FROM ${quoteMysqlIdentifier(mysqlTableName('runtime_job_runs'))}`,
  )
  return Number(rows[0]?.count || 0)
}

async function assertRuntimeJobsRestored(expected: RuntimeJobSnapshot[]): Promise<void> {
  if (!expected.length) return
  const [actual] = await pool.query<RuntimeJobSnapshot[]>(
    `SELECT id, task, enabled, schedule_kind, interval_seconds, daily_hour, daily_minute,
       next_run_at, updated_at FROM ${runtimeJobsTable}`,
  )
  const byId = new Map(actual.map((row) => [row.id, row]))
  for (const row of expected) {
    const restored = byId.get(row.id)
    if (!restored
      || restored.task !== row.task
      || Number(restored.enabled) !== Number(row.enabled)
      || restored.schedule_kind !== row.schedule_kind
      || restored.interval_seconds !== row.interval_seconds
      || restored.daily_hour !== row.daily_hour
      || restored.daily_minute !== row.daily_minute
      || new Date(restored.next_run_at).getTime() !== new Date(row.next_run_at).getTime()
      || new Date(restored.updated_at).getTime() !== new Date(row.updated_at).getTime()) {
      throw new Error(`restart acceptance changed runtime job configuration: ${row.id}`)
    }
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('unable to allocate acceptance port'))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

function setCookieLines(headers: Headers): string[] {
  const enhanced = headers as Headers & { getSetCookie?: () => string[] }
  return enhanced.getSetCookie?.() ?? [headers.get('set-cookie') || '']
}

function cookieHeader(headers: Headers): string {
  const values = setCookieLines(headers).flatMap((line) => {
    const match = line.match(/^([^=;,]+)=([^;,]*)/)
    return match ? [`${match[1]}=${match[2]}`] : []
  })
  if (!values.some((value) => value.startsWith('cybernaut_session='))) throw new Error('restart login did not return a session cookie')
  return values.join('; ')
}

function childEnvironment(port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    API_PORT: String(port),
    AUTH_SESSION_SECRET: 'restart-acceptance-session-secret-0123456789abcdef',
    JWT_SECRET: 'restart-acceptance-jwt-secret-0123456789abcdef',
    AUTH_COOKIE_SECURE: 'true',
    AUTH_COOKIE_SAME_SITE: 'lax',
    AUTH_ALLOWED_ORIGINS: 'https://restart.example.invalid',
    AUTH_ALLOW_LEGACY_BEARER: 'false',
    SEED_DEMO_USERS: 'false',
    MODEL_CREDENTIAL_ENCRYPTION_KEY: '33'.repeat(32),
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: '3a'.repeat(32),
    MODEL_PROVIDER_ALLOWED_HOSTS: 'skill.zeelin.cn',
    RADAR_SYNC_ENABLED: 'false',
    RADAR_AUTO_CRAWL_ENABLED: 'false',
    RADAR_WECHAT_DAILY_ENABLED: 'false',
    DAILY_INTAKE_ENABLED: 'false',
  }
}

async function startApp(port: number) {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', entry], {
    cwd: process.cwd(),
    env: childEnvironment(port),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.end()
  let output = ''
  const append = (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-30_000) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const baseUrl = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`app exited during restart acceptance: ${redactSensitiveText(output)}`)
    const response = await fetch(`${baseUrl}/api/health`).catch(() => null)
    if (response?.ok) return { child, baseUrl, output: () => output }
    await delay(250)
  }
  child.kill('SIGKILL')
  throw new Error(`app did not become ready during restart acceptance: ${redactSensitiveText(output)}`)
}

async function stopApp(app: { child: ChildProcessWithoutNullStreams; output: () => string }) {
  if (app.child.exitCode !== null) return
  app.child.kill('SIGINT')
  await Promise.race([
    new Promise<void>((resolve) => app.child.once('exit', () => resolve())),
    delay(15_000).then(() => { app.child.kill('SIGKILL'); throw new Error(`app did not stop cleanly: ${redactSensitiveText(app.output())}`) }),
  ])
  if (app.child.exitCode !== 0) throw new Error(`app exited with ${app.child.exitCode}: ${redactSensitiveText(app.output())}`)
}

async function expectJson(url: string, cookie: string, check: (body: Record<string, unknown>) => boolean) {
  const response = await fetch(url, { headers: { Cookie: cookie } })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  const body = await response.json() as Record<string, unknown>
  if (!check(body)) throw new Error(`${url} returned an unexpected persisted record: ${redactSensitiveText(JSON.stringify(body).slice(0, 2_000))}`)
}

async function main() {
  const marker = randomUUID()
  const email = `restart-${marker}@example.invalid`
  const password = `restart-${marker}`
  const projectName = `重启验收项目-${marker}`
  const conversationTitle = `重启验收会话-${marker}`
  const messageText = `restart-message-${marker}`
  const [user] = await db.insert(users).values({
    email, name: '重启验收用户', role: '投资经理', department: '验收部',
    passwordHash: await hashPassword(password),
  }).$returningId()
  let projectId = ''
  let chatId = ''
  let agentId = ''
  let messageId = ''
  let taskId = ''
  let firstApp: Awaited<ReturnType<typeof startApp>> | undefined
  let secondApp: Awaited<ReturnType<typeof startApp>> | undefined
  let runtimeJobSnapshot: RuntimeJobSnapshot[] = []
  let baselineRuntimeJobRuns = 0
  try {
    // Starting the complete service must not execute or permanently reconfigure real scheduled jobs.
    // Move existing due times out of the acceptance window and restore their exact schedule afterward.
    runtimeJobSnapshot = await deferRuntimeJobsForAcceptance()
    baselineRuntimeJobRuns = await runtimeJobRunCount()
    const [project] = await db.insert(projects).values({
      name: projectName, companyName: '重启验收科技有限公司', owner: '重启验收用户',
      ownerUserId: user.id, createdBy: user.id, stage: '尽调',
    }).$returningId()
    projectId = project.id
    await db.insert(projectMembers).values({
      projectId, userId: user.id, memberRole: '负责人', sourceName: '重启验收用户',
    })
    chatId = randomUUID()
    agentId = randomUUID()
    await db.insert(agentConversations).values({
      id: chatId, userId: user.id, projectId, title: conversationTitle, scope: 'project', status: 'idle', runtime: 'jw',
      externalSessionId: agentId,
      metadata: { acceptanceMarker: marker },
    })
    await db.insert(chatConversations).values({
      id: chatId, userId: user.id, projectId, projectName, title: conversationTitle, scope: 'project', agentId,
      messages: [{ id: marker, role: 'user', content: messageText }],
    })
    const [message] = await db.insert(agentMessages).values({
      conversationId: chatId, role: 'user', sequence: 0, content: messageText, status: 'complete',
    }).$returningId()
    messageId = message.id
    await db.insert(agentMessageParts).values({ messageId, partIndex: 0, type: 'text', content: messageText })
    const [task] = await db.insert(aiTasks).values({
      userId: user.id, projectId, conversationId: chatId, type: 'restart_acceptance',
      parameters: { acceptanceMarker: marker }, templateVersion: 'restart-acceptance-v1',
      status: 'succeeded', stage: '已完成', progress: 100, resultSummary: messageText,
      idempotencyKey: `restart-${marker}`, completedAt: new Date(),
    }).$returningId()
    taskId = task.id

    const port = await freePort()
    firstApp = await startApp(port)
    const login = await fetch(`${firstApp.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, remember: true }),
    })
    if (!login.ok) throw new Error(`restart acceptance login returned HTTP ${login.status}`)
    const cookie = cookieHeader(login.headers)
    await expectJson(`${firstApp.baseUrl}/api/auth/me`, cookie, (body) => (body.user as { id?: string })?.id === user.id)
    await expectJson(`${firstApp.baseUrl}/api/projects/${projectId}`, cookie, (body) => body.id === projectId)
    await expectJson(`${firstApp.baseUrl}/api/conversations/${chatId}`, cookie, (body) => body.id === chatId)
    await expectJson(`${firstApp.baseUrl}/api/agent/conversations/${agentId}`, cookie, (body) => (
      body.id === agentId && Array.isArray(body.messages)
    ))
    await stopApp(firstApp)
    firstApp = undefined

    secondApp = await startApp(port)
    await expectJson(`${secondApp.baseUrl}/api/auth/me`, cookie, (body) => (body.user as { id?: string })?.id === user.id)
    await expectJson(`${secondApp.baseUrl}/api/projects/${projectId}`, cookie, (body) => body.id === projectId)
    await expectJson(`${secondApp.baseUrl}/api/conversations/${chatId}`, cookie, (body) => body.id === chatId)
    await expectJson(`${secondApp.baseUrl}/api/agent/conversations/${agentId}`, cookie, (body) => {
      const messages = body.messages as Array<{ id?: string; parts?: Array<{ text?: string }> }> | undefined
      return body.id === agentId
        && messages?.[0]?.id === messageId
        && messages[0].parts?.[0]?.text === messageText
    })
    const [persistedTask] = await db.select().from(aiTasks).where(and(eq(aiTasks.id, taskId), eq(aiTasks.status, 'succeeded'))).limit(1)
    if (persistedTask?.resultSummary !== messageText || persistedTask.progress !== 100) {
      throw new Error('AI task did not persist across complete restart')
    }
    await stopApp(secondApp)
    secondApp = undefined
    await restoreRuntimeJobs(runtimeJobSnapshot)
    await assertRuntimeJobsRestored(runtimeJobSnapshot)
    runtimeJobSnapshot = []
    if (await runtimeJobRunCount() !== baselineRuntimeJobRuns) {
      throw new Error('restart acceptance unexpectedly executed a persisted runtime job')
    }
    console.log(JSON.stringify({
      ok: true,
      checks: [
        'user-session-cookie-restart', 'project-restart', 'chat-index-restart',
        'jw-conversation-message-part-restart', 'completed-ai-task-restart',
        'production-schema-read-only-start', 'graceful-two-cycle-restart',
        'scheduled-jobs-not-executed-or-reconfigured',
      ],
    }))
  } finally {
    if (firstApp) await stopApp(firstApp).catch(() => undefined)
    if (secondApp) await stopApp(secondApp).catch(() => undefined)
    if (runtimeJobSnapshot.length) await restoreRuntimeJobs(runtimeJobSnapshot).catch(() => undefined)
    if (taskId) await db.delete(aiTasks).where(eq(aiTasks.id, taskId)).catch(() => undefined)
    if (chatId) await db.delete(agentConversations).where(eq(agentConversations.id, chatId)).catch(() => undefined)
    if (chatId) await db.delete(chatConversations).where(eq(chatConversations.id, chatId)).catch(() => undefined)
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId)).catch(() => undefined)
    await db.delete(auditLogs).where(eq(auditLogs.userId, user.id)).catch(() => undefined)
    await db.delete(users).where(eq(users.id, user.id)).catch(() => undefined)
  }
}

await main().finally(async () => pool.end())
