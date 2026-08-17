import { createHash } from 'node:crypto'

export const LEAD_DUPLICATE_NORMALIZATION = 'NFKC + trim + collapse Unicode whitespace + lowercase comparison'

export type LeadDuplicateField = 'leads.name' | 'leads.company_name'
export type LeadDuplicateAction = 'pending' | 'merge' | 'keep-separate' | 'exception'
export type LeadSnapshot = Record<string, unknown> & {
  id: string
  name: string
  company_name: string | null
}

export type LeadDuplicateCollision = {
  field: LeadDuplicateField
  comparisonKey: string
  kind: 'exact-duplicate' | 'normalized-collision'
  records: Array<{ id: string; value: string }>
}

export type LeadDuplicateDispositionFile = {
  schemaVersion: '1.0'
  decisionSetId: string
  revision: number
  generatedAt: string
  normalization: typeof LEAD_DUPLICATE_NORMALIZATION
  normalizationReportSha256: string
  scope: {
    collisionGroups: number
    collisionRecordOccurrences: number
    uniqueLeadRecords: number
  }
  safeguards: {
    noAutomaticSelection: true
    physicalDeleteForbidden: true
    preserveAuditHistory: true
    transactionalApplyRequired: true
    revalidateLiveRows: true
  }
  groups: Array<{
    groupId: string
    field: LeadDuplicateField
    comparisonKey: string
    kind: 'exact-duplicate' | 'normalized-collision'
    records: Array<{ id: string; value: string; rowFingerprint: string }>
    decision: {
      decisionRevision: number
      action: LeadDuplicateAction
      canonicalLeadId: string | null
      mergedLeadIds: string[]
      reason: string
      approvedBy: string
      approvedAt: string | null
    }
  }>
}

type ValidationResult = {
  valid: boolean
  ready: boolean
  collisionGroups: number
  collisionRecordOccurrences: number
  uniqueLeadRecords: number
  pendingGroups: number
  decidedGroups: number
  mergeGroups: number
  errors: string[]
}

export function canonicalDisplayValue(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
}

export function leadDuplicateComparisonKey(value: string) {
  return canonicalDisplayValue(value).toLowerCase()
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return { $bufferSha256: sha256(value.toString('base64')) }
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJsonValue(child)]))
  }
  return value
}

export function leadRowFingerprint(row: LeadSnapshot) {
  return sha256(JSON.stringify(canonicalJsonValue(row)))
}

export function buildLeadDuplicateCollisions(rows: LeadSnapshot[]): LeadDuplicateCollision[] {
  const collisions: LeadDuplicateCollision[] = []
  const sources: Array<{ field: LeadDuplicateField; value: (row: LeadSnapshot) => string | null }> = [
    { field: 'leads.name', value: (row) => row.name },
    { field: 'leads.company_name', value: (row) => row.company_name },
  ]
  for (const source of sources) {
    const groups = new Map<string, Array<{ id: string; value: string }>>()
    for (const row of rows) {
      const value = source.value(row)
      if (typeof value !== 'string' || !value.trim()) continue
      const key = leadDuplicateComparisonKey(value)
      groups.set(key, [...(groups.get(key) || []), { id: row.id, value }])
    }
    for (const [comparisonKey, records] of groups) {
      if (records.length < 2) continue
      records.sort((left, right) => left.id.localeCompare(right.id))
      collisions.push({
        field: source.field,
        comparisonKey,
        kind: new Set(records.map((record) => record.value)).size === 1
          ? 'exact-duplicate' : 'normalized-collision',
        records,
      })
    }
  }
  return collisions.sort((left, right) => left.field.localeCompare(right.field)
    || left.comparisonKey.localeCompare(right.comparisonKey))
}

export function leadDuplicateGroupId(collision: LeadDuplicateCollision) {
  const ids = collision.records.map((record) => record.id).sort()
  return `ldg_${sha256(['lead-duplicate-group-v1', collision.field, collision.comparisonKey, ...ids].join('\0')).slice(0, 24)}`
}

export function collisionSignature(collisions: LeadDuplicateCollision[]) {
  return sha256(JSON.stringify(collisions.map((collision) => ({
    groupId: leadDuplicateGroupId(collision),
    field: collision.field,
    comparisonKey: collision.comparisonKey,
    kind: collision.kind,
    records: collision.records.map((record) => ({ id: record.id, value: record.value })),
  }))))
}

