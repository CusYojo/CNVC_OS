import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { operationalTelemetryRepository } from '../repositories/mysql/mysqlOperationalTelemetryRepository.js'
import {
  openLeadPipelineReview,
  recordLeadPipelineDecision,
  resolveLeadPipelineReview,
} from '../services/leadPipelineAuditService.js'
import { recordLeadPipelineRawEvent } from '../services/leadPipelineEventService.js'

const table = (name: string) => quoteMysqlIdentifier(mysqlTableName(name))
const rawTable = table('lead_pipeline_raw_events')
const itemsTable = table('lead_pipeline_items')
const transitionsTable = table('lead_pipeline_transitions')
const decisionsTable = table('lead_pipeline_decisions')
const reviewsTable = table('lead_pipeline_reviews')
const usersTable = table('users')

const checks: string[] = []
function check(condition: unknown, name: string) {
  assert.ok(condition, name)
  checks.push(name)
}

async function main() {
  await ensureSchema()
  const suffix = randomUUID()
  const userId = randomUUID()
  let eventId: string | null = null
  try {
    const baseline = (await operationalTelemetryRepository.snapshot()).leadAgents
    await pool.query(
      `INSERT INTO ${usersTable}
        (id,email,name,role,department,password_hash,status,created_at)
       VALUES (?,?,'复核吞吐验收用户','投资经理','验收部','acceptance-only','启用',NOW(3))`,
      [userId, `review-telemetry-${suffix}@example.invalid`],
    )
    const raw = await recordLeadPipelineRawEvent({
      sourceType: 'acceptance',
      sourceId: `review-telemetry:${suffix}`,
      payload: {
        source: 'lead-review-telemetry-acceptance',
        title: `复核吞吐验收-${suffix}`,
        summary: '仅用于验证人工复核积压与吞吐聚合，验收结束后精确删除。',
      },
    })
    eventId = raw.event.id
    const trigger = await recordLeadPipelineDecision({
      idempotencyKey: `review-telemetry-trigger:${suffix}`,
      eventId,
      decisionType: 'subject_identification',
      outcome: 'review',
      reason: '复核吞吐验收需要进入人工复核',
      output: { fixture: true },
      actorType: 'system',
      actorId: 'lead-review-telemetry-acceptance',
    })
    const review = await openLeadPipelineReview({
      idempotencyKey: `review-telemetry:${suffix}`,
      eventId,
      triggerDecisionId: trigger.id,
      reason: '复核吞吐验收临时记录',
      assignedUserId: userId,
    })
    const pending = (await operationalTelemetryRepository.snapshot()).leadAgents
    check(pending.pendingReviews === baseline.pendingReviews + 1,
      'pending-review-backlog-increments-exactly')
    check(pending.openedReviews24h === baseline.openedReviews24h + 1,
      'opened-review-throughput-increments-exactly')
    check(pending.resolvedReviews24h === baseline.resolvedReviews24h,
      'pending-review-does-not-inflate-resolved-throughput')
    check(pending.oldestPendingReviewAgeMs >= 0,
      'oldest-pending-review-age-is-non-negative')

    await resolveLeadPipelineReview({
      reviewId: review.id,
      reviewerUserId: userId,
      idempotencyKey: `review-telemetry-resolution:${suffix}`,
      outcome: 'reject',
      reason: '验收记录完成后拒绝，不创建正式线索',
      output: { fixture: true },
    })
    const resolved = (await operationalTelemetryRepository.snapshot()).leadAgents
    check(resolved.pendingReviews === baseline.pendingReviews,
      'resolved-review-leaves-pending-backlog')
    check(resolved.openedReviews24h === baseline.openedReviews24h + 1,
      'resolution-preserves-opened-throughput')
    check(resolved.resolvedReviews24h === baseline.resolvedReviews24h + 1,
      'resolved-review-throughput-increments-exactly')
    check(resolved.averageReviewResolutionMs24h >= 0,
      'average-review-resolution-duration-is-non-negative')
  } finally {
    if (eventId) {
      await pool.query(`DELETE FROM ${reviewsTable} WHERE event_id=?`, [eventId]).catch(() => undefined)
      await pool.query(
        `DELETE FROM ${decisionsTable} WHERE event_id=? AND parent_decision_id IS NOT NULL`,
        [eventId],
      ).catch(() => undefined)
      await pool.query(`DELETE FROM ${decisionsTable} WHERE event_id=?`, [eventId]).catch(() => undefined)
      await pool.query(`DELETE FROM ${transitionsTable} WHERE event_id=?`, [eventId]).catch(() => undefined)
      await pool.query(`DELETE FROM ${itemsTable} WHERE event_id=?`, [eventId]).catch(() => undefined)
      await pool.query(`DELETE FROM ${rawTable} WHERE id=?`, [eventId]).catch(() => undefined)
    }
    await pool.query(`DELETE FROM ${usersTable} WHERE id=?`, [userId]).catch(() => undefined)
    const [residueRows] = await pool.query<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) count FROM ${rawTable} WHERE source_id=?`,
      [`review-telemetry:${suffix}`],
    )
    check(Number(residueRows[0]?.count || 0) === 0, 'review-telemetry-fixture-residue-is-zero')
  }
  console.log(JSON.stringify({ ok: true, checks }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => await pool.end())
