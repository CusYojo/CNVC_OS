import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pool } from '../db/client.js'
import {
  validateLeadDuplicateDispositions, type LeadDuplicateDispositionFile,
} from './leadDuplicateDispositionContract.js'
import { loadCurrentLeadDuplicateDispositionContext } from './leadDuplicateDispositionRuntime.js'

const outputDirectory = path.resolve('.runtime/migration-evidence/lead-duplicate-dispositions')
const checks: string[] = []

function check(condition: unknown, name: string) {
  if (!condition) throw new Error(`lead duplicate disposition acceptance failed: ${name}`)
  checks.push(name)
}

function clone(file: LeadDuplicateDispositionFile) {
  return JSON.parse(JSON.stringify(file)) as LeadDuplicateDispositionFile
}

function approveKeepSeparate(file: LeadDuplicateDispositionFile) {
  for (const group of file.groups) {
    group.decision = {
      decisionRevision: 1,
      action: 'keep-separate',
      canonicalLeadId: null,
      mergedLeadIds: [],
      reason: '业务负责人确认主体应分别保留',
      approvedBy: '迁移业务负责人',
      approvedAt: '2026-08-11T08:00:00.000Z',
    }
  }
}

async function main() {
  const before = await loadCurrentLeadDuplicateDispositionContext()
  const pending = validateLeadDuplicateDispositions({ file: before.expected, expected: before.expected, strict: false })
  check(pending.valid && !pending.ready && pending.pendingGroups === before.expected.groups.length,
    'current-live-baseline-has-exact-pending-review-coverage')

  const strictPending = validateLeadDuplicateDispositions({ file: before.expected, expected: before.expected, strict: true })
  check(!strictPending.ready && strictPending.errors.includes('PENDING_DECISIONS'),
    'strict-mode-blocks-every-unapproved-group')

  const approved = clone(before.expected)
  approveKeepSeparate(approved)
  const approvedResult = validateLeadDuplicateDispositions({ file: approved, expected: before.expected, strict: true })
  check(approvedResult.valid && approvedResult.ready && approvedResult.pendingGroups === 0,
    'complete-approved-keep-separate-ledger-is-ready')

  const missingGroup = clone(approved)
  missingGroup.groups.pop()
  check(validateLeadDuplicateDispositions({ file: missingGroup, expected: before.expected, strict: true })
    .errors.includes('GROUP_COVERAGE_MISMATCH'), 'missing-group-is-rejected')

  const fingerprintDrift = clone(approved)
  if (fingerprintDrift.groups[0]?.records[0]) fingerprintDrift.groups[0].records[0].rowFingerprint = '0'.repeat(64)
  check(validateLeadDuplicateDispositions({ file: fingerprintDrift, expected: before.expected, strict: true })
    .errors.includes('ROW_FINGERPRINT_DRIFT'), 'row-fingerprint-drift-is-rejected')

  const baselineDrift = clone(approved)
  baselineDrift.normalizationReportSha256 = '0'.repeat(64)
  check(validateLeadDuplicateDispositions({ file: baselineDrift, expected: before.expected, strict: true })
    .errors.includes('BASELINE_MISMATCH'), 'normalization-report-drift-is-rejected')

  const invalidCanonical = clone(before.expected)
  const first = invalidCanonical.groups[0]
  if (!first) throw new Error('lead duplicate acceptance requires at least one current collision group')
  first.decision = {
    decisionRevision: 1, action: 'merge', canonicalLeadId: '00000000-0000-4000-8000-000000000000',
    mergedLeadIds: first.records.map((record) => record.id), reason: '业务负责人批准合并该重复主体',
    approvedBy: '迁移业务负责人', approvedAt: '2026-08-11T08:00:00.000Z',
  }
  check(validateLeadDuplicateDispositions({ file: invalidCanonical, expected: before.expected, strict: false })
    .errors.includes('INVALID_CANONICAL_LEAD'), 'canonical-lead-outside-group-is-rejected')

  const incompleteApproval = clone(approved)
  incompleteApproval.groups[0].decision.approvedBy = ''
  check(validateLeadDuplicateDispositions({ file: incompleteApproval, expected: before.expected, strict: true })
    .errors.includes('APPROVAL_INCOMPLETE'), 'incomplete-business-approval-is-rejected')

  const overlapping = before.expected.groups.flatMap((left, leftIndex) => before.expected.groups
    .slice(leftIndex + 1)
    .map((right) => ({ left, right, shared: left.records.find((record) => right.records.some((item) => item.id === record.id)) }))
    .filter((item) => item.shared))[0]
  if (!overlapping?.shared) throw new Error('lead duplicate acceptance requires an overlapping collision pair')
  const conflict = clone(before.expected)
  for (const sourceGroup of [overlapping.left, overlapping.right]) {
    const target = conflict.groups.find((group) => group.groupId === sourceGroup.groupId) as LeadDuplicateDispositionFile['groups'][number]
    const canonical = target.records.find((record) => record.id !== overlapping.shared?.id) as { id: string }
    target.decision = {
      decisionRevision: 1, action: 'merge', canonicalLeadId: canonical.id,
      mergedLeadIds: target.records.filter((record) => record.id !== canonical.id).map((record) => record.id),
      reason: '业务负责人批准合并该重复主体', approvedBy: '迁移业务负责人',
      approvedAt: '2026-08-11T08:00:00.000Z',
    }
  }
  check(validateLeadDuplicateDispositions({ file: conflict, expected: before.expected, strict: false })
    .errors.includes('CONFLICTING_MERGE_CANONICALS'), 'overlapping-groups-with-conflicting-canonicals-are-rejected')

  const after = await loadCurrentLeadDuplicateDispositionContext()
  check(before.collisionSignature === after.collisionSignature
    && before.reportSha256 === after.reportSha256, 'acceptance-is-read-only-and-baseline-remains-unchanged')

  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  const report = {
    schemaVersion: '1.0', generatedAt: new Date().toISOString(), ok: true,
    collisionGroups: before.expected.scope.collisionGroups,
    collisionRecordOccurrences: before.expected.scope.collisionRecordOccurrences,
    uniqueLeadRecords: before.expected.scope.uniqueLeadRecords,
    overlappingLeadRecords: before.expected.scope.collisionRecordOccurrences - before.expected.scope.uniqueLeadRecords,
    checks, databaseWrites: 0,
  }
  await writeFile(path.join(outputDirectory, 'acceptance-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify(report))
}

await main().finally(async () => pool.end())
