import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { resolveLeadBusinessRegion } from './leadRegion.js'
import { recordLeadPipelineRawEvent, transitionLeadPipelineItem } from './leadPipelineEventService.js'
import { formatShanghaiDateKey } from '../utils/shanghaiTime.js'

export type LeadReserveRawRow = RowDataPacket & {
  id: number
  seq: number | null
  src_id: string | null
  name: string | null
  detail_url: string | null
  detail_json: Record<string, unknown> | string | null
  imported: number | boolean
  imported_lead_id: string | null
  created_at: Date
}

const reserveTable = quoteMysqlIdentifier(mysqlTableName('lead_reserve'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))

function objectValue(value: unknown): Record<string, any> {
  if (!value) return {}
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, any> } catch { return {} }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function formatDate(value: unknown): string {
  if (!value) return '待核验'
  const text = String(value)
  if (/^\d{12,}$/.test(text)) {
    const parsed = new Date(Number(text))
    return Number.isNaN(parsed.getTime()) ? '待核验' : formatShanghaiDateKey(parsed)
  }
  return text.slice(0, 32)
}

export function leadReserveRawEventInput(row: LeadReserveRawRow) {
  return {
    sourceType: 'lead_reserve',
    sourceId: row.src_id || `reserve-row:${row.id}`,
    sourceOccurredAt: row.created_at,
    payload: {
      reserveId: row.id,
      seq: row.seq,
      srcId: row.src_id,
      name: row.name,
      detailUrl: row.detail_url,
      detailJson: objectValue(row.detail_json),
    },
  }
}

function reserveLead(row: LeadReserveRawRow, sourceKey: string) {
  const detail = objectValue(row.detail_json)
  const business = objectValue(detail.business)
  const name = String(detail.name || row.name || '未命名项目').trim().slice(0, 128) || '未命名项目'
  const companyName = String(detail.companyName || business.name || name).trim().slice(0, 128)
  const industry = Array.isArray(detail.industryList) && detail.industryList.length
    ? detail.industryList.map((item: any) => item?.name).filter(Boolean).join('、')
    : (Array.isArray(detail.tagList) ? detail.tagList.filter(Boolean).join('、') : '待核验')
  const oneLiner = String(detail.oneWord || detail.intro || '').trim()
  const detailUrl = String(row.detail_url || (detail.companyId ? `https://pitchhub.36kr.com/company/${detail.companyId}` : ''))
  const shareholders = Array.isArray(business.shareholder)
    ? business.shareholder.map((item: any) => ({
      name: item?.name || '', percent: item?.percent || '', amount: item?.amomon || '', date: item?.time || '',
    }))
    : []
  const fundingRounds = Array.isArray(detail.financingList)
    ? detail.financingList.map((item: any) => ({
      round: item?.roundTxt || '未披露',
      amount: item?.amount || '未披露',
      valuation: '未披露',
      investors: (Array.isArray(item?.investorList)
        ? item.investorList.map((investor: any) => investor?.name).filter((entry: unknown) => entry && entry !== 'null').join('、')
        : '') || (item?.vc && item.vc !== 'null' ? item.vc : '待核验'),
      date: formatDate(item?.date),
      sourceUrl: detailUrl,
    }))
    : []
  const radarProfile = {
    sourceId: row.src_id || String(row.id),
    radarSourceKey: sourceKey,
    channel: '36氪',
    sourceName: '36氪',
    sourceGroup: '36氪项目库',
    qualityRejected: false,
    profile: {
      projectName: name,
      companyName,
      projectRound: detail.currentFinancing?.name || fundingRounds[0]?.round || '未披露',
      industry,
      region: detail.provinceName || business.regLocation || '',
    },
  }
  const scoring = {
    projectName: name,
    whatIsIt: oneLiner,
    registry: {
      companyName,
      registeredCapital: business.shareholder?.[0]?.amomon || '待核验',
      legalRepresentative: business.legalPersonName || '待核验',
      establishDate: formatDate(business.estiblishTime || detail.setupDate),
      address: business.regLocation || '待核验',
      province: detail.provinceName || '待核验',
    },
    structuredTeam: [],
    structuredShareholders: shareholders,
    fundingRoundsResearched: fundingRounds,
    structuredNews: [],
  }
  const region = resolveLeadBusinessRegion({
    registry: scoring.registry,
    profile: radarProfile.profile,
    subjectName: name,
    companyName,
    sourceGroup: radarProfile.sourceGroup,
    channel: radarProfile.channel,
  })
  return {
    id: randomUUID(), name, companyName, industry: String(industry || '待核验').slice(0, 64),
    summary: oneLiner.slice(0, 1_000), detailUrl, fundingRounds, radarProfile, scoring, sourceKey, region,
  }
}

export type LeadScoringScheduler = (leadId: string) => Promise<boolean>

