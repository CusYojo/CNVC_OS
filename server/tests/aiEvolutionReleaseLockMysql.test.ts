import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import type { PoolConnection } from 'mysql2/promise'
import { withEvolutionReleaseLock, type EvolutionReleaseLockControl } from '../src/services/aiEvolutionReleaseLock.js'

test('isolated release lock excludes the same resolved directory and releases on failure', {
  skip: process.env.EVOLUTION_ISOLATED_MYSQL_TEST !== 'true',
}, async () => {
  assert.equal(process.env.DB_HOST, '127.0.0.1'); assert.equal(process.env.DB_PORT, '43318')
  assert.equal(process.env.DB_DATABASE, 'evolution_isolated_test'); assert.equal(process.env.DB_FREFIX, 'evo_test_')
  const { pool } = await import('../src/db/client.js')
  const root = process.cwd()
  let expired: EvolutionReleaseLockControl | undefined
  try {
    await withEvolutionReleaseLock(pool, root, async control => {
      expired = control
      await control.assertHeld()
      await assert.rejects(withEvolutionReleaseLock(pool, path.join(root, 'server', '..'), async () => {
        assert.fail('competing release must never execute')
      }), { code: 'EVOLUTION_RELEASE_BUSY' })
      assert.equal(await withEvolutionReleaseLock(pool, path.join(root, 'server'), async () => 'other-target'), 'other-target')
    })
    assert.ok(expired?.signal.aborted)
    await assert.rejects(expired.assertHeld(), { code: 'EVOLUTION_RELEASE_LOCK_LOST' })
    await assert.rejects(withEvolutionReleaseLock(pool, root, async () => { throw Error('deployment failed') }), /deployment failed/)
    assert.equal(await withEvolutionReleaseLock(pool, root, async () => 'reacquired'), 'reacquired')
    let ownedConnection: PoolConnection | undefined
    const instrumentedPool = { getConnection: async () => { ownedConnection = await pool.getConnection(); return ownedConnection } }
    await assert.rejects(withEvolutionReleaseLock(instrumentedPool, root, async control => {
      await ownedConnection!.query('SELECT RELEASE_ALL_LOCKS()')
      await assert.rejects(control.assertHeld(), { code: 'EVOLUTION_RELEASE_LOCK_LOST' })
      assert.equal(control.signal.aborted, true)
      return 'must not report success'
    }), { code: 'EVOLUTION_RELEASE_LOCK_LOST' })
    assert.equal(await withEvolutionReleaseLock(pool, root, async () => 'recovered'), 'recovered')
  } finally { await pool.end() }
})
