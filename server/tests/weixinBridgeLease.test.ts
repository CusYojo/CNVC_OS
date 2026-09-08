import assert from 'node:assert/strict'
import test from 'node:test'

import { acquireWeixinBridgeLease, type WeixinBridgeLeasePool } from '../src/services/weixinBridgeLease.js'

function fakePool() {
  let held = false
  let releasedConnections = 0
  const pool: WeixinBridgeLeasePool = {
    async getConnection() {
      return {
        async query(sql) {
          if (sql.includes('GET_LOCK')) {
            if (held) return [[{ acquired: 0 }], []]
            held = true
            return [[{ acquired: 1 }], []]
          }
          if (sql.includes('RELEASE_LOCK')) {
            held = false
            return [[{ released: 1 }], []]
          }
          throw new Error('unexpected query')
        },
        release() { releasedConnections += 1 },
      }
    },
  }
  return { pool, get releasedConnections() { return releasedConnections } }
}

test('only one bridge lease owns the database lock and release enables takeover', async () => {
  const state = fakePool()
  const first = await acquireWeixinBridgeLease(state.pool, 'test')
  const second = await acquireWeixinBridgeLease(state.pool, 'test')
  assert.equal(first.acquired, true)
  assert.equal(second.acquired, false)
  assert.equal(state.releasedConnections, 1)
  await first.release()
  const third = await acquireWeixinBridgeLease(state.pool, 'test')
  assert.equal(third.acquired, true)
  await third.release()
  assert.equal(state.releasedConnections, 3)
})
