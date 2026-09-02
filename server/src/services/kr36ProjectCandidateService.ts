import { createHash, randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { classifyKr36Project, type Kr36ScopeDecision } from './kr36ProjectClassifier.js'
import { recordLeadPipelineRawEvent, transitionLeadPipelineItem } from './leadPipelineEventService.js'
import { kr36ProjectUrl } from './kr36ProjectSourceService.js'

export type Kr36CandidateAdmissionStatus = 'not_ready' | 'ready' | 'processing' | 'review' | 'admitted'

export type Kr36CandidateRow = RowDataPacket & {
  id: string
  source_type: string
  source_project_id: string
  source_project_id_hash: string
  canonical_url: string
  project_name: string
  company_name: string | null
  founded_at: string | null
  source_industries: string[] | string
  sector_labels: string[] | string
  scope_status: Kr36ScopeDecision['status']
  scope_reasons: string[] | string
  rules_version: string
  first_seen_at: Date
  last_seen_at: Date
  fetched_at: Date
  content_hash: string
  raw_event_id: string
  admission_status: Kr36CandidateAdmissionStatus
  processing_started_at: Date | null
  admitted_at: Date | null
  admitted_lead_id: string | null
  attempts: number
  last_error: string | null
}

const candidateTable = quoteMysqlIdentifier(mysqlTableName('lead_source_candidates'))
const itemsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_items'))
const rawEventsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_raw_events'))

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return objectValue(JSON.parse(value)) } catch { return {} }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown, maximum = 128): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim().slice(0, maximum) : ''
}

function industryNames(detail: Record<string, unknown>, listItem: Record<string, unknown>): string[] {
  const values = [detail.industryList, detail.tagList, listItem.industryList, listItem.tagList]
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : []).map((item) => {
    const object = objectValue(item)
    return stringValue(object.name ?? object.label ?? item, 64)
  }).filter(Boolean))]
}

export function kr36CandidateRawPayload(input: {
  projectId: string
  listItem: Record<string, unknown>
  detail: Record<string, unknown>
}) {
  return {
    sourceProjectId: input.projectId,
    canonicalUrl: kr36ProjectUrl(input.projectId),
    listItem: input.listItem,
    detail: input.detail,
  }
}

function sourceHash(projectId: string): string {
  return createHash('sha256').update(projectId.normalize('NFKC').trim().toLocaleLowerCase()).digest('hex')
}

async function rejectSupersededEvent(eventId: string, connection: import('mysql2/promise').PoolConnection) {
  const [rows] = await connection.query<Array<RowDataPacket & { status: string }>>(
    `SELECT status FROM ${itemsTable} WHERE event_id=? FOR UPDATE`, [eventId],
  )
  if (rows[0]?.status !== 'discovered') return
  await transitionLeadPipelineItem(eventId, {
    status: 'rejected',
    reason: '36kr candidate superseded by a newer source snapshot',
    evidence: [], confidence: 100,
    actorType: 'system', actorId: 'kr36-project-sync',
  }, connection)
}

