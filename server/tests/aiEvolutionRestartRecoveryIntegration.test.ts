import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerEvolutionEnvironment } from '../src/runtime/evolution/dockerEvolutionEnvironment.js'
import { EvolutionRunCoordinator } from '../src/runtime/evolution/evolutionRunCoordinator.js'

type Ready = { userId: string; proposalId: string; identity: { runId: string; attempt: number; leaseToken: number; inputHash: string } }

test('a new host revokes an expired lease and removes the crashed host container', {
  skip: process.env.EVOLUTION_RESTART_INTEGRATION_TEST !== 'true', timeout: 60_000,
}, async () => {
  assert.equal(process.env.DB_DATABASE, 'evolution_isolated_test')
  assert.equal(process.env.DB_HOST, '127.0.0.1')
  assert.equal(process.env.DB_PORT, '43318')
  assert.equal(process.env.DB_FREFIX, 'evo_test_')
  const image = process.env.EVOLUTION_BUILD_IMAGE!
  assert.match(image, /^sha256:[a-f0-9]{64}$/)
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'evolutionCrashLeaseWorker.ts')
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const ready = await new Promise<Ready>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Crash worker did not become ready: ${stderr}`)), 30_000)
    let stdout = ''
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      const match = stdout.match(/CRASH_WORKER_READY (\{[^\n]+\})/)
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1]) as Ready) }
    })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Crash worker exited early (${code}): ${stderr}`)) })
  })
  const name = `sbl-evo-${ready.identity.runId}-${ready.identity.attempt}-${ready.identity.leaseToken}`
  try {
    assert.equal(execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', name], { encoding: 'utf8' }).trim(), 'true')
    child.kill('SIGKILL')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Crash worker did not terminate')), 10_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    await new Promise(resolve => setTimeout(resolve, 10_500))

    const { pool } = await import('../src/db/client.js')
    const { MySqlAiEvolutionRepository } = await import('../src/repositories/mysql/mysqlAiEvolutionRepository.js')
    const runs = new MySqlAiEvolutionRepository()
    const environment = new DockerEvolutionEnvironment(undefined, image)
    const coordinator = new EvolutionRunCoordinator(runs, 'replacement-host', async () => {
      assert.fail('recovery must not execute an interrupted run without explicit resume')
    }, identity => environment.terminate(identity), 'code')
    await coordinator.tick()

    const recovered = await runs.findRun(ready.userId, ready.identity.runId)
    assert.equal(recovered?.status, 'interrupted')
    assert.equal(recovered?.stage, 'interrupted')
    assert.equal(recovered?.leaseOwner, null)
    assert.equal(recovered?.leaseExpiresAt, null)
    const eventTypes = (await runs.listEvents(ready.userId, ready.identity.runId, 0)).map(event => event.eventType)
    assert.ok(eventTypes.includes('lease_revoked'))
    assert.ok(eventTypes.includes('interrupted'))
    assert.throws(() => execFileSync('docker', ['inspect', name], { stdio: 'pipe' }))
    await assert.rejects(runs.heartbeat(ready.identity), { code: 'EVOLUTION_STALE_EXECUTOR' })
    console.log(`RESTART_RECOVERY_PASS run=${ready.identity.runId} container=${name}`)
    await pool.end()
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }) } catch { /* already removed by recovery */ }
  }
})
