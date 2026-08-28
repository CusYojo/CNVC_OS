import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanupFdeTables, withAcceptanceCleanup, type FdeCleanupConnection } from '../src/scripts/fdeAcceptanceCleanup.js'

const targetPrefix = 'fde_accept_012345abcd_', sourcePrefix = 'business_', sourceTables = ['business_projects']
const lost = () => Object.assign(new Error('synthetic disconnect'), { code: 'PROTOCOL_CONNECTION_LOST' })

test('acceptance cleanup retains the original error and reports both failures without replay', async () => {
  const original = new Error('business failure'), cleanup = new Error('cleanup failure')
  let calls = 0
  await assert.rejects(withAcceptanceCleanup(async () => { calls++; throw original }, async () => { throw cleanup }), error => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === cleanup)
  assert.equal(calls, 1)
  await assert.rejects(withAcceptanceCleanup(async () => { throw original }, async () => {}), error => error === original)
  assert.equal(await withAcceptanceCleanup(async () => 42, async () => {}), 42)
  await assert.rejects(withAcceptanceCleanup(async () => 42, async () => { throw cleanup }), error => error === cleanup)
})

test('cleanup rejects unsafe prefixes before connecting', async () => {
  let connects = 0
  const connect = async (): Promise<FdeCleanupConnection> => { connects++; throw new Error('must not connect') }
  for (const prefix of ['business_', 'fde_accept_', 'fde_accept_012345abcd_;DROP']) {
    await assert.rejects(cleanupFdeTables({ targetPrefix: prefix, sourcePrefix, sourceTables, connect }))
  }
  await assert.rejects(cleanupFdeTables({ targetPrefix, sourcePrefix: targetPrefix, sourceTables, connect }))
  assert.equal(connects, 0)
})

test('cleanup reconnects after a lost DROP response and removes only remaining isolated tables', async () => {
  const remaining = new Set([`${targetPrefix}one`, `${targetPrefix}two`])
  const drops: string[] = [], closed: number[] = []
  let attempts = 0
  const result = await cleanupFdeTables({ targetPrefix, sourcePrefix, sourceTables, connect: async () => {
    const attempt = ++attempts
    return {
      tables: async prefix => prefix === sourcePrefix ? [...sourceTables] : [...remaining],
      foreignKeys: async () => {},
      drop: async table => { drops.push(table); remaining.delete(table); if (attempt === 1) throw lost() },
      close: async () => { closed.push(attempt) },
    }
  } })
  assert.deepEqual(result, { tables: 2, attempts: 2 })
  assert.deepEqual(drops, [`${targetPrefix}one`, `${targetPrefix}two`])
  assert.deepEqual(closed, [1, 2]); assert.equal(remaining.size, 0)
})

test('catalog escape or changed business table set fails before any DROP without retry', async () => {
  for (const mode of ['foreign-table', 'changed-source']) {
    let connects = 0, drops = 0, closed = 0
    await assert.rejects(cleanupFdeTables({ targetPrefix, sourcePrefix, sourceTables, connect: async () => {
      connects++
      return {
        tables: async prefix => prefix === sourcePrefix ? mode === 'changed-source' ? [] : sourceTables : ['business_projects'],
        foreignKeys: async () => {}, drop: async () => { drops++ }, close: async () => { closed++ },
      }
    } }))
    assert.equal(connects, 1); assert.equal(drops, 0); assert.equal(closed, 1)
  }
})

test('cleanup only retries transport errors, bounded to three fresh connections', async () => {
  let attempts = 0
  await assert.rejects(cleanupFdeTables({ targetPrefix, sourcePrefix, sourceTables, connect: async () => { attempts++; throw lost() } }), error => (error as { code?: string }).code === 'PROTOCOL_CONNECTION_LOST')
  assert.equal(attempts, 3)
  attempts = 0
  const denied = Object.assign(new Error('synthetic denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' })
  await assert.rejects(cleanupFdeTables({ targetPrefix, sourcePrefix, sourceTables, connect: async () => { attempts++; throw denied } }), error => error === denied)
  assert.equal(attempts, 1)
})