export async function upsertKr36ProjectCandidate(input: {
  projectId: string
  listItem: Record<string, unknown>
  detail: Record<string, unknown>
  fetchedAt?: Date
}) {
  const projectId = input.projectId.trim()
  if (!projectId) throw new Error('36氪候选 projectId 不能为空')
  const detail = objectValue(input.detail)
  const listItem = objectValue(input.listItem)
  const decision = classifyKr36Project({ detail, listItem })
  const payload = kr36CandidateRawPayload({ projectId, listItem, detail })
  const fetchedAt = input.fetchedAt ?? new Date()
  const hash = sourceHash(projectId)
  const lockName = `kr36-candidate:${hash.slice(0, 48)}`
  const connection = await pool.getConnection()
  let acquired = false
  try {
    const [lockRows] = await connection.query<Array<RowDataPacket & { acquired: number | null }>>(
      'SELECT GET_LOCK(?, 15) AS acquired', [lockName],
    )
    acquired = Number(lockRows[0]?.acquired) === 1
    if (!acquired) throw Object.assign(new Error('36氪候选互斥锁等待超时'), { retryable: true })
    await connection.beginTransaction()
    const [existingRows] = await connection.query<Kr36CandidateRow[]>(
      `SELECT * FROM ${candidateTable} WHERE source_type='36kr-project' AND source_project_id_hash=? FOR UPDATE`,
      [hash],
    )
    const existing = existingRows[0]
    const raw = await recordLeadPipelineRawEvent({
      sourceType: '36kr-project', sourceId: `36kr:project:${projectId}`, payload,
    }, connection)
    if (existing?.raw_event_id && existing.raw_event_id !== raw.event.id) {
      await rejectSupersededEvent(existing.raw_event_id, connection)
    }
    if (!decision.eligible && raw.item.status === 'discovered') {
      await transitionLeadPipelineItem(raw.event.id, {
        status: 'rejected',
        reason: decision.reasons.join('；'),
        evidence: [{ foundedAt: decision.foundedAt, sectorLabels: decision.sectorLabels, rulesVersion: decision.rulesVersion }],
        confidence: 100, actorType: 'system', actorId: 'kr36-scope-classifier',
      }, connection)
    }
    const projectName = stringValue(detail.name ?? detail.projectName ?? listItem.name ?? listItem.projectName) || `36氪项目${projectId}`
    const business = objectValue(detail.business)
    const companyName = stringValue(detail.companyName ?? business.name ?? listItem.companyName) || null
    const industries = industryNames(detail, listItem)
    const preservedAdmission = existing?.admission_status === 'admitted' || existing?.admission_status === 'processing'
      ? existing.admission_status
      : (decision.eligible ? 'ready' : 'not_ready')
    const id = existing?.id ?? randomUUID()
    if (existing) {
      await connection.query(
        `UPDATE ${candidateTable} SET canonical_url=?,project_name=?,company_name=?,founded_at=?,
          source_industries=CAST(? AS JSON),sector_labels=CAST(? AS JSON),scope_status=?,scope_reasons=CAST(? AS JSON),
          rules_version=?,last_seen_at=?,fetched_at=?,content_hash=?,raw_event_id=?,admission_status=?,
          processing_started_at=IF(?='processing',processing_started_at,NULL),
          last_error=IF(admission_status='admitted',last_error,NULL),updated_at=NOW(3)
         WHERE id=?`,
        [kr36ProjectUrl(projectId), projectName, companyName, decision.foundedAt,
          JSON.stringify(industries), JSON.stringify(decision.sectorLabels), decision.status, JSON.stringify(decision.reasons),
          decision.rulesVersion, fetchedAt, fetchedAt, raw.event.contentHash, raw.event.id, preservedAdmission,
          preservedAdmission, id],
      )
    } else {
      await connection.query(
        `INSERT INTO ${candidateTable}
          (id,source_type,source_project_id,source_project_id_hash,canonical_url,project_name,company_name,founded_at,
           source_industries,sector_labels,scope_status,scope_reasons,rules_version,first_seen_at,last_seen_at,fetched_at,
           content_hash,raw_event_id,admission_status,created_at,updated_at)
         VALUES (?,'36kr-project',?,?,?,?,?,?,CAST(? AS JSON),CAST(? AS JSON),?,CAST(? AS JSON),?,?,?,?,?,?,?,NOW(3),NOW(3))`,
        [id, projectId, hash, kr36ProjectUrl(projectId), projectName, companyName, decision.foundedAt,
          JSON.stringify(industries), JSON.stringify(decision.sectorLabels), decision.status, JSON.stringify(decision.reasons),
          decision.rulesVersion, fetchedAt, fetchedAt, fetchedAt, raw.event.contentHash, raw.event.id, preservedAdmission],
      )
    }
    await connection.commit()
    return {
      id,
      created: !existing,
      contentChanged: !existing || existing.content_hash !== raw.event.contentHash,
      shouldRefreshAdmitted: existing?.admission_status === 'admitted' && decision.eligible
        && (existing.content_hash !== raw.event.contentHash || Boolean(existing.last_error)),
      decision,
      rawEventId: raw.event.id,
      admissionStatus: preservedAdmission as Kr36CandidateAdmissionStatus,
      projectName,
    }
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    if (acquired) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {})
    connection.release()
  }
}

