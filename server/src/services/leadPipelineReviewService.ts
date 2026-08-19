import { createHash, randomUUID } from 'node:crypto'
import type { PoolConnection } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { isSpecificLeadSubjectName } from './leadSubjectName.js'
import { initialLeadFieldProvenance } from './leadFieldProvenance.js'
import {
  resolveLeadPipelineReview,
  type LeadPipelineDecisionOutcome,
  type LeadPipelineEvidenceInput,
} from './leadPipelineAuditService.js'
import { transitionLeadPipelineItem } from './leadPipelineEventService.js'
import {
  listLeadPipelineEntityMatches,
  recordLeadPipelineEntityMatch,
} from './leadPipelineEntityMatchService.js'
import { currentRequestId } from '../runtime/structuredLogger.js'
import { resolvePaperProjectIdentity } from './paperIdentity.js'

export type LeadPipelineReviewActor = {
  userId: string
  userName: string
  role: string
}

export type ResolveLeadPipelineReviewInput = {
  reviewId: string
  idempotencyKey: string
  outcome: Extract<LeadPipelineDecisionOutcome, 'accept' | 'reject'>
  subjectType?: 'company' | 'project' | 'team' | 'lab' | 'paper' | null
  subjectName?: string | null
  legalName?: string | null
  confidence?: number | null
  reason: string
  evidence?: LeadPipelineEvidenceInput[]
  targetLeadId?: string | null
}

type ReviewListRow = RowDataPacket & {
  id: string
  review_key: string
  event_id: string
  trigger_decision_id: string
  status: string
  reason: string
  assigned_user_id: string | null
  reviewer_user_id: string | null
  resolution_decision_id: string | null
  created_at: Date
  updated_at: Date
  resolved_at: Date | null
  source_type: string
  source_id: string | null
  raw_payload: Record<string, unknown> | string
  source_occurred_at: Date | null
  ingested_at: Date
  pipeline_status: string
  lead_id: string | null
  trigger_outcome: string
  trigger_subject_type: string | null
  trigger_subject_name: string | null
  trigger_legal_name: string | null
  trigger_confidence: number | null
  trigger_reason: string
  trigger_output: Record<string, unknown> | string
  assigned_user_name: string | null
  reviewer_user_name: string | null
  resolution_outcome: string | null
  resolution_reason: string | null
  resolution_output: Record<string, unknown> | string | null
}

type LockedReviewRow = RowDataPacket & ReviewListRow

type EvidenceRow = RowDataPacket & {
  decision_id: string
  source_id: string | null
  source_type: string
  locator: string | null
  claim: string
  quote: string | null
  source_url: string | null
  reliability: string | null
  verification_status: string
  metadata: Record<string, unknown> | string
}

type ExistingLead = {
  id: string
  name: string
  company_name: string | null
  pool_status: string
}
type ExistingLeadRow = RowDataPacket & ExistingLead

const rawTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_raw_events'))
const itemsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_items'))
const decisionsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_decisions'))
const evidenceTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_evidence'))
const reviewsTable = quoteMysqlIdentifier(mysqlTableName('lead_pipeline_reviews'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const usersTable = quoteMysqlIdentifier(mysqlTableName('users'))
const auditLogsTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))

const REVIEW_ROLES = new Set(['系统管理员', '投资总监', '投资经理', '风控与法务', '投委会秘书'])

function reviewError(code: string, message: string, status = 400) {
  return Object.assign(new Error(message), { code, status, retryable: false })
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? '').normalize('NFKC').replace(/\u0000/g, '').trim().slice(0, maxLength)
}

function parseObject(value: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
  if (!value) return {}
  if (typeof value !== 'string') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function canonicalJson(value: unknown) {
  return JSON.stringify(value ?? null)
}

function normalizeComparable(value: unknown) {
  return clean(value, 200_000)
    .toLocaleLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[\p{P}\p{S}\s]+/gu, '')
}

function meaningful(value: unknown, maxLength: number) {
  const text = clean(value, maxLength)
  return text && !['待核验', '待核实', '未披露', '无', '-', 'N/A', 'null'].includes(text) ? text : ''
}

