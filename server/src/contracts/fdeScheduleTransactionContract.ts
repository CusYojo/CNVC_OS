// MySQL ER_LOCK_DEADLOCK rolls back the entire InnoDB transaction. Only retry
// a transaction closure, never one statement or an operation with external effects.
export function isScheduleDeadlock(error: unknown): boolean {
  const seen = new Set<object>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const value = current as { code?: unknown; errno?: unknown; cause?: unknown }
    if (value.code === 'ER_LOCK_DEADLOCK' && value.errno === 1213) return true
    current = value.cause
  }
  return false
}

export async function retryScheduleTransaction<T>(transaction: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await transaction() }
    catch (error) {
      // Timeouts, lost connections and unknown commit outcomes are NOT safe retries.
      if (!isScheduleDeadlock(error)) throw error
      if (attempt === 3) {
        throw Object.assign(new Error('时间安排正在被其他操作更新，请刷新后重试'), {
          code: 'SCHEDULE_RETRY_REQUIRED', status: 409, cause: error,
        })
      }
    }
  }
}
