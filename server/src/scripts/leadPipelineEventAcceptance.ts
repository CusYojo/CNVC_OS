import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { db, pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { leads } from '../db/schema.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  recordLeadPipelineRawEvent,
  transitionLeadPipelineItem,
  verifyLeadPipelineRawEvent,
} from '../services/leadPipelineEventService.js'
import { commitRadarLeadPipelineReady } from '../services/aiSummaryService.js'

const rawTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_raw_events'))
const itemsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_items'))
const transitionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_transitions'))
const decisionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_decisions'))
const evidenceTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_evidence'))
const reviewsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_reviews'))
const entityMatchesTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_entity_matches'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const auditLogsTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
const marker = `pipeline-acceptance-${randomUUID()}`
const leadId = randomUUID()
const rollbackLeadName = `Radar事务回滚验收-${marker}`.slice(0, 128)
const ambiguousLeadName = `Radar重复主体验收-${marker}`.slice(0, 128)
const ambiguousLeadIds = [randomUUID(), randomUUID()]
const eventIds = new Set<string>()
const checks: string[] = []

async function count(table: string, where: string, values: unknown[]) {
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
    values,
  )
  return Number(rows[0]?.count || 0)
}

async function cleanup() {
  const ids = [...eventIds]
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',')
    await pool.query(`DELETE FROM ${entityMatchesTable} WHERE event_id IN (${placeholders})`, ids)
    await pool.query(`DELETE FROM ${evidenceTable} WHERE event_id IN (${placeholders})`, ids)
    await pool.query(`DELETE FROM ${reviewsTable} WHERE event_id IN (${placeholders})`, ids)
    await pool.query(`DELETE FROM ${decisionsTable} WHERE event_id IN (${placeholders})`, ids)
    await pool.query(`DELETE FROM ${transitionsTable} WHERE event_id IN (${placeholders})`, ids)
    await pool.query(`DELETE FROM ${itemsTable} WHERE event_id IN (${placeholders})`, ids)
    await pool.query(`DELETE FROM ${rawTable} WHERE id IN (${placeholders})`, ids)
  }
  await pool.query(`DELETE FROM ${auditLogsTable} WHERE target IN (?,?)`, [rollbackLeadName, ambiguousLeadName])
  await pool.query(`DELETE FROM ${leadsTable} WHERE id IN (?,?,?) OR name IN (?,?)`, [
    leadId, ...ambiguousLeadIds, rollbackLeadName, ambiguousLeadName,
  ])
}

