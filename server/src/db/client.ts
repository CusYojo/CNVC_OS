import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

const { Pool } = pg

const url = process.env.DATABASE_URL || 'postgres://cybernaut:cyb_mvp_2026@127.0.0.1:5432/cybernaut_mvp'

export const pool = new Pool({
  connectionString: url,
  max: 8,
  idleTimeoutMillis: 30_000,
})

pool.on('error', (err) => {
  console.error('[pg pool] unexpected error:', err.message)
})

export const db = drizzle(pool, { schema })
export { schema }
