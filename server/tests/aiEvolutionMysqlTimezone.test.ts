import assert from 'node:assert/strict'
import test from 'node:test'

test('isolated pool connections use the same clock for encoded dates and SQL NOW', {
  skip: process.env.EVOLUTION_ISOLATED_MYSQL_TEST !== 'true',
}, async () => {
  assert.equal(process.env.DB_HOST, '127.0.0.1')
  assert.equal(process.env.DB_PORT, '43318')
  assert.equal(process.env.DB_DATABASE, 'evolution_isolated_test')
  const { pool } = await import('../src/db/client.js')
  const connections = []
  try {
    for (let i = 0; i < 3; i++) connections.push(await pool.getConnection())
    for (const connection of connections) {
      const before = Date.now()
      const [rows] = await connection.query('SELECT NOW(3) AS db_clock, @@session.time_zone AS zone, TIMESTAMPDIFF(SECOND,NOW(3),?) AS offset_seconds', [new Date(before)])
      const row = (rows as { db_clock: Date; zone: string; offset_seconds: number }[])[0]
      assert.equal(row.zone, '+08:00')
      assert.ok(Math.abs(row.db_clock.getTime() - before) < 5000)
      assert.ok(Math.abs(row.offset_seconds) < 5)
    }
  } finally {
    for (const connection of connections) connection.release()
    await pool.end()
  }
})
