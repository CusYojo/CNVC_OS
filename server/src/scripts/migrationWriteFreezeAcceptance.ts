import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { redactSensitiveText } from '../security/redactSecrets.js'

function productionEnvironment(apiPort?: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    ...(apiPort ? { API_PORT: String(apiPort) } : {}),
    AUTH_SESSION_SECRET: 'write-freeze-acceptance-session-0123456789abcdef',
    JWT_SECRET: 'write-freeze-acceptance-jwt-0123456789abcdef',
    AUTH_COOKIE_SECURE: 'true',
    AUTH_COOKIE_SAME_SITE: 'lax',
    AUTH_ALLOWED_ORIGINS: 'https://write-freeze.example.invalid',
    AUTH_ALLOW_LEGACY_BEARER: 'false',
    SEED_DEMO_USERS: 'false',
    MODEL_CREDENTIAL_ENCRYPTION_KEY: '33'.repeat(32),
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: '44'.repeat(32),
    MODEL_PROVIDER_ALLOWED_HOSTS: 'skill.zeelin.cn',
    MIGRATION_WRITE_FREEZE: 'true',
    MIGRATION_WRITE_FREEZE_MODE: 'rollback-window',
  }
}

async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  return Promise.race([
    new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code))),
    new Promise<null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), timeoutMs)
      timeout.unref()
    }),
  ])
}

async function runProbe() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/scripts/migrationWriteFreezeDatabaseProbe.ts'], {
    cwd: process.cwd(),
    env: productionEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  const exitCode = await waitForExit(child, 30_000)
  if (exitCode === null) child.kill('SIGKILL')
  assert.equal(exitCode, 0, `database probe failed: ${redactSensitiveText(output)}`)
  const records = output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
  })
  const result = records.find((record) => record.ok === true && record.dmlRejected === true)
  assert.ok(result, `database probe did not return its contract: ${redactSensitiveText(output)}`)
  return result
}

async function runService(apiPort: number) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: process.cwd(),
    env: productionEnvironment(apiPort),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const append = (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-60_000) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  try {
    let health: {
      ok?: boolean
      service?: string
      writeMode?: string
      components?: Array<{ name?: string; ok?: boolean; state?: string }>
    } | undefined
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`frozen service exited before ready: ${redactSensitiveText(output)}`)
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/health/components`).catch(() => null)
      if (response?.ok) {
        health = await response.json() as typeof health
        break
      }
      await delay(250)
    }
    assert.equal(health?.ok, true, `frozen component health failed: ${redactSensitiveText(output)}`)
    assert.equal(health?.service, 'cybernaut-app')
    assert.equal(health?.writeMode, 'rollback-window')
    const components = new Map((health?.components || []).map((item) => [item.name, item]))
    assert.equal(components.get('migration-write-freeze')?.ok, true)
    for (const name of [
      'project-discovery-radar', 'mysql-runtime-jobs', 'mysql-lead-score-jobs',
      'mysql-project-score-jobs', 'mysql-ai-tasks',
    ]) {
      assert.equal(components.get(name)?.state, 'intentionally-disabled', `${name} must be explicitly disabled`)
    }

    const baseHealthResponse = await fetch(`http://127.0.0.1:${apiPort}/api/health`)
    const baseHealth = await baseHealthResponse.json() as { ok?: boolean; writeMode?: string }
    assert.equal(baseHealthResponse.status, 200)
    assert.equal(baseHealth.ok, true)
    assert.equal(baseHealth.writeMode, 'rollback-window')

    const mutationResponse = await fetch(`http://127.0.0.1:${apiPort}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'blocked@example.invalid', password: 'never-processed' }),
    })
    const mutationBody = await mutationResponse.json() as { code?: string }
    assert.equal(mutationResponse.status, 503)
    assert.equal(mutationBody.code, 'MIGRATION_WRITE_FROZEN')
    assert.equal(mutationResponse.headers.get('retry-after'), '60')

    const webResponse = await fetch(`http://127.0.0.1:${apiPort}/`)
    assert.equal(webResponse.status, 200)
    assert.match(webResponse.headers.get('content-type') || '', /text\/html/)
    return {
      healthStatus: baseHealthResponse.status,
      componentHealthStatus: 200,
      mutationStatus: mutationResponse.status,
      mutationCode: mutationBody.code,
      webReadStatus: webResponse.status,
      disabledWriteComponents: 5,
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    let exitCode = await waitForExit(child, 20_000)
    if (exitCode === null) {
      child.kill('SIGKILL')
      exitCode = await waitForExit(child, 5_000)
    }
    assert.equal(exitCode, 0, `frozen service did not stop cleanly: ${redactSensitiveText(output)}`)
  }
}

const database = await runProbe()
const service = await runService(await unusedPort())
const report = {
  ok: true,
  capturedAt: new Date().toISOString(),
  service: 'cybernaut-app',
  mode: 'rollback-window',
  database: {
    mysqlSessionDefaultReadOnly: database.mysqlSessionDefaultReadOnly,
    dmlRejected: database.dmlRejected,
    rejectionCode: database.rejectionCode,
    rowsWritten: database.rowsWritten,
  },
  http: service,
  excludedBusinessReportGenerationTests: true,
  projectOriginalsIgnoredByApproval: 17,
}
const evidenceDirectory = path.resolve('.runtime/migration-evidence/migration-write-freeze')
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
await writeFile(path.join(evidenceDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify(report))
