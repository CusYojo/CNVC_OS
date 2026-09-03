import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { LEAD_ENRICHMENT_TOPIC_KEYS } from '../services/leadEnrichmentContract.js'
import {
  confirmLeadEnrichmentEntity,
  enqueueLeadEnrichmentJob,
  excludeDeregisteredLeadFromPool,
  freezeLeadEnrichmentSnapshot,
  getLeadEnrichmentDisplayProfile,
  getLeadEnrichmentStatus,
  listLeadEnrichmentConflicts,
  listLeadEnrichmentFacts,
  persistLeadFact,
  recordLeadEnrichmentTopicPhase,
  resolveLeadEnrichmentConflict,
  retryLeadEnrichmentTopic,
} from '../services/leadEnrichmentService.js'
import { getLeadScoreJobBinding } from '../services/leadScoreJobService.js'
import { LEAD_RATING_V3_SCHEMA_VERSION } from '../services/leadRatingV3Service.js'
import { LEAD_RATING_V3_WORKFLOW } from '../services/leadRatingV3Service.js'
import { LEAD_INVESTMENT_PROFILE_SCHEMA_VERSION } from '../contracts/leadInvestmentProfileContract.js'
import {
  claimLeadEnrichmentTopicLease,
  leadEnrichmentOperationalMetrics,
  quarantineProviderBudgetLeadEnrichmentRetries,
  recoverExpiredLeadEnrichmentLeases,
} from '../services/leadEnrichmentWorkerService.js'
import { commitRadarLeadPipelineReady, saveLeadScoring } from '../services/aiSummaryService.js'
import { listLeadRatingHistory, restoreLeadRatingHistory } from '../services/leadRatingHistoryService.js'
import { readLeadTopicSearchCache, writeLeadTopicSearchCache } from '../services/leadTopicSearchCacheService.js'
import { commitLeadPublicIntel, type PublicIntelResult } from '../services/leadPublicIntelService.js'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'
import { scheduleLeadScoring } from '../routes/meta.js'
import { scoreWithAgentDetailed } from '../services/inProcessAiWorkflowService.js'
import {
  runLeadScoringAgent,
  type LeadScoringAgentQueryFactory,
  type LeadScoringAgentExecution,
} from '../services/leadScoringAgentService.js'
import { recordLeadPipelineRawEvent, transitionLeadPipelineItem } from '../services/leadPipelineEventService.js'
import { refreshLeadInvestmentProfileProjectionWithReceipt } from '../services/leadInvestmentProfileProjectionService.js'

const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const jobsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_jobs'))
const topicRunsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_topic_runs'))
const entitiesTable = quoteMysqlIdentifier(mysqlTableName('lead_entities'))
const entityRelationsTable = quoteMysqlIdentifier(mysqlTableName('lead_entity_relations'))
const factsTable = quoteMysqlIdentifier(mysqlTableName('lead_facts'))
const sourceDocumentsTable = quoteMysqlIdentifier(mysqlTableName('lead_source_documents'))
const usersTable = quoteMysqlIdentifier(mysqlTableName('users'))
const auditLogsTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
const pipelineRunsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_runs'))
const pipelineDecisionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_decisions'))
const pipelineItemsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_items'))
const investmentProfilesTable = quoteMysqlIdentifier(mysqlTableName('lead_investment_profile_projections'))

