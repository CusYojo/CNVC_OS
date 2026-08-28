import assert from 'node:assert/strict'

export type FdeCleanupConnection = {
  tables(prefix: string): Promise<string[]>
  foreignKeys(enabled: boolean): Promise<void>
  drop(table: string): Promise<void>
  close(): Promise<void>
}

const connectionCodes = new Set(['PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'])
function connectionLost(error: unknown): boolean {
  const seen = new Set<unknown>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    if ('code' in error && connectionCodes.has(String(error.code))) return true
    error = 'cause' in error ? error.cause : undefined
  }
  return false
}

// Preserve the original test error even when cleanup also fails. Never replay
// a business test after a transport failure: its commit status may be unknown.
export async function withAcceptanceCleanup<T>(work: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let result: T | undefined, failed = false, original: unknown
  try { result = await work() } catch (error) { failed = true; original = error }
  try { await cleanup() } catch (error) {
    if (failed) throw new AggregateError([original, error], '验收失败且清理失败；保留两个错误，请核对隔离夹具')
    throw error
  }
  if (failed) throw original
  return result as T
}

export async function cleanupFdeTables(input: {
  targetPrefix: string
  sourcePrefix: string
  sourceTables: string[]
  connect: () => Promise<FdeCleanupConnection>
}) {
  const { targetPrefix, sourcePrefix, sourceTables, connect } = input
  assert.match(targetPrefix, /^fde_accept_[a-f0-9]{10}_$/)
  assert.match(sourcePrefix, /^[A-Za-z0-9_]+$/)
  assert.notEqual(targetPrefix, sourcePrefix, '不得清理业务前缀')
  const seenTables = new Set<string>()
  for (let attempt = 1; attempt <= 3; attempt++) {
    let connection: FdeCleanupConnection | undefined
    try {
      // A fresh dedicated connection per attempt; never reuse the metadata
      // connection that was idle while the child scripts ran.
      connection = await connect()
      assert.deepEqual(await connection.tables(sourcePrefix), sourceTables, '业务表集合变化，停止清理')
      const tables = await connection.tables(targetPrefix)
      for (const table of tables) {
        assert.ok(table.startsWith(targetPrefix) && /^[A-Za-z0-9_]+$/.test(table), '拒绝删除隔离前缀外的表')
        seenTables.add(table)
      }
      await connection.foreignKeys(false)
      for (const table of tables) await connection.drop(table)
      await connection.foreignKeys(true)
      assert.equal((await connection.tables(targetPrefix)).length, 0, '隔离表清理不完整')
      assert.deepEqual(await connection.tables(sourcePrefix), sourceTables, '业务表集合必须保持不变')
      return { tables: seenTables.size, attempts: attempt }
    } catch (error) {
      // Only cleanup retries. DROP IF EXISTS plus a new catalog read handles
      // a lost response after a DROP committed; never broaden the prefix.
      if (!connectionLost(error) || attempt === 3) throw error
    } finally {
      if (connection) {
        await connection.foreignKeys(true).catch(() => {})
        await connection.close().catch(() => {})
      }
    }
  }
  throw new Error('隔离清理重试耗尽')
}
