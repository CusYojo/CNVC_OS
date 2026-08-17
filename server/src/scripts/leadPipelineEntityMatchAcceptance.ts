import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { openLeadPipelineReview, recordLeadPipelineDecision } from '../services/leadPipelineAuditService.js'
import { recordLeadPipelineRawEvent } from '../services/leadPipelineEventService.js'
import {
  listLeadPipelineEntityMatches,
  normalizeLeadEntitySubject,
  recordLeadPipelineEntityMatch,
} from '../services/leadPipelineEntityMatchService.js'

const table = (name: string) => quoteMysqlIdentifier(mysqlTableName(name))
const rawTable = table('lead_pipeline_raw_events')
const itemsTable = table('lead_pipeline_items')
const transitionsTable = table('lead_pipeline_transitions')
const decisionsTable = table('lead_pipeline_decisions')
const evidenceTable = table('lead_pipeline_evidence')
const reviewsTable = table('lead_pipeline_reviews')
const matchesTable = table('lead_pipeline_entity_matches')
const leadsTable = table('leads')
const marker = randomUUID()
const leadIds = [randomUUID(), randomUUID()]
let eventId = ''
const checks: string[] = []

async function count(where: string, values: unknown[]) {
  const [rows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${matchesTable} WHERE ${where}`,
    values,
  )
  return Number(rows[0]?.count ?? 0)
}

async function cleanup() {
  if (eventId) {
    await pool.query(`DELETE FROM ${matchesTable} WHERE event_id=?`, [eventId])
    await pool.query(`DELETE FROM ${reviewsTable} WHERE event_id=?`, [eventId])
    await pool.query(`DELETE FROM ${evidenceTable} WHERE event_id=?`, [eventId])
    await pool.query(`DELETE FROM ${decisionsTable} WHERE event_id=? AND parent_decision_id IS NOT NULL`, [eventId])
    await pool.query(`DELETE FROM ${decisionsTable} WHERE event_id=?`, [eventId])
    await pool.query(`DELETE FROM ${transitionsTable} WHERE event_id=?`, [eventId])
    await pool.query(`DELETE FROM ${itemsTable} WHERE event_id=?`, [eventId])
    await pool.query(`DELETE FROM ${rawTable} WHERE id=?`, [eventId])
  }
  await pool.query(`DELETE FROM ${leadsTable} WHERE id IN (?,?)`, leadIds)
}

async function main() {
  await ensureSchema()
  const subjectName = `实体匹配验收公司-${marker}`.slice(0, 128)
  try {
    await pool.query(
      `INSERT INTO ${leadsTable} (id,name,company_name,source,pool_status,score,created_at)
       VALUES (?,?,?,'entity-match-acceptance','成功',0,NOW(3)),
              (?,?,?,'entity-match-acceptance','成功',0,NOW(3))`,
      [leadIds[0], subjectName, subjectName, leadIds[1], subjectName, subjectName],
    )
    const captured = await recordLeadPipelineRawEvent({
      sourceType: 'entity-match-acceptance',
      sourceId: marker,
      payload: { subjectName, marker },
    })
    eventId = captured.event.id
    const decision = await recordLeadPipelineDecision({
      idempotencyKey: `${marker}:decision`,
      eventId,
      decisionType: 'entity_resolution',
      outcome: 'review',
      subjectType: 'company',
      subjectName,
      confidence: 100,
      reason: 'two exact-name candidates require manual review',
      actorType: 'system',
      actorId: 'entity-match-acceptance',
    })
    const review = await openLeadPipelineReview({
      idempotencyKey: `${marker}:review`,
      eventId,
      triggerDecisionId: decision.id,
      reason: 'two exact-name candidates require manual review',
    })

    await Promise.all(leadIds.flatMap((leadId) => [0, 1].map(async () =>
      await recordLeadPipelineEntityMatch({
        idempotencyKey: `${marker}:candidate:${leadId}`,
        eventId,
        decisionId: decision.id,
        reviewId: review.id,
        subjectType: 'company',
        subjectName,
        matchType: 'exact_name',
        candidateLeadId: leadId,
        candidateName: subjectName,
        candidateCompanyName: subjectName,
        score: 10_000,
        status: 'ambiguous',
        aliases: [subjectName, `  ${subjectName}  `],
      }),
    )))
    assert.equal(await count('event_id=?', [eventId]), 2)
    checks.push('concurrent-candidate-replay-is-idempotent')

    const listed = await listLeadPipelineEntityMatches([eventId, eventId])
    assert.equal(listed.length, 2)
    assert(listed.every((entry) => entry.decisionId === decision.id && entry.reviewId === review.id))
    assert(listed.every((entry) => entry.normalizedSubjectName === normalizeLeadEntitySubject(subjectName)))
    checks.push('event-decision-review-and-normalized-subject-are-queryable')

    await assert.rejects(() => recordLeadPipelineEntityMatch({
      idempotencyKey: `${marker}:candidate:${leadIds[0]}`,
      eventId,
      decisionId: decision.id,
      reviewId: review.id,
      subjectName,
      matchType: 'manual_target',
      candidateLeadId: leadIds[0],
      status: 'selected',
      resolutionType: 'manual',
    }), /idempotency key collision/)
    checks.push('idempotency-key-collision-cannot-rewrite-history')

    await pool.query(`DELETE FROM ${leadsTable} WHERE id=?`, [leadIds[0]])
    const afterDelete = await listLeadPipelineEntityMatches([eventId])
    const deletedCandidate = afterDelete.find((entry) => entry.candidateName === subjectName && entry.candidateLeadId == null)
    assert(deletedCandidate)
    assert.equal(deletedCandidate.candidateName, subjectName)
    checks.push('lead-deletion-nullifies-live-reference-but-preserves-candidate-snapshot')

    console.log(JSON.stringify({ ok: true, checks, count: checks.length }))
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => await pool.end())
