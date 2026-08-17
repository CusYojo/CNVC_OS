type LegacySourceRow = Record<string, unknown>

const LEGACY_SYNTHETIC_COLUMNS = new Set([
  'audit_logs.request_id',
  'audit_logs.result',
])

export function supportsLegacySyntheticColumn(table: string, column: string): boolean {
  return LEGACY_SYNTHETIC_COLUMNS.has(`${table}.${column}`)
}

export function legacySyntheticColumnValue(
  table: string,
  column: string,
  sourceRow: LegacySourceRow,
): unknown {
  if (table === 'audit_logs' && column === 'result') return 'success'
  if (table === 'audit_logs' && column === 'request_id') {
    const sourceId = String(sourceRow.id ?? '').trim()
    if (!sourceId) throw new Error('cannot synthesize audit_logs.request_id without source id')
    return `legacy-${sourceId}`
  }
  throw new Error(`unsupported legacy synthetic column ${table}.${column}`)
}
