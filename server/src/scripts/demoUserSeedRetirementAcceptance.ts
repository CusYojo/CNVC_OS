import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { seedUsers } from '../services/authService.js'

async function userCount() {
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${quoteMysqlIdentifier(mysqlTableName('users'))}`,
  )
  return Number(rows[0]?.count || 0)
}

async function main() {
  const original = process.env.SEED_DEMO_USERS
  const before = await userCount()
  try {
    process.env.SEED_DEMO_USERS = '1'
    const result = await seedUsers()
    const after = await userCount()
    if (!result.skipped || !result.retired || result.seeded !== 0 || before !== after) {
      throw new Error('retired demo-user seed attempted to change the user authority')
    }
    console.log(JSON.stringify({
      ok: true,
      checks: [
        'stale-seed-enable-request-is-ignored',
        'retired-seed-reports-zero-created-accounts',
        'mysql-user-authority-count-remains-unchanged',
      ],
      databaseWrites: 0,
    }))
  } finally {
    if (original === undefined) delete process.env.SEED_DEMO_USERS
    else process.env.SEED_DEMO_USERS = original
  }
}

await main().finally(async () => pool.end())