function assertReviewRole(actor: LeadPipelineReviewActor) {
  if (!REVIEW_ROLES.has(actor.role)) {
    throw reviewError('LEAD_REVIEW_ROLE_FORBIDDEN', '当前角色无权处理线索人工复核', 403)
  }
}

function canAccessReview(actor: LeadPipelineReviewActor, review: {
  status: string
  assigned_user_id: string | null
  reviewer_user_id: string | null
}) {
  if (actor.role === '系统管理员') return true
  if (review.status === 'pending') {
    return !review.assigned_user_id || review.assigned_user_id === actor.userId
  }
  return review.reviewer_user_id === actor.userId
}

function publicEvidence(row: EvidenceRow) {
  return {
    sourceId: row.source_id,
    sourceType: row.source_type,
    locator: row.locator,
    claim: row.claim,
    quote: row.quote,
    sourceUrl: row.source_url,
    reliability: row.reliability,
    verificationStatus: row.verification_status,
    metadata: parseObject(row.metadata),
  }
}

function publicReview(
  row: ReviewListRow,
  evidence: Map<string, ReturnType<typeof publicEvidence>[]>,
  existingLeads: ExistingLead[],
  entityMatches: Awaited<ReturnType<typeof listLeadPipelineEntityMatches>>,
) {
  return {
    id: row.id,
    reviewKey: row.review_key,
    status: row.status,
    reason: row.reason,
    assignedUserId: row.assigned_user_id,
    assignedUserName: row.assigned_user_name,
    reviewerUserId: row.reviewer_user_id,
    reviewerUserName: row.reviewer_user_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    event: {
      id: row.event_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      payload: parseObject(row.raw_payload),
      sourceOccurredAt: row.source_occurred_at,
      ingestedAt: row.ingested_at,
    },
    pipeline: { status: row.pipeline_status, leadId: row.lead_id },
    triggerDecision: {
      id: row.trigger_decision_id,
      outcome: row.trigger_outcome,
      subjectType: row.trigger_subject_type,
      subjectName: row.trigger_subject_name,
      legalName: row.trigger_legal_name,
      confidence: row.trigger_confidence == null ? null : Number(row.trigger_confidence),
      reason: row.trigger_reason,
      output: parseObject(row.trigger_output),
      evidence: evidence.get(row.trigger_decision_id) ?? [],
    },
    resolution: row.resolution_decision_id ? {
      decisionId: row.resolution_decision_id,
      outcome: row.resolution_outcome,
      reason: row.resolution_reason,
      evidence: evidence.get(row.resolution_decision_id) ?? [],
    } : null,
    existingLeads: existingLeads.map((lead) => ({
      id: lead.id,
      name: lead.name,
      companyName: lead.company_name,
      poolStatus: lead.pool_status,
    })),
    entityMatches,
  }
}

const REVIEW_SELECT = `
  SELECT r.*, raw.source_type, raw.source_id, raw.payload AS raw_payload,
    raw.source_occurred_at, raw.ingested_at,
    item.status AS pipeline_status, item.lead_id,
    trigger_decision.outcome AS trigger_outcome,
    trigger_decision.subject_type AS trigger_subject_type,
    trigger_decision.subject_name AS trigger_subject_name,
    trigger_decision.legal_name AS trigger_legal_name,
    trigger_decision.confidence AS trigger_confidence,
    trigger_decision.reason AS trigger_reason,
    trigger_decision.output AS trigger_output,
    assigned_user.name AS assigned_user_name,
    reviewer_user.name AS reviewer_user_name,
    resolution.outcome AS resolution_outcome,
    resolution.reason AS resolution_reason,
    resolution.output AS resolution_output
  FROM ${reviewsTable} r
  JOIN ${rawTable} raw ON raw.id=r.event_id
  JOIN ${itemsTable} item ON item.event_id=r.event_id
  JOIN ${decisionsTable} trigger_decision ON trigger_decision.id=r.trigger_decision_id
  LEFT JOIN ${usersTable} assigned_user ON assigned_user.id=r.assigned_user_id
  LEFT JOIN ${usersTable} reviewer_user ON reviewer_user.id=r.reviewer_user_id
  LEFT JOIN ${decisionsTable} resolution ON resolution.id=r.resolution_decision_id`

