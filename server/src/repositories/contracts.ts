export type RepositoryErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTEGRITY'
  | 'TRANSIENT'
  | 'UNKNOWN'

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode
  readonly operation: string
  readonly cause?: unknown

  constructor(code: RepositoryErrorCode, operation: string, message: string, cause?: unknown) {
    super(message)
    this.name = 'RepositoryError'
    this.code = code
    this.operation = operation
    this.cause = cause
  }
}

export function isRepositoryError(error: unknown): error is RepositoryError {
  return error instanceof RepositoryError
}

type MySqlDriverError = {
  code?: string
  errno?: number
  message?: string
  cause?: unknown
}

function findMySqlDriverError(error: unknown): MySqlDriverError | null {
  let current = error
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as MySqlDriverError
    if (typeof candidate.errno === 'number' || (typeof candidate.code === 'string' && candidate.code.startsWith('ER_'))) {
      return candidate
    }
    current = candidate.cause
  }
  return null
}

export function isMySqlTransientTransactionError(error: unknown): boolean {
  const driver = findMySqlDriverError(error) ?? (error as MySqlDriverError)
  return driver.errno === 1205 || driver.errno === 1213
    || driver.code === 'ER_LOCK_WAIT_TIMEOUT' || driver.code === 'ER_LOCK_DEADLOCK'
}

export function isMySqlDriverError(error: unknown): boolean {
  return findMySqlDriverError(error) !== null
}

export function mapMySqlRepositoryError(error: unknown, operation: string): RepositoryError {
  if (isRepositoryError(error)) return error
  const driver = findMySqlDriverError(error) ?? (error as MySqlDriverError)
  if (driver.errno === 1062 || driver.code === 'ER_DUP_ENTRY') {
    return new RepositoryError('CONFLICT', operation, '记录违反唯一性约束', error)
  }
  if (
    driver.errno === 1451 || driver.errno === 1452
    || driver.code === 'ER_ROW_IS_REFERENCED_2' || driver.code === 'ER_NO_REFERENCED_ROW_2'
  ) {
    return new RepositoryError('INTEGRITY', operation, '记录违反关联完整性约束', error)
  }
  if (isMySqlTransientTransactionError(error)) {
    return new RepositoryError('TRANSIENT', operation, '数据库事务暂时不可用，可安全重试', error)
  }
  return new RepositoryError('UNKNOWN', operation, 'Repository 操作失败', error)
}
