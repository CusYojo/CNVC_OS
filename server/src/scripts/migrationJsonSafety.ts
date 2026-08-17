export type MigrationJsonContext = {
  sourceSystem: string
  table: string
  column: string
  sourceKey?: string
}

export class MigrationJsonError extends Error {
  readonly code = 'MIGRATION_INVALID_JSON'
  constructor(readonly context: MigrationJsonContext) {
    super(`Invalid JSON in ${context.sourceSystem}.${context.table}.${context.column}`)
    this.name = 'MigrationJsonError'
  }
}

export function parseMigrationJson(raw: unknown, context: MigrationJsonContext): unknown {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) }
  catch { throw new MigrationJsonError(context) }
}

export function isMigrationJsonError(error: unknown): error is MigrationJsonError {
  return error instanceof MigrationJsonError
}

export function migrationJsonIssue(error: MigrationJsonError) {
  return {
    severity: 'error' as const,
    sourceTable: error.context.table,
    sourceKey: error.context.sourceKey?.slice(0, 255),
    code: error.code,
    message: 'Source JSON is invalid and was quarantined without retaining its raw body.',
    payload: { column: error.context.column },
  }
}
