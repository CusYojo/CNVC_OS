import mysql from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import { createServer, connect, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { MYSQL_CONNECTION_COLLATION, mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

function isolatedPool(
  connectionLimit: number,
  queueLimit: number,
  endpoint = { host: mysqlConfig.host, port: mysqlConfig.port },
) {
  return mysql.createPool({
    host: endpoint.host,
    port: endpoint.port,
    database: mysqlConfig.database,
    user: mysqlConfig.user,
    password: mysqlConfig.password,
    charset: MYSQL_CONNECTION_COLLATION,
    timezone: '+08:00',
    connectionLimit,
    waitForConnections: true,
    queueLimit,
    connectTimeout: mysqlConfig.connectTimeoutMs,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  })
}

async function startFaultProxy() {
  let available = true
  const sockets = new Set<Socket>()
  const server = createServer((client) => {
    sockets.add(client)
    client.once('close', () => sockets.delete(client))
    client.on('error', () => undefined)
    if (!available) {
      client.destroy()
      return
    }
    const upstream = connect({ host: mysqlConfig.host, port: mysqlConfig.port })
    sockets.add(upstream)
    upstream.once('close', () => sockets.delete(upstream))
    upstream.on('error', () => {
      client.destroy()
      upstream.destroy()
    })
    client.pipe(upstream).pipe(client)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('[mysql resilience] fault proxy did not bind a TCP port')
  return {
    port: address.port,
    setAvailable(value: boolean) {
      available = value
      if (!value) for (const socket of [...sockets]) socket.destroy()
    },
    async close() {
      available = false
      for (const socket of [...sockets]) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

async function main() {
  const testPool = isolatedPool(1, 1)
  const proxy = await startFaultProxy()
  const outagePool = isolatedPool(2, 2, { host: '127.0.0.1', port: proxy.port })
  const jobsTable = quoteMysqlIdentifier(mysqlTableName('runtime_jobs'))
  const marker = randomUUID()
  const committedId = `mysql-outage-committed-${marker}`
  const uncommittedId = `mysql-outage-uncommitted-${marker}`
  try {
    const held = await testPool.getConnection()
    let queuedSettled = false
    const queued = testPool.query('SELECT 1 AS ok').then(([rows]) => {
      queuedSettled = true
      return rows as RowDataPacket[]
    })
    await delay(50)
    if (queuedSettled) throw new Error('[mysql resilience] query did not wait while the only connection was held')

    const overflowError = await testPool.query('SELECT 2 AS ok').then(
      () => null,
      (error: unknown) => error as Error & { code?: string },
    )
    if (!overflowError || !/queue limit/i.test(overflowError.message)) {
      throw new Error(`[mysql resilience] exhausted pool did not return a clear queue-limit error: ${overflowError?.message || 'none'}`)
    }
    held.release()
    const queuedRows = await queued
    if (Number(queuedRows[0]?.ok) !== 1) throw new Error('[mysql resilience] queued query did not recover after a connection was released')

    await outagePool.query('SELECT 1 AS ok')
    await outagePool.query(
      `INSERT INTO ${jobsTable}
        (id, task, enabled, schedule_kind, interval_seconds, payload, next_run_at, created_at, updated_at)
       VALUES (?, 'mysql-outage-acceptance', 0, 'interval', 3600, JSON_OBJECT(), DATE_ADD(NOW(3), INTERVAL 1 DAY), NOW(3), NOW(3))`,
      [committedId],
    )
    const transaction = await outagePool.getConnection()
    await transaction.beginTransaction()
    await transaction.query(
      `INSERT INTO ${jobsTable}
        (id, task, enabled, schedule_kind, interval_seconds, payload, next_run_at, created_at, updated_at)
       VALUES (?, 'mysql-outage-acceptance', 0, 'interval', 3600, JSON_OBJECT(), DATE_ADD(NOW(3), INTERVAL 1 DAY), NOW(3), NOW(3))`,
      [uncommittedId],
    )
    proxy.setAvailable(false)
    await delay(100)
    const outageError = await outagePool.query('SELECT 1 AS unavailable').then(
      () => null,
      (error: unknown) => error as Error & { code?: string },
    )
    if (!outageError) throw new Error('[mysql resilience] simulated network outage did not fail closed')
    await transaction.rollback().catch(() => undefined)
    transaction.release()

    proxy.setAvailable(true)
    let recoveredRows: Array<RowDataPacket & { id: string }> = []
    let transientErrorCode = String(outageError.code || outageError.name)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const [rows] = await outagePool.query<Array<RowDataPacket & { id: string }>>(
          `SELECT id FROM ${jobsTable} WHERE id IN (?, ?) ORDER BY id`,
          [committedId, uncommittedId],
        )
        recoveredRows = rows
        break
      } catch (error) {
        transientErrorCode = String((error as { code?: unknown }).code || (error as Error).name)
        await delay(150)
      }
    }
    if (recoveredRows.length !== 1 || recoveredRows[0].id !== committedId) {
      throw new Error('[mysql resilience] recovery did not preserve the committed row and roll back the uncommitted row')
    }

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'bounded-queue-error',
        'queued-query-recovery',
        'simulated-network-outage-fails-closed',
        'same-pool-reconnects-after-network-recovery',
        'confirmed-commit-survives-disconnect',
        'uncommitted-transaction-rolls-back-on-disconnect',
      ],
      configuredPool: {
        connectionLimit: mysqlConfig.connectionLimit,
        queueLimit: mysqlConfig.queueLimit,
        connectTimeoutMs: mysqlConfig.connectTimeoutMs,
      },
      connectionRecovered: true,
      transientErrorCode,
    }))
  } finally {
    await testPool.query(`DELETE FROM ${jobsTable} WHERE id IN (?, ?)`, [committedId, uncommittedId]).catch(() => undefined)
    await Promise.all([testPool.end(), outagePool.end(), proxy.close()])
  }
}

await main()
