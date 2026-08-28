import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import mysql from 'mysql2/promise'

// Runs the actual isolated schema/browser harness, never a business-prefix test.
assert.match(process.env.DB_FREFIX ?? '', /^[A-Za-z0-9_]+$/)
const results: Array<Record<string, unknown>> = []
for (const mode of ['normal', 'signals', 'failure'] as const) {
  let output = '', partial = '', prefix = '', fixtureRoot = '', url = '', ready = false, cleanupStarted = false, cleanupComplete = false, lateSignal = false, timedOut = false
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', 'server/src/scripts/fdeMigrationAcceptance.ts', '--weekly-browser'], {
    env: { ...process.env, FDE_ACCEPTANCE_FIXTURE_EXIT: mode === 'signals' ? '' : mode }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  })
  const consume = (chunk: Buffer) => {
    output += chunk.toString(); partial += chunk.toString()
    const lines = partial.split('\n'); partial = lines.pop()!
    for (const line of lines) {
      let event: Record<string, unknown>
      try { event = JSON.parse(line) } catch { continue }
      if (event.fixturePrefix) { prefix = String(event.fixturePrefix); fixtureRoot = String(event.fixtureRoot) }
      if (event.fixture === 'fde-weekly-browser') { ready = true; url = String(event.url); if (mode === 'signals') child.kill('SIGINT') }
      if (event.cleanupStarted) { cleanupStarted = true; if (mode === 'signals') child.kill('SIGTERM') }
      if (event.acceptanceSignal === 'SIGTERM' && cleanupStarted) lateSignal = true
      if (event.cleanup === true) cleanupComplete = true
    }
  }
  child.stdout.on('data', consume); child.stderr.on('data', consume)
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 180_000)
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }))
  }).finally(() => clearTimeout(timer))
  console.log(JSON.stringify({ lifecycleMode: mode, prefix, fixtureRoot, ...result, ready, cleanupStarted, cleanupComplete, lateSignal, timedOut }))
  process.stdout.write(output)
  assert.equal(timedOut, false); assert.equal(result.signal, null); assert.equal(result.code, mode === 'failure' ? 1 : 0, output)
  assert.equal(ready, true); assert.equal(cleanupStarted, true); assert.equal(cleanupComplete, true)
  if (mode === 'signals') assert.equal(lateSignal, true, 'SIGTERM must arrive during actual MySQL cleanup, not just while serving')
  assert.match(prefix, /^fde_accept_[a-f0-9]{10}_$/); assert.notEqual(prefix, process.env.DB_FREFIX)
  assert.ok(fixtureRoot.includes('fde-migration-acceptance-')); assert.equal(existsSync(fixtureRoot), false)
  const connection = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_DATABASE, user: process.env.DB_MIGRATION_USERNAME || process.env.DB_USERNAME, password: process.env.DB_MIGRATION_PASSWORD || process.env.DB_PASSWORD, connectTimeout: 10_000 })
  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS remaining FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND LEFT(TABLE_NAME,?)=?', [process.env.DB_DATABASE, prefix.length, prefix])
    assert.equal(Number(rows[0].remaining), 0)
  } finally { await connection.end() }
  const closed = await new Promise<boolean>(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(url).port) })
    socket.once('connect', () => { socket.destroy(); resolve(false) })
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'))
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false) })
  })
  assert.equal(closed, true, 'fixture listener must be gone after cleanup')
  assert.doesNotMatch(output, /WebSocket server error/)
  results.push({ mode, prefix, fixtureRoot, code: result.code, lateSignal, remainingTables: 0, fixtureRootRemoved: true, listenerClosed: true })
}
console.log(JSON.stringify({ ok: true, scope: 'isolated-harness-lifecycle-not-business-uat', checks: ['normal-ready-stop-cleanup', 'SIGINT-then-SIGTERM-during-actual-cleanup', 'child-failure-retained-after-cleanup'], results }))
