import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  LEAD_ENRICHMENT_SCHEMA_VERSION,
  LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS,
  LEAD_ENRICHMENT_TOPIC_KEYS,
  classifyPaperContent,
  initialTopicStates,
  leadEnrichmentRuntimePolicy,
  normalizePaperIdentity,
} from '../services/leadEnrichmentContract.js'
import { buildLeadEnrichmentSnapshot, validateLeadFactCandidate } from '../services/leadEnrichmentService.js'
import { leadTopicResearchContract } from '../services/leadTopicWebResearchService.js'
import { companyRegistrationEligibility } from '../services/leadRegistry.js'

const root = process.cwd()
const [migration, instanceMigration, eventService, enrichmentService, worker, retryPolicy, circuitBreaker, evidenceClassification, conflictDetection, sourceSubjectMatch, publicIntelService, scoreService, routes, serverEntry, sourceDocuments, detailPage, systemPage, backfill, summaryService, intakeService, reserveIntakeService, reviewService, topicResearch, codexCliResearch, codexWorkerRunner, envExample] = await Promise.all([
  readFile(`${root}/server/drizzle/0047_add_lead_enrichment_evidence.sql`, 'utf8'),
  readFile(`${root}/server/drizzle/0049_add_lead_fact_instance_keys.sql`, 'utf8'),
  readFile(`${root}/server/src/services/leadPipelineEventService.ts`, 'utf8'),
  readFile(`${root}/server/src/services/leadEnrichmentService.ts`, 'utf8'),
  readFile(`${root}/server/src/services/leadEnrichmentWorkerService.ts`, 'utf8'),
  readFile(`${root}/server/src/services/leadEnrichmentRetryPolicy.ts`, 'utf8'),
  readFile(`${root}/server/src/services/leadEnrichmentCircuitBreaker.ts`, 'utf8'),
  readFile(`${root}/server/src/services/leadEvidenceClassificationService.ts`, 'utf8'),
  readFile(`${root}/server/src/services/leadFactConflictDetectionService.ts`, 'utf8'),
  readFile(`${root}/server/src/services/leadSourceSubjectMatchService.ts`, 'utf8'),
  readFile(`${root}/server/src/services/leadPublicIntelService.ts`, 'utf8'),
  readFile(`${root}/server/src/services/leadScoreJobService.ts`, 'utf8'),
  readFile(`${root}/server/src/routes/meta.ts`, 'utf8'),
  readFile(`${root}/server/src/index.ts`, 'utf8'),
  readFile(`${root}/server/src/services/leadSourceDocumentService.ts`, 'utf8'),
  readFile(`${root}/src/pages/LeadDetailPage.tsx`, 'utf8'),
  readFile(`${root}/src/pages/SystemPage.tsx`, 'utf8'),
  readFile(`${root}/server/src/scripts/backfillLeadEnrichment.ts`, 'utf8'),
  readFile(`${root}/server/src/services/aiSummaryService.ts`, 'utf8'),
  readFile(`${root}/server/src/services/leadIntakeService.ts`, 'utf8'),
  readFile(`${root}/server/src/services/leadReserveIntakeService.ts`, 'utf8'),
  readFile(`${root}/server/src/services/leadPipelineReviewService.ts`, 'utf8'),
  readFile(`${root}/server/src/services/leadTopicWebResearchService.ts`, 'utf8'),
  readFile(`${root}/server/src/services/codexCliWebSearchService.ts`, 'utf8'),
  readFile(`${root}/server/src/scripts/runLeadEnrichmentCodexWorker.ts`, 'utf8'),
  readFile(`${root}/.env.example`, 'utf8'),
])