export function createLeadDuplicateDispositionTemplate(input: {
  collisions: LeadDuplicateCollision[]
  rows: LeadSnapshot[]
  normalizationReportSha256: string
  generatedAt?: string
}): LeadDuplicateDispositionFile {
  const rowsById = new Map(input.rows.map((row) => [row.id, row]))
  const uniqueIds = new Set(input.collisions.flatMap((collision) => collision.records.map((record) => record.id)))
  const generatedAt = input.generatedAt || new Date().toISOString()
  return {
    schemaVersion: '1.0',
    decisionSetId: `lead-duplicate-dispositions-${generatedAt.slice(0, 10).replaceAll('-', '')}`,
    revision: 1,
    generatedAt,
    normalization: LEAD_DUPLICATE_NORMALIZATION,
    normalizationReportSha256: input.normalizationReportSha256,
    scope: {
      collisionGroups: input.collisions.length,
      collisionRecordOccurrences: input.collisions.reduce((total, collision) => total + collision.records.length, 0),
      uniqueLeadRecords: uniqueIds.size,
    },
    safeguards: {
      noAutomaticSelection: true,
      physicalDeleteForbidden: true,
      preserveAuditHistory: true,
      transactionalApplyRequired: true,
      revalidateLiveRows: true,
    },
    groups: input.collisions.map((collision) => ({
      groupId: leadDuplicateGroupId(collision),
      field: collision.field,
      comparisonKey: collision.comparisonKey,
      kind: collision.kind,
      records: collision.records.map((record) => {
        const row = rowsById.get(record.id)
        if (!row) throw new Error('LEAD_DUPLICATE_ROW_MISSING')
        return { ...record, rowFingerprint: leadRowFingerprint(row) }
      }),
      decision: {
        decisionRevision: 1,
        action: 'pending',
        canonicalLeadId: null,
        mergedLeadIds: [],
        reason: '',
        approvedBy: '',
        approvedAt: null,
      },
    })),
  }
}

function sameStrings(left: string[], right: string[]) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function validApproval(decision: LeadDuplicateDispositionFile['groups'][number]['decision']) {
  return decision.decisionRevision >= 1
    && decision.reason.trim().length >= 10
    && decision.approvedBy.trim().length >= 2
    && typeof decision.approvedAt === 'string'
    && Number.isFinite(Date.parse(decision.approvedAt))
}

class UnionFind {
  private readonly parent = new Map<string, string>()
  add(id: string) { if (!this.parent.has(id)) this.parent.set(id, id) }
  find(id: string): string {
    this.add(id)
    const parent = this.parent.get(id) as string
    if (parent === id) return id
    const root = this.find(parent)
    this.parent.set(id, root)
    return root
  }
  union(left: string, right: string) { this.parent.set(this.find(right), this.find(left)) }
}

