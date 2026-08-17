import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import type { PoolConnection } from 'mysql2/promise'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  leadRowFingerprint, sha256,
  type LeadDuplicateDispositionFile, type LeadSnapshot,
} from './leadDuplicateDispositionContract.js'

type LeadRow = RowDataPacket & LeadSnapshot & {
  pool_status: string
  converted_project_id: string | null
  radar_source_keys: unknown
}

type CountRow = RowDataPacket & { leadId: string; count: number }

function table(name: string) {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code)
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return { $bufferSha256: sha256(value.toString('base64')) }
  if (Array.isArray(value)) return value.map(jsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, jsonValue(child)]))
  }
  return value
}

function stringArray(value: unknown): string[] {
  const parsed = typeof value === 'string' ? (() => {
    try { return JSON.parse(value) as unknown } catch { return [] }
  })() : value
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
    : []
}

export type LeadDuplicateApplyPlan = {
  mergeTargets: Map<string, string>
  componentMembers: Map<string, Set<string>>
  allLeadIds: string[]
  actionCounts: Record<'merge' | 'keep-separate' | 'exception', number>
}

export function buildLeadDuplicateApplyPlan(file: LeadDuplicateDispositionFile): LeadDuplicateApplyPlan {
  const mergeTargets = new Map<string, string>()
  const componentMembers = new Map<string, Set<string>>()
  const allLeadIds = new Set<string>()
  const actionCounts = { merge: 0, 'keep-separate': 0, exception: 0 }
  for (const group of file.groups) {
    assert(group.decision.action !== 'pending', 'LEAD_DUPLICATE_PENDING_DECISION')
    actionCounts[group.decision.action] += 1
    for (const record of group.records) allLeadIds.add(record.id)
    if (group.decision.action !== 'merge') continue
    const canonical = group.decision.canonicalLeadId
    assert(Boolean(canonical), 'LEAD_DUPLICATE_CANONICAL_MISSING')
    const members = componentMembers.get(canonical as string) || new Set<string>([canonical as string])
    for (const record of group.records) members.add(record.id)
    componentMembers.set(canonical as string, members)
    for (const mergedId of group.decision.mergedLeadIds) {
      const existing = mergeTargets.get(mergedId)
      assert(!existing || existing === canonical, 'LEAD_DUPLICATE_CONFLICTING_MERGE_TARGET')
      mergeTargets.set(mergedId, canonical as string)
    }
  }
  return { mergeTargets, componentMembers, allLeadIds: [...allLeadIds].sort(), actionCounts }
}

async function referenceCounts(connection: PoolConnection, leadIds: string[]) {
  const definitions = [
    ['lead_score_jobs', 'lead_id'],
    ['lead_pipeline_items', 'lead_id'],
    ['lead_pipeline_entity_matches', 'candidate_lead_id'],
    ['lead_reserve', 'imported_lead_id'],
  ] as const
  const result = new Map<string, Map<string, number>>()
  for (const [tableName, column] of definitions) {
    const [rows] = await connection.query<CountRow[]>(
      `SELECT ${column} AS leadId,COUNT(*) count FROM ${table(tableName)} WHERE ${column} IN (?) GROUP BY ${column}`,
      [leadIds],
    )
    result.set(tableName, new Map(rows.map((row) => [row.leadId, Number(row.count)])))
  }
  return result
}

function componentForCanonical(plan: LeadDuplicateApplyPlan, canonical: string) {
  return plan.componentMembers.get(canonical) || new Set<string>([canonical])
}

