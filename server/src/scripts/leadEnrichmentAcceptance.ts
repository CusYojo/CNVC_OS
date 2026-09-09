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
const [migration, instanceMigration, eventService, enrichmentService, worker, retryPolicy, circuitBreaker, evidenceClassification, conflictDetection, sourceSubjectMatch, publicIntelService, routes, serverEntry, sourceDocuments, detailPage, systemPage, backfill, summaryService, intakeService, reserveIntakeService, reviewService, topicResearch, codexCliResearch, codexWorkerRunner, envExample, prefetchResearch] = await Promise.all([
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
  readFile(`${root}/server/src/scripts/prefetchLeadEnrichmentResearch.ts`, 'utf8'),
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
assert.equal(LEAD_ENRICHMENT_SCHEMA_VERSION, 'lead-enrichment-v8-web-hit')
assert.match(enrichmentService, /schema_version/)
assert.match(enrichmentService, /candidate\.acceptanceMode !== 'web_hit'/)
assert.match(enrichmentService, /triggerType exceeds 48 characters/)
assert.match(worker, /j\.schema_version=\?/)
assert.match(worker, /\(\?='' OR j\.trigger_type=\?\)/)
assert.match(worker, /triggerTypeFilter: triggerTypeFilter \|\| null/)
assert.match(worker, /j\.entity_type<>'research' OR NOT EXISTS[\s\S]*active_research_topic\.status='running'/)
assert.match(worker, /let effectiveEntityStatus = lease\.entity_status/)
assert.match(worker, /effectiveEntityStatus = sourceStatus === 'confirmed' \? 'confirmed' : 'ambiguous'/)
assert.match(worker, /const cached = effectiveEntityStatus === 'confirmed'/)
assert.match(worker, /!cacheHit && effectiveEntityStatus === 'confirmed'/)
assert.match(worker, /UPDATE \$\{topicRunsTable\} tr JOIN \$\{jobsTable\} j[\s\S]*j\.schema_version=\?/)
assert.match(worker, /WHERE schema_version=\? AND \(\? IS NULL OR created_at>=\?\)[\s\S]*AND status='running'/)
assert.match(worker, /SELECT tr\.id,tr\.job_id,tr\.lead_id,tr\.last_error[\s\S]*j\.schema_version=\?/)
assert.match(worker, /Math\.min\(10,/)
assert.doesNotMatch(enrichmentService, /enqueueLeadScoreJob/)
assert.doesNotMatch(enrichmentService, /enqueueRating/)
assert.deepEqual(LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS, [
  'basic_profile', 'financing', 'ownership', 'team', 'products', 'latest_developments',
])
assert.match(eventService, /enqueueLeadEnrichmentJob/)
assert.match(eventService, /LEAD_ENRICHMENT_JOB_REQUIRED/)
assert.match(eventService, /enrichment\.jobId/)
assert.match(eventService, /lead-scoring-input.*project-scoring-input/s)
assert.match(eventService, /company_deregistered/)
assert.match(eventService, /'ready','rejected'/)
assert.match(worker, /researchLeadTopicWithWeb/)
assert.match(worker, /fetchLeadSourceDocument/)
assert.match(worker, /sourceDocumentContainsQuote/)
assert.match(worker, /validateLeadFactCandidate\(candidate\)/)
assert.match(worker, /deterministicRejectedFactCount/)
assert.match(worker, /sourceDocumentId: document\.id/)
assert.match(worker, /excludeDeregisteredLeadFromPool/)
assert.match(worker, /lease_owner=\?/)
assert.match(worker, /recordTopicPhase/)
assert.match(worker, /isLeadAgentRuntimeThrottleError/)
assert.match(worker, /execution_attempts=GREATEST\(0,execution_attempts-\?\)/)
assert.match(worker, /Date\.now\(\) < localThrottleUntilMs/)
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
assert.match(topicResearch, /lead-topic-web-research-v13-web-hit/)
assert.match(worker, /acceptanceMode: 'web_hit'/)
assert.match(worker, /verificationStatus: 'verified'/)
assert.match(worker, /sourceType: 'web_search'/)
assert.doesNotMatch(topicResearch, /融资金额和产品性能数字/)
assert.doesNotMatch(topicResearch, /融资状态、轮次、金额和投资方/)
assert.doesNotMatch(topicResearch, /团队任职必须区分当前任职和历史任职/)
assert.doesNotMatch(topicResearch, /产品只输出来源已明确披露的名称、参数、性能、矩阵和应用场景/)
assert.match(topicResearch, /LEAD_TOPIC_PRIMARY_SOURCE_POLICY/)
assert.match(topicResearch, /site:gov\.cn/)
assert.deepEqual(leadTopicResearchContract('financing').factKeys, [
  'financing.status', 'financing.round', 'financing.date', 'financing.amount',
])
assert.deepEqual(leadTopicResearchContract('latest_developments').factKeys, ['news.event', 'news.event_date'])
assert(leadTopicResearchContract('basic_profile').factKeys.includes('profile.website'))
assert(leadTopicResearchContract('basic_profile').factKeys.includes('profile.industry'))
assert.match(topicResearch, /candidates: z\.array/)
assert.match(topicResearch, /quote: z\.string/)
assert.match(topicResearch, /LEAD_ENRICHMENT_RESEARCH_BACKEND === 'codex-cli'/)
assert.match(topicResearch, /acquireLeadAgentRuntimePermit/)
assert.match(topicResearch, /lead-enrichment-web-research/)
assert.match(topicResearch, /finishLeadAgentRuntimePermit/)
assert.match(prefetchResearch, /leadIds\.length >= 1 && leadIds\.length <= 10/)
assert.match(prefetchResearch, /prefetch fails closed for non-confirmed subjects/)
assert.match(prefetchResearch, /ALLOW_LEAD_RESEARCH_PREFETCH/)
assert.match(prefetchResearch, /Math\.min\(10,/)
assert.match(prefetchResearch, /writeLeadTopicSearchCache/)
assert.match(prefetchResearch, /businessDataWrites: 0/)
assert.match(prefetchResearch, /receipt\.sync\(\)/)
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
assert.match(enrichmentService, /display_fact\.fact_key LIKE 'customer\.%'/)
assert.match(enrichmentService, /confidential_fact\.instance_key=display_fact\.instance_key/)
assert.match(enrichmentService, /JSON_UNQUOTE\(confidential_fact\.value\)[\s\S]*保密\|受限\|confidential\|restricted/)
assert.match(enrichmentService, /sensitive_customer\.confidentiality IN \('confidential','restricted'\)/)
assert.match(enrichmentService, /JSON_TABLE\([\s\S]*sensitive_customer\.aliases[\s\S]*sensitive_alias\.alias/)
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
assert.doesNotMatch(routes, /ratings\/history\/:historyId\/restore/)
assert.match(routes, /requireSystemAdmin[\s\S]*enrichment\/conflicts\/.*\/resolve/)
assert.match(routes, /post\('\/leads\/:id\/score', requireSystemAdmin[\s\S]*LEAD_SCORING_RETIRED/)
assert.match(routes, /post\('\/leads\/:id\/score\/retry', requireSystemAdmin[\s\S]*LEAD_SCORING_RETIRED/)
assert.match(routes, /get\('\/leads\/:id\/score'[\s\S]*LEAD_SCORING_RETIRED/)
assert.doesNotMatch(routes, /convertLead\(leadId[\s\S]{0,500}scheduleLeadScoring/)
assert.match(routes, /post\('\/leads\/:id\/enrichment\/entity\/confirm', requireSystemAdmin/)
assert.doesNotMatch(routes, /legacyRequestBody/)
assert.doesNotMatch(routes, /enrichmentSnapshotId: enrichment\.snapshot\?\.id/)
assert.match(serverEntry, /startLeadEnrichmentWorker/)
assert.match(serverEntry, /stopLeadEnrichmentWorker/)
assert.match(serverEntry, /leadEnrichmentWorkerHealth/)
assert.doesNotMatch(serverEntry, /startLeadScoreJobWorker|stopLeadScoreJobWorker|leadScoreJobHealth|executeLeadScoring/)
assert.match(routes, /post\('\/leads\/:id\/enrichment\/topics\/:topic\/retry', requireSystemAdmin/)
assert.match(routes, /post\('\/leads\/:id\/enrichment\/entity\/confirm', requireSystemAdmin/)
assert.match(routes, /post\('\/leads\/:id\/enrichment\/conflicts\/:conflictId\/resolve', requireSystemAdmin/)
assert.doesNotMatch(detailPage, /联网资料补全/)
assert.doesNotMatch(detailPage, /enrichment\/topics\/\$\{topicKey\}\/retry/)
assert.doesNotMatch(detailPage, /enrichment\/entity\/confirm/)
assert.match(detailPage, /canManageLeadPool\(currentUser\)[\s\S]*dataStatus\.conflictCount/)
assert.match(detailPage, /`\/leads\/\$\{leadId\}\/enrichment\/conflicts`/)
assert.match(detailPage, /enrichment\/conflicts\/\$\{selectedConflictId\}\/resolve/)
assert.doesNotMatch(detailPage, /`\/leads\/\$\{id\}\/enrichment`/)
assert.doesNotMatch(detailPage, /`\/leads\/\$\{leadId\}\/facts\?/)
assert.match(detailPage, /`\/leads\/\$\{id\}\/verified-profile`/)
assert.match(detailPage, /`\/leads\/\$\{leadId\}\/verified-facts\?/)
assert.doesNotMatch(detailPage, /主体与关系|已提取事实与直接来源|加载更多事实/)
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
assert.match(detailPage, /projectIntroductionCandidates[\s\S]*projectIntroductionSourceUrl/)
assert.match(detailPage, /lead\.projectIntroduction/)
assert.match(detailPage, /headlineIntroductionText/)
assert.doesNotMatch(detailPage, /lead\.scoring\?\.companyIntroduction \|\| lead\.scoring\?\.whatIsIt \|\| lead\.summary/)
assert.match(detailPage, /permissionCodes\?\.includes\('system\.manage'\)/)
assert.match(detailPage, /canManageLeadPool\(currentUser\)/)
assert.doesNotMatch(systemPage, /V3评分恢复|rating-recovery|ratingRestoreTarget/)
assert.match(backfill, /report-read-only/)
assert.match(backfill, /--lead-ids accepts at most 100 explicit IDs per batch/)
assert.match(backfill, /--lead-ids was provided but empty; refusing to fall back to page mode/)
assert.match(backfill, /page-mode apply requires explicit --allow-page-selection acknowledgement/)
assert.match(backfill, /--batch-id must be 1-28 safe characters/)
assert.match(backfill, /--lead-ids includes a missing or inactive lead; no jobs were queued/)
assert.match(backfill, /mode: 'explicit-lead-ids'/)
assert.match(backfill, /deregisteredEvicted/)
assert.match(backfill, /reRated/)
assert.match(backfill, /retry-preview/)
assert.match(backfill, /all-retryable/)
assert.match(backfill, /budget is never retried automatically/)
assert.match(backfill, /batchRetries/)
assert.match(backfill, /按错误类型重试历史补全批次/)
assert.match(backfill, /j\.status IN \('queued','running'\)/)
assert.match(backfill, /tr\.status IN \('queued','retrying','running'\)/)

const identity = normalizePaperIdentity({ sourceName: 'arXiv', sourceId: 'W1234567890', link: 'https://openalex.org/W1234567890' })
assert.equal(identity.provider, 'openalex')
assert.equal(identity.sourceStatus, 'review')
assert.equal(classifyPaperContent({ url: 'https://example.org/supplement.xlsx' }), 'supplement')
assert.equal(companyRegistrationEligibility('已注销').eligibleForLeadPool, false)
assert.equal(companyRegistrationEligibility('吊销未注销').eligibleForLeadPool, true)
assert.equal(leadEnrichmentRuntimePolicy({ LEAD_ENRICHMENT_ACCEPT_NEW_JOBS: 'false' }).acceptNewJobs, false)
assert.deepEqual(leadEnrichmentRuntimePolicy({}), { workerEnabled: true, acceptNewJobs: true })

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
assert.equal(Object.values(companyStates).filter((status) => status === 'queued').length, 6)
assert.equal(Object.values(companyStates).filter((status) => status === 'not_applicable').length, 7)
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
    'confirmed-subject-codex-prefetch-is-bounded-cached-and-recoverable',
    'evidence-gate-and-immutable-snapshot',
    'openalex-content-and-deregistered-company-guards',
    'independent-intake-worker-and-auto-score-rollback-switches',
    'snapshot-bound-v3-input',
    'controlled-source-fetch-with-admin-only-operations-and-minimal-verified-detail-projection',
  ],
}))
