import { createHash } from 'node:crypto'

export type LeadReserveGapRecord = {
  id: number
  sourceKeySha256: string
  fingerprintSha256: string
}

export type AiArtifactGapRecord = {
  id: string
  taskType: string
  fileName: string
  format: string
  taskIdSha256: string
  userIdSha256: string
  projectIdSha256: string
  fileNameSha256: string
  storagePathSha256: string
  qualityStatus: string
  archived: boolean
  fingerprintSha256: string
}

export type SourceGapDomain<T> = {
  count: number
  baselineSha256: string
  disposition: string
  rationale: string
  approvedBy: string
  approvedAt: string
  records: T[]
}

export type SourceGapDispositionDocument = {
  schemaVersion: '1.0'
  generatedAt: string
  decisionVersion: number
  leadReserve: SourceGapDomain<LeadReserveGapRecord>
  aiArtifacts: SourceGapDomain<AiArtifactGapRecord>
  safeguards: string[]
}

export type CurrentSourceGaps = {
  leadReserve: LeadReserveGapRecord[]
  aiArtifacts: AiArtifactGapRecord[]
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function stableDomainSha(records: Array<{ id: string | number; fingerprintSha256: string }>): string {
  return sha256(JSON.stringify(records
    .map((record) => [String(record.id), record.fingerprintSha256])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))))
}

export function leadReserveGapRecord(input: {
  id: number
  srcId: string | null
  imported: number
  importedLeadId: string | null
  scoreStatus: string
}): LeadReserveGapRecord {
  const sourceKeySha256 = sha256(input.srcId || `row:${input.id}`)
  return {
    id: input.id,
    sourceKeySha256,
    fingerprintSha256: sha256(JSON.stringify([
      input.id, sourceKeySha256, Boolean(input.imported), input.importedLeadId, input.scoreStatus,
    ])),
  }
}

export function aiArtifactGapRecord(input: {
  id: string
  taskId: string
  taskType: string
  userId: string
  projectId: string
  fileName: string
  format: string
  storagePath: string
  qualityStatus: string
  archived: number
}): AiArtifactGapRecord {
  return {
    id: input.id,
    taskType: input.taskType,
    fileName: input.fileName,
    format: input.format,
    taskIdSha256: sha256(input.taskId),
    userIdSha256: sha256(input.userId),
    projectIdSha256: sha256(input.projectId),
    fileNameSha256: sha256(input.fileName),
    storagePathSha256: sha256(input.storagePath),
    qualityStatus: input.qualityStatus,
    archived: Boolean(input.archived),
    fingerprintSha256: sha256(JSON.stringify([
      input.id, input.taskId, input.taskType, input.userId, input.projectId,
      input.fileName, input.format, sha256(input.storagePath), input.qualityStatus, Boolean(input.archived),
    ])),
  }
}

export function createPendingSourceGapDisposition(current: CurrentSourceGaps): SourceGapDispositionDocument {
  return {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    decisionVersion: 1,
    leadReserve: {
      count: current.leadReserve.length,
      baselineSha256: stableDomainSha(current.leadReserve),
      disposition: 'pending', rationale: '', approvedBy: '', approvedAt: '',
      records: current.leadReserve,
    },
    aiArtifacts: {
      count: current.aiArtifacts.length,
      baselineSha256: stableDomainSha(current.aiArtifacts),
      disposition: 'pending', rationale: '', approvedBy: '', approvedAt: '',
      records: current.aiArtifacts,
    },
    safeguards: [
      'source recovery removes the gap and requires regenerating this draft',
      'quarantine or archive approval never invents missing source bytes or business detail',
      'database writes remain zero until a separately reviewed apply command is implemented and invoked',
      'any record or fingerprint drift invalidates the entire domain decision',
      'PPT and report-generation test exclusions do not imply source-gap approval',
    ],
  }
}

function approvalErrors(
  label: string,
  domain: SourceGapDomain<unknown>,
  requiredDisposition: string,
  strict: boolean,
): string[] {
  if (!strict && domain.disposition === 'pending') return []
  const errors: string[] = []
  if (domain.disposition !== requiredDisposition) errors.push(`${label}:DISPOSITION_REQUIRED`)
  if (domain.rationale.trim().length < 12) errors.push(`${label}:RATIONALE_REQUIRED`)
  if (!/^[A-Za-z0-9._:@-]{3,128}$/.test(domain.approvedBy.trim())) errors.push(`${label}:APPROVER_REQUIRED`)
  if (!domain.approvedAt || !Number.isFinite(Date.parse(domain.approvedAt))) errors.push(`${label}:APPROVED_AT_REQUIRED`)
  else if (Date.parse(domain.approvedAt) > Date.now() + 5 * 60_000) errors.push(`${label}:APPROVED_AT_FUTURE`)
  return errors
}

function recordErrors<T extends { id: string | number; fingerprintSha256: string }>(
  label: string,
  domain: SourceGapDomain<T>,
  current: T[],
): string[] {
  const errors: string[] = []
  if (domain.count !== current.length || domain.records.length !== current.length) errors.push(`${label}:COUNT_DRIFT`)
  if (domain.baselineSha256 !== stableDomainSha(current)) errors.push(`${label}:BASELINE_DRIFT`)
  const currentById = new Map(current.map((record) => [String(record.id), record]))
  if (new Set(domain.records.map((record) => String(record.id))).size !== domain.records.length) {
    errors.push(`${label}:DUPLICATE_RECORD_ID`)
  }
  for (const record of domain.records) {
    const expected = currentById.get(String(record.id))
    if (!expected) errors.push(`${label}:UNEXPECTED_RECORD`)
    else if (expected.fingerprintSha256 !== record.fingerprintSha256) errors.push(`${label}:FINGERPRINT_DRIFT`)
    else if (JSON.stringify(expected) !== JSON.stringify(record)) errors.push(`${label}:RECORD_FIELDS_DRIFT`)
  }
  for (const record of current) {
    if (!domain.records.some((candidate) => String(candidate.id) === String(record.id))) errors.push(`${label}:MISSING_RECORD`)
  }
  return errors
}

export function validateSourceGapDisposition(
  document: SourceGapDispositionDocument,
  current: CurrentSourceGaps,
  strict: boolean,
): string[] {
  const errors: string[] = []
  if (document.schemaVersion !== '1.0') errors.push('SCHEMA_VERSION')
  if (document.decisionVersion !== 1) errors.push('DECISION_VERSION')
  if (!Array.isArray(document.safeguards) || document.safeguards.length < 5) errors.push('SAFEGUARDS')
  errors.push(...recordErrors('LEAD_RESERVE', document.leadReserve, current.leadReserve))
  errors.push(...recordErrors('AI_ARTIFACTS', document.aiArtifacts, current.aiArtifacts))
  errors.push(...approvalErrors('LEAD_RESERVE', document.leadReserve, 'approved-permanent-quarantine', strict))
  errors.push(...approvalErrors('AI_ARTIFACTS', document.aiArtifacts, 'approved-permanent-archive', strict))
  if (!strict) {
    for (const [label, domain, allowed] of [
      ['LEAD_RESERVE', document.leadReserve, 'approved-permanent-quarantine'],
      ['AI_ARTIFACTS', document.aiArtifacts, 'approved-permanent-archive'],
    ] as const) {
      if (!['pending', allowed].includes(domain.disposition)) errors.push(`${label}:INVALID_DISPOSITION`)
    }
  }
  return [...new Set(errors)]
}
