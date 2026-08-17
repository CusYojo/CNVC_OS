import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import mysql from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import { io as socketIo, type Socket } from 'socket.io-client'
import { redactSensitiveText } from '../security/redactSecrets.js'

function identifier(value: string) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error('unsafe acceptance identifier')
  return `\`${value}\``
}

async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!port) throw new Error('failed to allocate isolated acceptance port')
  return port
}

async function portOpen(port: number) {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = (open: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(300)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null) return child.exitCode
  return await Promise.race([
    new Promise<number | null>((resolve) => child.once('exit', resolve)),
    delay(timeoutMs).then(() => null),
  ])
}

async function applyIsolatedMigrations(environment: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'server/src/scripts/migrateMySqlSchema.ts',
  ], { cwd: process.cwd(), env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const append = (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-40_000) }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  const exitCode = await waitForExit(child, 60_000)
  if (exitCode === null) {
    child.kill('SIGKILL')
    throw new Error('isolated schema migration timed out')
  }
  if (exitCode !== 0) throw new Error(`isolated schema migration failed: ${redactSensitiveText(output)}`)
}

async function connectSocket(url: string, token: string, origin: string) {
  const socket = socketIo(url, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token },
    extraHeaders: { Origin: origin },
    reconnection: false,
    timeout: 5_000,
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('legacy Socket connection timed out')), 7_000)
    socket.once('connect', () => { clearTimeout(timer); resolve() })
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error) })
  })
  return socket
}