export async function applyApprovedLeadDuplicateDispositions(input: {
  connection: PoolConnection
  file: LeadDuplicateDispositionFile
  decisionFileSha256: string
  runId?: string
}) {
  const { connection, file, decisionFileSha256 } = input
  const runId = input.runId || randomUUID()
  const plan = buildLeadDuplicateApplyPlan(file)
  assert(plan.allLeadIds.length > 0, 'LEAD_DUPLICATE_EMPTY_SCOPE')

  const [lockedRows] = await connection.query<LeadRow[]>(
    `SELECT * FROM ${table('leads')} WHERE id IN (?) ORDER BY id FOR UPDATE`,
    [plan.allLeadIds],
  )
  assert(lockedRows.length === plan.allLeadIds.length, 'LEAD_DUPLICATE_LIVE_ROW_MISSING')
  const rowsById = new Map(lockedRows.map((row) => [row.id, row]))
  for (const group of file.groups) {
    for (const record of group.records) {
      const row = rowsById.get(record.id)
      assert(row && leadRowFingerprint({ ...row }) === record.rowFingerprint, 'LEAD_DUPLICATE_ROW_FINGERPRINT_DRIFT')
    }
  }

  const refs = await referenceCounts(connection, plan.allLeadIds)
  for (const [canonical, members] of plan.componentMembers) {
    const memberRows = [...members].map((id) => rowsById.get(id) as LeadRow)
    assert(rowsById.has(canonical), 'LEAD_DUPLICATE_CANONICAL_LIVE_ROW_MISSING')
    assert(memberRows.every((row) => row.pool_status !== '已合并'), 'LEAD_DUPLICATE_ALREADY_MERGED_OUTSIDE_LEDGER')
    const converted = memberRows.filter((row) => Boolean(row.converted_project_id))
    assert(new Set(converted.map((row) => row.converted_project_id)).size <= 1,
      'LEAD_DUPLICATE_MULTIPLE_CONVERTED_PROJECTS')
    assert(converted.length === 0 || converted.every((row) => row.id === canonical),
      'LEAD_DUPLICATE_CONVERTED_LEAD_MUST_BE_CANONICAL')
    const scoreJobs = [...members].reduce((total, id) => total + (refs.get('lead_score_jobs')?.get(id) || 0), 0)
    assert(scoreJobs <= 1, 'LEAD_DUPLICATE_SCORE_JOB_COLLISION')
    const reserveLinks = [...members].reduce((total, id) => total + (refs.get('lead_reserve')?.get(id) || 0), 0)
    assert(reserveLinks <= 1, 'LEAD_DUPLICATE_RESERVE_LINK_COLLISION')
  }

  if (plan.mergeTargets.size > 0) {
    const [existingMappings] = await connection.query<Array<RowDataPacket & {
      sourceId: string; targetId: string; sourceChecksum: string
    }>>(
      `SELECT source_id sourceId,target_id targetId,source_checksum sourceChecksum
       FROM ${table('migration_entity_mappings')}
       WHERE source_system='business_decision' AND source_table='lead_duplicate_merge'
         AND source_id IN (?) FOR UPDATE`,
      [[...plan.mergeTargets.keys()]],
    )
    assert(existingMappings.length === 0, 'LEAD_DUPLICATE_PREEXISTING_MERGE_MAPPING')
  }

  const sourceCounts = {
    groups: file.groups.length,
    uniqueLeadRecords: file.scope.uniqueLeadRecords,
    mergeGroups: plan.actionCounts.merge,
    keepSeparateGroups: plan.actionCounts['keep-separate'],
    exceptionGroups: plan.actionCounts.exception,
    mergedLeadRecords: plan.mergeTargets.size,
  }
  await connection.query(
    `INSERT INTO ${table('migration_runs')}
      (id,migration_type,source_locator,source_sha256,mode,status,source_counts,target_counts,
       source_checksum,target_checksum,report,started_at,completed_at)
     VALUES (?,'lead-duplicate-disposition',?,?,'apply','succeeded',?,?,?,?,?,NOW(3),NOW(3))`,
    [runId, `decision-set:${file.decisionSetId}`, decisionFileSha256,
      JSON.stringify(sourceCounts), JSON.stringify({}), decisionFileSha256,
      sha256(JSON.stringify([...plan.mergeTargets.entries()].sort())),
      JSON.stringify({ schemaVersion: '1.0', revision: file.revision, ...sourceCounts, physicalDeletes: 0 })],
  )

  let referencesMoved = 0
  for (const [canonical, members] of plan.componentMembers) {
    const sourceKeys = [...new Set([...members].flatMap((id) => stringArray(rowsById.get(id)?.radar_source_keys)))].sort()
    await connection.query(`UPDATE ${table('leads')} SET radar_source_keys=? WHERE id=?`, [JSON.stringify(sourceKeys), canonical])
  }
  for (const [mergedId, canonical] of plan.mergeTargets) {
    const scoreJob = refs.get('lead_score_jobs')?.get(mergedId) || 0
    if (scoreJob) {
      const [result] = await connection.query(`UPDATE ${table('lead_score_jobs')} SET lead_id=? WHERE lead_id=?`, [canonical, mergedId])
      referencesMoved += (result as { affectedRows: number }).affectedRows
    }
    for (const [tableName, column] of [
      ['lead_pipeline_items', 'lead_id'],
      ['lead_pipeline_entity_matches', 'candidate_lead_id'],
      ['lead_reserve', 'imported_lead_id'],
    ] as const) {
      const [result] = await connection.query(`UPDATE ${table(tableName)} SET ${column}=? WHERE ${column}=?`, [canonical, mergedId])
      referencesMoved += (result as { affectedRows: number }).affectedRows
    }
    const canonicalRow = rowsById.get(canonical) as LeadRow
    await connection.query(
      `UPDATE ${table('lead_pipeline_entity_matches')}
       SET candidate_name=?,candidate_company_name=? WHERE candidate_lead_id=?`,
      [canonicalRow.name, canonicalRow.company_name, canonical],
    )
    await connection.query(
      `UPDATE ${table('leads')} SET pool_status='已合并',radar_source_keys=JSON_ARRAY() WHERE id=?`,
      [mergedId],
    )
    const sourceRow = rowsById.get(mergedId) as LeadRow
    await connection.query(
      `INSERT INTO ${table('migration_entity_mappings')}
        (id,run_id,source_system,source_table,source_id,target_table,target_id,mapping_kind,source_checksum,created_at)
       VALUES (?,?,'business_decision','lead_duplicate_merge',?,'leads',?,'resolved',?,NOW(3))`,
      [randomUUID(), runId, mergedId, canonical, leadRowFingerprint({ ...sourceRow })],
    )
  }

  for (const group of file.groups) {
    const code = group.decision.action === 'merge' ? 'LEAD_DUPLICATE_MERGE_APPROVED'
      : group.decision.action === 'keep-separate' ? 'LEAD_DUPLICATE_KEEP_SEPARATE_APPROVED'
        : 'LEAD_DUPLICATE_EXCEPTION_APPROVED'
    const snapshots = group.records.map((record) => ({
      id: record.id,
      rowFingerprint: record.rowFingerprint,
      rowSnapshot: jsonValue(rowsById.get(record.id)),
    }))
    await connection.query(
      `INSERT INTO ${table('migration_issues')}
        (id,run_id,severity,source_system,source_table,source_key,code,message,payload,created_at)
       VALUES (?,?,'warning','business_decision','leads',?,?,?, ?,NOW(3))`,
      [randomUUID(), runId, group.groupId, code,
        '历史重复线索已按批准的逐组业务裁决处理，原行保留且禁止物理删除。',
        JSON.stringify({
          schemaVersion: '1.0', field: group.field, kind: group.kind,
          comparisonKeySha256: sha256(group.comparisonKey), decision: group.decision,
          snapshots,
        })],
    )
  }
  await connection.query(
    `INSERT INTO ${table('audit_logs')}
      (id,user_id,user_name,module,action,target,ip,result,request_id,created_at)
     VALUES (?,NULL,?,'数据迁移','应用重复线索裁决',?,NULL,'success',?,NOW(3))`,
    [randomUUID(), '迁移裁决执行器',
      `decisionSet:${file.decisionSetId};groups:${file.groups.length};merged:${plan.mergeTargets.size}`,
      `migration:${runId}`],
  )
  await connection.query(
    `UPDATE ${table('migration_runs')} SET target_counts=?,report=? WHERE id=?`,
    [JSON.stringify({ groupsRecorded: file.groups.length, mergedLeadRecords: plan.mergeTargets.size, referencesMoved }),
      JSON.stringify({ schemaVersion: '1.0', revision: file.revision, ...sourceCounts,
        groupsRecorded: file.groups.length, referencesMoved, physicalDeletes: 0 }), runId],
  )
  return { runId, ...sourceCounts, referencesMoved, physicalDeletes: 0 }
}

