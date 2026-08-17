import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { migrationWriteFreezePolicy } from '../config/migrationWriteFreezePolicy.js'

assert.equal(migrationWriteFreezePolicy.enabled, true)
const table = quoteMysqlIdentifier(mysqlTableName('users'))
const id = randomUUID()
const email = `migration-write-freeze-${id}@example.invalid`

try {
  const [modeRows] = await pool.query<Array<RowDataPacket & { read_only: number }>>(
    'SELECT @@SESSION.transaction_read_only AS read_only',
  )
  assert.equal(Number(modeRows[0]?.read_only), 1, 'MySQL session default must be read-only')

  let rejectionCode = ''
  try {
    await pool.query(
      `INSERT INTO ${table} (id, email, name, role, department, password_hash, status)
       VALUES (?, ?, 'migration freeze probe', '系统管理员', '迁移验收', 'not-a-login-hash', '禁用')`,
      [id, email],
    )
  } catch (error) {
    rejectionCode = String((error as { code?: string }).code || '')
  }
  assert.equal(rejectionCode, 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION')
  const [rows] = await pool.query<Array<RowDataPacket & { value: number }>>(
    `SELECT COUNT(*) AS value FROM ${table} WHERE id=?`,
    [id],
  )
  assert.equal(Number(rows[0]?.value), 0, 'write-freeze probe must leave no row')
  console.log(JSON.stringify({
    ok: true,
    mode: migrationWriteFreezePolicy.mode,
    mysqlSessionDefaultReadOnly: true,
    dmlRejected: true,
    rejectionCode,
    rowsWritten: 0,
  }))
} finally {
  await pool.end()
}
