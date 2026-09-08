import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import * as schema from './schema.js'
import { MYSQL_CONNECTION_COLLATION, mysqlConfig } from './config.js'
import { safeErrorLog } from '../security/redactSecrets.js'
import { migrationWriteFreezePolicy } from '../config/migrationWriteFreezePolicy.js'

export const pool = mysql.createPool({
  host: mysqlConfig.host,
  port: mysqlConfig.port,
  database: mysqlConfig.database,
  user: mysqlConfig.user,
  password: mysqlConfig.password,
  charset: MYSQL_CONNECTION_COLLATION,
  timezone: '+08:00',
  connectionLimit: mysqlConfig.connectionLimit,
  waitForConnections: true,
  queueLimit: mysqlConfig.queueLimit,
  connectTimeout: mysqlConfig.connectTimeoutMs,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  decimalNumbers: true,
})

pool.pool.on('connection', (connection) => {
  connection.on('error', (error) => console.error(JSON.stringify({
    event: 'mysql_connection_error', error: safeErrorLog(error),
  })))
  // Match mysql2's timestamp encoding to NOW()/TIMESTAMP on every connection.
  // A UTC server default otherwise offsets lease expiry by eight hours.
  connection.query("SET SESSION time_zone = '+08:00'", (error) => {
    if (!error) return
    console.error(JSON.stringify({ event: 'mysql_timezone_initialization_failed', error: safeErrorLog(error) }))
    connection.destroy()
  })
  if (migrationWriteFreezePolicy.enabled) {
    // Queued before the pool hands a new connection to callers. This makes
    // implicit and explicit transactions read-only; HTTP/startup guards are
    // defence in depth rather than the only write lock.
    connection.query('SET SESSION TRANSACTION READ ONLY', (error) => {
      if (!error) return
      console.error(JSON.stringify({
        event: 'mysql_read_only_session_initialization_failed', error: safeErrorLog(error),
      }))
      connection.destroy()
    })
  }
})

export const db = drizzle({ client: pool, schema, mode: 'default' })
export { schema }