export async function getKr36CandidateSupplySnapshot() {
  const [rows] = await pool.query<Array<RowDataPacket & {
    total: number
    eligible: number
    ready: number
    processing: number
    review: number
    admitted: number
    today_seen: number
    today_admitted: number
    stale_hours: number | null
    ready_ai: number
    ready_embodied: number
    ready_semiconductor: number
    ready_without_focus_tag: number
    founded_at_pending: number
    last_fetched_at: Date | null
    last_admitted_at: Date | null
  }>>(
    `SELECT COUNT(*) total,
      COALESCE(SUM(scope_status='eligible'),0) eligible,
      COALESCE(SUM(admission_status='ready'),0) ready,
      COALESCE(SUM(admission_status='processing'),0) processing,
      COALESCE(SUM(admission_status='review'),0) review,
      COALESCE(SUM(admission_status='admitted'),0) admitted,
      COALESCE(SUM(first_seen_at >= CURRENT_DATE()),0) today_seen,
      COALESCE(SUM(admitted_at >= CURRENT_DATE()),0) today_admitted,
      TIMESTAMPDIFF(HOUR,MAX(fetched_at),NOW(3)) stale_hours,
      COALESCE(SUM(admission_status='ready' AND JSON_CONTAINS(sector_labels,JSON_QUOTE('artificial_intelligence'))),0) ready_ai,
      COALESCE(SUM(admission_status='ready' AND JSON_CONTAINS(sector_labels,JSON_QUOTE('embodied_intelligence'))),0) ready_embodied,
      COALESCE(SUM(admission_status='ready' AND JSON_CONTAINS(sector_labels,JSON_QUOTE('semiconductor'))),0) ready_semiconductor,
      COALESCE(SUM(admission_status='ready' AND JSON_LENGTH(sector_labels)=0),0) ready_without_focus_tag,
      COALESCE(SUM(scope_status='founded_at_pending'),0) founded_at_pending,
      MAX(fetched_at) last_fetched_at,
      MAX(admitted_at) last_admitted_at
     FROM ${candidateTable} WHERE source_type='36kr-project'`,
  )
  const row = rows[0]
  if (!row) return {}
  const numeric = Object.fromEntries(Object.entries(row)
    .filter(([key]) => !['last_fetched_at', 'last_admitted_at'].includes(key))
    .map(([key, value]) => [key, value == null ? null : Number(value)]))
  const quota = Math.max(1, Number(process.env.KR36_PROJECT_DAILY_QUOTA) || 10)
  const safetyStockDays = Math.max(1, Number(process.env.KR36_PROJECT_SAFETY_STOCK_DAYS) || 45)
  const estimatedSupplyDays = Math.floor(Number(row.ready || 0) / quota)
  return {
    ...numeric,
    estimated_supply_days: estimatedSupplyDays,
    supply_status: estimatedSupplyDays === 0 ? 'exhausted' : estimatedSupplyDays < safetyStockDays ? 'warning' : 'healthy',
    safety_stock_days: safetyStockDays,
    last_fetched_at: row.last_fetched_at,
    last_admitted_at: row.last_admitted_at,
  }
}

export async function listKr36CandidatesDueForRecheck(input: { recentDays?: number; limit?: number } = {}) {
  const recentDays = Math.max(1, Math.min(input.recentDays ?? 90, 365))
  const limit = Math.max(1, Math.min(input.limit ?? 200, 1_000))
  const [rows] = await pool.query<Array<RowDataPacket & {
    source_project_id: string
    payload: Record<string, unknown> | string
  }>>(
    `SELECT c.source_project_id,e.payload FROM ${candidateTable} c
     JOIN ${rawEventsTable} e ON e.id=c.raw_event_id
     WHERE c.source_type='36kr-project' AND (
       (c.scope_status='founded_at_pending' AND c.fetched_at<DATE_SUB(NOW(3),INTERVAL 30 DAY))
       OR (c.scope_status<>'founded_at_pending' AND c.first_seen_at>=DATE_SUB(NOW(3),INTERVAL ? DAY)
         AND c.fetched_at<DATE_SUB(NOW(3),INTERVAL 1 DAY))
       OR (c.scope_status<>'founded_at_pending' AND c.first_seen_at<DATE_SUB(NOW(3),INTERVAL ? DAY)
         AND c.fetched_at<DATE_SUB(NOW(3),INTERVAL 7 DAY))
     )
     ORDER BY c.fetched_at ASC,c.id ASC LIMIT ?`,
    [recentDays, recentDays, limit],
  )
  return rows.map((row) => {
    const payload = objectValue(row.payload)
    return { projectId: row.source_project_id, listItem: objectValue(payload.listItem) }
  })
}

export { candidateTable as kr36CandidateTable }