async function main() {
  const prefix = `lba_${randomUUID().replaceAll('-', '').slice(0, 8)}_`
  assert(/^lba_[0-9a-f]{8}_$/.test(prefix))
  const database = process.env.DB_DATABASE?.trim()
  const migrationUser = process.env.DB_MIGRATION_USERNAME?.trim()
  const migrationPassword = process.env.DB_MIGRATION_PASSWORD
  if (!database) throw new Error('DB_DATABASE is required')
  if (!migrationUser || !migrationPassword) {
    throw new Error('DB_MIGRATION_USERNAME and DB_MIGRATION_PASSWORD are required for isolated schema acceptance')
  }
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const userId = randomUUID()
  const email = `legacy-http-socket-${userId}@example.invalid`
  const jwtSecret = `legacy-jwt-${randomUUID()}-${randomUUID()}`
  const sessionSecret = `legacy-session-${randomUUID()}-${randomUUID()}`
  const cutoff = new Date(Date.now() + 60 * 60_000).toISOString()
  const migrationConnection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database,
    user: migrationUser,
    password: migrationPassword,
    charset: 'utf8mb4_0900_ai_ci',
  })
  let connection: mysql.Connection | null = null
  let child: ChildProcess | null = null
  let socket: Socket | null = null
  let output = ''
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    API_PORT: String(port),
    DB_DATABASE: database,
    DB_FREFIX: prefix,
    AUTH_SESSION_SECRET: sessionSecret,
    JWT_SECRET: jwtSecret,
    AUTH_COOKIE_SECURE: 'false',
    AUTH_COOKIE_SAME_SITE: 'lax',
    AUTH_ALLOWED_ORIGINS: origin,
    AUTH_ALLOW_LEGACY_BEARER: 'true',
    AUTH_LEGACY_BEARER_CUTOFF: cutoff,
    AUTH_LEGACY_BEARER_ALLOWED_USER_IDS: userId,
    SOCKET_AUTH_REVALIDATE_MS: '1000',
    SEED_DEMO_USERS: 'false',
    RADAR_SYNC_ENABLED: 'false',
    RADAR_AUTO_CRAWL_ENABLED: 'false',
    RADAR_WECHAT_DAILY_ENABLED: 'false',
    DAILY_INTAKE_ENABLED: 'false',
  }
  try {
    const [preexisting] = await migrationConnection.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) count FROM information_schema.TABLES
       WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE ? ESCAPE '\\\\'`,
      [database, `${prefix.replaceAll('_', '\\_')}%`],
    )
    if (Number(preexisting[0]?.count ?? 0) !== 0) {
      throw new Error('isolated acceptance table prefix already exists; rerun to allocate another prefix')
    }
    await applyIsolatedMigrations(environment)
    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      database,
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      charset: 'utf8mb4_0900_ai_ci',
    })
    child = spawn(process.execPath, [
      '--env-file-if-exists=.env', '--import', 'tsx', 'server/src/index.ts',
    ], { cwd: process.cwd(), env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    const append = (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-40_000) }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`isolated app exited before ready: ${redactSensitiveText(output)}`)
      const health = await fetch(`${origin}/api/health`).catch(() => null)
      if (health?.ok) break
      await delay(250)
      if (attempt === 239) throw new Error(`isolated app did not become ready: ${redactSensitiveText(output)}`)
    }
    const usersTable = identifier(`${prefix}users`)
    const policyTable = identifier(`${prefix}auth_legacy_bearer_policy`)
    const auditTable = identifier(`${prefix}audit_logs`)
    await connection.execute(
      `INSERT INTO ${usersTable}
        (id,email,name,role,department,password_hash,status,created_at)
       VALUES (?,?,?,'系统管理员','迁移验收',?,'启用',NOW(3))`,
      [userId, email, '旧 JWT REST Socket 验收管理员', await bcrypt.hash(randomUUID(), 10)],
    )
    await connection.execute(
      `UPDATE ${policyTable} SET revoked_before=DATE_SUB(NOW(3), INTERVAL 5 SECOND),
         reason='isolated acceptance baseline',updated_by=NULL,updated_at=NOW(3) WHERE id='global'`,
    )
    const token = jwt.sign({
      uid: userId,
      email,
      name: '旧 JWT REST Socket 验收管理员',
      role: '系统管理员',
      department: '迁移验收',
    }, jwtSecret, { expiresIn: '10m' })

    const me = await fetch(`${origin}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}`, Origin: origin },
    })
    assert.equal(me.status, 200)
    const meBody = await me.json() as { authMode?: string; user?: { id?: string } }
    assert.equal(meBody.authMode, 'legacy-bearer')
    assert.equal(meBody.user?.id, userId)

    socket = await connectSocket(origin, token, origin)
    assert.equal(socket.connected, true)
    const [auditRows] = await connection.query<Array<RowDataPacket & { target: string; count: number }>>(
      `SELECT target,COUNT(*) count FROM ${auditTable}
       WHERE user_id=? AND action='旧 JWT 迁移窗口使用' GROUP BY target ORDER BY target`,
      [userId],
    )
    assert.deepEqual(auditRows.map((row) => [row.target, Number(row.count)]), [['rest', 1], ['socket', 1]])

    const disconnected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connected legacy Socket was not invalidated')), 7_000)
      socket!.once('disconnect', () => { clearTimeout(timer); resolve() })
    })
    await connection.execute(
      `UPDATE ${policyTable} SET revoked_before=NOW(3),version=version+1,
         reason='isolated acceptance invalidation',updated_by=?,updated_at=NOW(3) WHERE id='global'`,
      [userId],
    )
    const rejected = await fetch(`${origin}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}`, Origin: origin },
    })
    assert.equal(rejected.status, 401)
    assert.equal(((await rejected.json()) as { code?: string }).code, 'AUTH_LEGACY_REVOKED')
    await disconnected

    console.log(JSON.stringify({
      ok: true,
      serviceProcessesStarted: 1,
      isolatedTablePrefix: true,
      checks: [
        'allowlisted-legacy-jwt-authenticates-rest-only-before-cutoff',
        'allowlisted-legacy-jwt-authenticates-socket-only-before-cutoff',
        'rest-and-socket-legacy-use-create-separate-token-free-audit-records',
        'database-watermark-immediately-rejects-rest-token',
        'connected-socket-is-disconnected-on-next-bounded-revalidation',
      ],
    }))
  } finally {
    socket?.disconnect()
    if (child?.exitCode === null) child.kill('SIGTERM')
    let exitCode = child ? await waitForExit(child, 20_000) : 0
    if (child && exitCode === null) {
      child.kill('SIGKILL')
      exitCode = await waitForExit(child, 5_000)
    }
    if (exitCode !== 0) console.error(`[legacy bearer acceptance] isolated app exit=${String(exitCode)} ${redactSensitiveText(output)}`)
    await connection?.end().catch(() => undefined)
    const escapedPrefix = `${prefix.replaceAll('_', '\\_')}%`
    const [tables] = await migrationConnection.query<Array<RowDataPacket & { tableName: string }>>(
      `SELECT TABLE_NAME tableName FROM information_schema.TABLES
       WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE ? ESCAPE '\\\\' ORDER BY TABLE_NAME`,
      [database, escapedPrefix],
    )
    await migrationConnection.query('SET FOREIGN_KEY_CHECKS=0')
    try {
      for (const table of tables) await migrationConnection.query(`DROP TABLE ${identifier(table.tableName)}`)
    } finally {
      await migrationConnection.query('SET FOREIGN_KEY_CHECKS=1')
    }
    const [remaining] = await migrationConnection.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) count FROM information_schema.TABLES
       WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE ? ESCAPE '\\\\'`,
      [database, escapedPrefix],
    )
    await migrationConnection.end()
    assert.equal(Number(remaining[0]?.count ?? 0), 0)
    assert.equal(await portOpen(port), false)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
