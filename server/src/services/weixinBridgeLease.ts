import { createHash } from 'node:crypto'

type QueryResult = [unknown, unknown]

export type WeixinBridgeLeaseConnection = {
  query(sql: string, values: unknown[]): Promise<QueryResult>
  release(): void
}

export type WeixinBridgeLeasePool = {
  getConnection(): Promise<WeixinBridgeLeaseConnection>
}

export type WeixinBridgeLease = {
  acquired: boolean
  release(): Promise<void>
}

function lockName(databaseName: string) {
  const digest = createHash('sha256').update(databaseName).digest('hex').slice(0, 40)
  return `weixin-bridge:${digest}`
}

export async function acquireWeixinBridgeLease(
  pool: WeixinBridgeLeasePool,
  databaseName: string,
): Promise<WeixinBridgeLease> {
  const connection = await pool.getConnection()
  let acquired = false
  try {
    const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName(databaseName)])
    acquired = Number((rows as Array<{ acquired?: number }>)[0]?.acquired ?? 0) === 1
    if (!acquired) connection.release()
  } catch (error) {
    connection.release()
    throw error
  }
  let released = !acquired
  return {
    acquired,
    async release() {
      if (released) return
      released = true
      try { await connection.query('SELECT RELEASE_LOCK(?) AS released', [lockName(databaseName)]) }
      finally { connection.release() }
    },
  }
}
