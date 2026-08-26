import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { pool } from '../db/client.js'
import { quoteMysqlIdentifier } from '../db/config.js'

const execFileAsync = promisify(execFile)

async function runScript(script: string, database: string, extraEnvironment: NodeJS.ProcessEnv = {}, scriptArgs: string[] = []) {
  return execFileAsync(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', script, ...scriptArgs], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnvironment, DB_DATABASE: database },
    maxBuffer: 8 * 1024 * 1024,
  })
}

function parseJsonReport(stdout: string) {
  const report = stdout.trim()
  assert(report.startsWith('{'), 'acceptance script did not return a JSON report')
  return JSON.parse(report)
}

async function reserveFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return server.close(() => reject(new Error('could not allocate acceptance port')))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt += 1) await delay(100)
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function runHttpAcceptance(database: string) {
  const apiPort = await reserveFreePort()
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DB_DATABASE: database,
    API_PORT: String(apiPort),
    AUTH_SESSION_SECRET: 'lead-enrichment-http-acceptance-session-secret-0123456789',
    JWT_SECRET: 'lead-enrichment-http-acceptance-jwt-secret-0123456789',
    AUTH_COOKIE_SECURE: 'false',
    AUTH_ALLOW_LEGACY_BEARER: 'false',
    SEED_DEMO_USERS: 'false',
    LEAD_ENRICHMENT_ENABLED: 'false',
    LEAD_SCORE_WORKER_ENABLED: 'false',
    RADAR_SYNC_ENABLED: 'false',
    RADAR_AUTO_CRAWL_ENABLED: 'false',
    RADAR_WECHAT_DAILY_ENABLED: 'false',
    DAILY_INTAKE_ENABLED: 'false',
  }
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', 'server/src/index.ts'], {
    cwd: process.cwd(), env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-80_000) })
  child.stderr?.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-80_000) })
  try {
    let ready = false
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`lead enrichment HTTP acceptance server exited early: ${output}`)
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`).catch(() => null)
      if (response?.ok) {
        const body = await response.json() as { ok?: boolean; service?: string }
        if (body.ok === true && body.service === 'cybernaut-app') { ready = true; break }
      }
      await delay(250)
    }
    if (!ready) throw new Error(`lead enrichment HTTP acceptance server did not become ready: ${output}`)
    const result = await runScript('server/src/scripts/leadEnrichmentHttpFixtureAcceptance.ts', database, {
      LEAD_ENRICHMENT_HTTP_ACCEPTANCE_URL: `http://127.0.0.1:${apiPort}`,
      ALLOW_MYSQL_ACCEPTANCE_WRITES: '1',
    })
    return parseJsonReport(result.stdout)
  } finally {
    await stopChild(child)
  }
}

async function main() {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16)
  const database = `sbl_lead_enrichment_acceptance_${suffix}`
  assert(/^sbl_lead_enrichment_acceptance_[a-f0-9]{16}$/.test(database))
  let created = false
  try {
    await pool.query(`CREATE DATABASE ${quoteMysqlIdentifier(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    created = true
    await runScript('server/src/scripts/migrateMySqlSchema.ts', database)
    const result = await runScript('server/src/scripts/leadEnrichmentMysqlFixtureAcceptance.ts', database, {
      ALLOW_MYSQL_ACCEPTANCE_WRITES: '1',
      LEAD_ENRICHMENT_ENABLED: 'false',
      LEAD_SCORE_WORKER_ENABLED: 'false',
    })
    const parsed = parseJsonReport(result.stdout)
    assert.equal(parsed.ok, true)
    const http = await runHttpAcceptance(database)
    assert.equal(http.ok, true)
    parsed.checks.push(...http.checks)
    const retryEnvironment = {
      LEAD_ENRICHMENT_ENABLED: 'false',
      LEAD_SCORE_WORKER_ENABLED: 'false',
    }
    const retryArgs = ['--retry', '--batch-id=mysql-retry-acceptance', '--error-class=network']
    const preview = parseJsonReport((await runScript(
      'server/src/scripts/backfillLeadEnrichment.ts', database, retryEnvironment, retryArgs,
    )).stdout)
    assert.equal(preview.mode, 'retry-preview')
    assert.equal(preview.eligibleTopics, 1)
    assert.equal(preview.affectedJobs, 1)
    const applied = parseJsonReport((await runScript(
      'server/src/scripts/backfillLeadEnrichment.ts', database, retryEnvironment, [...retryArgs, '--apply'],
    )).stdout)
    assert.equal(applied.mode, 'retry-apply')
    assert.equal(applied.eligibleTopics, 1)
    const replayPreview = parseJsonReport((await runScript(
      'server/src/scripts/backfillLeadEnrichment.ts', database, retryEnvironment, retryArgs,
    )).stdout)
    assert.equal(replayPreview.eligibleTopics, 0)
    parsed.checks.push(
      'historical-backfill-retry-preview-is-read-only',
      'historical-backfill-retry-by-error-class-preserves-history-and-is-idempotent',
    )
    console.log(JSON.stringify({ ...parsed, databaseLifecycle: 'isolated-created-migrated-dropped' }))
  } finally {
    if (created) await pool.query(`DROP DATABASE ${quoteMysqlIdentifier(database)}`).catch(() => undefined)
    await pool.end()
  }
}

await main()