export async function listLeadPipelineReviews(input: {
  actor: LeadPipelineReviewActor
  status?: 'pending' | 'resolved' | 'all'
  page?: number
  pageSize?: number
}) {
  assertReviewRole(input.actor)
  const status = input.status ?? 'pending'
  const page = Math.max(1, Math.floor(input.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(input.pageSize ?? 20)))
  const clauses: string[] = []
  const params: unknown[] = []
  if (status !== 'all') {
    clauses.push('r.status=?')
    params.push(status)
  }
  if (input.actor.role !== '系统管理员') {
    clauses.push("((r.status='pending' AND (r.assigned_user_id IS NULL OR r.assigned_user_id=?)) OR (r.status='resolved' AND r.reviewer_user_id=?))")
    params.push(input.actor.userId, input.actor.userId)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const [countRows] = await pool.query<Array<RowDataPacket & { total: number }>>(
    `SELECT COUNT(*) AS total FROM ${reviewsTable} r ${where}`,
    params,
  )
  const [rows] = await pool.query<ReviewListRow[]>(
    `${REVIEW_SELECT} ${where}
     ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END, r.created_at ASC, r.id ASC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  )
  const decisionIds = [...new Set(rows.flatMap((row) => [row.trigger_decision_id, row.resolution_decision_id]).filter(Boolean))] as string[]
  const evidenceByDecision = new Map<string, ReturnType<typeof publicEvidence>[]>()
  if (decisionIds.length) {
    const [evidenceRows] = await pool.query<EvidenceRow[]>(
      `SELECT decision_id, source_id, source_type, locator, claim, quote, source_url,
        reliability, verification_status, metadata
       FROM ${evidenceTable} WHERE decision_id IN (${decisionIds.map(() => '?').join(',')})
       ORDER BY created_at ASC, id ASC`,
      decisionIds,
    )
    for (const row of evidenceRows) {
      const current = evidenceByDecision.get(row.decision_id) ?? []
      current.push(publicEvidence(row))
      evidenceByDecision.set(row.decision_id, current)
    }
  }
  const names = [...new Set(rows.map((row) => clean(row.trigger_subject_name, 128)).filter(Boolean))]
  const leadByName = new Map<string, ExistingLead[]>()
  if (names.length) {
    const [leadRows] = await pool.query<ExistingLeadRow[]>(
      `SELECT id, name, company_name, pool_status FROM ${leadsTable}
       WHERE name IN (${names.map(() => '?').join(',')}) ORDER BY created_at ASC, id ASC`,
      names,
    )
    for (const lead of leadRows) {
      const current = leadByName.get(lead.name) ?? []
      current.push(lead)
      leadByName.set(lead.name, current)
    }
  }
  const total = Number(countRows[0]?.total ?? 0)
  const persistedEntityMatches = await listLeadPipelineEntityMatches(rows.map((row) => row.event_id))
  const matchesByEvent = new Map<string, typeof persistedEntityMatches>()
  for (const match of persistedEntityMatches) {
    const current = matchesByEvent.get(match.eventId) ?? []
    current.push(match)
    matchesByEvent.set(match.eventId, current)
  }
  return {
    list: rows.map((row) => publicReview(
      row,
      evidenceByDecision,
      leadByName.get(row.trigger_subject_name ?? '') ?? [],
      matchesByEvent.get(row.event_id) ?? [],
    )),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

function validatedManualEvidence(input: ResolveLeadPipelineReviewInput, row: LockedReviewRow) {
  const subjectName = clean(input.subjectName, 128)
  const legalName = clean(input.legalName, 128)
  const reason = clean(input.reason, 8_000)
  const subjectType = input.subjectType ?? null
  if (!reason) throw reviewError('LEAD_REVIEW_REASON_REQUIRED', '人工复核必须填写处理理由')
  if (input.outcome === 'reject') {
    return { subjectName: null, legalName: null, subjectType: null, reason, evidence: [] as LeadPipelineEvidenceInput[] }
  }
  if (!subjectType || !['company', 'project', 'team', 'lab', 'paper'].includes(subjectType)) {
    throw reviewError('LEAD_REVIEW_SUBJECT_TYPE_REQUIRED', '接受线索必须选择主体类型')
  }
  if (!subjectName || !isSpecificLeadSubjectName(subjectName, subjectType === 'paper')) {
    throw reviewError('LEAD_REVIEW_INVALID_SUBJECT', '接受线索必须填写明确、可识别的主体名称')
  }
  const rawText = canonicalJson(parseObject(row.raw_payload))
  if (!normalizeComparable(rawText).includes(normalizeComparable(subjectName))) {
    throw reviewError('LEAD_REVIEW_SUBJECT_NOT_IN_SOURCE', '主体名称无法在不可变原始事件中定位')
  }
  const evidence = (input.evidence ?? []).slice(0, 10).map((item) => ({
    ...item,
    sourceType: clean(item.sourceType || row.source_type, 32),
    claim: clean(item.claim, 8_000),
    quote: clean(item.quote, 8_000) || null,
    verificationStatus: 'verified' as const,
  }))
  if (!evidence.length || evidence.some((item) => !item.claim || !item.quote)) {
    throw reviewError('LEAD_REVIEW_EVIDENCE_REQUIRED', '接受线索必须提供原文引文和对应事实主张')
  }
  if (evidence.some((item) => !normalizeComparable(rawText).includes(normalizeComparable(item.quote)))) {
    throw reviewError('LEAD_REVIEW_EVIDENCE_NOT_IN_SOURCE', '人工复核引文无法在不可变原始事件中定位')
  }
  return { subjectName, legalName: legalName || null, subjectType, reason, evidence }
}

function newLeadFields(row: LockedReviewRow, validated: ReturnType<typeof validatedManualEvidence>, actor: LeadPipelineReviewActor) {
  const payload = parseObject(row.raw_payload)
  const profile = asObject(payload.project_profile)
  const triggerOutput = parseObject(row.trigger_output)
  const sourceGroup = meaningful(payload.source_group, 64)
  const sourceName = meaningful(payload.source_name || payload.source, 128)
  const link = meaningful(payload.link || profile.source_url, 4_000)
  const isPaper = validated.subjectType === 'paper'
  const paperProjectIdentity = isPaper ? resolvePaperProjectIdentity({
    titleOriginal: payload.title || profile.paper_title || validated.subjectName,
    titleZh: triggerOutput.translatedTitle,
    modelProjectName: triggerOutput.paperProjectName,
    modelProjectNameZh: triggerOutput.paperProjectNameZh,
  }) : { projectName: '', projectNameOriginal: '' }
  const summary = meaningful(
    isPaper ? triggerOutput.translatedSummary || payload.summary : payload.summary || profile.core_highlights || payload.article_text,
    4_000,
  )
  const fundingRound = meaningful(profile.project_round, 128)
  const amount = meaningful(profile.financing_amount, 128)
  const valuation = meaningful(profile.latest_valuation, 128)
  const investors = meaningful(profile.institutions, 500)
  const fundingRounds = fundingRound || amount || valuation || investors ? [{
    round: fundingRound || '待核验',
    amount: amount || '未披露',
    valuation: valuation || '未披露',
    investors: investors || '待核验',
    sourceUrl: link,
  }] : []
  const source = {
    title: meaningful(payload.title, 1_000) || validated.subjectName || '人工复核原始来源',
    url: link,
    reliability: '人工核验',
    category: sourceGroup || row.source_type,
    excerpt: meaningful(payload.summary || payload.article_text, 1_000),
  }
  const categories = Array.isArray(payload.categories) ? payload.categories.map((value) => clean(value, 64)).filter(Boolean) : []
  const radarProfile = {
    sourceId: row.source_id,
    radarSourceKey: row.source_id,
    sourceTitle: meaningful(payload.title, 1_000),
    sourceName,
    sourceGroup,
    channel: isPaper ? '论文' : sourceGroup || '人工复核',
    link,
    articleText: meaningful(payload.article_text, 20_000),
    profile: isPaper ? {
      ...profile,
      projectName: paperProjectIdentity.projectName,
    } : profile,
    aiSubjectReview: triggerOutput,
    manualReview: {
      reviewId: row.id,
      reviewerUserId: actor.userId,
      subjectType: validated.subjectType,
      subjectName: validated.subjectName,
      legalName: validated.legalName,
      resolvedAt: new Date().toISOString(),
    },
    paperMeta: isPaper ? {
      title: meaningful(payload.title || profile.paper_title, 1_000) || validated.subjectName,
      titleOriginal: meaningful(payload.title || profile.paper_title, 1_000) || validated.subjectName,
      titleZh: meaningful(triggerOutput.translatedTitle, 500),
      projectName: paperProjectIdentity.projectName,
      projectNameOriginal: paperProjectIdentity.projectNameOriginal,
      authors: Array.isArray(payload.authors) ? payload.authors : [],
      categories,
      abstract: meaningful(payload.summary, 4_000),
      abstractOriginal: meaningful(payload.summary, 4_000),
      abstractZh: meaningful(triggerOutput.translatedSummary, 4_000),
      pdfUrl: meaningful(payload.pdf_url || profile.paper_pdf_url, 4_000),
      publishedAt: meaningful(payload.published_at, 128),
    } : {},
  }
  return {
    name: validated.subjectName!,
    companyName: validated.legalName || (validated.subjectType === 'company' ? validated.subjectName : null),
    industry: meaningful(profile.industry, 64) || (isPaper && categories.length ? categories.slice(0, 3).join('、') : '待核验'),
    source: `人工复核 · ${sourceName || row.source_type}`,
    summary,
    team: meaningful(profile.team_composition, 2_000) || null,
    fundingRounds,
    sources: [source],
    radarProfile,
    radarSourceKeys: row.source_id ? [row.source_id] : [],
  }
}

async function lockReview(connection: PoolConnection, reviewId: string) {
  const [rows] = await connection.query<LockedReviewRow[]>(
    `${REVIEW_SELECT} WHERE r.id=? FOR UPDATE`,
    [reviewId],
  )
  const row = rows[0]
  if (!row) throw reviewError('LEAD_REVIEW_NOT_FOUND', '人工复核任务不存在', 404)
  return row
}

async function selectOrCreateLead(
  connection: PoolConnection,
  row: LockedReviewRow,
  validated: ReturnType<typeof validatedManualEvidence>,
  actor: LeadPipelineReviewActor,
  targetLeadId?: string | null,
) {
  if (row.lead_id) {
    const [linked] = await connection.query<ExistingLeadRow[]>(
      `SELECT id, name, company_name, pool_status FROM ${leadsTable} WHERE id=? FOR UPDATE`,
      [row.lead_id],
    )
    if (!linked[0]) throw reviewError('LEAD_REVIEW_LINKED_LEAD_MISSING', '复核任务关联的正式线索不存在', 409)
    return { lead: linked[0], created: false, candidates: linked, matchType: 'pipeline_binding' }
  }
  if (targetLeadId) {
    const [target] = await connection.query<ExistingLeadRow[]>(
      `SELECT id, name, company_name, pool_status FROM ${leadsTable} WHERE id=? FOR UPDATE`,
      [targetLeadId],
    )
    if (!target[0]) throw reviewError('LEAD_REVIEW_TARGET_NOT_FOUND', '选择的目标线索不存在', 404)
    if (clean(target[0].name, 128) !== validated.subjectName) {
      throw reviewError('LEAD_REVIEW_TARGET_SUBJECT_MISMATCH', '选择的目标线索与当前复核主体不一致', 409)
    }
    if (target[0].pool_status === '已转专属项目' || target[0].pool_status === '已合并') {
      throw reviewError('LEAD_REVIEW_TARGET_TERMINAL', '选择的目标线索已转为专属项目，不能继续合并', 409)
    }
    const [candidates] = await connection.query<ExistingLeadRow[]>(
      `SELECT id, name, company_name, pool_status FROM ${leadsTable}
       WHERE name=? AND pool_status NOT IN ('已转专属项目','已合并') ORDER BY created_at ASC, id ASC FOR UPDATE`,
      [validated.subjectName],
    )
    return { lead: target[0], created: false, candidates, matchType: 'manual_target' }
  }
  const [matches] = await connection.query<ExistingLeadRow[]>(
    `SELECT id, name, company_name, pool_status FROM ${leadsTable}
     WHERE name=? AND pool_status NOT IN ('已转专属项目','已合并') ORDER BY created_at ASC, id ASC FOR UPDATE`,
    [validated.subjectName],
  )
  if (matches.length > 1) {
    throw reviewError('LEAD_REVIEW_DUPLICATE_TARGET_REQUIRED', '存在多条同名线索，必须人工选择合并目标', 409)
  }
  if (matches[0]) return { lead: matches[0], created: false, candidates: matches, matchType: 'exact_name' }
  const fields = newLeadFields(row, validated, actor)
  const id = randomUUID()
  await connection.query(
    `INSERT INTO ${leadsTable}
      (id, name, company_name, industry, source, pool_status, score, summary, highlights, risks,
       team, funding_rounds, risk_tags, sources, radar_profile, radar_source_keys, field_provenance, created_at)
     VALUES (?, ?, ?, ?, ?, '成功', 0, ?, JSON_ARRAY(), JSON_ARRAY(), ?, CAST(? AS JSON),
       JSON_ARRAY('人工复核'), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), NOW(3))`,
    [id, fields.name, fields.companyName, fields.industry, fields.source, fields.summary, fields.team,
      canonicalJson(fields.fundingRounds), canonicalJson(fields.sources), canonicalJson(fields.radarProfile),
      canonicalJson(fields.radarSourceKeys), canonicalJson(initialLeadFieldProvenance(fields, 'manual_review'))],
  )
  return {
    lead: { id, name: fields.name, company_name: fields.companyName, pool_status: '成功' } satisfies ExistingLead,
    created: true,
    candidates: [] as ExistingLead[],
    matchType: 'no_match',
  }
}

export async function resolveAndCommitLeadPipelineReview(
  input: ResolveLeadPipelineReviewInput,
  actor: LeadPipelineReviewActor,
) {
  assertReviewRole(actor)
  const idempotencyKey = clean(input.idempotencyKey, 128)
  if (idempotencyKey.length < 8) {
    throw reviewError('LEAD_REVIEW_IDEMPOTENCY_KEY_REQUIRED', '人工复核必须提供稳定幂等键')
  }
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const row = await lockReview(connection, clean(input.reviewId, 36))
    if (!canAccessReview(actor, row)) {
      throw reviewError('LEAD_REVIEW_FORBIDDEN', '该人工复核任务未分配给当前用户', 403)
    }
    const validated = validatedManualEvidence(input, row)
    if (row.status === 'resolved') {
      const existing = await resolveLeadPipelineReview({
        reviewId: row.id,
        reviewerUserId: actor.userId,
        idempotencyKey,
        outcome: input.outcome,
        subjectType: validated.subjectType,
        subjectName: validated.subjectName,
        legalName: validated.legalName,
        confidence: input.confidence,
        reason: validated.reason,
        output: parseObject(row.resolution_output),
        evidence: validated.evidence,
      }, connection)
      await connection.commit()
      return { ...existing, leadId: row.lead_id, leadCreated: false, pipelineStatus: row.pipeline_status }
    }

    let lead: ExistingLead | null = null
    let leadCreated = false
    let entityCandidates: ExistingLead[] = []
    let entityMatchType = 'manual_reject'
    if (input.outcome === 'accept') {
      const selected = await selectOrCreateLead(connection, row, validated, actor, clean(input.targetLeadId, 36) || null)
      lead = selected.lead
      leadCreated = selected.created
      entityCandidates = selected.candidates
      entityMatchType = selected.matchType
    }
    const resolved = await resolveLeadPipelineReview({
      reviewId: row.id,
      reviewerUserId: actor.userId,
      idempotencyKey,
      outcome: input.outcome,
      subjectType: validated.subjectType,
      subjectName: validated.subjectName,
      legalName: validated.legalName,
      confidence: input.confidence,
      reason: validated.reason,
      output: { targetLeadId: lead?.id ?? null, leadCreated, source: 'manual-review-api' },
      evidence: validated.evidence,
    }, connection)
    const transition = await transitionLeadPipelineItem(row.event_id, {
      status: input.outcome === 'accept' ? 'ready' : 'rejected',
      reason: validated.reason,
      evidence: validated.evidence,
      confidence: input.confidence,
      leadId: lead?.id ?? null,
      actorType: 'user',
      actorId: actor.userId,
    }, connection)
    if (transition.blocked) {
      throw reviewError('LEAD_REVIEW_TRANSITION_BLOCKED', '正式线索已进入不可自动撤回状态，需另行发起业务处置', 409)
    }
    for (const candidate of entityCandidates) {
      await recordLeadPipelineEntityMatch({
        idempotencyKey: `${idempotencyKey}:candidate:${candidate.id}`,
        eventId: row.event_id,
        decisionId: row.trigger_decision_id,
        reviewId: row.id,
        subjectType: validated.subjectType,
        subjectName: validated.subjectName!,
        matchType: entityMatchType,
        candidateLeadId: candidate.id,
        candidateName: candidate.name,
        candidateCompanyName: candidate.company_name,
        score: 10_000,
        status: entityCandidates.length > 1 ? 'ambiguous' : 'candidate',
        metadata: { poolStatus: candidate.pool_status },
      }, connection)
    }
    await recordLeadPipelineEntityMatch({
      idempotencyKey: `${idempotencyKey}:resolution`,
      eventId: row.event_id,
      decisionId: row.trigger_decision_id,
      reviewId: row.id,
      subjectType: validated.subjectType,
      subjectName: validated.subjectName || clean(row.trigger_subject_name, 128) || row.event_id,
      matchType: entityMatchType,
      candidateLeadId: lead?.id ?? null,
      candidateName: lead?.name ?? null,
      candidateCompanyName: lead?.company_name ?? null,
      score: lead ? 10_000 : null,
      status: input.outcome === 'reject' ? 'rejected' : leadCreated ? 'created' : 'selected',
      resolutionType: input.outcome === 'reject' ? 'rejected' : leadCreated ? 'created' : 'manual',
      resolutionDecisionId: resolved.decision.id,
      metadata: { actorUserId: actor.userId },
    }, connection)
    await connection.query(
      `INSERT INTO ${auditLogsTable}
        (id, user_id, user_name, module, action, target, result, request_id, created_at)
       VALUES (?, ?, ?, '项目获取池', ?, ?, 'success', ?, NOW(3))`,
      [randomUUID(), actor.userId, clean(actor.userName, 64),
        input.outcome === 'accept' ? '人工复核接受线索' : '人工复核拒绝线索',
        `${validated.subjectName || row.source_id || row.event_id} · review=${row.id}`,
        currentRequestId() ?? randomUUID()],
    )
    await connection.commit()
    return {
      ...resolved,
      leadId: lead?.id ?? null,
      leadCreated,
      pipelineStatus: transition.item.status,
    }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

export function leadPipelineReviewContractDigest() {
  return createHash('sha256').update([
    'lead-pipeline-review-v1',
    [...REVIEW_ROLES].sort().join(','),
    'mysql-authoritative-source',
    'immutable-evidence-validation',
    'host-transaction-commit',
  ].join(':')).digest('hex')
}
