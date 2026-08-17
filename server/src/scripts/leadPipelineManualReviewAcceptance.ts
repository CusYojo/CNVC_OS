import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { ensureSchema } from '../db/migrate.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { recordLeadPipelineRawEvent, verifyLeadPipelineRawEvent } from '../services/leadPipelineEventService.js'
import { openLeadPipelineReview, recordLeadPipelineDecision } from '../services/leadPipelineAuditService.js'
import {
  leadPipelineReviewContractDigest,
  listLeadPipelineReviews,
  resolveAndCommitLeadPipelineReview,
  type LeadPipelineReviewActor,
} from '../services/leadPipelineReviewService.js'

const rawTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_raw_events'))
const itemsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_items'))
const transitionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_transitions'))
const decisionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_decisions'))
const evidenceTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_evidence'))
const reviewsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_reviews'))
const entityMatchesTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_entity_matches'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const usersTable = quoteMysqlIdentifier(mysqlTableName('users'))
const auditLogsTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))

const checks: string[] = []
function check(condition: unknown, name: string, detail?: unknown) {
  assert.ok(condition, detail == null ? name : `${name}: ${JSON.stringify(detail)}`)
  checks.push(name)
}

async function createReviewFixture(input: {
  suffix: string
  label: string
  subjectName: string
  assignedUserId?: string | null
}) {
  const quote = `${input.subjectName}完成新一轮融资，核心产品已经获得客户订单。`
  const raw = await recordLeadPipelineRawEvent({
    sourceType: 'radar',
    sourceId: `manual-review:${input.label}:${input.suffix}`,
    payload: {
      source: 'manual-review-acceptance',
      source_id: `${input.label}-${input.suffix}`,
      source_group: '融资新闻',
      title: `${input.subjectName}完成融资`,
      summary: quote,
      article_text: `公开报道显示，${quote} 本轮资金将用于产品研发。`,
      link: `https://example.invalid/${input.label}/${input.suffix}`,
      project_profile: {
        project_name: input.subjectName,
        company_name: input.subjectName,
        industry: '企业服务',
        project_round: 'A轮',
        financing_amount: '1亿元',
      },
    },
  })
  const decision = await recordLeadPipelineDecision({
    idempotencyKey: `manual-review-trigger:${input.label}:${input.suffix}`,
    eventId: raw.event.id,
    decisionType: 'subject_identification',
    outcome: 'review',
    subjectType: 'company',
    subjectName: input.subjectName,
    confidence: 68,
    reason: '主体和投资相关性需要人工复核',
    output: { source: 'acceptance-agent', candidate: input.label },
    actorType: 'agent',
    actorId: 'acceptance-agent',
    evidence: [{
      sourceType: 'radar',
      sourceId: raw.event.sourceId,
      locator: 'summary',
      claim: `候选材料提及 ${input.subjectName}`,
      quote,
      verificationStatus: 'unverified',
    }],
  })
  const review = await openLeadPipelineReview({
    idempotencyKey: `manual-review:${input.label}:${input.suffix}`,
    eventId: raw.event.id,
    triggerDecisionId: decision.id,
    reason: '主体和投资相关性需要人工复核',
    assignedUserId: input.assignedUserId ?? null,
  })
  await pool.query(
    `UPDATE ${itemsTable} SET status='review', decision_reason='主体和投资相关性需要人工复核', updated_at=NOW(3) WHERE event_id=?`,
    [raw.event.id],
  )
  return { raw, decision, review, quote }
}