export function validateLeadDuplicateDispositions(input: {
  file: LeadDuplicateDispositionFile
  expected: LeadDuplicateDispositionFile
  strict: boolean
}): ValidationResult {
  const { file, expected, strict } = input
  const errors: string[] = []
  const error = (code: string) => { if (!errors.includes(code)) errors.push(code) }
  if (file.schemaVersion !== '1.0' || !Number.isInteger(file.revision) || file.revision < 1
    || !/^lead-duplicate-dispositions-[0-9]{8}$/.test(file.decisionSetId || '')) error('INVALID_HEADER')
  if (file.normalization !== LEAD_DUPLICATE_NORMALIZATION
    || file.normalizationReportSha256 !== expected.normalizationReportSha256) error('BASELINE_MISMATCH')
  if (JSON.stringify(file.scope) !== JSON.stringify(expected.scope)) error('SCOPE_MISMATCH')
  if (JSON.stringify(file.safeguards) !== JSON.stringify(expected.safeguards)) error('SAFEGUARDS_MISMATCH')
  if (!Array.isArray(file.groups) || file.groups.length !== expected.groups.length || file.groups.length > 10_000) {
    error('GROUP_COVERAGE_MISMATCH')
  }

  const actualById = new Map((Array.isArray(file.groups) ? file.groups : []).map((group) => [group.groupId, group]))
  if (actualById.size !== (file.groups || []).length) error('DUPLICATE_GROUP_ID')
  let pendingGroups = 0
  let decidedGroups = 0
  let mergeGroups = 0
  const unionFind = new UnionFind()
  const mergeCanonicals = new Map<string, string>()
  const nonMergeGroups: Array<{ action: LeadDuplicateAction; ids: string[] }> = []

  for (const expectedGroup of expected.groups) {
    const group = actualById.get(expectedGroup.groupId)
    if (!group) { error('GROUP_COVERAGE_MISMATCH'); continue }
    if (group.field !== expectedGroup.field || group.comparisonKey !== expectedGroup.comparisonKey
      || group.kind !== expectedGroup.kind) error('GROUP_IDENTITY_MISMATCH')
    const expectedIds = expectedGroup.records.map((record) => record.id)
    const actualIds = Array.isArray(group.records) ? group.records.map((record) => record.id) : []
    if (!sameStrings(actualIds, expectedIds) || new Set(actualIds).size !== actualIds.length) error('RECORD_COVERAGE_MISMATCH')
    const expectedRecords = new Map(expectedGroup.records.map((record) => [record.id, record]))
    for (const record of group.records || []) {
      const expectedRecord = expectedRecords.get(record.id)
      if (!expectedRecord || record.value !== expectedRecord.value) error('RECORD_VALUE_DRIFT')
      if (!expectedRecord || record.rowFingerprint !== expectedRecord.rowFingerprint) error('ROW_FINGERPRINT_DRIFT')
    }

    const decision = group.decision
    if (!decision || !['pending', 'merge', 'keep-separate', 'exception'].includes(decision.action)) {
      error('INVALID_ACTION'); continue
    }
    if (decision.action === 'pending') {
      pendingGroups += 1
      if (decision.canonicalLeadId !== null || decision.mergedLeadIds?.length || decision.reason
        || decision.approvedBy || decision.approvedAt !== null) error('PENDING_DECISION_HAS_APPROVAL_DATA')
      continue
    }
    decidedGroups += 1
    if (!validApproval(decision)) error('APPROVAL_INCOMPLETE')
    if (decision.action === 'merge') {
      mergeGroups += 1
      if (!decision.canonicalLeadId || !expectedIds.includes(decision.canonicalLeadId)) {
        error('INVALID_CANONICAL_LEAD'); continue
      }
      const mergedIds = expectedIds.filter((id) => id !== decision.canonicalLeadId)
      if (!Array.isArray(decision.mergedLeadIds) || !sameStrings(decision.mergedLeadIds, mergedIds)
        || new Set(decision.mergedLeadIds).size !== decision.mergedLeadIds.length) error('INVALID_MERGE_SCOPE')
      for (const id of expectedIds) unionFind.add(id)
      for (const id of mergedIds) unionFind.union(decision.canonicalLeadId, id)
      mergeCanonicals.set(group.groupId, decision.canonicalLeadId)
    } else {
      if (decision.canonicalLeadId !== null || !Array.isArray(decision.mergedLeadIds) || decision.mergedLeadIds.length) {
        error('NON_MERGE_HAS_MERGE_SCOPE')
      }
      nonMergeGroups.push({ action: decision.action, ids: expectedIds })
    }
  }

  const componentCanonicals = new Map<string, Set<string>>()
  for (const [groupId, canonical] of mergeCanonicals) {
    const group = actualById.get(groupId)
    if (!group) continue
    const root = unionFind.find(group.records[0].id)
    const canonicals = componentCanonicals.get(root) || new Set<string>()
    canonicals.add(canonical)
    componentCanonicals.set(root, canonicals)
  }
  if ([...componentCanonicals.values()].some((canonicals) => canonicals.size !== 1)) error('CONFLICTING_MERGE_CANONICALS')
  for (const group of nonMergeGroups) {
    const roots = group.ids.map((id) => unionFind.find(id))
    if (new Set(roots).size < roots.length) error('MERGE_CONTRADICTS_SEPARATE_DECISION')
  }
  if (strict && pendingGroups > 0) error('PENDING_DECISIONS')
  return {
    valid: errors.length === 0 || (errors.length === 1 && errors[0] === 'PENDING_DECISIONS'),
    ready: errors.length === 0 && pendingGroups === 0,
    collisionGroups: expected.scope.collisionGroups,
    collisionRecordOccurrences: expected.scope.collisionRecordOccurrences,
    uniqueLeadRecords: expected.scope.uniqueLeadRecords,
    pendingGroups,
    decidedGroups,
    mergeGroups,
    errors,
  }
}