async function main() {
  assertIsolatedMysqlAcceptanceDatabase('leadEnrichmentMysqlFixtureAcceptance')
  const leadId = randomUUID()
  const actorId = randomUUID()
  await pool.query(
    `INSERT INTO ${usersTable} (id,email,name,role,department,password_hash,status,created_at)
     VALUES (?,'lead-enrichment-acceptance@example.invalid','隔离验收管理员','系统管理员','测试部','acceptance-only','启用',NOW(3))`,
    [actorId],
  )
  await pool.query(
    `INSERT INTO ${leadsTable}
      (id,name,company_name,industry,pool_status,score,summary,highlights,risks,funding_rounds,risk_tags,sources,
       scoring,radar_profile,radar_source_keys,field_provenance,created_at)
     VALUES (?,?,?,'企业服务','成功',0,'隔离验收企业',JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),
       JSON_OBJECT('officialSite','https://acceptance.example.com/',
         'aliases',JSON_ARRAY('联网补全验收品牌'),
         'registry',JSON_OBJECT('creditCode','91110108ACCEPTANCE1','legalRepresentative','验收法人',
           'registeredAddress','浙江省杭州市验收路1号','registrationStatus','存续')),
       JSON_OBJECT('qualityRejected',false),JSON_ARRAY(),JSON_OBJECT(),NOW(3))`,
    [leadId, '联网补全隔离验收企业', '联网补全隔离验收企业有限公司'],
  )
  const prerequisiteLeadId = randomUUID()
  await pool.query(
    `INSERT INTO ${leadsTable}
      (id,name,company_name,industry,pool_status,score,summary,highlights,risks,funding_rounds,risk_tags,sources,
       radar_profile,radar_source_keys,field_provenance,created_at)
     VALUES (?,?,?,'企业服务','成功',0,'评分前置快照隔离验收',JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),
       JSON_OBJECT('qualityRejected',false),JSON_ARRAY(),JSON_OBJECT(),NOW(3))`,
    [prerequisiteLeadId, '评分前置快照验收企业', '评分前置快照验收企业有限公司'],
  )
  assert.equal(await scheduleLeadScoring(prerequisiteLeadId), false)
  const prerequisiteStatus = await getLeadEnrichmentStatus(prerequisiteLeadId)
  assert.equal(prerequisiteStatus.status, 'queued')
  assert.equal(prerequisiteStatus.topics.length, 13)
  assert.equal(await getLeadScoreJobBinding(prerequisiteLeadId), null)
  const [providerBudgetTopics] = await pool.query<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM ${topicRunsTable} WHERE lead_id=? AND topic_key='basic_profile' LIMIT 1`, [prerequisiteLeadId],
  )
  await pool.query(
    `UPDATE ${topicRunsTable}
     SET status='retrying',last_error='联网搜索网关 403：令牌额度不足：需要 0.0251，可用 0.0032',
         next_attempt_at=NOW(3),lease_owner=NULL,lease_expires_at=NULL
     WHERE id=?`,
    [providerBudgetTopics[0]?.id],
  )
  assert.equal(await quarantineProviderBudgetLeadEnrichmentRetries(), 1)
  const [providerBudgetRows] = await pool.query<Array<RowDataPacket & { status: string; metrics: unknown }>>(
    `SELECT status,metrics FROM ${topicRunsTable} WHERE id=?`, [providerBudgetTopics[0]?.id],
  )
  const providerBudgetMetrics = typeof providerBudgetRows[0]?.metrics === 'string'
    ? JSON.parse(providerBudgetRows[0].metrics) : providerBudgetRows[0]?.metrics
  assert.equal(providerBudgetRows[0]?.status, 'dead_letter')
  assert.equal(providerBudgetMetrics?.errorClass, 'budget')
  assert.equal(providerBudgetMetrics?.automaticDisposition, 'provider_billing_dead_letter_on_startup')
  const first = await enqueueLeadEnrichmentJob({
    leadId, triggerType: 'mysql-acceptance', idempotencyToken: 'mysql-acceptance-idempotency',
  })
  const duplicate = await enqueueLeadEnrichmentJob({
    leadId, triggerType: 'mysql-acceptance', idempotencyToken: 'mysql-acceptance-idempotency',
  })
  assert.equal(first.queued, true)
  assert.equal(duplicate.queued, false)
  assert.equal(duplicate.jobId, first.jobId)
  assert(first.jobId)
  const [jobs] = await pool.query<Array<RowDataPacket & { entity_id: string }>>(
    `SELECT entity_id FROM ${jobsTable} WHERE id=?`, [first.jobId],
  )
  const entityId = jobs[0]?.entity_id
  assert(entityId, 'enrichment job did not bind a normalized entity')
  const [entityRows] = await pool.query<Array<RowDataPacket & { aliases: unknown; identifiers: unknown }>>(
    `SELECT aliases,identifiers FROM ${entitiesTable} WHERE id=?`, [entityId],
  )
  const entityAliases = typeof entityRows[0]?.aliases === 'string' ? JSON.parse(entityRows[0].aliases) : entityRows[0]?.aliases
  const entityIdentifiers = typeof entityRows[0]?.identifiers === 'string' ? JSON.parse(entityRows[0].identifiers) : entityRows[0]?.identifiers
  assert(entityAliases.includes('联网补全验收品牌'))
  assert.equal(entityIdentifiers.creditCode, '91110108ACCEPTANCE1')
  assert.equal(entityIdentifiers.websiteDomain, 'acceptance.example.com')
  assert.equal(entityIdentifiers.legalRepresentative, '验收法人')
  assert.equal(entityIdentifiers.registeredAddress, '浙江省杭州市验收路1号')
  const [topics] = await pool.query<Array<RowDataPacket & { id: string; topic_key: typeof LEAD_ENRICHMENT_TOPIC_KEYS[number] }>>(
    `SELECT id,topic_key FROM ${topicRunsTable} WHERE job_id=? ORDER BY topic_key`, [first.jobId],
  )
  assert.equal(topics.length, 13)
  const phaseTopic = topics.find((topic) => topic.topic_key === 'basic_profile')!
  await pool.query(
    `UPDATE ${topicRunsTable} SET status='running',lease_owner='acceptance-phase-owner' WHERE id=?`, [phaseTopic.id],
  )
  assert.equal(await recordLeadEnrichmentTopicPhase({
    topicRunId: phaseTopic.id, leaseOwner: 'acceptance-phase-owner', phase: 'searching',
  }), true)
  const [phaseRows] = await pool.query<Array<RowDataPacket & { metrics: unknown }>>(
    `SELECT metrics FROM ${topicRunsTable} WHERE id=?`, [phaseTopic.id],
  )
  const phaseMetrics = typeof phaseRows[0]?.metrics === 'string' ? JSON.parse(phaseRows[0].metrics) : phaseRows[0]?.metrics
  assert.equal(phaseMetrics?.currentPhase, 'searching')
  assert.equal(phaseMetrics?.phaseTransitions?.[0]?.phase, 'searching')
  await pool.query(
    `UPDATE ${topicRunsTable} SET status='queued',lease_owner=NULL,lease_expires_at=NULL WHERE id=?`, [phaseTopic.id],
  )
  const sourceDocumentId = randomUUID()
  const sourceText = topics.map((topic) => `隔离验收事实-${topic.topic_key}`).join('\n')
  const sourceHash = createHash('sha256').update(sourceText).digest('hex')
  await pool.query(
    `INSERT INTO ${sourceDocumentsTable}
      (id,lead_id,canonical_url,canonical_url_hash,final_url,fetch_status,http_status,content_type,title,publisher,
       content_hash,extracted_text,accessed_at,expires_at,created_at)
     VALUES (?,?,?,?,?,'ready',200,'text/plain','隔离验收来源','验收夹具',?,?,NOW(3),DATE_ADD(NOW(3),INTERVAL 1 HOUR),NOW(3))`,
    [sourceDocumentId, leadId, 'https://example.com/acceptance', createHash('sha256').update('https://example.com/acceptance').digest('hex'),
      'https://example.com/acceptance', sourceHash, sourceText],
  )
  let projectedIndustryFactId = ''
  for (const topic of topics) {
    const value = `隔离验收事实-${topic.topic_key}`
    const factKey = topic.topic_key === 'products'
      ? 'product.main_business'
      : topic.topic_key === 'market_policy'
        ? 'industry.segment'
      : `acceptance.${topic.topic_key}`
    const persisted = await persistLeadFact({
      leadId, topicRunId: topic.id, topicKey: topic.topic_key, subjectType: 'company', subjectId: entityId,
      factKey, value, evidenceLevel: 'E2', verificationStatus: 'verified',
      evidence: [{
        sourceUrl: 'https://example.com/acceptance', sourceDocumentId,
        sourceType: 'acceptance_fixture', quote: value, reliability: 'E2', pageHash: sourceHash,
      }],
    })
    if (topic.topic_key === 'market_policy') projectedIndustryFactId = persisted.factId
  }
  assert(projectedIndustryFactId)
  await pool.query(
    `UPDATE ${topicRunsTable} SET status='completed',completed_at=NOW(3),updated_at=NOW(3) WHERE job_id=?`,
    [first.jobId],
  )
  await pool.query(`UPDATE ${jobsTable} SET entity_status='confirmed',status='running',updated_at=NOW(3) WHERE id=?`, [first.jobId])
  const frozen = await freezeLeadEnrichmentSnapshot(first.jobId)
  assert.equal(frozen.inserted, true)
  assert.equal(frozen.snapshot.status, 'ready')
  assert.equal(frozen.snapshot.coverage, 100)
  assert.equal(frozen.snapshot.facts.length, 13)
  const replay = await freezeLeadEnrichmentSnapshot(first.jobId)
  assert.equal(replay.inserted, false)
  assert.equal(replay.snapshotId, frozen.snapshotId)
  assert.equal(replay.snapshot.snapshotHash, frozen.snapshot.snapshotHash)
  const [investmentProfileRows] = await pool.query<Array<RowDataPacket & {
    schema_version: string; snapshot_id: string; snapshot_hash: string; dictionary_hash: string;
    industry_segment: string | null; verified_dimensions: number;
    profile_status: string; source_fact_ids: unknown; count: number;
  }>>(
    `SELECT schema_version,snapshot_id,snapshot_hash,dictionary_hash,industry_segment,verified_dimensions,
            profile_status,source_fact_ids,
            (SELECT COUNT(*) FROM ${investmentProfilesTable} WHERE lead_id=?) count
     FROM ${investmentProfilesTable} WHERE lead_id=? LIMIT 1`,
    [leadId, leadId],
  )
  assert.equal(investmentProfileRows[0]?.count, 1)
  assert.equal(investmentProfileRows[0]?.schema_version, LEAD_INVESTMENT_PROFILE_SCHEMA_VERSION)
  assert.equal(investmentProfileRows[0]?.snapshot_id, frozen.snapshotId)
  assert.equal(investmentProfileRows[0]?.snapshot_hash, frozen.snapshot.snapshotHash)
  assert.equal(investmentProfileRows[0]?.industry_segment, '隔离验收事实-market_policy')
  assert.equal(Number(investmentProfileRows[0]?.verified_dimensions), 1)
  assert.equal(investmentProfileRows[0]?.profile_status, 'partial')
  const originalInvestmentProfile = investmentProfileRows[0]!
  const originalSourceFactIds = typeof originalInvestmentProfile.source_fact_ids === 'string'
    ? JSON.parse(originalInvestmentProfile.source_fact_ids)
    : originalInvestmentProfile.source_fact_ids
  assert.deepEqual(originalSourceFactIds, [projectedIndustryFactId])
  await pool.query(`DELETE FROM ${investmentProfilesTable} WHERE lead_id=?`, [leadId])
  const [deletedInvestmentProfiles] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${investmentProfilesTable} WHERE lead_id=?`, [leadId],
  )
  assert.equal(Number(deletedInvestmentProfiles[0]?.count), 0)
  const rebuiltInvestmentProfile = await refreshLeadInvestmentProfileProjectionWithReceipt({
    leadId, snapshotId: frozen.snapshotId,
  })
  assert(rebuiltInvestmentProfile)
  assert.equal(rebuiltInvestmentProfile.write?.changed, true)
  assert.equal(rebuiltInvestmentProfile.write?.beforeFingerprint, null)
  const [rebuiltInvestmentProfileRows] = await pool.query<Array<RowDataPacket & {
    schema_version: string; snapshot_id: string; snapshot_hash: string; dictionary_hash: string;
    industry_segment: string | null; verified_dimensions: number;
    profile_status: string; source_fact_ids: unknown; count: number;
  }>>(
    `SELECT schema_version,snapshot_id,snapshot_hash,dictionary_hash,industry_segment,verified_dimensions,
            profile_status,source_fact_ids,
            (SELECT COUNT(*) FROM ${investmentProfilesTable} WHERE lead_id=?) count
     FROM ${investmentProfilesTable} WHERE lead_id=? LIMIT 1`,
    [leadId, leadId],
  )
  const rebuiltInvestmentProfileRow = rebuiltInvestmentProfileRows[0]!
  assert.equal(rebuiltInvestmentProfileRow.count, 1)
  assert.deepEqual({
    schemaVersion: rebuiltInvestmentProfileRow.schema_version,
    snapshotId: rebuiltInvestmentProfileRow.snapshot_id,
    snapshotHash: rebuiltInvestmentProfileRow.snapshot_hash,
    dictionaryHash: rebuiltInvestmentProfileRow.dictionary_hash,
    industrySegment: rebuiltInvestmentProfileRow.industry_segment,
    verifiedDimensions: Number(rebuiltInvestmentProfileRow.verified_dimensions),
    profileStatus: rebuiltInvestmentProfileRow.profile_status,
    sourceFactIds: typeof rebuiltInvestmentProfileRow.source_fact_ids === 'string'
      ? JSON.parse(rebuiltInvestmentProfileRow.source_fact_ids)
      : rebuiltInvestmentProfileRow.source_fact_ids,
  }, {
    schemaVersion: originalInvestmentProfile.schema_version,
    snapshotId: originalInvestmentProfile.snapshot_id,
    snapshotHash: originalInvestmentProfile.snapshot_hash,
    dictionaryHash: originalInvestmentProfile.dictionary_hash,
    industrySegment: originalInvestmentProfile.industry_segment,
    verifiedDimensions: Number(originalInvestmentProfile.verified_dimensions),
    profileStatus: originalInvestmentProfile.profile_status,
    sourceFactIds: originalSourceFactIds,
  })
  const rebuiltInvestmentProfileReplay = await refreshLeadInvestmentProfileProjectionWithReceipt({
    leadId, snapshotId: frozen.snapshotId,
  })
  assert(rebuiltInvestmentProfileReplay)
  assert.equal(rebuiltInvestmentProfileReplay.write?.changed, false)
  assert.equal(
    rebuiltInvestmentProfileReplay.write?.beforeFingerprint,
    rebuiltInvestmentProfileReplay.write?.afterFingerprint,
  )
  const unchangedResearchReplay = await enqueueLeadEnrichmentJob({
    leadId, triggerType: 'mysql-acceptance-unchanged-replay', idempotencyToken: 'unchanged-facts-new-job',
  })
  assert.equal(unchangedResearchReplay.queued, true)
  assert(unchangedResearchReplay.jobId)
  await pool.query(
    `UPDATE ${topicRunsTable} SET status='completed',completed_at=NOW(3),updated_at=NOW(3) WHERE job_id=?`,
    [unchangedResearchReplay.jobId],
  )
  await pool.query(
    `UPDATE ${jobsTable} SET entity_status='confirmed',status='running',updated_at=NOW(3) WHERE id=?`,
    [unchangedResearchReplay.jobId],
  )
  const unchangedReplaySnapshot = await freezeLeadEnrichmentSnapshot(unchangedResearchReplay.jobId)
  assert.equal(unchangedReplaySnapshot.inserted, false)
  assert.equal(unchangedReplaySnapshot.snapshotId, frozen.snapshotId)
  assert.equal(unchangedReplaySnapshot.snapshot.snapshotHash, frozen.snapshot.snapshotHash)
  const binding = await getLeadScoreJobBinding(leadId)
  assert.deepEqual(binding, {
    enrichmentSnapshotId: frozen.snapshotId,
    snapshotHash: frozen.snapshot.snapshotHash,
    ratingSchemaVersion: LEAD_RATING_V3_SCHEMA_VERSION,
  })
  const completedAt = new Date()
  const scoring = { total: 80, ratingV3: { status: 'ready', snapshotHash: frozen.snapshot.snapshotHash } }
  const ratingHistory = {
    snapshotId: frozen.snapshotId, snapshotHash: frozen.snapshot.snapshotHash,
    ratingSchemaVersion: LEAD_RATING_V3_SCHEMA_VERSION, workflow: 'score-lead-rating-v3',
    promptVersion: 'score-lead-rating-v3-lead-rating-v3-agent-v1', model: 'acceptance-model',
    status: 'ready', completedAt,
  }
  await saveLeadScoring(leadId, scoring, 80, { ingest: false, ratingHistory })
  await saveLeadScoring(leadId, scoring, 80, { ingest: false, ratingHistory })
  const history = await listLeadRatingHistory({ leadId, page: 1, pageSize: 10 })
  assert.equal(history.total, 1)
  assert.equal(history.ratings[0]?.snapshotId, frozen.snapshotId)
  await pool.query(
    `UPDATE ${leadsTable} SET score=95,scoring=JSON_OBJECT('total',95,'ratingV3',JSON_OBJECT('status','ready','computed',JSON_OBJECT('score',95))) WHERE id=?`,
    [leadId],
  )
  const restored = await restoreLeadRatingHistory({
    leadId, historyId: history.ratings[0]!.id, reason: '隔离验收恢复上一版评级',
    actor: { userId: actorId, userName: '隔离验收管理员' },
  })
  assert.equal(restored.score, 80)
  const [restoredRows] = await pool.query<Array<RowDataPacket & { score: number; scoring: unknown }>>(
    `SELECT score,scoring FROM ${leadsTable} WHERE id=?`, [leadId],
  )
  assert.equal(Number(restoredRows[0]?.score), 80)
  const restoredScoring = typeof restoredRows[0]?.scoring === 'string' ? JSON.parse(restoredRows[0].scoring) : restoredRows[0]?.scoring
  assert.equal(restoredScoring?.ratingV3?.restoredFromHistoryId, history.ratings[0]?.id)
  assert.equal(history.ratings[0]?.model, 'acceptance-model')
  const cacheInput = {
    subjectName: '联网补全隔离验收企业有限公司', entityType: 'company', topicKey: 'financing' as const,
    promptVersion: 'lead-topic-web-research-v1', queryPlan: ['融资 金额', '投资方'],
  }
  await writeLeadTopicSearchCache({
    ...cacheInput, model: 'acceptance-model',
    result: { topicKey: 'financing', facts: [], gaps: ['未披露'], conflicts: [], sources: [], usage: null },
  })
  const cached = await readLeadTopicSearchCache<Record<string, unknown>>(cacheInput)
  assert.equal(cached?.topicKey, 'financing')
  const status = await getLeadEnrichmentStatus(leadId)
  assert.equal(status.status, 'snapshot_ready')
  assert.equal(status.topics.length, 13)
  const facts = await listLeadEnrichmentFacts({ leadId, page: 1, pageSize: 5 })
  assert.equal(facts.total, 13)
  assert.equal(facts.facts.length, 5)
  assert.equal(facts.hasMore, true)
  assert(facts.facts.every((fact) => fact.evidence.length === 1))
  await persistLeadFact({
    leadId, topicRunId: phaseTopic.id, topicKey: 'basic_profile', subjectType: 'company', subjectId: entityId,
    factKey: 'acceptance.unverified_display_guard', value: '隔离验收事实-basic_profile',
    evidenceLevel: 'E3', verificationStatus: 'unverified',
    evidence: [{
      sourceUrl: 'https://example.com/acceptance', sourceDocumentId,
      sourceType: 'acceptance_fixture', quote: '隔离验收事实-basic_profile', reliability: 'E3', pageHash: sourceHash,
    }],
  })
  const displayFacts = await listLeadEnrichmentFacts({
    leadId, page: 1, pageSize: 100, projection: 'verified-display',
  })
  assert.equal(displayFacts.total, 13)
  assert(displayFacts.facts.every((fact) => fact.verificationStatus === 'verified'))
  assert(displayFacts.facts.every((fact) => fact.evidence.every((evidence) => (
    !Object.hasOwn(evidence, 'quote') && !Object.hasOwn(evidence, 'locator') && !Object.hasOwn(evidence, 'pageHash')
  ))))
  assert(displayFacts.facts.every((fact) => (
    !Object.hasOwn(fact, 'topicKey') && !Object.hasOwn(fact, 'subjectId')
      && !Object.hasOwn(fact, 'evidenceLevel') && !Object.hasOwn(fact, 'version')
      && !Object.hasOwn(fact, 'createdAt')
  )))
  const displayProfile = await getLeadEnrichmentDisplayProfile(leadId)
  assert.equal(displayProfile.leadId, leadId)
  assert.deepEqual(Object.keys(displayProfile.introductions).sort(), [
    'companyIntroduction', 'projectIntroduction', 'teamIntroduction',
  ])
  assert.deepEqual(Object.keys(displayProfile.introductionSources).sort(), [
    'companyIntroduction', 'projectIntroduction', 'teamIntroduction',
  ])
  assert.equal(displayProfile.introductions.companyIntroduction, '隔离验收事实-products')
  assert.deepEqual(displayProfile.introductionSources.companyIntroduction.map((source) => source.sourceUrl), [
    'https://example.com/acceptance',
  ])
  assert(displayProfile.introductionSources.companyIntroduction.every((source) => (
    !Object.hasOwn(source, 'quote') && !Object.hasOwn(source, 'pageHash')
      && !Object.hasOwn(source, 'factId') && !Object.hasOwn(source, 'sourceDocumentId')
  )))
  assert(!Object.hasOwn(displayProfile, 'topics'))
  assert(!Object.hasOwn(displayProfile, 'entities'))
  const metrics = await leadEnrichmentOperationalMetrics()
  assert.equal(metrics.topics.completed, 26, 'two completed topic-run sets should be observable without creating a second snapshot')
  assert.equal(metrics.snapshots.ready, 1)
  assert.equal(metrics.scoreJobs.queued, 1)
  assert(metrics.facts.some((item) => item.evidenceLevel === 'E2' && item.count === 13))
  const basicTopic = topics.find((topic) => topic.topic_key === 'basic_profile')!
  const conflictingValue = '隔离验收事实-basic_profile-第二来源冲突值'
  const conflictingDocumentId = randomUUID()
  const conflictingHash = createHash('sha256').update(conflictingValue).digest('hex')
  await pool.query(
    `INSERT INTO ${sourceDocumentsTable}
      (id,lead_id,canonical_url,canonical_url_hash,final_url,fetch_status,http_status,content_type,title,publisher,
       content_hash,extracted_text,accessed_at,expires_at,created_at)
     VALUES (?,?,?,?,?,'ready',200,'text/plain','冲突验收来源','验收夹具',?,?,NOW(3),DATE_ADD(NOW(3),INTERVAL 1 HOUR),NOW(3))`,
    [conflictingDocumentId, leadId, 'https://example.org/acceptance-conflict',
      createHash('sha256').update('https://example.org/acceptance-conflict').digest('hex'),
      'https://example.org/acceptance-conflict', conflictingHash, conflictingValue],
  )
  const conflicting = await persistLeadFact({
    leadId, topicRunId: basicTopic.id, topicKey: 'basic_profile', subjectType: 'company', subjectId: entityId,
    factKey: 'acceptance.basic_profile', value: conflictingValue, evidenceLevel: 'E2', verificationStatus: 'verified',
    evidence: [{
      sourceUrl: 'https://example.org/acceptance-conflict', sourceDocumentId: conflictingDocumentId,
      sourceType: 'acceptance_fixture', quote: conflictingValue, reliability: 'E2', pageHash: conflictingHash,
    }],
  })
  assert.equal(conflicting.conflicted, true)
  const conflicts = await listLeadEnrichmentConflicts(leadId)
  const openConflict = conflicts.find((conflict) => conflict.status === 'open' && conflict.factKey === 'acceptance.basic_profile')
  assert(openConflict)
  assert.equal(openConflict.candidateFactIds.length, 2)
  assert(openConflict.candidateFactIds.includes(conflicting.factId))
  assert.equal(openConflict.candidates.length, 2)
  assert(openConflict.candidates.every((candidate) => candidate.evidence.length === 1))
  await resolveLeadEnrichmentConflict({
    leadId, conflictId: openConflict.id, decision: 'accept_fact', selectedFactId: conflicting.factId,
    reason: '隔离验收选择第二来源事实', actor: { userId: actorId, userName: '隔离验收管理员' },
  })
  const selected = await listLeadEnrichmentFacts({ leadId, topicKey: 'basic_profile', page: 1, pageSize: 10 })
  const currentBasic = selected.facts.find((fact) => fact.factKey === 'acceptance.basic_profile')
  assert.equal(currentBasic?.id, conflicting.factId)
  assert.equal(currentBasic?.value, conflictingValue)
  assert.equal(currentBasic?.verificationStatus, 'verified')
  const financingTopic = topics.find((topic) => topic.topic_key === 'financing')!
  const dismissedConflictValue = '隔离验收事实-financing-不采信候选'
  const dismissedDocumentId = randomUUID()
  const dismissedDocumentHash = createHash('sha256').update(dismissedConflictValue).digest('hex')
  await pool.query(
    `INSERT INTO ${sourceDocumentsTable}
      (id,lead_id,canonical_url,canonical_url_hash,final_url,fetch_status,http_status,content_type,title,publisher,
       content_hash,extracted_text,accessed_at,expires_at,created_at)
     VALUES (?,?,?,?,?,'ready',200,'text/plain','驳回冲突验收来源','验收夹具',?,?,NOW(3),DATE_ADD(NOW(3),INTERVAL 1 HOUR),NOW(3))`,
    [dismissedDocumentId, leadId, 'https://example.net/acceptance-dismissed-conflict',
      createHash('sha256').update('https://example.net/acceptance-dismissed-conflict').digest('hex'),
      'https://example.net/acceptance-dismissed-conflict', dismissedDocumentHash, dismissedConflictValue],
  )
  const dismissedCandidate = await persistLeadFact({
    leadId, topicRunId: financingTopic.id, topicKey: 'financing', subjectType: 'company', subjectId: entityId,
    factKey: 'acceptance.financing', value: dismissedConflictValue, evidenceLevel: 'E2', verificationStatus: 'verified',
    evidence: [{
      sourceUrl: 'https://example.net/acceptance-dismissed-conflict', sourceDocumentId: dismissedDocumentId,
      sourceType: 'acceptance_fixture', quote: dismissedConflictValue, reliability: 'E2', pageHash: dismissedDocumentHash,
    }],
  })
  assert.equal(dismissedCandidate.conflicted, true)
  const dismissibleConflict = (await listLeadEnrichmentConflicts(leadId))
    .find((conflict) => conflict.status === 'open' && conflict.factKey === 'acceptance.financing')
  assert(dismissibleConflict)
  await resolveLeadEnrichmentConflict({
    leadId, conflictId: dismissibleConflict.id, decision: 'dismiss',
    reason: '隔离验收驳回全部冲突候选并重跑', actor: { userId: actorId, userName: '隔离验收管理员' },
  })
  const [dismissedFacts] = await pool.query<Array<RowDataPacket & { is_current: number; verification_status: string }>>(
    `SELECT is_current,verification_status FROM ${factsTable}
     WHERE lead_id=? AND id IN (${dismissibleConflict.candidateFactIds.map(() => '?').join(',')})`,
    [leadId, ...dismissibleConflict.candidateFactIds],
  )
  assert.equal(dismissedFacts.length, 2)
  assert(dismissedFacts.every((fact) => Number(fact.is_current) === 0 && fact.verification_status === 'rejected'))
  await pool.query(
    `UPDATE ${leadsTable} SET scoring=JSON_SET(scoring,'$.aliases',JSON_ARRAY('联网补全验收新品牌')) WHERE id=?`,
    [leadId],
  )
  const secondJob = await enqueueLeadEnrichmentJob({
    leadId, triggerType: 'manual-refresh', idempotencyToken: 'second-job-before-deregistration',
  })
  assert.equal(secondJob.queued, true)
  const [mergedEntityRows] = await pool.query<Array<RowDataPacket & { aliases: unknown }>>(
    `SELECT aliases FROM ${entitiesTable} WHERE id=?`, [entityId],
  )
  const mergedAliases = typeof mergedEntityRows[0]?.aliases === 'string' ? JSON.parse(mergedEntityRows[0].aliases) : mergedEntityRows[0]?.aliases
  assert(mergedAliases.includes('联网补全验收品牌'))
  assert(mergedAliases.includes('联网补全验收新品牌'))
  const [secondTopics] = await pool.query<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM ${topicRunsTable} WHERE job_id=? AND topic_key='financing' LIMIT 1`, [secondJob.jobId],
  )
  await pool.query(
    `UPDATE ${topicRunsTable} SET status='dead_letter',execution_attempts=3,last_error='acceptance failure',completed_at=NOW(3) WHERE id=?`,
    [secondTopics[0]!.id],
  )
  assert.equal(await retryLeadEnrichmentTopic({
    leadId, topicKey: 'financing', reason: '隔离验收管理员手动重试',
    actor: { userId: actorId, userName: '隔离验收管理员' },
  }), true)
  const [retryRows] = await pool.query<Array<RowDataPacket & { status: string; execution_attempts: number; metrics: unknown }>>(
    `SELECT status,execution_attempts,metrics FROM ${topicRunsTable} WHERE id=?`, [secondTopics[0]!.id],
  )
  const retryMetrics = typeof retryRows[0]?.metrics === 'string' ? JSON.parse(retryRows[0].metrics) : retryRows[0]?.metrics
  assert.equal(retryRows[0]?.status, 'queued')
  assert.equal(Number(retryRows[0]?.execution_attempts), 3)
  assert.equal(retryMetrics?.manualRetries?.[0]?.previousStatus, 'dead_letter')
  assert.equal(retryMetrics?.manualRetries?.[0]?.attempts, 3)
  const [retryAudits] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${auditLogsTable} WHERE action='手动重试联网补全专题' AND target LIKE ?`, [`%${leadId}%`],
  )
  assert.equal(Number(retryAudits[0]?.count), 1)
  const factsBeforeExclusion = await listLeadEnrichmentFacts({ leadId, page: 1, pageSize: 100 })
  const excluded = await excludeDeregisteredLeadFromPool({
    leadId, registrationStatus: '登记状态：已注销', sourceUrl: 'https://example.com/registry',
    actor: { userId: actorId, userName: '隔离验收管理员' },
  })
  assert.equal(excluded.excluded, true)
  assert(Number(excluded.cancelledJobs) >= 1)
  assert(Number(excluded.cancelledTopics) >= 13)
  assert.equal(await getLeadScoreJobBinding(leadId), null)
  const [excludedRows] = await pool.query<Array<RowDataPacket & { pool_status: string; scoring: unknown }>>(
    `SELECT pool_status,scoring FROM ${leadsTable} WHERE id=?`, [leadId],
  )
  assert.equal(excludedRows[0]?.pool_status, '已注销')
  const excludedScoring = typeof excludedRows[0]?.scoring === 'string' ? JSON.parse(excludedRows[0].scoring) : excludedRows[0]?.scoring
  assert.equal(excludedScoring?.ratingV3?.status, 'invalidated')
  assert.equal(await retryLeadEnrichmentTopic({
    leadId, topicKey: 'financing', reason: '注销后不得重新排队',
    actor: { userId: actorId, userName: '隔离验收管理员' },
  }), false)
  const [excludedJobRows] = await pool.query<Array<RowDataPacket & { status: string }>>(
    `SELECT status FROM ${jobsTable} WHERE id=?`, [secondJob.jobId],
  )
  assert.equal(excludedJobRows[0]?.status, 'rejected')
  await assert.rejects(
    freezeLeadEnrichmentSnapshot(secondJob.jobId!),
    (error: unknown) => (error as { code?: string }).code === 'LEAD_ENRICHMENT_JOB_INACTIVE',
  )
  const factsAfterExclusion = await listLeadEnrichmentFacts({ leadId, page: 1, pageSize: 100 })
  assert.equal(factsAfterExclusion.total, factsBeforeExclusion.total)
  const [exclusionAudits] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${auditLogsTable} WHERE action='注销企业移出共享线索池' AND target LIKE ?`, [`%${leadId}%`],
  )
  assert.equal(Number(exclusionAudits[0]?.count), 1)
  const serviceBoundaryLeadId = randomUUID()
  await pool.query(
    `INSERT INTO ${leadsTable}
      (id,name,company_name,industry,pool_status,score,summary,highlights,risks,funding_rounds,risk_tags,sources,
       radar_source_keys,field_provenance,created_at)
     VALUES (?,?,?,'企业服务','成功',0,'服务边界注销验收',JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),
       JSON_ARRAY(),JSON_OBJECT(),NOW(3))`,
    [serviceBoundaryLeadId, '服务边界注销验收企业', '服务边界注销验收企业有限公司'],
  )
  const deregisteredIntel: PublicIntelResult = {
    positioning: '仅用于隔离验收', registeredCapital: '', legalRepresentative: '', foundedAt: '',
    registrationStatus: '注销', region: '', registeredAddress: '', fundingRounds: [], shareholders: [],
    competitors: [], companyNews: [],
    sources: [{ title: '工商登记验收来源', url: 'https://example.com/registry/deregistered', reliability: '高' }],
    confidence: 1,
  }
  await assert.rejects(
    commitLeadPublicIntel({
      company: '服务边界注销验收企业有限公司', intel: deregisteredIntel,
      targetLeadId: serviceBoundaryLeadId, userId: actorId,
    }),
    (error: unknown) => (error as { code?: string }).code === 'COMPANY_DEREGISTERED',
  )
  const [serviceBoundaryRows] = await pool.query<Array<RowDataPacket & { pool_status: string }>>(
    `SELECT pool_status FROM ${leadsTable} WHERE id=?`, [serviceBoundaryLeadId],
  )
  assert.equal(serviceBoundaryRows[0]?.pool_status, '已注销')
  const genericAdmissionLeadId = randomUUID()
  await pool.query(
    `INSERT INTO ${leadsTable}
      (id,name,company_name,industry,pool_status,score,summary,highlights,risks,funding_rounds,risk_tags,sources,
       scoring,radar_source_keys,field_provenance,created_at)
     VALUES (?,?,?,'企业服务','成功',0,'通用入口注销验收',JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),
       JSON_OBJECT('registry',JSON_OBJECT('registrationStatus','登记状态：注销')),JSON_ARRAY(),JSON_OBJECT(),NOW(3))`,
    [genericAdmissionLeadId, '通用入口注销验收企业', '通用入口注销验收企业有限公司'],
  )
  const genericAdmissionEvent = await recordLeadPipelineRawEvent({
    sourceType: 'reserve-import', sourceId: `generic-deregistered-${genericAdmissionLeadId}`,
    payload: { leadId: genericAdmissionLeadId, registrationStatus: '注销' },
  })
  const genericAdmissionTransition = await transitionLeadPipelineItem(genericAdmissionEvent.event.id, {
    status: 'ready', leadId: genericAdmissionLeadId, reason: '隔离验收尝试通用入口正式入池',
    actorType: 'system', actorId: 'mysql-acceptance',
  })
  assert.equal(genericAdmissionTransition.item.status, 'rejected')
  const [genericAdmissionRows] = await pool.query<Array<RowDataPacket & { pool_status: string; jobs: number }>>(
    `SELECT l.pool_status,(SELECT COUNT(*) FROM ${jobsTable} j WHERE j.lead_id=l.id) jobs
     FROM ${leadsTable} l WHERE l.id=?`, [genericAdmissionLeadId],
  )
  assert.equal(genericAdmissionRows[0]?.pool_status, '已注销')
  assert.equal(Number(genericAdmissionRows[0]?.jobs), 0)
  const preAdmissionName = '入池前注销验收企业'
  const preAdmissionEvent = await recordLeadPipelineRawEvent({
    sourceType: 'radar', sourceId: `pre-admission-deregistered-${genericAdmissionLeadId}`,
    payload: { companyName: preAdmissionName, registrationStatus: '注销' },
  })
  await assert.rejects(
    commitRadarLeadPipelineReady({
      lead: {
        name: preAdmissionName, companyName: `${preAdmissionName}有限公司`, source: '项目发现雷达 · 注销准入验收',
        poolStatus: '成功', radarProfile: { registry: { registrationStatus: '登记状态：已注销' } },
      },
      eventId: preAdmissionEvent.event.id,
      transition: {
        reason: '隔离验收尝试将注销企业提交入池', confidence: 100,
        actorType: 'system', actorId: 'mysql-acceptance',
      },
    }),
    (error: unknown) => (error as { code?: string }).code === 'COMPANY_DEREGISTERED',
  )
  const [preAdmissionRows] = await pool.query<Array<RowDataPacket & { leads: number; jobs: number; status: string }>>(
    `SELECT (SELECT COUNT(*) FROM ${leadsTable} WHERE name=?) leads,
       (SELECT COUNT(*) FROM ${jobsTable} WHERE lead_id IN (SELECT id FROM ${leadsTable} WHERE name=?)) jobs,
       status FROM ${pipelineItemsTable} WHERE event_id=?`,
    [preAdmissionName, preAdmissionName, preAdmissionEvent.event.id],
  )
  assert.equal(Number(preAdmissionRows[0]?.leads), 0)
  assert.equal(Number(preAdmissionRows[0]?.jobs), 0)
  assert.equal(preAdmissionRows[0]?.status, 'rejected')
  const entityConfirmationLeadId = randomUUID()
  await pool.query(
    `INSERT INTO ${leadsTable}
      (id,name,company_name,industry,pool_status,score,summary,highlights,risks,funding_rounds,risk_tags,sources,
       radar_profile,radar_source_keys,field_provenance,created_at)
     VALUES (?,?,?,'企业服务','成功',0,'主体歧义人工确认验收',JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),
       JSON_OBJECT('qualityRejected',false),JSON_ARRAY(),JSON_OBJECT(),NOW(3))`,
    [entityConfirmationLeadId, '主体歧义确认验收品牌', '待确认主体有限公司'],
  )
  const entityConfirmationJob = await enqueueLeadEnrichmentJob({
    leadId: entityConfirmationLeadId,
    triggerType: 'mysql-entity-confirmation-acceptance',
    idempotencyToken: 'mysql-entity-confirmation-acceptance',
  })
  assert.equal(entityConfirmationJob.queued, true)
  const [entityConfirmationJobs] = await pool.query<Array<RowDataPacket & { entity_id: string }>>(
    `SELECT entity_id FROM ${jobsTable} WHERE id=?`, [entityConfirmationJob.jobId],
  )
  const entityConfirmationEntityId = entityConfirmationJobs[0]?.entity_id
  assert(entityConfirmationEntityId)
  await pool.query(`UPDATE ${jobsTable} SET entity_type='unknown',entity_status='ambiguous',status='review',completed_at=NOW(3) WHERE id=?`, [entityConfirmationJob.jobId])
  await pool.query(`UPDATE ${entitiesTable} SET entity_type='unknown',status='ambiguous' WHERE id=?`, [entityConfirmationEntityId])
  await pool.query(
    `UPDATE ${topicRunsTable}
     SET status='review',execution_attempts=2,metrics=JSON_OBJECT('reason','entity_confirmation_required'),completed_at=NOW(3)
     WHERE job_id=? AND topic_key IN ('financing','ownership')`, [entityConfirmationJob.jobId],
  )
  await pool.query(
    `UPDATE ${topicRunsTable}
     SET status='review',execution_attempts=1,metrics=JSON_OBJECT('reason','evidence_conflict'),completed_at=NOW(3)
     WHERE job_id=? AND topic_key='competition'`, [entityConfirmationJob.jobId],
  )
  await assert.rejects(
    confirmLeadEnrichmentEntity({
      leadId: entityConfirmationLeadId,
      canonicalName: '杭州主体确认科技有限公司',
      reason: '未知主体缺少类型时必须拒绝确认',
      actor: { userId: actorId, userName: '隔离验收管理员' },
    }),
    (error: unknown) => (error as { code?: string }).code === 'ENTITY_TYPE_REQUIRED',
  )
  const entityConfirmed = await confirmLeadEnrichmentEntity({
    leadId: entityConfirmationLeadId,
    canonicalName: '杭州主体确认科技有限公司',
    entityType: 'company',
    identifiers: { creditCode: '91330100CONFIRMED01', websiteDomain: 'https://www.confirmed.example.com/path' },
    reason: '隔离验收管理员依据统一信用代码和官网域名确认主体',
    actor: { userId: actorId, userName: '隔离验收管理员' },
  })
  assert.equal(entityConfirmed.alreadyConfirmed, false)
  assert.equal(entityConfirmed.resumedTopics, 2)
  assert.equal(entityConfirmed.entity.identifiers.creditCode, '91330100CONFIRMED01')
  assert.equal(entityConfirmed.entity.identifiers.websiteDomain, 'confirmed.example.com')
  const [confirmedJobRows] = await pool.query<Array<RowDataPacket & { status: string; entity_type: string; entity_status: string }>>(
    `SELECT status,entity_type,entity_status FROM ${jobsTable} WHERE id=?`, [entityConfirmationJob.jobId],
  )
  assert.equal(confirmedJobRows[0]?.status, 'queued')
  assert.equal(confirmedJobRows[0]?.entity_type, 'company')
  assert.equal(confirmedJobRows[0]?.entity_status, 'confirmed')
  const [confirmedTopicRows] = await pool.query<Array<RowDataPacket & {
    topic_key: string; status: string; execution_attempts: number; metrics: unknown
  }>>(
    `SELECT topic_key,status,execution_attempts,metrics FROM ${topicRunsTable}
     WHERE job_id=? AND topic_key IN ('financing','ownership','competition') ORDER BY topic_key`,
    [entityConfirmationJob.jobId],
  )
  assert.equal(confirmedTopicRows.filter((row) => row.status === 'queued').length, 2)
  assert.equal(confirmedTopicRows.find((row) => row.topic_key === 'competition')?.status, 'review')
  assert(confirmedTopicRows.filter((row) => row.status === 'queued').every((row) => Number(row.execution_attempts) === 2))
  const confirmationMetrics = typeof confirmedTopicRows.find((row) => row.status === 'queued')?.metrics === 'string'
    ? JSON.parse(String(confirmedTopicRows.find((row) => row.status === 'queued')?.metrics))
    : confirmedTopicRows.find((row) => row.status === 'queued')?.metrics
  assert.equal(confirmationMetrics?.entityConfirmations?.[0]?.previousEntityStatus, 'ambiguous')
  assert.equal(confirmationMetrics?.entityConfirmations?.[0]?.attempts, 2)
  const entityConfirmationReplay = await confirmLeadEnrichmentEntity({
    leadId: entityConfirmationLeadId,
    canonicalName: '杭州主体确认科技有限公司',
    reason: '重复提交应幂等返回已确认状态',
    actor: { userId: actorId, userName: '隔离验收管理员' },
  })
  assert.equal(entityConfirmationReplay.alreadyConfirmed, true)
  const [entityConfirmationAudits] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${auditLogsTable} WHERE action='人工确认联网补全主体' AND target LIKE ?`,
    [`%${entityConfirmationLeadId}%`],
  )
  assert.equal(Number(entityConfirmationAudits[0]?.count), 1)
  const batchRetryLeadId = randomUUID()
  await pool.query(
    `INSERT INTO ${leadsTable}
      (id,name,company_name,industry,pool_status,score,summary,highlights,risks,funding_rounds,risk_tags,sources,
       scoring,radar_profile,radar_source_keys,field_provenance,created_at)
     VALUES (?,?,?,'企业服务','成功',0,'历史批次错误分类重试验收',JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),
       JSON_OBJECT('registry',JSON_OBJECT('registrationStatus','存续')),
       JSON_OBJECT('qualityRejected',false),JSON_ARRAY(),JSON_OBJECT(),NOW(3))`,
    [batchRetryLeadId, '历史批次错误分类重试验收企业', '历史批次错误分类重试验收企业有限公司'],
  )
  const batchRetryJob = await enqueueLeadEnrichmentJob({
    leadId: batchRetryLeadId,
    triggerType: 'historical-backfill:mysql-retry-acceptance',
    idempotencyToken: 'mysql-retry-acceptance',
  })
  assert.equal(batchRetryJob.queued, true)
  await pool.query(
    `UPDATE ${topicRunsTable}
     SET status='dead_letter',execution_attempts=3,last_error='isolated network failure',
         metrics=JSON_OBJECT('errorClass','network'),completed_at=NOW(3),updated_at=NOW(3)
     WHERE job_id=? AND topic_key='financing'`,
    [batchRetryJob.jobId],
  )
  await pool.query(
    `UPDATE ${jobsTable} SET status='review',last_error='isolated network failure',completed_at=NOW(3),updated_at=NOW(3)
     WHERE id=?`,
    [batchRetryJob.jobId],
  )
  for (const forbiddenTool of ['WebSearch', 'WebFetch'] as const) {
    const rawEvent = await recordLeadPipelineRawEvent({
      sourceType: 'acceptance', sourceId: `forbidden-score-tool-${forbiddenTool}`,
      payload: { leadId: prerequisiteLeadId, forbiddenTool },
    })
    const queryFactory: LeadScoringAgentQueryFactory = (params) => (async function* () {
      await params.options?.canUseTool?.(
        forbiddenTool,
        forbiddenTool === 'WebSearch' ? { query: 'must be denied' } : { url: 'https://example.org/must-be-denied' },
        { signal: new AbortController().signal, toolUseID: `forbidden-${forbiddenTool.toLowerCase()}` },
      )
    })()
    const agentRunner = async (input: Parameters<typeof runLeadScoringAgent>[0]): Promise<LeadScoringAgentExecution> => (
      await runLeadScoringAgent(input, { queryFactory, timeoutMs: 5_000 })
    )
    await assert.rejects(
      scoreWithAgentDetailed(LEAD_RATING_V3_WORKFLOW, {
        projectName: '评分Agent禁用联网工具隔离验收',
      }, {
        agentRunner, primaryModel: 'acceptance-forbidden-tool-model', fallbackModel: 'acceptance-forbidden-tool-model',
        audit: {
          eventIds: [rawEvent.event.id], inputEventId: rawEvent.event.id,
          entityType: 'lead', leadId: prerequisiteLeadId,
        },
      }),
      new RegExp(`attempted forbidden tool: ${forbiddenTool}`),
    )
  }
  const [forbiddenRunRows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${pipelineRunsTable}
     WHERE agent_profile='lead-scoring-agent' AND status='failed' AND error LIKE '%attempted forbidden tool:%'`,
  )
  assert.equal(Number(forbiddenRunRows[0]?.count), 2)
  const [forbiddenDecisionRows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${pipelineDecisionsTable}
     WHERE decision_type='lead_rating_v3' AND outcome='failed' AND reason LIKE '%forbidden tool:%'`,
  )
  assert.equal(Number(forbiddenDecisionRows[0]?.count), 2)
  await pool.query(
    `UPDATE ${topicRunsTable} SET next_attempt_at=DATE_ADD(NOW(3),INTERVAL 1 DAY)
     WHERE status IN ('queued','retrying')`,
  )
  const leaseRecoveryLeadId = randomUUID()
  await pool.query(
    `INSERT INTO ${leadsTable}
      (id,name,company_name,industry,pool_status,score,summary,highlights,risks,funding_rounds,risk_tags,sources,
       radar_profile,radar_source_keys,field_provenance,created_at)
     VALUES (?,?,?,'企业服务','成功',0,'过期租约恢复验收',JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),
       JSON_OBJECT('qualityRejected',false),JSON_ARRAY(),JSON_OBJECT(),NOW(3))`,
    [leaseRecoveryLeadId, '过期租约恢复验收企业', '过期租约恢复验收企业有限公司'],
  )
  const leaseRecoveryJob = await enqueueLeadEnrichmentJob({
    leadId: leaseRecoveryLeadId, triggerType: 'mysql-lease-recovery-acceptance',
    idempotencyToken: 'mysql-lease-recovery-acceptance', priority: 1,
  })
  assert.equal(leaseRecoveryJob.queued, true)
  await pool.query(
    `UPDATE ${topicRunsTable}
     SET status=IF(topic_key='basic_profile','running','not_applicable'),
         lease_owner=IF(topic_key='basic_profile','stale-worker',NULL),
         lease_expires_at=IF(topic_key='basic_profile',DATE_SUB(NOW(3),INTERVAL 1 MINUTE),NULL),
         next_attempt_at=NOW(3),completed_at=IF(topic_key='basic_profile',NULL,NOW(3))
     WHERE job_id=?`, [leaseRecoveryJob.jobId],
  )
  await pool.query(
    `UPDATE ${jobsTable} SET status='running',lease_owner='stale-worker',
       lease_expires_at=DATE_SUB(NOW(3),INTERVAL 1 MINUTE) WHERE id=?`, [leaseRecoveryJob.jobId],
  )
  assert.equal(await recoverExpiredLeadEnrichmentLeases(), 1)
  const [recoveredLeaseRows] = await pool.query<Array<RowDataPacket & { status: string; metrics: unknown }>>(
    `SELECT status,metrics FROM ${topicRunsTable} WHERE job_id=? AND topic_key='basic_profile'`, [leaseRecoveryJob.jobId],
  )
  const recoveredLeaseMetrics = typeof recoveredLeaseRows[0]?.metrics === 'string'
    ? JSON.parse(recoveredLeaseRows[0].metrics) : recoveredLeaseRows[0]?.metrics
  assert.equal(recoveredLeaseRows[0]?.status, 'retrying')
  assert.equal(recoveredLeaseMetrics?.lastLeaseDisposition, 'abandoned')
  const concurrentClaims = await Promise.all([
    claimLeadEnrichmentTopicLease(), claimLeadEnrichmentTopicLease(),
  ])
  assert.equal(concurrentClaims.filter((claim) => claim?.job_id === leaseRecoveryJob.jobId).length, 1)
  assert.equal(concurrentClaims.filter(Boolean).length, 1)

  const repeatableLeadId = randomUUID()
  await pool.query(
    `INSERT INTO ${leadsTable}
      (id,name,company_name,industry,pool_status,score,summary,highlights,risks,funding_rounds,risk_tags,sources,
       radar_profile,radar_source_keys,field_provenance,created_at)
     VALUES (?,?,?,'企业服务','成功',0,'可重复事实验收',JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),
       JSON_OBJECT('qualityRejected',false),JSON_ARRAY(),JSON_OBJECT(),NOW(3))`,
    [repeatableLeadId, '多轮融资事实验收企业', '多轮融资事实验收企业有限公司'],
  )
  const repeatableJob = await enqueueLeadEnrichmentJob({
    leadId: repeatableLeadId, triggerType: 'mysql-repeatable-facts-acceptance',
    idempotencyToken: 'mysql-repeatable-facts-acceptance', priority: 1,
  })
  assert.equal(repeatableJob.queued, true)
  const [repeatableJobRows] = await pool.query<Array<RowDataPacket & { entity_id: string }>>(
    `SELECT entity_id FROM ${jobsTable} WHERE id=?`, [repeatableJob.jobId],
  )
  const [repeatableTopicRows] = await pool.query<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM ${topicRunsTable} WHERE job_id=? AND topic_key='financing'`, [repeatableJob.jobId],
  )
  const repeatableSourceText = '公司于2024年完成A轮融资1亿元。\n公司于2025年完成B轮融资2亿元。\n另一来源称公司于2025年完成B轮融资3亿元。'
  const repeatableSourceHash = createHash('sha256').update(repeatableSourceText).digest('hex')
  const repeatableSourceId = randomUUID()
  await pool.query(
    `INSERT INTO ${sourceDocumentsTable}
      (id,lead_id,canonical_url,canonical_url_hash,final_url,fetch_status,http_status,content_type,title,publisher,
       content_hash,extracted_text,accessed_at,expires_at,created_at)
     VALUES (?,?,?,?,?,'ready',200,'text/plain','多轮融资验收来源','验收夹具',?,?,NOW(3),DATE_ADD(NOW(3),INTERVAL 1 HOUR),NOW(3))`,
    [repeatableSourceId, repeatableLeadId, 'https://example.com/repeatable-financing',
      createHash('sha256').update('https://example.com/repeatable-financing').digest('hex'),
      'https://example.com/repeatable-financing', repeatableSourceHash, repeatableSourceText],
  )
  const persistRepeatableAmount = async (
    instanceKey: string,
    value: string,
    quote: string,
    source: { id: string; url: string; hash: string } = {
      id: repeatableSourceId, url: 'https://example.com/repeatable-financing', hash: repeatableSourceHash,
    },
    conflictReason = '',
  ) => await persistLeadFact({
    leadId: repeatableLeadId, topicRunId: repeatableTopicRows[0]?.id, topicKey: 'financing',
    subjectType: 'company', subjectId: repeatableJobRows[0]!.entity_id,
    factKey: 'financing.amount', instanceKey, value, unit: '亿元', currency: 'CNY',
    periodStart: instanceKey.slice(0, 4), periodEnd: instanceKey.slice(0, 4), scope: '已完成融资',
    conflictReason,
    evidenceLevel: 'E2', verificationStatus: 'verified',
    evidence: [{
      sourceUrl: source.url, sourceDocumentId: source.id,
      sourceType: 'acceptance_fixture', quote, reliability: 'E2', pageHash: source.hash,
    }],
  })
  await persistRepeatableAmount('2024 A轮', '1亿元', '公司于2024年完成A轮融资1亿元')
  await persistRepeatableAmount('2025 B轮', '2亿元', '公司于2025年完成B轮融资2亿元')
  await pool.query(
    `UPDATE ${topicRunsTable} SET status='completed',completed_at=NOW(3),updated_at=NOW(3) WHERE job_id=?`,
    [repeatableJob.jobId],
  )
  await pool.query(
    `UPDATE ${jobsTable} SET entity_status='confirmed',status='running',updated_at=NOW(3) WHERE id=?`,
    [repeatableJob.jobId],
  )
  const repeatableSnapshot = await freezeLeadEnrichmentSnapshot(repeatableJob.jobId!)
  const repeatedAmounts = repeatableSnapshot.snapshot.facts.filter((fact) => fact.factKey === 'financing.amount')
  assert.equal(repeatedAmounts.length, 2)
  assert.deepEqual(repeatedAmounts.map((fact) => fact.instanceKey).sort(), ['2024 a轮', '2025 b轮'])
  const conflictingRepeatableText = '另一来源称公司于2025年完成B轮融资3亿元。'
  const conflictingRepeatableHash = createHash('sha256').update(conflictingRepeatableText).digest('hex')
  const conflictingRepeatableSourceId = randomUUID()
  const conflictingRepeatableUrl = 'https://example.org/repeatable-financing-conflict'
  await pool.query(
    `INSERT INTO ${sourceDocumentsTable}
      (id,lead_id,canonical_url,canonical_url_hash,final_url,fetch_status,http_status,content_type,title,publisher,
       content_hash,extracted_text,accessed_at,expires_at,created_at)
     VALUES (?,?,?,?,?,'ready',200,'text/plain','B轮融资冲突验收来源','验收夹具',?,?,NOW(3),DATE_ADD(NOW(3),INTERVAL 1 HOUR),NOW(3))`,
    [conflictingRepeatableSourceId, repeatableLeadId, conflictingRepeatableUrl,
      createHash('sha256').update(conflictingRepeatableUrl).digest('hex'), conflictingRepeatableUrl,
      conflictingRepeatableHash, conflictingRepeatableText],
  )
  const declaredConflictReason = '两份来源对B轮融资金额披露不一致'
  const sameInstanceConflict = await persistRepeatableAmount(
    ' 2025  B轮 ', '3亿元', '另一来源称公司于2025年完成B轮融资3亿元',
    { id: conflictingRepeatableSourceId, url: conflictingRepeatableUrl, hash: conflictingRepeatableHash },
    declaredConflictReason,
  )
  assert.equal(sameInstanceConflict.conflicted, true)
  const repeatableFacts = await listLeadEnrichmentFacts({ leadId: repeatableLeadId, topicKey: 'financing' })
  assert.equal(repeatableFacts.total, 2)
  assert.deepEqual(repeatableFacts.facts.map((fact) => fact.instanceKey).sort(), ['2024 a轮', '2025 b轮'])
  const repeatableConflicts = await listLeadEnrichmentConflicts(repeatableLeadId)
  assert.equal(repeatableConflicts.length, 1)
  assert.equal(repeatableConflicts[0]?.instanceKey, '2025 b轮')
  assert.equal(repeatableConflicts[0]?.candidateFactIds.length, 2)
  assert.equal(repeatableConflicts[0]?.automaticReason, declaredConflictReason)
  assert.equal(repeatableConflicts[0]?.candidates.length, 2)
  assert(repeatableConflicts[0]?.candidates.every((candidate) => candidate.evidence.length === 1))
  assert.equal(new Set(repeatableConflicts[0]?.candidates.flatMap((candidate) => (
    candidate.evidence.map((evidence) => evidence.sourceUrl)
  ))).size, 2)

  const realtimePriorityLeadId = randomUUID()
  const historicalPriorityLeadId = randomUUID()
  for (const [priorityLeadId, name] of [
    [realtimePriorityLeadId, '实时优先级验收企业'],
    [historicalPriorityLeadId, '历史回补优先级验收企业'],
  ]) {
    await pool.query(
      `INSERT INTO ${leadsTable}
        (id,name,company_name,industry,pool_status,score,summary,highlights,risks,funding_rounds,risk_tags,sources,
         radar_profile,radar_source_keys,field_provenance,created_at)
       VALUES (?,?,?,'企业服务','成功',0,'优先级隔离验收',JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),
         JSON_OBJECT('qualityRejected',false),JSON_ARRAY(),JSON_OBJECT(),NOW(3))`,
      [priorityLeadId, name, `${name}有限公司`],
    )
  }
  const historicalPriorityJob = await enqueueLeadEnrichmentJob({
    leadId: historicalPriorityLeadId, triggerType: 'historical-backfill:mysql-priority-acceptance',
    idempotencyToken: 'mysql-priority-acceptance', priority: 500,
  })
  const realtimePriorityJob = await enqueueLeadEnrichmentJob({
    leadId: realtimePriorityLeadId, triggerType: 'pipeline-ready',
    idempotencyToken: 'mysql-priority-acceptance', priority: 20,
  })
  for (const priorityJob of [historicalPriorityJob, realtimePriorityJob]) {
    await pool.query(
      `UPDATE ${topicRunsTable}
       SET status=IF(topic_key='basic_profile','queued','not_applicable'),next_attempt_at=NOW(3),
           completed_at=IF(topic_key='basic_profile',NULL,NOW(3)) WHERE job_id=?`, [priorityJob.jobId],
    )
  }
  const priorityClaim = await claimLeadEnrichmentTopicLease()
  assert.equal(priorityClaim?.job_id, realtimePriorityJob.jobId)

  const entityGraphLeadId = randomUUID()
  await pool.query(
    `INSERT INTO ${leadsTable}
      (id,name,company_name,industry,pool_status,score,summary,highlights,risks,funding_rounds,risk_tags,sources,
       radar_profile,radar_source_keys,field_provenance,created_at)
     VALUES (?,?,?,'企业服务','成功',0,'实体关系图隔离验收',JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),
       JSON_OBJECT('qualityRejected',false,'projectName','火种图谱项目','teamName','火种图谱核心团队',
         'aiSubjectReview',JSON_OBJECT('subjectType','project')),
       JSON_ARRAY(),JSON_OBJECT(),NOW(3))`,
    [entityGraphLeadId, '火种图谱项目', '火种图谱运营有限公司'],
  )
  const entityGraphJob = await enqueueLeadEnrichmentJob({
    leadId: entityGraphLeadId, triggerType: 'mysql-entity-graph-acceptance',
    idempotencyToken: 'mysql-entity-graph-acceptance', priority: 999,
  })
  assert.equal(entityGraphJob.queued, true)
  assert.equal(entityGraphJob.entityType, 'project')
  const [entityGraphEntities] = await pool.query<Array<RowDataPacket & {
    id: string; entity_type: string; canonical_name: string; aliases: unknown;
  }>>(
    `SELECT id,entity_type,canonical_name,aliases FROM ${entitiesTable} WHERE lead_id=? ORDER BY entity_type`,
    [entityGraphLeadId],
  )
  assert.deepEqual(entityGraphEntities.map((entity) => entity.entity_type), ['company', 'project', 'team'])
  const companyGraphEntity = entityGraphEntities.find((entity) => entity.entity_type === 'company')!
  const projectGraphEntity = entityGraphEntities.find((entity) => entity.entity_type === 'project')!
  const companyGraphAliases = typeof companyGraphEntity.aliases === 'string'
    ? JSON.parse(companyGraphEntity.aliases) : companyGraphEntity.aliases
  assert.equal(companyGraphAliases.includes('火种图谱项目'), false)
  const [entityGraphRelations] = await pool.query<Array<RowDataPacket & {
    relation_type: string; from_type: string; to_type: string;
  }>>(
    `SELECT r.relation_type,source.entity_type from_type,target.entity_type to_type
     FROM ${entityRelationsTable} r
     JOIN ${entitiesTable} source ON source.id=r.from_entity_id
     JOIN ${entitiesTable} target ON target.id=r.to_entity_id
     WHERE r.lead_id=? ORDER BY r.relation_type`,
    [entityGraphLeadId],
  )
  assert(entityGraphRelations.some((relation) => (
    relation.relation_type === 'operated_by' && relation.from_type === 'project' && relation.to_type === 'company'
  )))
  assert(entityGraphRelations.some((relation) => (
    relation.relation_type === 'core_team_of' && relation.from_type === 'team' && relation.to_type === 'project'
  )))
  const relationEvidenceText = '火种图谱项目由火种图谱运营有限公司负责运营。'
  const relationEvidenceHash = createHash('sha256').update(relationEvidenceText).digest('hex')
  const relationEvidenceDocumentId = randomUUID()
  const relationEvidenceUrl = 'https://example.com/entity-relation-evidence'
  await pool.query(
    `INSERT INTO ${sourceDocumentsTable}
      (id,lead_id,canonical_url,canonical_url_hash,final_url,fetch_status,http_status,content_type,title,publisher,
       content_hash,extracted_text,accessed_at,expires_at,created_at)
     VALUES (?,?,?,?,?,'ready',200,'text/plain','实体关系验收来源','验收夹具',?,?,NOW(3),DATE_ADD(NOW(3),INTERVAL 1 HOUR),NOW(3))`,
    [relationEvidenceDocumentId, entityGraphLeadId, relationEvidenceUrl,
      createHash('sha256').update(relationEvidenceUrl).digest('hex'), relationEvidenceUrl,
      relationEvidenceHash, relationEvidenceText],
  )
  const [entityGraphTopicRows] = await pool.query<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM ${topicRunsTable} WHERE job_id=? AND topic_key='basic_profile' LIMIT 1`, [entityGraphJob.jobId],
  )
  const relationFact = await persistLeadFact({
    leadId: entityGraphLeadId, topicRunId: entityGraphTopicRows[0]?.id, topicKey: 'basic_profile',
    subjectType: 'project', subjectId: projectGraphEntity.id,
    factKey: 'profile.operating_company', value: '火种图谱运营有限公司',
    evidenceLevel: 'E2', verificationStatus: 'verified',
    evidence: [{
      sourceUrl: relationEvidenceUrl, sourceDocumentId: relationEvidenceDocumentId,
      sourceType: 'acceptance_fixture', quote: relationEvidenceText,
      reliability: 'E2', pageHash: relationEvidenceHash,
    }],
  })
  const [evidenceBoundRelations] = await pool.query<Array<RowDataPacket & {
    status: string; evidence_fact_id: string | null;
  }>>(
    `SELECT status,evidence_fact_id FROM ${entityRelationsTable}
     WHERE lead_id=? AND relation_type='operated_by' LIMIT 1`, [entityGraphLeadId],
  )
  assert.equal(evidenceBoundRelations[0]?.status, 'confirmed')
  assert.equal(evidenceBoundRelations[0]?.evidence_fact_id, relationFact.factId)
  const entityGraphStatus = await getLeadEnrichmentStatus(entityGraphLeadId)
  assert.equal(entityGraphStatus.entities.length, 3)
  assert(entityGraphStatus.relations.some((relation) => (
    relation.relationType === 'operated_by' && relation.evidenceFactId === relationFact.factId
  )))
  const replacementCompanyId = randomUUID()
  await pool.query(
    `INSERT INTO ${entitiesTable}
      (id,lead_id,entity_type,canonical_name,normalized_name,status,aliases,identifiers,created_at,updated_at)
     VALUES (?,?,'company','火种图谱新运营有限公司','火种图谱新运营有限公司','confirmed',JSON_ARRAY('火种新运营'),JSON_OBJECT(),NOW(3),NOW(3))`,
    [replacementCompanyId, entityGraphLeadId],
  )
  const replacementEvidenceText = '工商与项目公告确认火种图谱项目现由火种图谱新运营有限公司负责运营。'
  const replacementEvidenceHash = createHash('sha256').update(replacementEvidenceText).digest('hex')
  const replacementDocumentId = randomUUID()
  const replacementEvidenceUrl = 'https://example.gov.cn/entity-relation-replacement'
  await pool.query(
    `INSERT INTO ${sourceDocumentsTable}
      (id,lead_id,canonical_url,canonical_url_hash,final_url,fetch_status,http_status,content_type,title,publisher,
       content_hash,extracted_text,accessed_at,expires_at,created_at)
     VALUES (?,?,?,?,?,'ready',200,'text/plain','运营主体变更验收来源','验收夹具',?,?,NOW(3),DATE_ADD(NOW(3),INTERVAL 1 HOUR),NOW(3))`,
    [replacementDocumentId, entityGraphLeadId, replacementEvidenceUrl,
      createHash('sha256').update(replacementEvidenceUrl).digest('hex'), replacementEvidenceUrl,
      replacementEvidenceHash, replacementEvidenceText],
  )
  const replacementFact = await persistLeadFact({
    leadId: entityGraphLeadId, topicRunId: entityGraphTopicRows[0]?.id, topicKey: 'basic_profile',
    subjectType: 'project', subjectId: projectGraphEntity.id,
    factKey: 'profile.operating_company', value: '火种图谱新运营有限公司',
    evidenceLevel: 'E1', verificationStatus: 'verified',
    evidence: [{
      sourceUrl: replacementEvidenceUrl, sourceDocumentId: replacementDocumentId,
      sourceType: 'acceptance_fixture', quote: replacementEvidenceText,
      reliability: 'E1', pageHash: replacementEvidenceHash,
    }],
  })
  const [versionedRelationRows] = await pool.query<Array<RowDataPacket & {
    to_entity_id: string; status: string; evidence_fact_id: string | null;
  }>>(
    `SELECT to_entity_id,status,evidence_fact_id FROM ${entityRelationsTable}
     WHERE lead_id=? AND relation_type='operated_by' ORDER BY status,to_entity_id`, [entityGraphLeadId],
  )
  assert(versionedRelationRows.some((relation) => (
    relation.to_entity_id === companyGraphEntity.id && relation.status === 'superseded'
  )))
  assert(versionedRelationRows.some((relation) => (
    relation.to_entity_id === replacementCompanyId && relation.status === 'confirmed'
      && relation.evidence_fact_id === replacementFact.factId
  )))
  const currentEntityGraphStatus = await getLeadEnrichmentStatus(entityGraphLeadId)
  assert.equal(currentEntityGraphStatus.relations.filter((relation) => relation.relationType === 'operated_by').length, 1)
  assert.equal(currentEntityGraphStatus.relations.find((relation) => relation.relationType === 'operated_by')?.to.id, replacementCompanyId)
  console.log(JSON.stringify({
    ok: true,
    checks: [
      'idempotent-job-and-thirteen-topics',
      'v3-scoring-without-snapshot-enqueues-enrichment-prerequisite-only',
      'provider-billing-retries-dead-letter-before-reclaim',
      'auditable-topic-phase-transitions',
      'entity-bound-versioned-facts-and-evidence',
      'company-entity-identifiers-and-aliases-merge-without-history-loss',
      'immutable-snapshot-hash-replay',
      'snapshot-bound-investment-profile-projection-is-idempotent',
      'deleted-investment-profile-rebuilds-from-frozen-snapshot-and-second-rebuild-is-noop',
      'unchanged-facts-across-new-topic-runs-reuse-snapshot-and-rating-binding',
      'snapshot-bound-single-v3-job',
      'atomic-idempotent-v3-rating-history',
      'admin-audited-rating-history-restore',
      'subject-topic-prompt-query-search-cache',
      'paginated-fact-and-source-read-api',
      'verified-detail-projection-excludes-unverified-and-audit-payload',
      'snapshot-introductions-project-direct-public-sources-without-audit-payload',
      'admin-operational-metrics',
      'same-level-conflict-candidates-and-transactional-resolution',
      'dismissed-conflict-candidates-leave-current-fact-set-but-retain-history',
      'admin-audited-manual-retry-preserves-attempt-history',
      'deregistered-lead-evicts-all-pending-jobs-without-deleting-evidence',
      'inactive-deregistered-job-cannot-freeze-snapshot-or-requeue-score',
      'public-intel-commit-boundary-cannot-admit-deregistered-company',
      'generic-pipeline-ready-boundary-rejects-known-deregistered-company-without-creating-job',
      'deregistered-radar-candidate-is-rejected-before-formal-lead-insert',
      'admin-confirms-ambiguous-entity-and-resumes-only-identity-blocked-topics',
      'scoring-agent-web-search-and-fetch-are-denied-and-audited',
      'expired-topic-and-job-leases-recover-and-concurrent-claim-is-single-winner',
      'repeatable-fact-instances-coexist-and-conflict-only-within-the-same-instance',
      'realtime-enrichment-priority-precedes-historical-backfill',
      'project-company-team-entities-and-relations-remain-separate',
      'verified-relation-fact-binds-directional-entity-relation-and-status-api-projects-graph',
      'superseded-relation-evidence-is-retained-but-excluded-from-current-projection',
    ],
  }))
}

await main().finally(() => pool.end())
