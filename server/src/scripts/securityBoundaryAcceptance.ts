import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { redactSensitiveText } from '../security/redactSecrets.js'

const entry = 'server-dist/index.js'
const acceptanceEntry = 'server/src/scripts/resourceIsolationAcceptance.ts'
const requiredChecks = [
  'project-keyword-sql-injection-rejection',
  'project-owner-sql-injection-rejection',
  'project-route-sql-injection-rejection',
  'sql-injection-data-integrity',
  'database-error-response-disclosure-rejection',
  'database-failed-write-rollback',
  'malformed-json-response-disclosure-rejection',
  'filesystem-error-response-disclosure-rejection',
  'audit-log-create-mutation-rejection',
  'audit-log-update-mutation-rejection',
  'audit-log-delete-mutation-rejection',
  'audit-log-admin-delete-rejection',
  'audit-log-row-immutability',
  'high-risk-audit-actor-time-target-result-request-id',
  'project-workspace-generated-access-audit-without-storage-path',
  'ai-artifact-owner-download-audit',
  'ai-artifact-cross-user-download-rejection',
  'project-read-scope',
  'project-mutation-scope',
  'project-file-download-scope',
  'project-knowledge-scope',
  'workspace-traversal-rejection',
  'workspace-symlink-rejection',
  'workspace-absolute-path-rejection',
  'workspace-double-encoded-traversal-rejection',
  'generated-cross-user-rejection',
  'generated-symlink-rejection',
  'generated-traversal-arbitrary-read-rejection',
  'generated-absolute-path-rejection',
  'acceptance-knowledge-fixture-cleanup',
] as const

if (!existsSync(entry)) throw new Error('security boundary acceptance requires a current build; run npm run build first')

async function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('could not allocate security acceptance port')))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(null)
    }, timeoutMs)
    const onExit = (code: number | null) => {
      clearTimeout(timer)
      resolve(code)
    }
    child.once('exit', onExit)
  })
}

function appendBounded(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString('utf8')}`.slice(-80_000)
}

function acceptanceResult(output: string): { ok?: boolean; checks?: string[] } {
  for (const line of output.split(/\r?\n/).reverse()) {
    if (!line.trim().startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as { ok?: boolean; checks?: string[] }
      if (Array.isArray(parsed.checks)) return parsed
    } catch {
      // Continue past structured application or database logs.
    }
  }
  throw new Error(`security acceptance did not emit a result: ${redactSensitiveText(output)}`)
}

async function main() {
  const apiPort = await reserveFreePort()
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'cybernaut-security-acceptance-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    API_PORT: String(apiPort),
    RESOURCE_ACCEPTANCE_URL: `http://127.0.0.1:${apiPort}`,
    PROJECT_FILE_ROOT: path.join(runtimeRoot, 'project-files'),
    AGENT_WORKSPACE: path.join(runtimeRoot, 'workspace'),
    AI_ARTIFACT_ROOT: path.join(runtimeRoot, 'ai-artifacts'),
    AI_SKILL_ROOT: path.resolve(process.cwd(), 'server', 'workspace', '.agents', 'skills'),
    AUTH_SESSION_SECRET: 'security-boundary-acceptance-session-0123456789abcdef',
    JWT_SECRET: 'security-boundary-acceptance-jwt-0123456789abcdef',
    AUTH_COOKIE_SECURE: 'true',
    AUTH_COOKIE_SAME_SITE: 'lax',
    AUTH_ALLOWED_ORIGINS: 'https://security-boundary.example.invalid',
    AUTH_ALLOW_LEGACY_BEARER: 'false',
    SEED_DEMO_USERS: 'false',
    MODEL_CREDENTIAL_ENCRYPTION_KEY: '33'.repeat(32),
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: '3b'.repeat(32),
    MODEL_PROVIDER_ALLOWED_HOSTS: 'skill.zeelin.cn',
    RADAR_SYNC_ENABLED: 'false',
    RADAR_AUTO_CRAWL_ENABLED: 'false',
    RADAR_WECHAT_DAILY_ENABLED: 'false',
    DAILY_INTAKE_ENABLED: 'false',
  }
  const app = spawn(process.execPath, ['--env-file-if-exists=.env', entry], {
    cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let appOutput = ''
  app.stdout.on('data', (chunk: Buffer) => { appOutput = appendBounded(appOutput, chunk) })
  app.stderr.on('data', (chunk: Buffer) => { appOutput = appendBounded(appOutput, chunk) })

  try {
    let ready = false
    for (let attempt = 0; attempt < 180; attempt += 1) {
      if (app.exitCode !== null) throw new Error(`security acceptance app exited before ready: ${redactSensitiveText(appOutput)}`)
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`).catch(() => null)
      if (response?.ok) {
        const body = await response.json() as { ok?: boolean; service?: string }
        ready = body.ok === true && body.service === 'cybernaut-app'
        if (ready) break
      }
      await delay(250)
    }
    if (!ready) throw new Error(`security acceptance app did not become ready: ${redactSensitiveText(appOutput)}`)

    const probe = spawn(process.execPath, [
      '--env-file-if-exists=.env', '--import', 'tsx', acceptanceEntry,
    ], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let probeOutput = ''
    probe.stdout.on('data', (chunk: Buffer) => { probeOutput = appendBounded(probeOutput, chunk) })
    probe.stderr.on('data', (chunk: Buffer) => { probeOutput = appendBounded(probeOutput, chunk) })
    let probeExit = await waitForExit(probe, 120_000)
    if (probeExit === null) {
      probe.kill('SIGKILL')
      probeExit = await waitForExit(probe, 5_000)
    }
    if (probeExit !== 0) throw new Error(`security attack probes failed (exit=${String(probeExit)}): ${redactSensitiveText(probeOutput)}`)
    const result = acceptanceResult(probeOutput)
    const missing = requiredChecks.filter((check) => !result.checks?.includes(check))
    if (!result.ok || missing.length) throw new Error(`security acceptance result is incomplete: ${missing.join(', ')}`)

    console.log(JSON.stringify({
      ok: true,
      serviceProcessesStarted: 1,
      service: 'cybernaut-app',
      apiPort,
      attackClasses: ['sql-injection', 'path-traversal', 'authorization-bypass', 'arbitrary-file-read'],
      checks: result.checks?.length,
      requiredChecks: [...requiredChecks],
    }))
  } finally {
    if (app.exitCode === null) app.kill('SIGTERM')
    let appExit = await waitForExit(app, 20_000)
    if (appExit === null) {
      app.kill('SIGKILL')
      appExit = await waitForExit(app, 5_000)
    }
    await rm(runtimeRoot, { recursive: true, force: true })
    if (appExit !== 0) throw new Error(`security acceptance app did not stop cleanly (exit=${String(appExit)}): ${redactSensitiveText(appOutput)}`)
  }
}

await main()
