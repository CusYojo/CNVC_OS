import { eq } from 'drizzle-orm'
import type { RowDataPacket } from 'mysql2'
import { db, pool } from '../db/client.js'
import { leads } from '../db/schema.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { commitRadarLeadPipelineReady } from './aiSummaryService.js'
import { verifyLeadPipelineRawEvent } from './leadPipelineEventService.js'
import { resolveLeadBusinessRegion } from './leadRegion.js'
import { mergeLeadScoringWithRetainedSources, project36KrLeadDetail } from './leadReserveProjection.js'
import type { RadarLeadSyncFields } from './leadRadarMerge.js'
import { kr36ProjectUrl } from './kr36ProjectSourceService.js'
import type { Kr36CandidateRow } from './kr36ProjectCandidateService.js'

const candidateTable = quoteMysqlIdentifier(mysqlTableName('lead_source_candidates'))

function objectValue(value: unknown): Record<string, any> {
  if (typeof value === 'string') {
    try { return objectValue(JSON.parse(value)) } catch { return {} }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') {
    try { return jsonArray(JSON.parse(value)) } catch { return [] }
  }
  return []
}

function shanghaiDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

async function candidateById(id: string): Promise<Kr36CandidateRow | null> {
  const [rows] = await pool.query<Kr36CandidateRow[]>(`SELECT * FROM ${candidateTable} WHERE id=? LIMIT 1`, [id])
  return rows[0] ?? null
}

async function buildAdmissionPayload(candidate: Kr36CandidateRow): Promise<{
  eventId: string
  lead: RadarLeadSyncFields
  scoring: Record<string, unknown>
}> {
  const verified = await verifyLeadPipelineRawEvent(candidate.raw_event_id)
  if (!verified.exists || !verified.valid || !verified.event) {
    throw Object.assign(new Error('36氪候选的不可变原始事件缺失或校验失败'), { retryable: false })
  }
  const rawPayload = objectValue(verified.event.payload)
  const detail = objectValue(rawPayload.detail)
  const detailUrl = String(rawPayload.canonicalUrl || candidate.canonical_url || kr36ProjectUrl(candidate.source_project_id))
  const projection = project36KrLeadDetail(detail, detailUrl, candidate.project_name)
  const sourceKey = `36kr:project:${candidate.source_project_id}`
  const sourceIndustries = jsonArray(candidate.source_industries)
  const sectorLabels = jsonArray(candidate.sector_labels)
  const scoring = {
    projectName: projection.projectName,
    whatIsIt: projection.oneWord,
    ...(projection.officialSite ? { officialSite: projection.officialSite } : {}),
    registry: projection.registry,
    registryEvidence: projection.registryEvidence,
    sourceLabeledProfile: projection.sourceLabeledProfile,
    structuredTeam: projection.structuredTeam,
    structuredShareholders: projection.structuredShareholders,
    fundingRoundsResearched: projection.fundingRounds,
    structuredNews: [],
  }
  const radarProfile = {
    sourceId: candidate.source_project_id,
    radarSourceKey: sourceKey,
    link: detailUrl,
    channel: '36氪',
    sourceName: '36氪',
    sourceGroup: '36氪项目库',
    qualityRejected: false,
    registry: projection.registry,
    profile: {
      projectName: projection.projectName,
      projectIntroduction: projection.introduction,
      companyName: projection.companyName,
      projectRound: projection.projectRound,
      industry: projection.industry,
      region: projection.region,
      logoUrl: projection.logoUrl,
      foundedAt: candidate.founded_at,
      sourceIndustries,
      sectorLabels,
      scopeRulesVersion: candidate.rules_version,
    },
  }
  const region = resolveLeadBusinessRegion({
    registry: projection.registry,
    profile: radarProfile.profile,
    subjectName: projection.projectName,
    companyName: projection.companyName,
    sourceGroup: radarProfile.sourceGroup,
    channel: radarProfile.channel,
  })
  const lead: RadarLeadSyncFields = {
    name: projection.projectName,
    companyName: projection.companyName,
    industry: String(projection.industry || sourceIndustries.join('、') || '待核验').slice(0, 64),
    businessRegion: region?.region || null,
    businessRegionSource: region?.source || null,
    businessRegionConfidence: region?.confidence || null,
    source: '36氪项目库',
    poolStatus: '成功',
    summary: projection.oneWord.slice(0, 1_000),
    fundingRounds: projection.fundingRounds,
    sources: detailUrl ? [{
      title: `${projection.projectName} | 项目信息-36氪`, url: detailUrl,
      reliability: '中', category: '36氪', excerpt: projection.introduction.slice(0, 200),
    }] : [],
    radarProfile,
    radarSourceKeys: [sourceKey],
  }
  return { eventId: verified.event.id, lead, scoring }
}

async function persistSourceScoring(leadId: string, scoring: Record<string, unknown>) {
  const [lead] = await db.select({ scoring: leads.scoring }).from(leads).where(eq(leads.id, leadId)).limit(1)
  if (!lead) throw new Error(`36氪准入后找不到线索 ${leadId}`)
  const merged = mergeLeadScoringWithRetainedSources(lead.scoring, scoring, objectValue(scoring.registry), {
    preserveDataQuality: true,
  })
  await db.update(leads).set({ scoring: merged }).where(eq(leads.id, leadId))
}