export async function verifyAppliedLeadDuplicateDisposition(input: {
  connection: PoolConnection
  file: LeadDuplicateDispositionFile
  decisionFileSha256: string
}) {
  const [runs] = await input.connection.query<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM ${table('migration_runs')}
     WHERE migration_type='lead-duplicate-disposition' AND source_locator=? AND source_sha256=? AND status='succeeded'
     ORDER BY completed_at DESC LIMIT 1`,
    [`decision-set:${input.file.decisionSetId}`, input.decisionFileSha256],
  )
  if (!runs[0]) return null
  const plan = buildLeadDuplicateApplyPlan(input.file)
  const runId = runs[0].id
  const [issues] = await input.connection.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${table('migration_issues')} WHERE run_id=?`, [runId])
  assert(Number(issues[0]?.count || 0) === input.file.groups.length, 'LEAD_DUPLICATE_APPLIED_ISSUE_COVERAGE_MISMATCH')
  if (plan.mergeTargets.size) {
    const [mappings] = await input.connection.query<Array<RowDataPacket & { sourceId: string; targetId: string }>>(
      `SELECT source_id sourceId,target_id targetId FROM ${table('migration_entity_mappings')}
       WHERE run_id=? AND source_system='business_decision' AND source_table='lead_duplicate_merge'`, [runId])
    assert(mappings.length === plan.mergeTargets.size
      && mappings.every((mapping) => plan.mergeTargets.get(mapping.sourceId) === mapping.targetId),
    'LEAD_DUPLICATE_APPLIED_MAPPING_MISMATCH')
    const [rows] = await input.connection.query<Array<RowDataPacket & { id: string; poolStatus: string }>>(
      `SELECT id,pool_status poolStatus FROM ${table('leads')} WHERE id IN (?)`, [[...plan.mergeTargets.keys()]])
    assert(rows.length === plan.mergeTargets.size && rows.every((row) => row.poolStatus === '已合并'),
      'LEAD_DUPLICATE_APPLIED_ARCHIVE_STATE_MISMATCH')
    const refs = await referenceCounts(input.connection, [...plan.mergeTargets.keys()])
    assert([...refs.values()].every((counts) => [...counts.values()].reduce((sum, count) => sum + count, 0) === 0),
      'LEAD_DUPLICATE_APPLIED_REFERENCE_RESIDUE')
  }
  return { runId, groupsRecorded: input.file.groups.length, mergedLeadRecords: plan.mergeTargets.size }
}
