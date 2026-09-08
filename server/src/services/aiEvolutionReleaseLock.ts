import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import { evolutionError } from './aiEvolutionPolicyService.js'

export type EvolutionReleaseLockControl = { signal: AbortSignal; assertHeld: () => Promise<void> }

/** All publishers sharing a target must use the same coordination database. */
export async function withEvolutionReleaseLock<T>(pool: Pick<Pool, 'getConnection'>, targetRoot: string,
  work: (control: EvolutionReleaseLockControl) => Promise<T>): Promise<T> {
  if (!path.isAbsolute(targetRoot)) throw Error('Release target root must be absolute')
  const resolved = await realpath(targetRoot)
  const key = createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex')
  const connection = await pool.getConnection()
  const controller = new AbortController()
  const lost = () => evolutionError(409, 'EVOLUTION_RELEASE_LOCK_LOST', '发布目录执行权已失效')
  let acquired = false
  let usable = true
  const onError = () => { usable = false; controller.abort(lost()) }
  connection.on('error', onError)
  const assertHeld = async () => {
    if (controller.signal.aborted) throw lost()
    try {
      const [rows] = await connection.query<RowDataPacket[]>({ sql: 'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held', timeout: 5000 }, [key])
      if (rows[0]?.held !== 1) throw lost()
    } catch (error) {
      usable = false; controller.abort(lost()); throw error
    }
    if (controller.signal.aborted) throw lost()
  }
  try {
    const rows = await connection.query<RowDataPacket[]>({ sql: 'SELECT GET_LOCK(?, 0) AS acquired', timeout: 5000 }, [key])
      .then(([result]) => result, error => { usable = false; throw error })
    if (rows[0]?.acquired !== 1) throw evolutionError(409, 'EVOLUTION_RELEASE_BUSY', '该发布目录正在被其他发布或恢复任务使用')
    acquired = true
    await assertHeld()
    const result = await work({ signal: controller.signal, assertHeld })
    await assertHeld()
    return result
  } finally {
    controller.abort(lost())
    if (acquired && usable) {
      try {
        const [rows] = await connection.query<RowDataPacket[]>({ sql: 'SELECT RELEASE_LOCK(?) AS released', timeout: 5000 }, [key])
        if (rows[0]?.released !== 1) usable = false
      } catch { usable = false }
    }
    connection.removeListener('error', onError)
    if (usable) connection.release()
    else connection.destroy()
  }
}