async function main() {
  await ensureSchema()
  await db.insert(leads).values({
    id: leadId,
    name: `原始事件验收项目-${marker}`.slice(0, 128),
    source: 'lead-pipeline-event-acceptance',
    poolStatus: '成功',
  })
  try {
    const input = {
      sourceType: 'radar',
      sourceId: marker,
      sourceOccurredAt: '2026-08-09T08:00:00+08:00',
      payload: { title: '不可变事件验收', nested: { b: 2, a: 1 }, sourceId: marker },
    }
    const concurrent = await Promise.all([
      recordLeadPipelineRawEvent(input),
      recordLeadPipelineRawEvent({ ...input, payload: { sourceId: marker, nested: { a: 1, b: 2 }, title: '不可变事件验收' } }),
    ])
    concurrent.forEach((result) => eventIds.add(result.event.id))
    assert.equal(new Set(concurrent.map((result) => result.event.id)).size, 1)
    assert.equal(concurrent.filter((result) => result.created).length, 1)
    assert.equal(await count(rawTable, 'source_id=?', [marker]), 1)
    assert.equal(await count(itemsTable, 'event_id=?', [concurrent[0].event.id]), 1)
    assert.equal(await count(transitionsTable, "event_id=? AND to_status='discovered'", [concurrent[0].event.id]), 1)
    checks.push('concurrent-identical-source-content-creates-one-raw-event')
    checks.push('raw-capture-creates-one-discovered-item-and-transition')

    const verified = await verifyLeadPipelineRawEvent(concurrent[0].event.id)
    assert.equal(verified.exists, true)
    assert.equal(verified.valid, true)
    checks.push('stored-payload-hash-and-event-identity-verify')

    const changed = await recordLeadPipelineRawEvent({
      ...input,
      payload: { ...input.payload, title: '同一来源的新内容版本' },
    })
    eventIds.add(changed.event.id)
    assert.notEqual(changed.event.id, concurrent[0].event.id)
    assert.equal(changed.created, true)
    assert.equal(await count(rawTable, 'source_id=?', [marker]), 2)
    checks.push('same-source-changed-content-creates-new-immutable-version')

    const contentOnly = await Promise.all([
      recordLeadPipelineRawEvent({ sourceType: 'news', payload: { marker, value: 7 } }),
      recordLeadPipelineRawEvent({ sourceType: 'news', payload: { value: 7, marker } }),
    ])
    contentOnly.forEach((result) => eventIds.add(result.event.id))
    assert.equal(new Set(contentOnly.map((result) => result.event.id)).size, 1)
    assert.equal(contentOnly.filter((result) => result.created).length, 1)
    checks.push('missing-source-id-falls-back-to-content-hash-idempotency')

    const eventId = concurrent[0].event.id
    const review = await transitionLeadPipelineItem(eventId, {
      status: 'review',
      reason: 'ambiguous subject requires manual review',
      evidence: [{ excerpt: '不可变事件验收' }],
      confidence: 62,
      actorType: 'agent',
      actorId: 'acceptance-agent-v1',
    })
    assert.equal(review.changed, true)
    assert.equal(review.item.status, 'review')
    assert.equal(review.item.confidence, 62)
    assert.equal(review.item.processingAttempts, 1)
    checks.push('review-state-reason-evidence-confidence-persisted')

    const ready = await transitionLeadPipelineItem(eventId, {
      status: 'ready',
      reason: 'host validation accepted reviewed subject',
      evidence: [{ excerpt: '不可变事件验收', locator: 'fixture:1' }],
      confidence: 95,
      leadId,
      actorType: 'system',
      actorId: 'acceptance-host',
    })
    assert.equal(ready.changed, true)
    assert.equal(ready.item.status, 'ready')
    assert.equal(ready.item.leadId, leadId)
    assert.equal(await count(transitionsTable, 'event_id=?', [eventId]), 3)
    checks.push('review-to-ready-links-formal-lead-with-history')

    const blocked = await transitionLeadPipelineItem(eventId, {
      status: 'rejected',
      reason: 'later automatic result must not withdraw a committed lead',
      actorType: 'agent',
      actorId: 'later-agent',
    })
    assert.equal(blocked.changed, false)
    assert.equal(blocked.blocked, true)
    assert.equal(blocked.item.status, 'ready')
    assert.equal(await count(transitionsTable, 'event_id=?', [eventId]), 3)
    checks.push('automatic-rerun-cannot-silently-withdraw-ready-lead')

    await assert.rejects(
      commitRadarLeadPipelineReady({
        lead: {
          name: rollbackLeadName,
          source: '项目发现雷达 · 事务回滚验收',
          poolStatus: '成功',
          summary: '该线索插入后将因不存在的流水线事件而触发事务回滚。',
          radarSourceKeys: [`rollback:${marker}`],
        },
        eventId: `missing-${randomUUID()}`,
        transition: {
          reason: 'acceptance forces ready transition failure after formal lead write',
          evidence: [{ marker }],
          confidence: 99,
          actorType: 'system',
          actorId: 'lead-pipeline-event-acceptance',
        },
      }),
      /lead pipeline item not found/,
    )
    assert.equal(await count(leadsTable, 'name=?', [rollbackLeadName]), 0)
    assert.equal(await count(auditLogsTable, 'target=?', [rollbackLeadName]), 0)
    checks.push('radar-formal-lead-and-ready-transition-roll-back-together')

    await db.insert(leads).values(ambiguousLeadIds.map((id) => ({
      id,
      name: ambiguousLeadName,
      companyName: ambiguousLeadName,
      source: 'lead-pipeline-duplicate-acceptance',
      poolStatus: '成功',
    })))
    const ambiguousEvent = await recordLeadPipelineRawEvent({
      sourceType: 'radar',
      sourceId: `duplicate-${marker}`,
      payload: { title: `${ambiguousLeadName}完成融资`, subjectName: ambiguousLeadName },
    })
    eventIds.add(ambiguousEvent.event.id)
    await assert.rejects(
      commitRadarLeadPipelineReady({
        lead: {
          name: ambiguousLeadName,
          companyName: ambiguousLeadName,
          source: '项目发现雷达 · 重复主体验收',
          poolStatus: '成功',
          summary: '该候选命中两条正式线索，必须转人工选择，不得自动取第一条。',
        },
        eventId: ambiguousEvent.event.id,
        transition: {
          reason: 'acceptance verifies duplicate entity review staging',
          evidence: [{ subjectName: ambiguousLeadName }],
          confidence: 98,
          actorType: 'system',
          actorId: 'lead-pipeline-event-acceptance',
        },
      }),
      (error: unknown) => {
        const failure = error as { code?: string; reviewStaged?: boolean; duplicateMatches?: number }
        return failure.code === 'RADAR_LEAD_ENTITY_AMBIGUOUS'
          && failure.reviewStaged === true
          && failure.duplicateMatches === 1
      },
    )
    assert.equal(await count(leadsTable, 'name=?', [ambiguousLeadName]), 2)
    assert.equal(await count(auditLogsTable, 'target=?', [ambiguousLeadName]), 0)
    assert.equal(await count(itemsTable, "event_id=? AND status='review' AND lead_id IS NULL", [ambiguousEvent.event.id]), 1)
    assert.equal(await count(decisionsTable, "event_id=? AND decision_type='entity_resolution' AND outcome='review'", [ambiguousEvent.event.id]), 1)
    assert.equal(await count(reviewsTable, "event_id=? AND status='pending'", [ambiguousEvent.event.id]), 1)
    assert.equal(await count(entityMatchesTable, "event_id=? AND status='ambiguous'", [ambiguousEvent.event.id]), 2)
    checks.push('radar-ambiguous-existing-entity-stages-actionable-review-without-merging-or-creating')

    const originalPayload = JSON.stringify(concurrent[0].event.payload)
    await pool.query(`UPDATE ${rawTable} SET payload=JSON_SET(payload, '$.title', 'tampered') WHERE id=?`, [eventId])
    assert.equal((await verifyLeadPipelineRawEvent(eventId)).valid, false)
    await pool.query(`UPDATE ${rawTable} SET payload=CAST(? AS JSON) WHERE id=?`, [originalPayload, eventId])
    assert.equal((await verifyLeadPipelineRawEvent(eventId)).valid, true)
    checks.push('out-of-band-raw-payload-tampering-is-detected')

    console.log(JSON.stringify({ ok: true, checks, count: checks.length }))
  } finally {
    await cleanup()
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => await pool.end())
