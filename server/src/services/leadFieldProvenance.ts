export type LeadFieldSourceType =
  | 'manual'
  | 'manual_review'
  | 'legacy_import'
  | 'public_intel'
  | 'radar'
  | 'ai_scoring'
  | 'deterministic_backfill'

export const LEAD_FIELD_PRIORITY: Record<LeadFieldSourceType, number> = {
  manual: 100,
  manual_review: 100,
  legacy_import: 90,
  public_intel: 60,
  deterministic_backfill: 55,
  radar: 50,
  ai_scoring: 40,
}

export type LeadFieldProvenanceEntry = {
  sourceType: LeadFieldSourceType
  priority: number
  origins: LeadFieldSourceType[]
  operation: 'create' | 'set_if_empty' | 'append_unique' | 'machine_refresh' | 'preserve_existing'
  updatedAt?: string
}

export type LeadFieldProvenanceMap = Record<string, LeadFieldProvenanceEntry>

const SYSTEM_FIELDS = new Set([
  'id', 'createdAt', 'createdBy', 'convertedProjectId', 'claimedBy', 'poolStatus', 'fieldProvenance',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isMeaningfulLeadFieldValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') {
    return !['', '待核验', '待核实', '未披露', '未披露/待核实', '无', '-', 'N/A', 'null']
      .includes(value.trim())
  }
  if (Array.isArray(value)) return value.some(isMeaningfulLeadFieldValue)
  if (isObject(value)) return Object.values(value).some(isMeaningfulLeadFieldValue)
  return true
}

function entry(value: unknown): LeadFieldProvenanceEntry | undefined {
  if (!isObject(value)) return undefined
  const sourceType = String(value.sourceType || '') as LeadFieldSourceType
  const priority = Number(value.priority)
  if (!(sourceType in LEAD_FIELD_PRIORITY) || !Number.isFinite(priority)) return undefined
  const origins = Array.isArray(value.origins)
    ? value.origins.filter((item): item is LeadFieldSourceType => typeof item === 'string' && item in LEAD_FIELD_PRIORITY)
    : [sourceType]
  const operation = String(value.operation || 'preserve_existing') as LeadFieldProvenanceEntry['operation']
  return {
    sourceType,
    priority,
    origins: [...new Set(origins.length ? origins : [sourceType])],
    operation,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  }
}

export function leadFieldProvenanceMap(value: unknown): LeadFieldProvenanceMap {
  if (!isObject(value)) return {}
  const result: LeadFieldProvenanceMap = {}
  for (const [key, raw] of Object.entries(value)) {
    const parsed = entry(raw)
    if (parsed) result[key] = parsed
  }
  return result
}

export function leadFieldPriority(provenance: unknown, field: string): number {
  const map = leadFieldProvenanceMap(provenance)
  return map[field]?.priority ?? map['*']?.priority ?? LEAD_FIELD_PRIORITY.legacy_import
}

function provenanceEntry(
  current: LeadFieldProvenanceEntry | undefined,
  sourceType: LeadFieldSourceType,
  operation: LeadFieldProvenanceEntry['operation'],
  takeOwnership = false,
): LeadFieldProvenanceEntry {
  const incomingPriority = LEAD_FIELD_PRIORITY[sourceType]
  return {
    sourceType: takeOwnership || incomingPriority >= Number(current?.priority ?? 0) ? sourceType : current!.sourceType,
    priority: takeOwnership ? incomingPriority : Math.max(Number(current?.priority ?? 0), incomingPriority),
    origins: [...new Set([...(current?.origins ?? (current ? [current.sourceType] : [])), sourceType])],
    operation,
    updatedAt: new Date().toISOString(),
  }
}

export function initialLeadFieldProvenance(
  input: Record<string, unknown>,
  sourceType: LeadFieldSourceType,
): LeadFieldProvenanceMap {
  const map: LeadFieldProvenanceMap = {}
  for (const [field, value] of Object.entries(input)) {
    if (SYSTEM_FIELDS.has(field) || !isMeaningfulLeadFieldValue(value)) continue
    map[field] = provenanceEntry(undefined, sourceType, 'create')
  }
  return map
}

export function applyLeadFieldPolicy<T extends Record<string, unknown>>(
  existing: T,
  proposed: Record<string, unknown>,
  sourceType: LeadFieldSourceType,
  options: {
    additiveFields?: readonly string[]
    alwaysReplaceFields?: readonly string[]
    linkedFields?: readonly (readonly string[])[]
    operation?: 'set_if_empty' | 'machine_refresh'
  } = {},
): Partial<T> & { fieldProvenance?: LeadFieldProvenanceMap } {
  const additive = new Set(options.additiveFields ?? [])
  const alwaysReplace = new Set(options.alwaysReplaceFields ?? [])
  const incomingPriority = LEAD_FIELD_PRIORITY[sourceType]
  const currentMap = leadFieldProvenanceMap(existing.fieldProvenance)
  const nextMap: LeadFieldProvenanceMap = { ...currentMap }
  const patch: Record<string, unknown> = {}
  const linkedPriority = new Map<string, { meaningful: boolean; priority: number }>()
  for (const group of options.linkedFields ?? []) {
    const meaningfulFields = group.filter((field) => isMeaningfulLeadFieldValue(existing[field]))
    const groupState = {
      meaningful: meaningfulFields.length > 0,
      priority: meaningfulFields.reduce(
        (highest, field) => Math.max(highest, leadFieldPriority(existing.fieldProvenance, field)),
        0,
      ),
    }
    for (const field of group) linkedPriority.set(field, groupState)
  }

  for (const [field, next] of Object.entries(proposed)) {
    if (SYSTEM_FIELDS.has(field) || next === undefined) continue
    const current = existing[field]
    if (JSON.stringify(current) === JSON.stringify(next)) continue
    const operation = additive.has(field)
      ? 'append_unique' as const
      : options.operation ?? 'set_if_empty'
    const linkedState = linkedPriority.get(field)
    const hasProtectedCurrent = linkedState?.meaningful ?? isMeaningfulLeadFieldValue(current)
    const protectedPriority = linkedState?.priority ?? leadFieldPriority(existing.fieldProvenance, field)
    const canWrite = alwaysReplace.has(field)
      || additive.has(field)
      || !hasProtectedCurrent
      || (operation === 'machine_refresh' && protectedPriority <= incomingPriority)
    if (!canWrite) continue
    patch[field] = next
    nextMap[field] = provenanceEntry(
      currentMap[field] ?? currentMap['*'],
      sourceType,
      operation,
      alwaysReplace.has(field),
    )
  }

  if (Object.keys(patch).length) patch.fieldProvenance = nextMap
  return patch as Partial<T> & { fieldProvenance?: LeadFieldProvenanceMap }
}