async function main() {
  await ensureSchema()
  const suffix = randomUUID()
  const userIds = [randomUUID(), randomUUID(), randomUUID()]
  await pool.query(
    `INSERT INTO ${usersTable}
      (id,email,name,role,department,password_hash,status,created_at)
     VALUES
      (?,?,'人工复核经理','投资经理','验收部','acceptance-only','启用',NOW(3)),
      (?,?,'人工复核外部用户','投资经理','验收部','acceptance-only','启用',NOW(3)),
      (?,?,'人工复核管理员','系统管理员','验收部','acceptance-only','启用',NOW(3))`,
    [
      userIds[0], `manual-review-owner-${suffix}@example.invalid`,
      userIds[1], `manual-review-outsider-${suffix}@example.invalid`,
      userIds[2], `manual-review-admin-${suffix}@example.invalid`,
    ],
  )
  const owner: LeadPipelineReviewActor = { userId: userIds[0], userName: '人工复核经理', role: '投资经理' }
  const outsider: LeadPipelineReviewActor = { userId: userIds[1], userName: '人工复核外部用户', role: '投资经理' }
  const admin: LeadPipelineReviewActor = { userId: userIds[2], userName: '人工复核管理员', role: '系统管理员' }
  const fixtures: Awaited<ReturnType<typeof createReviewFixture>>[] = []
  const createdLeadIds: string[] = []
  try {
    check(/^[a-f0-9]{64}$/.test(leadPipelineReviewContractDigest()), 'review-contract-version-has-stable-digest')

    const acceptedFixture = await createReviewFixture({
      suffix,
      label: 'accept',
      subjectName: `复核闭环星科技${suffix.slice(0, 6)}`,
      assignedUserId: owner.userId,
    })
    fixtures.push(acceptedFixture)
    const [ownerList, outsiderList, adminList] = await Promise.all([
      listLeadPipelineReviews({ actor: owner, status: 'pending' }),
      listLeadPipelineReviews({ actor: outsider, status: 'pending' }),
      listLeadPipelineReviews({ actor: admin, status: 'pending' }),
    ])
    check(ownerList.list.some((item) => item.id === acceptedFixture.review.id)
      && !outsiderList.list.some((item) => item.id === acceptedFixture.review.id)
      && adminList.list.some((item) => item.id === acceptedFixture.review.id),
    'assigned-review-visible-only-to-assignee-and-system-admin')

    await assert.rejects(() => resolveAndCommitLeadPipelineReview({
      reviewId: acceptedFixture.review.id,
      idempotencyKey: `unauthorized-${suffix}`,
      outcome: 'reject',
      reason: '外部用户不得处理已分配任务',
    }, outsider), (error: unknown) => (error as { code?: string }).code === 'LEAD_REVIEW_FORBIDDEN')
    check(true, 'unauthorized-review-resolution-is-rejected')

    await assert.rejects(() => resolveAndCommitLeadPipelineReview({
      reviewId: acceptedFixture.review.id,
      idempotencyKey: `bad-evidence-${suffix}`,
      outcome: 'accept',
      subjectType: 'company',
      subjectName: acceptedFixture.decision.subjectName,
      confidence: 90,
      reason: '无效引文不得入池',
      evidence: [{ sourceType: 'radar', claim: '编造证据', quote: '这段文字不在不可变原始事件中' }],
    }, owner), (error: unknown) => (error as { code?: string }).code === 'LEAD_REVIEW_EVIDENCE_NOT_IN_SOURCE')
    const [[pendingAfterInvalid], [leadAfterInvalid]] = await Promise.all([
      pool.query<Array<RowDataPacket & { status: string }>>(`SELECT status FROM ${reviewsTable} WHERE id=?`, [acceptedFixture.review.id]),
      pool.query<Array<RowDataPacket & { count: number }>>(`SELECT COUNT(*) count FROM ${leadsTable} WHERE name=?`, [acceptedFixture.decision.subjectName]),
    ])
    check(pendingAfterInvalid[0]?.status === 'pending' && Number(leadAfterInvalid[0]?.count) === 0,
      'invalid-schema-or-evidence-rolls-back-review-and-formal-lead-write')

    const resolutionKey = `accept-resolution-${suffix}`
    const accepted = await resolveAndCommitLeadPipelineReview({
      reviewId: acceptedFixture.review.id,
      idempotencyKey: resolutionKey,
      outcome: 'accept',
      subjectType: 'company',
      subjectName: acceptedFixture.decision.subjectName,
      confidence: 96,
      reason: '人工核对原文后确认主体明确且具备投资相关性',
      evidence: [{
        sourceId: acceptedFixture.raw.event.sourceId,
        sourceType: 'radar',
        locator: 'summary',
        claim: `原文支持主体 ${acceptedFixture.decision.subjectName} 及融资事实`,
        quote: acceptedFixture.quote,
      }],
    }, owner)
    assert.ok(accepted.leadId)
    createdLeadIds.push(accepted.leadId)
    const [[reviewRows], [itemRows], [leadRows], [decisionRows], [evidenceRows], [auditRows]] = await Promise.all([
      pool.query<Array<RowDataPacket & { status: string; reviewer_user_id: string; resolution_decision_id: string }>>(
        `SELECT status,reviewer_user_id,resolution_decision_id FROM ${reviewsTable} WHERE id=?`, [acceptedFixture.review.id],
      ),
      pool.query<Array<RowDataPacket & { status: string; lead_id: string }>>(
        `SELECT status,lead_id FROM ${itemsTable} WHERE event_id=?`, [acceptedFixture.raw.event.id],
      ),
      pool.query<Array<RowDataPacket & { id: string; name: string; source: string; radar_profile: unknown }>>(
        `SELECT id,name,source,radar_profile FROM ${leadsTable} WHERE id=?`, [accepted.leadId],
      ),
      pool.query<Array<RowDataPacket & { id: string; parent_decision_id: string; actor_type: string; outcome: string }>>(
        `SELECT id,parent_decision_id,actor_type,outcome FROM ${decisionsTable} WHERE event_id=? ORDER BY created_at,id`,
        [acceptedFixture.raw.event.id],
      ),
      pool.query<Array<RowDataPacket & { verification_status: string; quote: string }>>(
        `SELECT verification_status,quote FROM ${evidenceTable} WHERE event_id=? ORDER BY created_at,id`,
        [acceptedFixture.raw.event.id],
      ),
      pool.query<Array<RowDataPacket & { count: number }>>(
        `SELECT COUNT(*) count FROM ${auditLogsTable} WHERE user_id=? AND target LIKE ?`,
        [owner.userId, `%review=${acceptedFixture.review.id}%`],
      ),
    ])
    check(reviewRows[0]?.status === 'resolved'
      && reviewRows[0]?.reviewer_user_id === owner.userId
      && itemRows[0]?.status === 'ready'
      && itemRows[0]?.lead_id === accepted.leadId
      && leadRows[0]?.name === acceptedFixture.decision.subjectName
      && /人工复核/.test(leadRows[0]?.source ?? '')
      && decisionRows.length === 2
      && decisionRows[1]?.parent_decision_id === acceptedFixture.decision.id
      && decisionRows[1]?.actor_type === 'user'
      && decisionRows[1]?.outcome === 'accept'
      && evidenceRows.some((row) => row.verification_status === 'verified'
        && row.quote === acceptedFixture.quote.normalize('NFKC'))
      && Number(auditRows[0]?.count) === 1,
    'host-transaction-atomically-resolves-review-creates-lead-transitions-ready-and-audits', {
      reviewRows, itemRows, leadRows, decisionRows, evidenceRows, auditRows,
    })
    const rawIntegrity = await verifyLeadPipelineRawEvent(acceptedFixture.raw.event.id)
    check(rawIntegrity.valid, 'manual-review-does-not-mutate-immutable-raw-event')

    const repeated = await resolveAndCommitLeadPipelineReview({
      reviewId: acceptedFixture.review.id,
      idempotencyKey: resolutionKey,
      outcome: 'accept',
      subjectType: 'company',
      subjectName: acceptedFixture.decision.subjectName,
      confidence: 96,
      reason: '人工核对原文后确认主体明确且具备投资相关性',
      evidence: [{
        sourceId: acceptedFixture.raw.event.sourceId,
        sourceType: 'radar',
        locator: 'summary',
        claim: `原文支持主体 ${acceptedFixture.decision.subjectName} 及融资事实`,
        quote: acceptedFixture.quote,
      }],
    }, owner)
    const [repeatCounts] = await pool.query<Array<RowDataPacket & { leads: number; decisions: number; audits: number }>>(
      `SELECT
        (SELECT COUNT(*) FROM ${leadsTable} WHERE id=?) leads,
        (SELECT COUNT(*) FROM ${decisionsTable} WHERE event_id=?) decisions,
        (SELECT COUNT(*) FROM ${auditLogsTable} WHERE user_id=? AND target LIKE ?) audits`,
      [accepted.leadId, acceptedFixture.raw.event.id, owner.userId, `%review=${acceptedFixture.review.id}%`],
    )
    check(repeated.decision.id === accepted.decision.id
      && Number(repeatCounts[0]?.leads) === 1
      && Number(repeatCounts[0]?.decisions) === 2
      && Number(repeatCounts[0]?.audits) === 1,
    'manual-review-retry-is-idempotent-without-duplicate-lead-decision-or-audit', repeatCounts[0])

    const duplicateName = `重复主体星科技${suffix.slice(0, 6)}`
    const duplicateLeadIds = [randomUUID(), randomUUID()]
    const mismatchedLeadId = randomUUID()
    createdLeadIds.push(...duplicateLeadIds, mismatchedLeadId)
    await pool.query(
      `INSERT INTO ${leadsTable}
        (id,name,company_name,industry,source,pool_status,score,created_at)
       VALUES
        (?,?,?,'企业服务','人工复核重复验收','成功',0,NOW(3)),
        (?,?,?,'企业服务','人工复核重复验收','成功',0,NOW(3)),
        (?,? ,?,'企业服务','人工复核错误目标验收','成功',0,NOW(3))`,
      [
        duplicateLeadIds[0], duplicateName, duplicateName,
        duplicateLeadIds[1], duplicateName, duplicateName,
        mismatchedLeadId, `异名主体${suffix.slice(0, 6)}`, `异名主体${suffix.slice(0, 6)}`,
      ],
    )
    const duplicateFixture = await createReviewFixture({
      suffix,
      label: 'duplicate',
      subjectName: duplicateName,
      assignedUserId: owner.userId,
    })
    fixtures.push(duplicateFixture)
    const duplicateInput = {
      reviewId: duplicateFixture.review.id,
      outcome: 'accept' as const,
      subjectType: 'company' as const,
      subjectName: duplicateName,
      confidence: 95,
      reason: '人工核对主体后选择现有同名线索作为合并目标',
      evidence: [{
        sourceId: duplicateFixture.raw.event.sourceId,
        sourceType: 'radar',
        locator: 'summary',
        claim: `原文支持主体 ${duplicateName}`,
        quote: duplicateFixture.quote,
      }],
    }
    await assert.rejects(() => resolveAndCommitLeadPipelineReview({
      ...duplicateInput,
      idempotencyKey: `duplicate-wrong-target-${suffix}`,
      targetLeadId: mismatchedLeadId,
    }, owner), (error: unknown) => (error as { code?: string }).code === 'LEAD_REVIEW_TARGET_SUBJECT_MISMATCH')
    check(true, 'manual-review-cannot-merge-into-a-different-subject')

    await pool.query(`UPDATE ${leadsTable} SET pool_status='已转专属项目' WHERE id=?`, [duplicateLeadIds[1]])
    await assert.rejects(() => resolveAndCommitLeadPipelineReview({
      ...duplicateInput,
      idempotencyKey: `duplicate-terminal-target-${suffix}`,
      targetLeadId: duplicateLeadIds[1],
    }, owner), (error: unknown) => (error as { code?: string }).code === 'LEAD_REVIEW_TARGET_TERMINAL')
    await pool.query(`UPDATE ${leadsTable} SET pool_status='成功' WHERE id=?`, [duplicateLeadIds[1]])
    check(true, 'manual-review-cannot-merge-into-a-terminal-converted-lead')

    await assert.rejects(() => resolveAndCommitLeadPipelineReview({
      ...duplicateInput,
      idempotencyKey: `duplicate-target-required-${suffix}`,
    }, owner), (error: unknown) => (error as { code?: string }).code === 'LEAD_REVIEW_DUPLICATE_TARGET_REQUIRED')
    const [[pendingDuplicateReview], [duplicateBeforeSelection], [duplicateDecisionBeforeSelection]] = await Promise.all([
      pool.query<Array<RowDataPacket & { status: string }>>(
        `SELECT status FROM ${reviewsTable} WHERE id=?`, [duplicateFixture.review.id],
      ),
      pool.query<Array<RowDataPacket & { count: number }>>(
        `SELECT COUNT(*) count FROM ${leadsTable} WHERE name=?`, [duplicateName],
      ),
      pool.query<Array<RowDataPacket & { count: number }>>(
        `SELECT COUNT(*) count FROM ${decisionsTable} WHERE event_id=?`, [duplicateFixture.raw.event.id],
      ),
    ])
    check(pendingDuplicateReview[0]?.status === 'pending'
      && Number(duplicateBeforeSelection[0]?.count) === 2
      && Number(duplicateDecisionBeforeSelection[0]?.count) === 1,
    'multiple-exact-subject-matches-require-explicit-human-target-with-full-rollback')

    const duplicateResolved = await resolveAndCommitLeadPipelineReview({
      ...duplicateInput,
      idempotencyKey: `duplicate-selected-target-${suffix}`,
      targetLeadId: duplicateLeadIds[0],
    }, owner)
    const [[duplicateAfterSelection], [duplicateItemAfterSelection]] = await Promise.all([
      pool.query<Array<RowDataPacket & { count: number }>>(
        `SELECT COUNT(*) count FROM ${leadsTable} WHERE name=?`, [duplicateName],
      ),
      pool.query<Array<RowDataPacket & { status: string; lead_id: string }>>(
        `SELECT status,lead_id FROM ${itemsTable} WHERE event_id=?`, [duplicateFixture.raw.event.id],
      ),
    ])
    check(duplicateResolved.leadId === duplicateLeadIds[0]
      && duplicateResolved.leadCreated === false
      && Number(duplicateAfterSelection[0]?.count) === 2
      && duplicateItemAfterSelection[0]?.status === 'ready'
      && duplicateItemAfterSelection[0]?.lead_id === duplicateLeadIds[0],
    'explicit-human-selection-merges-only-to-the-chosen-exact-subject-without-creating-a-third-lead')

    const rejectedFixture = await createReviewFixture({
      suffix,
      label: 'reject',
      subjectName: `复核拒绝候选${suffix.slice(0, 6)}`,
    })
    fixtures.push(rejectedFixture)
    const rejected = await resolveAndCommitLeadPipelineReview({
      reviewId: rejectedFixture.review.id,
      idempotencyKey: `reject-resolution-${suffix}`,
      outcome: 'reject',
      confidence: 100,
      reason: '人工确认主体不唯一，不进入正式线索池',
    }, owner)
    const [[rejectedItem], [rejectedLead]] = await Promise.all([
      pool.query<Array<RowDataPacket & { status: string; lead_id: string | null }>>(
        `SELECT status,lead_id FROM ${itemsTable} WHERE event_id=?`, [rejectedFixture.raw.event.id],
      ),
      pool.query<Array<RowDataPacket & { count: number }>>(
        `SELECT COUNT(*) count FROM ${leadsTable} WHERE name=?`, [rejectedFixture.decision.subjectName],
      ),
    ])
    check(rejected.pipelineStatus === 'rejected'
      && rejectedItem[0]?.status === 'rejected'
      && rejectedItem[0]?.lead_id == null
      && Number(rejectedLead[0]?.count) === 0,
    'manual-reject-preserves-history-without-creating-formal-lead')

    const resolvedList = await listLeadPipelineReviews({ actor: owner, status: 'resolved' })
    check(resolvedList.list.some((item) => item.id === acceptedFixture.review.id)
      && resolvedList.list.some((item) => item.id === rejectedFixture.review.id)
      && resolvedList.list.every((item) => item.reviewerUserId === owner.userId),
    'resolved-review-history-is-user-scoped-and-readable-from-mysql')

    await assert.rejects(() => listLeadPipelineReviews({
      actor: { userId: randomUUID(), userName: '无权角色', role: '访客' },
      status: 'pending',
    }), (error: unknown) => (error as { code?: string }).code === 'LEAD_REVIEW_ROLE_FORBIDDEN')
    check(true, 'non-review-role-cannot-read-review-queue')

    console.log(JSON.stringify({ ok: true, checks, count: checks.length }))
  } finally {
    const eventIds = fixtures.map((fixture) => fixture.raw.event.id)
    if (eventIds.length) {
      const placeholders = eventIds.map(() => '?').join(',')
      await pool.query(
        `DELETE FROM ${auditLogsTable} WHERE user_id IN (${userIds.map(() => '?').join(',')})
          AND module='项目获取池' AND action LIKE '人工复核%'`,
        userIds,
      )
      if (createdLeadIds.length) {
        await pool.query(`DELETE FROM ${itemsTable} WHERE event_id IN (${placeholders})`, eventIds).catch(() => undefined)
        await pool.query(`DELETE FROM ${leadsTable} WHERE id IN (${createdLeadIds.map(() => '?').join(',')})`, createdLeadIds)
      }
      await pool.query(`DELETE FROM ${entityMatchesTable} WHERE event_id IN (${placeholders})`, eventIds)
      await pool.query(`DELETE FROM ${reviewsTable} WHERE event_id IN (${placeholders})`, eventIds)
      await pool.query(`DELETE FROM ${evidenceTable} WHERE event_id IN (${placeholders})`, eventIds)
      await pool.query(`DELETE FROM ${decisionsTable} WHERE event_id IN (${placeholders}) AND parent_decision_id IS NOT NULL`, eventIds)
      await pool.query(`DELETE FROM ${decisionsTable} WHERE event_id IN (${placeholders})`, eventIds)
      await pool.query(`DELETE FROM ${transitionsTable} WHERE event_id IN (${placeholders})`, eventIds)
      await pool.query(`DELETE FROM ${itemsTable} WHERE event_id IN (${placeholders})`, eventIds)
      await pool.query(`DELETE FROM ${rawTable} WHERE id IN (${placeholders})`, eventIds)
    }
    await pool.query(`DELETE FROM ${usersTable} WHERE id IN (${userIds.map(() => '?').join(',')})`, userIds)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => await pool.end())