export async function compensateLeadReserveScoring(scheduleScoring: LeadScoringScheduler, limit = 200) {
  const [rows] = await pool.query<Array<RowDataPacket & { id: number; imported_lead_id: string }>>(
    `SELECT id, imported_lead_id FROM ${reserveTable}
     WHERE imported=1 AND imported_lead_id IS NOT NULL AND score_status='pending'
     ORDER BY imported_at, id LIMIT ?`,
    [Math.max(1, Math.min(limit, 1_000))],
  )
  let requested = 0
  let deferred = 0
  for (const row of rows) {
    try {
      if (await scheduleScoring(row.imported_lead_id)) {
        await pool.query(
          `UPDATE ${reserveTable} SET score_status='requested', score_requested_at=NOW(3), score_last_error=NULL WHERE id=?`,
          [row.id],
        )
        requested += 1
      } else {
        deferred += 1
      }
    } catch (error) {
      await pool.query(
        `UPDATE ${reserveTable} SET score_last_error=? WHERE id=?`,
        [(error instanceof Error ? error.message : String(error)).slice(0, 4_000), row.id],
      )
      deferred += 1
    }
  }
  return { found: rows.length, requested, deferred }
}

export async function runLeadReserveIntake(options: {
  limit: number
  scheduleScoring: LeadScoringScheduler
}) {
  const limit = Math.max(1, Math.min(options.limit, 500))
  const connection = await pool.getConnection()
  const insertedIds: string[] = []
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<LeadReserveRawRow[]>(
      `SELECT id, seq, src_id, name, detail_url, detail_json, imported, imported_lead_id, created_at FROM ${reserveTable}
       WHERE imported=0 AND detail_json IS NOT NULL ORDER BY seq, id LIMIT ? FOR UPDATE SKIP LOCKED`,
      [limit],
    )
    for (const row of rows) {
      const raw = await recordLeadPipelineRawEvent(leadReserveRawEventInput(row), connection)
      const sourceKey = `lead-reserve-event:${raw.event.id}`
      const legacySourceKey = `lead-reserve:${row.id}`
      const lead = reserveLead(row, sourceKey)
      const [existing] = await connection.query<Array<RowDataPacket & { id: string }>>(
        `SELECT id FROM ${leadsTable}
         WHERE JSON_CONTAINS(radar_source_keys, JSON_QUOTE(?))
            OR JSON_CONTAINS(radar_source_keys, JSON_QUOTE(?))
         LIMIT 1`,
        [lead.sourceKey, legacySourceKey],
      )
      const leadId = raw.item.leadId || row.imported_lead_id || existing[0]?.id || lead.id
      if (!raw.item.leadId && !row.imported_lead_id && !existing[0]) {
        await connection.query(
          `INSERT INTO ${leadsTable}
            (id,name,company_name,industry,business_region,business_region_source,business_region_confidence,
             source,pool_status,score,summary,highlights,risks,team,funding_rounds,risk_tags,sources,
             scoring,radar_profile,radar_source_keys,created_at)
           VALUES (?,?,?,?,?,?,?,'36氪项目库','成功',0,?,JSON_ARRAY(),JSON_ARRAY(),'待核验',?,JSON_ARRAY(),?,?,?,JSON_ARRAY(?),NOW(3))`,
          [leadId, lead.name, lead.companyName, lead.industry,
            lead.region?.region || null, lead.region?.source || null, lead.region?.confidence || null,
            lead.summary, JSON.stringify(lead.fundingRounds),
            JSON.stringify(lead.detailUrl ? [{ title: lead.name, url: lead.detailUrl, reliability: '中', category: '36氪', excerpt: lead.summary.slice(0, 200) }] : []),
            JSON.stringify(lead.scoring), JSON.stringify(lead.radarProfile), lead.sourceKey],
        )
      }
      await transitionLeadPipelineItem(raw.event.id, {
        status: 'ready',
        reason: '36kr reserve candidate committed by host transaction',
        evidence: lead.detailUrl ? [{ title: lead.name, url: lead.detailUrl, source: '36氪项目库' }] : [],
        confidence: 100,
        leadId,
        actorType: 'system',
        actorId: 'lead-reserve-daily-intake',
      }, connection)
      await connection.query(
        `UPDATE ${reserveTable} SET imported=1, imported_at=COALESCE(imported_at,NOW(3)),
          imported_lead_id=?, score_status='pending', score_last_error=NULL WHERE id=?`,
        [leadId, row.id],
      )
      insertedIds.push(leadId)
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }

  const scoring = await compensateLeadReserveScoring(options.scheduleScoring, Math.max(limit * 2, 200))
  const [remainingRows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) AS count FROM ${reserveTable} WHERE imported=0`,
  )
  return {
    ok: true,
    selected: insertedIds.length,
    insertedIds,
    scoring,
    remaining: Number(remainingRows[0]?.count) || 0,
  }
}