export async function commitKr36Candidate(candidateId: string, options: { refresh?: boolean } = {}) {
  const candidate = await candidateById(candidateId)
  if (!candidate) throw new Error(`36氪候选不存在: ${candidateId}`)
  if (candidate.scope_status !== 'eligible') throw new Error(`36氪候选未通过范围规则: ${candidate.scope_status}`)
  if (!options.refresh && candidate.admission_status !== 'processing') {
    throw new Error(`36氪候选未处于 processing: ${candidate.admission_status}`)
  }
  const payload = await buildAdmissionPayload(candidate)
  try {
    const result = await commitRadarLeadPipelineReady({
      lead: payload.lead,
      eventId: payload.eventId,
      transition: {
        reason: options.refresh ? '36kr admitted candidate refreshed from source' : '36kr candidate released by daily quota',
        evidence: [{ title: payload.lead.name, url: candidate.canonical_url, source: '36氪项目库' }],
        confidence: 100,
        actorType: 'system', actorId: options.refresh ? 'kr36-project-sync' : 'kr36-project-daily-admission',
      },
    })
    await persistSourceScoring(result.row.id, payload.scoring)
    await pool.query(
      `UPDATE ${candidateTable} SET admission_status='admitted',processing_started_at=NULL,
        admitted_at=COALESCE(admitted_at,NOW(3)),admitted_lead_id=?,last_error=NULL,updated_at=NOW(3) WHERE id=?`,
      [result.row.id, candidate.id],
    )
    return { candidateId: candidate.id, leadId: result.row.id, status: result.status, refreshed: Boolean(options.refresh) }
  } catch (error) {
    const code = (error as Error & { code?: string }).code
    const review = code === 'RADAR_LEAD_ENTITY_AMBIGUOUS'
    const retryStatus = code === 'COMPANY_DEREGISTERED'
      ? 'not_ready'
      : (review ? 'review' : (options.refresh ? 'admitted' : 'ready'))
    await pool.query(
      `UPDATE ${candidateTable} SET admission_status=?,processing_started_at=NULL,last_error=?,updated_at=NOW(3) WHERE id=?`,
      [retryStatus,
        (error instanceof Error ? error.message : String(error)).slice(0, 4_000), candidate.id],
    )
    throw error
  }
}

export async function runKr36DailyAdmission(input: { quota?: number } = {}) {
  const quota = Math.max(1, Math.min(input.quota ?? 1, 50))
  const dateKey = shanghaiDateKey()
  const lockName = `kr36-daily-admission:${dateKey}`
  const selectionSeed = `kr36-daily-admission:${dateKey}`
  const connection = await pool.getConnection()
  let acquired = false
  const selectedIds: string[] = []
  try {
    const [lockRows] = await connection.query<Array<RowDataPacket & { acquired: number | null }>>(
      'SELECT GET_LOCK(?, 1) AS acquired', [lockName],
    )
    acquired = Number(lockRows[0]?.acquired) === 1
    if (!acquired) return { ok: true, skipped: true, reason: 'already_running', selected: 0, dateKey }
    await connection.beginTransaction()
    await connection.query(
      `UPDATE ${candidateTable} SET admission_status='ready',processing_started_at=NULL,
        last_error=COALESCE(last_error,'stale processing recovered'),updated_at=NOW(3)
       WHERE source_type='36kr-project' AND admission_status='processing'
         AND processing_started_at < DATE_SUB(NOW(3),INTERVAL 60 MINUTE)`,
    )
    const [countRows] = await connection.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) count FROM ${candidateTable}
       WHERE source_type='36kr-project' AND (
         (admission_status='admitted' AND admitted_at>=CURRENT_DATE())
         OR (admission_status='processing' AND processing_started_at>=CURRENT_DATE())
       )`,
    )
    const remaining = Math.max(0, quota - Number(countRows[0]?.count || 0))
    if (remaining > 0) {
      const [rows] = await connection.query<Array<RowDataPacket & { id: string }>>(
        `SELECT id FROM ${candidateTable}
         WHERE source_type='36kr-project' AND scope_status='eligible' AND admission_status='ready'
         ORDER BY SHA2(CONCAT(?,':',id),256),id
         LIMIT ? FOR UPDATE SKIP LOCKED`,
        [selectionSeed, remaining],
      )
      for (const row of rows) {
        await connection.query(
          `UPDATE ${candidateTable} SET admission_status='processing',processing_started_at=NOW(3),
            attempts=attempts+1,last_error=NULL,updated_at=NOW(3) WHERE id=?`, [row.id],
        )
        selectedIds.push(row.id)
      }
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    if (acquired) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {})
    connection.release()
  }

  const committed = []
  const failed = []
  for (const id of selectedIds) {
    try { committed.push(await commitKr36Candidate(id)) }
    catch (error) { failed.push({ id, error: error instanceof Error ? error.message : String(error) }) }
  }
  const [remainingRows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${candidateTable}
     WHERE source_type='36kr-project' AND scope_status='eligible' AND admission_status='ready'`,
  )
  if (failed.length) {
    throw Object.assign(new Error(`36氪每日准入失败 ${failed.length} 条，候选已回到可重试状态`), {
      code: 'KR36_ADMISSION_FAILURE', retryable: true, failures: failed,
    })
  }
  return {
    ok: failed.length === 0,
    dateKey,
    quota,
    selected: selectedIds.length,
    committed,
    failed,
    remaining: Number(remainingRows[0]?.count || 0),
  }
}

export async function refreshAdmittedKr36Candidate(candidateId: string) {
  const candidate = await candidateById(candidateId)
  if (!candidate || candidate.admission_status !== 'admitted') return { skipped: true, reason: 'not_admitted' }
  return await commitKr36Candidate(candidateId, { refresh: true })
}