for (const table of [
  'lead_entities', 'lead_entity_relations', 'lead_enrichment_jobs', 'lead_enrichment_topic_runs', 'lead_topic_search_cache', 'lead_facts', 'lead_fact_evidence',
  'lead_source_documents', 'lead_fact_conflicts', 'lead_enrichment_snapshots',
  'lead_rating_history',
]) assert.match(migration, new RegExp('CREATE TABLE `sbl_' + table + '`'))
assert.match(migration, /snapshot_hash/)
assert.match(migration, /rating_schema_version/)
assert.match(instanceMigration, /instance_key/)
assert.match(instanceMigration, /uq_lead_facts_instance_version/)
assert.equal(LEAD_ENRICHMENT_TOPIC_KEYS.length, 13)
assert.equal(LEAD_ENRICHMENT_SCHEMA_VERSION, 'lead-enrichment-v3')
assert.deepEqual(LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS, [
  'basic_profile', 'financing', 'team', 'products', 'latest_developments',
])
assert.match(eventService, /enqueueLeadEnrichmentJob/)
assert.match(eventService, /lead-scoring-input.*project-scoring-input/s)
assert.match(eventService, /company_deregistered/)
assert.match(eventService, /'ready','rejected'/)
assert.match(worker, /researchLeadTopicWithWeb/)
assert.match(worker, /fetchLeadSourceDocument/)
assert.match(worker, /sourceDocumentContainsQuote/)
assert.match(worker, /sourceDocumentId: document\.id/)
assert.match(worker, /excludeDeregisteredLeadFromPool/)
assert.match(worker, /lease_owner=\?/)
assert.match(worker, /recordTopicPhase/)
assert.match(worker, /leadEnrichmentRetryDecision/)
assert.match(worker, /classifyLeadWebEvidence/)
assert.match(worker, /leadSourceSupportsSubject/)
assert.match(worker, /detectLeadCandidateFactConflicts/)
assert.match(worker, /leadEnrichmentCircuitBreaker/)
assert.match(worker, /quarantineProviderBudgetLeadEnrichmentRetries/)
assert.match(worker, /provider_billing_dead_letter_on_startup/)
assert.match(worker, /isLeadEnrichmentProviderBudgetError\(error\) \? 'billing'/)
assert.match(worker, /not_rendered_on_lead_detail/)
assert.match(worker, /polling = current[\s\S]*if \(polling === current\) polling = undefined/)
assert.doesNotMatch(worker, /polling = current\.finally/)
assert.match(retryPolicy, /rate_limit[\s\S]*network[\s\S]*model[\s\S]*parse[\s\S]*validation[\s\S]*budget/)
assert.match(retryPolicy, /isLeadEnrichmentProviderBudgetError/)
assert.match(retryPolicy, /额度不足/)
assert.match(circuitBreaker, /failureThreshold[\s\S]*cooldownMs/)
assert.match(circuitBreaker, /billingCooldownMs/)
assert.match(circuitBreaker, /openReason/)
assert.match(envExample, /LEAD_ENRICHMENT_BILLING_COOLDOWN_MS=900000/)
assert.match(evidenceClassification, /official_regulatory_filing/)
assert.match(evidenceClassification, /official_public_record/)
assert.match(conflictDetection, /同一事实键出现多个不同值/)
assert.match(conflictDetection, /leadFactIdentityKey/)
assert.match(topicResearch, /repeatable fact requires a stable instanceKey/)
assert.match(topicResearch, /lead-topic-web-research-v7-detail-fields/)
assert.deepEqual(leadTopicResearchContract('financing').factKeys, [
  'financing.status', 'financing.round', 'financing.amount', 'financing.investors',
])
assert.deepEqual(leadTopicResearchContract('latest_developments').factKeys, ['news.event', 'news.event_date'])
assert(leadTopicResearchContract('basic_profile').factKeys.includes('profile.website'))
assert(leadTopicResearchContract('basic_profile').factKeys.includes('profile.industry'))
assert.match(topicResearch, /candidates: z\.array/)
assert.match(topicResearch, /quote: z\.string/)
assert.match(topicResearch, /LEAD_ENRICHMENT_RESEARCH_BACKEND === 'codex-cli'/)
assert.match(codexCliResearch, /'--search', 'exec'/)
assert.match(codexCliResearch, /'--ephemeral'/)
assert.match(codexCliResearch, /'read-only'/)
assert.match(codexCliResearch, /--output-schema/)
assert.match(codexCliResearch, /requestCodexCliMultiTopicWebSearchText/)
assert.match(codexCliResearch, /minItems: topicKeys\.length/)
assert.match(codexCliResearch, /maxItems: topicKeys\.length/)
assert.match(codexCliResearch, /budgetMultiplier: index === 0 \? topicKeys\.length : 1/)
assert.doesNotMatch(codexCliResearch, /dangerously-bypass/)
assert.match(codexWorkerRunner, /LEAD_ENRICHMENT_RESEARCH_BACKEND !== 'codex-cli'/)
assert.match(sourceSubjectMatch, /market_policy/)
assert.match(enrichmentService, /手动重试联网补全专题/)
assert.match(enrichmentService, /getLeadEnrichmentDisplayProfile/)
assert.match(enrichmentService, /introductionSources/)
assert.match(enrichmentService, /companyFactIds/)
assert.match(enrichmentService, /projection\?: 'audit' \| 'verified-display'/)
assert.match(enrichmentService, /verification_status='verified'/)
assert.match(enrichmentService, /displayProjection \? \{[\s\S]*sourceUrl:[\s\S]*\} : \{[\s\S]*quote:/)
assert.match(enrichmentService, /manualRetries/)
assert.match(enrichmentService, /人工确认联网补全主体/)
assert.match(enrichmentService, /entityConfirmations/)
assert.match(enrichmentService, /'已注销'/)
assert.match(enrichmentService, /buildLeadEntityGraphPlan/)
assert.match(enrichmentService, /leadFactSubjectEntityType/)
assert.match(enrichmentService, /leadFactEntityRelationType/)
assert.match(enrichmentService, /bindLeadEntityRelationEvidence/)
assert.match(enrichmentService, /from_entity_name/)
assert.match(enrichmentService, /companyFactIds/)
assert.match(worker, /routedSubject/)
assert.match(worker, /researchEntityType = lease\.entity_type/)
assert.match(worker, /primaryEntityName/)
assert.match(publicIntelService, /COMPANY_DEREGISTERED/)
assert.match(publicIntelService, /excludeDeregisteredLeadFromPool/)
assert.match(summaryService, /deregistered-company-exclusion-v1/)
assert.match(summaryService, /lead\.poolStatus === '已注销'/)
assert.match(summaryService, /getLeadById\(leadId: string, options: \{ includeHidden\?: boolean \}/)
assert.match(summaryService, /and\(eq\(leads\.id, canonicalLeadId\), visiblePublicLeadExpr\)/)
assert.match(intakeService, /登记状态为注销，已在入池前排除/)
assert.match(intakeService, /result\.status === 'rejected'/)
assert.match(reserveIntakeService, /score_status='excluded'/)
assert.match(reserveIntakeService, /companyRegistrationEligibility\(lead\.registrationStatus\)/)
assert.match(reviewService, /COMPANY_DEREGISTERED/)
assert.match(reviewService, /paperAuthors: Array\.isArray\(payload\.paper_authors\)/)
assert.match(reviewService, /authorAffiliations: Array\.isArray\(payload\.paper_author_affiliations\)/)
assert.match(routes, /paperAuthors: Array\.isArray\(it\.paper_authors\)/)
assert.match(routes, /authorAffiliations: Array\.isArray\(it\.paper_author_affiliations\)/)
assert.match(sourceDocuments, /SOURCE_SSRF_REJECTED/)
assert.match(sourceDocuments, /robotsAllows/)
assert.match(sourceDocuments, /contentHash/)
assert.match(scoreService, /enrichment_snapshot_id/)
assert.match(routes, /loadLeadEnrichmentSnapshot/)
assert.match(routes, /resolveLeadEnrichmentConflict/)
assert.match(routes, /listLeadEnrichmentFacts/)
assert.match(routes, /leads\/:id\/facts/)
assert.match(routes, /get\('\/leads\/:id\/enrichment', requireSystemAdmin/)
assert.match(routes, /get\('\/leads\/:id\/enrichment\/conflicts', requireSystemAdmin/)
assert.match(routes, /get\('\/leads\/:id\/facts', requireSystemAdmin/)
assert.match(routes, /getLeadById\(leadId, \{ includeHidden: true \}\)/)
assert.match(routes, /get\('\/leads\/:id\/verified-profile'/)
assert.match(routes, /get\('\/leads\/:id\/verified-facts'/)
assert.match(routes, /projection: 'verified-display'/)
assert.match(routes, /leads\/:id\/ratings\/history/)
assert.match(routes, /get\('\/leads\/:id\/ratings\/history', requireSystemAdmin/)
assert.match(routes, /ratings\/history\/:historyId\/restore[\s\S]*requireSystemAdmin/)
assert.match(routes, /requireSystemAdmin[\s\S]*enrichment\/conflicts\/.*\/resolve/)
assert.match(routes, /boundSnapshot[\s\S]*enrichmentSnapshot/)
assert.match(routes, /leadRatingSubjectProfile\(boundSnapshot\.subjectProfile\)/)
assert.match(routes, /validateSnapshotBoundLeadRatingApplicability\(result\.ratingV3, boundSnapshot\.topicStates\)/)
assert.doesNotMatch(routes, /subjectProfile:\s*boundSnapshot\.subjectProfile/)
assert.match(routes, /triggerType: 'score-prerequisite'/)
assert.match(routes, /post\('\/leads\/:id\/score', requireSystemAdmin/)
assert.match(routes, /post\('\/leads\/:id\/score\/retry', requireSystemAdmin/)
assert.match(routes, /post\('\/leads\/:id\/enrichment\/entity\/confirm', requireSystemAdmin/)
assert.doesNotMatch(routes, /legacyRequestBody/)
assert.doesNotMatch(routes, /enrichmentSnapshotId: enrichment\.snapshot\?\.id/)
assert.match(serverEntry, /startLeadEnrichmentWorker/)
assert.match(serverEntry, /stopLeadEnrichmentWorker/)
assert.match(serverEntry, /leadEnrichmentWorkerHealth/)
assert.match(routes, /post\('\/leads\/:id\/enrichment\/topics\/:topic\/retry', requireSystemAdmin/)
assert.match(routes, /post\('\/leads\/:id\/enrichment\/entity\/confirm', requireSystemAdmin/)
assert.match(routes, /post\('\/leads\/:id\/enrichment\/conflicts\/:conflictId\/resolve', requireSystemAdmin/)
assert.doesNotMatch(detailPage, /联网资料补全/)
assert.doesNotMatch(detailPage, /enrichment\/topics\/\$\{topicKey\}\/retry/)
assert.doesNotMatch(detailPage, /enrichment\/entity\/confirm/)
assert.doesNotMatch(detailPage, /enrichment\/conflicts/)
assert.doesNotMatch(detailPage, /`\/leads\/\$\{id\}\/enrichment`/)
assert.doesNotMatch(detailPage, /`\/leads\/\$\{leadId\}\/facts\?/)
assert.match(detailPage, /`\/leads\/\$\{id\}\/verified-profile`/)
assert.match(detailPage, /`\/leads\/\$\{leadId\}\/verified-facts\?/)
assert.doesNotMatch(detailPage, /主体与关系|已提取事实与直接来源|加载更多事实|裁决联网补全冲突/)
assert.match(detailPage, /loadAllLeadVerifiedFacts/)
assert.match(detailPage, /fact\.verificationStatus === 'verified'/)
assert.match(detailPage, /fact\.evidence\.some\(\(evidence\) => Boolean\(externalUrl\(evidence\.sourceUrl\)\)\)/)
assert.match(detailPage, /verifiedFactNode/)
assert.match(detailPage, /verifiedTeamAsMembers/)
assert.match(detailPage, /verifiedNewsUpdates/)
assert.match(detailPage, /ReviewSection title="项目简介"/)
assert.match(detailPage, /ReviewSection title="产品与商业化"/)
assert.match(detailPage, /ReviewSection title="团队成员"/)
assert.match(detailPage, /ReviewSection title="证据与动态"/)
assert.match(detailPage, /generatedIntroductions\?\.companyIntroduction/)
assert.match(detailPage, /generatedIntroductions\?\.teamIntroduction/)
assert.match(detailPage, /generatedIntroductions\?\.projectIntroduction/)
assert.match(detailPage, /generatedIntroductionSources\?\.companyIntroduction/)
assert.match(detailPage, /generatedIntroductionSources\?\.teamIntroduction/)
assert.match(detailPage, /generatedIntroductionSources\?\.projectIntroduction/)
assert.match(detailPage, /projectIntroductionSource[\s\S]*lead-review-inline-link/)
assert.match(detailPage, /暂无已验证的项目介绍，不使用企业介绍或原始宣传文案替代/)
assert.match(detailPage, /headlineIntroductionText/)
assert.doesNotMatch(detailPage, /lead\.scoring\?\.companyIntroduction \|\| lead\.scoring\?\.whatIsIt \|\| lead\.summary/)
assert.match(detailPage, /currentUser\?\.role === '系统管理员'/)
assert.match(systemPage, /V3评分恢复/)
assert.match(systemPage, /ratings\/history\/\$\{ratingRestoreTarget\.id\}\/restore/)
assert.match(backfill, /report-read-only/)
assert.match(backfill, /deregisteredEvicted/)
assert.match(backfill, /reRated/)
assert.match(backfill, /retry-preview/)
assert.match(backfill, /all-retryable/)
assert.match(backfill, /budget is never retried automatically/)
assert.match(backfill, /batchRetries/)
assert.match(backfill, /按错误类型重试历史补全批次/)

const identity = normalizePaperIdentity({ sourceName: 'arXiv', sourceId: 'W1234567890', link: 'https://openalex.org/W1234567890' })
assert.equal(identity.provider, 'openalex')
assert.equal(identity.sourceStatus, 'review')
assert.equal(classifyPaperContent({ url: 'https://example.org/supplement.xlsx' }), 'supplement')
assert.equal(companyRegistrationEligibility('已注销').eligibleForLeadPool, false)
assert.equal(companyRegistrationEligibility('吊销未注销').eligibleForLeadPool, true)
assert.equal(leadEnrichmentRuntimePolicy({ LEAD_ENRICHMENT_ACCEPT_NEW_JOBS: 'false' }).acceptNewJobs, false)
assert.equal(leadEnrichmentRuntimePolicy({ LEAD_ENRICHMENT_AUTO_SCORE: 'false' }).autoScore, false)

assert.throws(() => validateLeadFactCandidate({
  leadId: 'lead', topicKey: 'financial_operations', subjectType: 'company', subjectId: 'company',
  factKey: 'financial.revenue', value: '1亿元', evidenceLevel: 'E3', verificationStatus: 'verified',
  evidence: [{ sourceUrl: 'https://example.org', sourceType: 'web', quote: '营业收入1亿元' }],
}), /E3 evidence cannot be verified/)

const states = initialTopicStates({ entityType: 'research', hasCommercialCompany: false })
assert.equal(states.basic_profile, 'queued')
assert.equal(states.financing, 'not_applicable')
assert.equal(states.ownership, 'not_applicable')
for (const key of LEAD_ENRICHMENT_TOPIC_KEYS) if (states[key] === 'queued') states[key] = 'missing'
const snapshot = buildLeadEnrichmentSnapshot({
  leadId: 'lead', jobId: 'job', entityType: 'research', topicStates: states,
  facts: [], evidenceIndex: {}, gaps: [], conflicts: [],
})
assert.equal(snapshot.status, 'ready')

const companyStates = initialTopicStates({ entityType: 'company' })
assert.equal(Object.values(companyStates).filter((status) => status === 'queued').length, 5)
assert.equal(Object.values(companyStates).filter((status) => status === 'not_applicable').length, 8)
for (const key of LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS) companyStates[key] = 'completed'
const completeDetailSnapshot = buildLeadEnrichmentSnapshot({
  leadId: 'company-lead', jobId: 'company-job', entityType: 'company', topicStates: companyStates,
  facts: [], evidenceIndex: {}, gaps: [], conflicts: [],
})
assert.equal(completeDetailSnapshot.coverage, 100)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'entity-graph-and-seven-versioned-enrichment-tables-with-score-binding',
    'pipeline-ready-enqueues-without-scoring-recursion',
    'detail-field-topic-scope-worker-health-provider-billing-circuit-and-repeat-polling',
    'codex-cli-web-search-worker-keeps-host-evidence-gates',
    'evidence-gate-and-immutable-snapshot',
    'openalex-content-and-deregistered-company-guards',
    'independent-intake-worker-and-auto-score-rollback-switches',
    'snapshot-bound-v3-input',
    'controlled-source-fetch-with-admin-only-operations-and-minimal-verified-detail-projection',
  ],
}))
