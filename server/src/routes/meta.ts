import { Router } from 'express'
import { desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { auditLogs, leads } from '../db/schema.js'
import { aiTaskRepository, identityRepositories } from '../repositories/index.js'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { requireSystemAdmin } from '../middleware/requireAuth.js'
import {
  createManagedUser,
  resetManagedUserPassword,
  updateManagedUser,
} from '../services/identityAdministrationService.js'
import { requireAccessibleProject } from '../services/projectAccessService.js'
import {
  createLead,
  convertLead,
  deleteLeadFromPublicPool,
  getLeadById,
  ingestLeadProfile,
  leadPoolStats,
  listLeads,
  listLeadScoresForRanking,
  listRecoverableLeadScoreIds,
  clearLeadScoreJob,
  isLeadEligibleForScoring,
  readLeadScoreJob,
  saveLeadScoreJob,
  commitRadarLeadPipelineReady,
  type LeadScoreJob,
} from '../services/aiSummaryService.js'
import {
  enqueueLeadScoreJob,
  getLeadScoreJobBinding,
  listCircuitDeadLetterLeadScoreIds,
  type LeadScoreExecutionResult,
} from '../services/leadScoreJobService.js'
import {
  confirmLeadEnrichmentEntity,
  enqueueLeadEnrichmentJob,
  excludeDeregisteredLeadFromPool,
  getLeadEnrichmentDisplayProfile,
  getLeadEnrichmentStatus,
  listLeadEnrichmentConflicts,
  listLeadEnrichmentFacts,
  leadRatingSubjectProfile,
  loadLeadEnrichmentSnapshot,
  resolveLeadEnrichmentConflict,
  retryLeadEnrichmentTopic,
} from '../services/leadEnrichmentService.js'
import { LEAD_ENRICHMENT_TOPIC_KEYS } from '../services/leadEnrichmentContract.js'
import { leadEnrichmentOperationalMetrics } from '../services/leadEnrichmentWorkerService.js'
import { listLeadRatingHistory, restoreLeadRatingHistory } from '../services/leadRatingHistoryService.js'
import { collectCompanyIntel, scoreWithAgentDetailed } from '../services/inProcessAiWorkflowService.js'
import {
  leadScoreRetryPolicy,
  publicLeadScoreDeadLetterError,
  publicLeadScoreError,
} from '../services/leadScoreRetryPolicy.js'
import { prepareLeadScoringAuditContext } from '../services/leadScoringPipelineService.js'
import {
  LEAD_RATING_V3_PROMPT_VERSION,
  LEAD_RATING_V3_SCHEMA_VERSION,
  LEAD_RATING_V3_WORKFLOW,
  validateSnapshotBoundLeadRatingApplicability,
  validateSnapshotBoundLeadRatingEvidence,
} from '../services/leadRatingV3Service.js'
import { companyRegistrationEligibility, normalizeLeadRegistry } from '../services/leadRegistry.js'
import { isLeadScoringSubjectEligible, isSpecificLeadSubjectName } from '../services/leadSubjectName.js'
import {
  commitLeadPublicIntel,
  leadPublicIntelRawEventInput,
  meaningfulPublicIntelText,
  missingLeadCompanyIntelFields,
  type PublicIntelResult,
} from '../services/leadPublicIntelService.js'
import type { LeadCompanyIntelField } from '../services/leadCompanyIntelExtractionService.js'
import {
  evaluateRadarIntakeWorkflow,
  runPublicIntelEnrichmentAgents,
  runPublicIntelIntakeAgents,
} from '../services/leadOnlineWorkflowService.js'
import {
  fetchRadarWindow,
  readRadarCandidatesByIds,
  readRadarSyncState,
  saveRadarSyncState,
} from '../services/radarSyncService.js'
import { resolveLeadBusinessRegion } from '../services/leadRegion.js'
import {
  extractLeadFinancingFacts,
  extractLeadFinancingFactsWithStatus,
} from '../services/leadFinancingFactService.js'
import { reviewRadarCandidatesWithAi } from '../services/radarAiReviewService.js'
import { deriveRadarChannel, isRadarPaperCandidate } from '../services/radarChannel.js'
import { resolvePaperProjectIdentity } from '../services/paperIdentity.js'
import { recordLeadPipelineRawEvent, transitionLeadPipelineItem } from '../services/leadPipelineEventService.js'
import { openLeadPipelineReview } from '../services/leadPipelineAuditService.js'
import {
  listLeadPipelineReviews,
  resolveAndCommitLeadPipelineReview,
} from '../services/leadPipelineReviewService.js'

/** arxiv 学科分类 → 可读行业标签 */
const ARXIV_INDUSTRY_MAP: Record<string, string> = {
  'cs.AI': '人工智能',
  'cs.LG': '机器学习',
  'cs.CL': '自然语言处理',
  'cs.CV': '计算机视觉',
  'cs.IR': '信息检索',
  'cs.MA': '多智能体系统',
  'cs.CR': '网络安全',
  'cs.SE': '软件工程',
  'cs.CY': '计算与社会',
  'cs.SI': '社交网络',
  'cs.DS': '数据科学',
  'cs.IT': '信息论',
  'cs.LO': '计算逻辑',
  'cs.GT': '计算经济',
  'cs.DL': '信息检索',
  'stat.ML': '机器学习',
  'q-bio.QM': '生物医药',
  'q-bio.NC': '生物医药',
  'math.NA': '数学与计算',
}

/** 将 arxiv 分类列表翻译为行业标签 */
function arxivCategoriesToIndustry(categories: unknown): string {
  if (!Array.isArray(categories) || categories.length === 0) return '待确认'
  const labels = [...new Set(
    categories
      .map((c) => ARXIV_INDUSTRY_MAP[String(c).trim()])
      .filter(Boolean),
  )]
  return labels.length ? labels.join('、') : '待确认'
}

export const metaRouter = Router()
const metaRouteId = (value: string | string[]) => z.string().min(1).parse(value)

type PublicIntelContextEvidence = { title: string; snippet: string; url: string }

function publicIntelContextEvidence(value: unknown): PublicIntelContextEvidence[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const source = item as Record<string, unknown>
    const url = meaningfulPublicIntelText(source.url)
    const snippet = meaningfulPublicIntelText(source.excerpt || source.summary)
    if (!url || !snippet) return []
    return [{
      title: meaningfulPublicIntelText(source.title) || '线索池已有来源',
      snippet: snippet.slice(0, 1200),
      url,
    }]
  }).slice(0, 20)
}

async function collectPublicIntel(
  company: string,
  contextEvidence: PublicIntelContextEvidence[] = [],
  registryFields?: LeadCompanyIntelField[],
): Promise<PublicIntelResult> {
  return await collectCompanyIntel({ company, contextEvidence, registryFields }) as PublicIntelResult
}

metaRouter.get('/users', requireSystemAdmin, async (_req, res, next) => {
  try {
    const rows = await identityRepositories.users.listSafe()
    res.json({ list: rows, total: rows.length, page: 1, pageSize: rows.length })
  } catch (err) { next(err) }
})

const CreateManagedUserSchema = z.object({
  email: z.email().max(255),
  name: z.string().trim().min(1).max(64),
  role: z.string().trim().min(1).max(64),
  department: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
})

const UpdateManagedUserSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  role: z.string().trim().min(1).max(64).optional(),
  department: z.string().trim().min(1).max(64).optional(),
  status: z.enum(['启用', '禁用']).optional(),
}).strict()

metaRouter.post('/users', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const row = await createManagedUser(CreateManagedUserSchema.parse(req.body), {
      userId: req.user!.uid,
      userName: req.user!.name,
    })
    res.status(201).json(row)
  } catch (error) { next(error) }
})

metaRouter.patch('/users/:id', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const row = await updateManagedUser(
      metaRouteId(req.params.id),
      UpdateManagedUserSchema.parse(req.body),
      { userId: req.user!.uid, userName: req.user!.name },
    )
    res.json(row)
  } catch (error) { next(error) }
})

// Compatibility endpoint used by the existing client store. The authoritative
// status transition and its session revocation/audit still run in the service.
metaRouter.post('/users/:id/toggle-status', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const userId = metaRouteId(req.params.id)
    const current = await identityRepositories.users.findById(userId)
    if (!current) {
      res.status(404).json({ code: 'USER_NOT_FOUND', message: '用户不存在', details: null })
      return
    }
    const row = await updateManagedUser(userId, { status: current.status === '启用' ? '禁用' : '启用' }, {
      userId: req.user!.uid,
      userName: req.user!.name,
    })
    res.json(row)
  } catch (error) { next(error) }
})

metaRouter.post('/users/:id/reset-password', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ password: z.string().min(1).max(128) }).parse(req.body)
    const result = await resetManagedUserPassword(metaRouteId(req.params.id), body.password, {
      userId: req.user!.uid,
      userName: req.user!.name,
    })
    res.json(result)
  } catch (error) { next(error) }
})

metaRouter.get('/audit-logs', requireSystemAdmin, async (_req, res, next) => {
  try {
    const rows = await db.select({
      id: auditLogs.id,
      user: auditLogs.userName,
      module: auditLogs.module,
      action: auditLogs.action,
      target: auditLogs.target,
      ip: auditLogs.ip,
      result: auditLogs.result,
      requestId: auditLogs.requestId,
      createdAt: auditLogs.createdAt,
    }).from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(200)
    res.json({ list: rows, total: rows.length })
  } catch (err) { next(err) }
})

metaRouter.get('/templates', async (_req, res, next) => {
  try {
    const rows = await aiTaskRepository.listTaskTemplates()
    const list = rows.map((row) => ({
      id: row.type,
      name: row.label,
      type: row.outputFormat,
      version: row.templateVersion,
      updatedAt: row.updatedAt,
      status: row.status === 'enabled' ? '启用' : '停用',
    }))
    res.json({ list, total: list.length })
  } catch (err) { next(err) }
})

const LeadCreateSchema = z.object({
  name: z.string(),
  companyName: z.string().optional(),
  industry: z.string().optional(),
  businessRegion: z.string().optional(),
  businessRegionSource: z.string().optional(),
  businessRegionConfidence: z.string().optional(),
  source: z.string().optional(),
  summary: z.string().optional(),
  score: z.number().default(0),
  highlights: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  riskTags: z.array(z.string()).default([]),
  team: z.string().optional(),
  fundingRounds: z.array(z.unknown()).default([]),
  sources: z.array(z.unknown()).default([]),
})

// 公共池分页查询 —— 必传分页,pageSize 1-100,默认 50/1。
// 注意:返回结构改为 { list, total, page, pageSize, totalPages }(与此前 { list } 不兼容)。
// 旧前端代码不读 list 之外的字段,升级时同步改 store + SourcingPage。
const ListLeadsQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  channel: z.string().optional(),
  sort: z.enum(['latest', 'score']).optional(),
  keyword: z.string().optional(),  // 关键词全库跨字段检索
  source: z.string().optional(),   // 渠道二级标签(按 sourceName 模糊匹配)
  industry: z.string().optional(), // 行业检索（按 leads.industry LIKE 模糊匹配）
  region: z.string().optional(),   // 地区业务标签（按注册地/项目画像匹配）
  leadType: z.enum(['company', 'research']).optional(),
  stage: z.string().max(64).optional(),
  updatedRange: z.enum(['7d', '30d', '90d']).optional(),
})

const LeadReviewListQuery = z.object({
  status: z.enum(['pending', 'resolved', 'all']).default('pending'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})

const LeadReviewEvidenceSchema = z.object({
  sourceId: z.string().max(2_000).nullish(),
  sourceType: z.string().min(1).max(32),
  locator: z.string().max(2_000).nullish(),
  claim: z.string().min(1).max(8_000),
  quote: z.string().min(1).max(8_000),
  sourceUrl: z.string().max(4_000).nullish(),
  reliability: z.string().max(16).nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const ResolveLeadReviewSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  outcome: z.enum(['accept', 'reject']),
  subjectType: z.enum(['company', 'project', 'team', 'lab', 'paper']).nullish(),
  subjectName: z.string().max(128).nullish(),
  legalName: z.string().max(128).nullish(),
  confidence: z.coerce.number().min(0).max(100).nullish(),
  reason: z.string().min(2).max(8_000),
  evidence: z.array(LeadReviewEvidenceSchema).max(10).default([]),
  targetLeadId: z.string().uuid().nullish(),
}).superRefine((value, context) => {
  if (value.outcome !== 'accept') return
  if (!value.subjectType) context.addIssue({ code: 'custom', path: ['subjectType'], message: '接受线索必须选择主体类型' })
  if (!value.subjectName?.trim()) context.addIssue({ code: 'custom', path: ['subjectName'], message: '接受线索必须填写主体名称' })
  if (!value.evidence.length) context.addIssue({ code: 'custom', path: ['evidence'], message: '接受线索必须提供原文证据' })
})

metaRouter.get('/lead-pipeline/reviews', async (req: AuthedRequest, res, next) => {
  try {
    const query = LeadReviewListQuery.parse(req.query)
    res.json(await listLeadPipelineReviews({
      actor: {
        userId: req.user!.uid,
        userName: req.user!.name,
        role: req.user!.role,
      },
      ...query,
    }))
  } catch (error) { next(error) }
})

metaRouter.post('/lead-pipeline/reviews/:id/resolve', async (req: AuthedRequest, res, next) => {
  try {
    const body = ResolveLeadReviewSchema.parse(req.body)
    const result = await resolveAndCommitLeadPipelineReview({
      reviewId: metaRouteId(req.params.id),
      ...body,
    }, {
      userId: req.user!.uid,
      userName: req.user!.name,
      role: req.user!.role,
    })
    // 人工结论已经在事务中提交；后续评分排队失败不能把成功响应伪装成整笔失败，
    // 否则浏览器重试会让用户误以为结论尚未落库。队列自身可由恢复任务补偿。
    const scoringQueued = result.leadId && body.outcome === 'accept'
      ? await scheduleLeadScoring(result.leadId).catch((error) => {
          console.error('[lead-review] accepted lead scoring enqueue failed:', error)
          return false
        })
      : false
    res.json({ ...result, scoringQueued })
  } catch (error) { next(error) }
})

metaRouter.get('/leads', async (req, res, next) => {
  try {
    const { page, pageSize, channel, sort, keyword, source, industry, region, leadType, stage, updatedRange } = ListLeadsQuery.parse(req.query)
    res.json(await listLeads({ page, pageSize, channel, sort, keyword, source, industry, region, leadType, stage, updatedRange }))
  } catch (err) { next(err) }
})

// 单条线索详情(全字段含 jsonb 大字段),按需从列表里点详情时再拉
// 公共池全局统计(顶部卡片用,聚合全库不分页)。必须注册在 /leads/:id 之前
metaRouter.get('/leads/stats', async (_req, res, next) => {
  try { res.json(await leadPoolStats()) } catch (err) { next(err) }
})

metaRouter.get('/leads/:id', async (req, res, next) => {
  try {
    const row = await getLeadById(req.params.id)
    if (!row) return res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' })
    res.json(row)
  } catch (err) { next(err) }
})

metaRouter.get('/leads/:id/enrichment', requireSystemAdmin, async (req, res, next) => {
  try {
    const leadId = metaRouteId(req.params.id)
    const lead = await getLeadById(leadId, { includeHidden: true })
    if (!lead) return res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' })
    res.json(await getLeadEnrichmentStatus(leadId))
  } catch (error) { next(error) }
})

metaRouter.post('/leads/:id/enrichment', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const leadId = metaRouteId(req.params.id)
    const body = z.object({ idempotencyKey: z.string().min(8).max(128) }).strict().parse(req.body)
    const lead = await getLeadById(leadId)
    if (!lead) return res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' })
    const result = await enqueueLeadEnrichmentJob({
      leadId,
      triggerType: 'manual-refresh',
      idempotencyToken: body.idempotencyKey,
      priority: 50,
    })
    res.status(result.queued ? 202 : 200).json(result)
  } catch (error) { next(error) }
})

metaRouter.post('/leads/:id/enrichment/topics/:topic/retry', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const leadId = metaRouteId(req.params.id)
    const topicKey = z.enum(LEAD_ENRICHMENT_TOPIC_KEYS).parse(req.params.topic)
    const body = z.object({ reason: z.string().trim().min(4).max(2_000) }).strict().parse(req.body)
    const retried = await retryLeadEnrichmentTopic({
      leadId, topicKey, reason: body.reason,
      actor: { userId: req.user!.uid, userName: req.user!.name },
    })
    res.status(retried ? 202 : 409).json({ retried, leadId, topicKey })
  } catch (error) { next(error) }
})

metaRouter.post('/leads/:id/enrichment/entity/confirm', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const leadId = metaRouteId(req.params.id)
    const body = z.object({
      canonicalName: z.string().trim().min(2).max(255),
      entityType: z.enum(['company', 'project', 'team', 'research']).optional(),
      identifiers: z.object({
        creditCode: z.string().trim().max(64).optional(),
        websiteDomain: z.string().trim().max(255).optional(),
        legalRepresentative: z.string().trim().max(128).optional(),
        registeredAddress: z.string().trim().max(500).optional(),
      }).strict().optional(),
      reason: z.string().trim().min(4).max(2_000),
    }).strict().parse(req.body)
    const result = await confirmLeadEnrichmentEntity({
      leadId, ...body, actor: { userId: req.user!.uid, userName: req.user!.name },
    })
    res.status(result.alreadyConfirmed ? 200 : 202).json(result)
  } catch (error) { next(error) }
})

metaRouter.get('/leads/:id/enrichment/conflicts', requireSystemAdmin, async (req, res, next) => {
  try {
    const leadId = metaRouteId(req.params.id)
    const lead = await getLeadById(leadId, { includeHidden: true })
    if (!lead) return res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' })
    res.json({ leadId, conflicts: await listLeadEnrichmentConflicts(leadId) })
  } catch (error) { next(error) }
})

metaRouter.get('/leads/:id/facts', requireSystemAdmin, async (req, res, next) => {
  try {
    const leadId = metaRouteId(req.params.id)
    const query = z.object({
      topic: z.enum(LEAD_ENRICHMENT_TOPIC_KEYS).optional(),
      page: z.coerce.number().int().min(1).max(100_000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }).strict().parse(req.query)
    const lead = await getLeadById(leadId, { includeHidden: true })
    if (!lead) return res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' })
    res.json(await listLeadEnrichmentFacts({
      leadId, topicKey: query.topic, page: query.page, pageSize: query.pageSize,
    }))
  } catch (error) { next(error) }
})

metaRouter.get('/leads/:id/verified-profile', async (req, res, next) => {
  try {
    const leadId = metaRouteId(req.params.id)
    const lead = await getLeadById(leadId)
    if (!lead) return res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' })
    res.json(await getLeadEnrichmentDisplayProfile(leadId))
  } catch (error) { next(error) }
})

metaRouter.get('/leads/:id/verified-facts', async (req, res, next) => {
  try {
    const leadId = metaRouteId(req.params.id)
    const query = z.object({
      topic: z.enum(LEAD_ENRICHMENT_TOPIC_KEYS).optional(),
      page: z.coerce.number().int().min(1).max(100_000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }).strict().parse(req.query)
    const lead = await getLeadById(leadId)
    if (!lead) return res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' })
    res.json(await listLeadEnrichmentFacts({
      leadId, topicKey: query.topic, page: query.page, pageSize: query.pageSize,
      projection: 'verified-display',
    }))
  } catch (error) { next(error) }
})

metaRouter.get('/lead-enrichment/metrics', requireSystemAdmin, async (_req, res, next) => {
  try { res.json(await leadEnrichmentOperationalMetrics()) } catch (error) { next(error) }
})

metaRouter.get('/leads/:id/ratings/history', requireSystemAdmin, async (req, res, next) => {
  try {
    const leadId = metaRouteId(req.params.id)
    const query = z.object({
      page: z.coerce.number().int().min(1).max(100_000).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(10),
    }).strict().parse(req.query)
    const lead = await getLeadById(leadId, { includeHidden: true })
    if (!lead) return res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' })
    res.json(await listLeadRatingHistory({ leadId, page: query.page, pageSize: query.pageSize }))
  } catch (error) { next(error) }
})

metaRouter.post('/leads/:id/ratings/history/:historyId/restore', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ reason: z.string().trim().min(4).max(2_000) }).strict().parse(req.body)
    const result = await restoreLeadRatingHistory({
      leadId: metaRouteId(req.params.id), historyId: metaRouteId(req.params.historyId), reason: body.reason,
      actor: { userId: req.user!.uid, userName: req.user!.name },
    })
    res.json(result)
  } catch (error) { next(error) }
})

metaRouter.post('/leads/:id/enrichment/conflicts/:conflictId/resolve', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      decision: z.enum(['accept_fact', 'dismiss']),
      selectedFactId: z.string().uuid().optional(),
      reason: z.string().trim().min(4).max(2_000),
    }).strict().parse(req.body)
    const result = await resolveLeadEnrichmentConflict({
      leadId: metaRouteId(req.params.id), conflictId: metaRouteId(req.params.conflictId),
      ...body, actor: { userId: req.user!.uid, userName: req.user!.name },
    })
    res.status(202).json(result)
  } catch (error) { next(error) }
})

metaRouter.delete('/leads/:id', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const result = await deleteLeadFromPublicPool(metaRouteId(req.params.id), {
      userId: req.user!.uid,
      userName: req.user!.name,
    })
    if (!result) return res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' })
    res.json({
      code: 0,
      message: result.alreadyDeleted ? 'already_deleted' : 'deleted',
      deleted: result.id,
      name: result.name,
    })
  } catch (err) { next(err) }
})

// 对已入池公司再次检索公开来源，只合并带来源的有效字段，不覆盖现有 AI 评分。
metaRouter.post('/leads/:id/enrich-public-info', async (req: AuthedRequest, res, next) => {
  try {
    const leadId = String(req.params.id)
    const lead = await getLeadById(leadId)
    if (!lead) return res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' })
    const company = meaningfulPublicIntelText(lead.companyName)
      || meaningfulPublicIntelText(lead.name)
    if (!company) return res.status(400).json({ code: 'INVALID_SUBJECT', message: '公司主体名称尚未确认，无法检索公开信息' })

    const missingFields = missingLeadCompanyIntelFields({
      scoring: lead.scoring,
      radarProfile: lead.radarProfile,
      website: (lead as { website?: unknown }).website,
    })
    if (!missingFields.length) {
      res.json({
        lead,
        intel: null,
        skipped: true,
        reason: 'company registry fields are already complete',
      })
      return
    }

    const intel = await collectPublicIntel(company, publicIntelContextEvidence(lead.sources), missingFields)
    const captured = await recordLeadPipelineRawEvent(leadPublicIntelRawEventInput(company, intel))
    const registration = companyRegistrationEligibility(intel.registrationStatus)
    if (!registration.eligibleForLeadPool) {
      await excludeDeregisteredLeadFromPool({
        leadId, registrationStatus: registration.normalizedStatus,
        sourceUrl: intel.sources?.[0]?.url || '',
        actor: { userId: req.user!.uid, userName: req.user!.name },
      })
      res.status(202).json({
        lead: null,
        intel,
        eventId: captured.event.id,
        pipelineStatus: 'rejected',
        code: 'COMPANY_DEREGISTERED',
        reason: registration.reason,
      })
      return
    }
    const agentStages = await runPublicIntelEnrichmentAgents({
      eventId: captured.event.id,
      leadId,
      company,
      intel,
    })
    const committed = await commitLeadPublicIntel({
      company,
      intel,
      targetLeadId: leadId,
      userId: req.user!.uid,
    })
    void ingestLeadProfile(committed.lead)
    const updated = await getLeadById(leadId)
    res.json({
      lead: updated,
      intel,
      eventId: committed.eventId,
      replayed: committed.replayed,
      researchDecisionId: agentStages.research.decision.id,
      enrichmentDecisionId: agentStages.enrichment.decision.id,
    })
  } catch (err) { next(err) }
})

metaRouter.post('/leads', async (req: AuthedRequest, res, next) => {
  try {
    const body = LeadCreateSchema.parse(req.body)
    if (!isSpecificLeadSubjectName(body.name)) {
      return res.status(400).json({
        code: 'INVALID_SUBJECT_NAME',
        message: '主体名称不符合规范，请提供明确的项目、公司或团队名称',
      })
    }
    const row = await createLead({
      ...body,
      radarProfile: { qualityRejected: false },
    } as never, req.user!.uid)
    if (!row) throw new Error('线索创建后未返回记录')
    const { fieldProvenance: _internalFieldProvenance, ...publicRow } = row
    res.status(201).json(publicRow)
  } catch (err) { next(err) }
})

// 情报采集：输入公司名 → 主服务进程内抓取公开信息 → 结构化写入 leads 库
metaRouter.post('/leads/collect', async (req: AuthedRequest, res, next) => {
  try {
    const { company } = z.object({ company: z.string().min(2) }).parse(req.body)
    if (!isSpecificLeadSubjectName(company)) {
      return res.status(400).json({
        code: 'INVALID_COMPANY_NAME',
        message: '公司名称不符合规范，请提供明确的公司全称',
      })
    }
    const result = await collectPublicIntel(company)
    const captured = await recordLeadPipelineRawEvent(leadPublicIntelRawEventInput(company, result))
    const registration = companyRegistrationEligibility(result.registrationStatus)
    if (!registration.eligibleForLeadPool) {
      await transitionLeadPipelineItem(captured.event.id, {
        status: 'rejected',
        reason: registration.reason!,
        evidence: [{
          field: 'registrationStatus',
          value: registration.normalizedStatus,
          rule: 'deregistered-company-exclusion-v1',
        }],
        confidence: 100,
        actorType: 'system',
        actorId: 'lead-registration-admission-guard',
      })
      res.status(202).json({
        lead: null,
        intel: result,
        eventId: captured.event.id,
        pipelineStatus: 'rejected',
        code: 'COMPANY_DEREGISTERED',
        reason: registration.reason,
      })
      return
    }
    const agentStages = await runPublicIntelIntakeAgents({
      eventId: captured.event.id,
      company,
      intel: result,
    })
    const screeningOutcome = agentStages.screening.decision.outcome
    if (screeningOutcome !== 'accept') {
      const status = screeningOutcome === 'reject' ? 'rejected' : 'review'
      await transitionLeadPipelineItem(captured.event.id, {
        status,
        reason: agentStages.screening.decision.reason,
        evidence: [{ decisionId: agentStages.screening.decision.id }],
        confidence: agentStages.screening.decision.confidence ?? 0,
        actorType: 'agent',
        actorId: agentStages.screening.decision.actorId,
      })
      let reviewId: string | null = null
      if (status === 'review') {
        const review = await openLeadPipelineReview({
          idempotencyKey: `${captured.event.id}:public-intel-screening-review:v1`,
          eventId: captured.event.id,
          triggerDecisionId: agentStages.screening.decision.id,
          reason: agentStages.screening.decision.reason,
        })
        reviewId = review.id
      }
      res.status(202).json({
        lead: null,
        intel: result,
        eventId: captured.event.id,
        pipelineStatus: status,
        reviewId,
        researchDecisionId: agentStages.research.decision.id,
        screeningDecisionId: agentStages.screening.decision.id,
      })
      return
    }
    let committed: Awaited<ReturnType<typeof commitLeadPublicIntel>>
    try {
      committed = await commitLeadPublicIntel({
        company,
        intel: result,
        userId: req.user!.uid,
      })
    } catch (error) {
      const ambiguity = error as Error & {
        code?: string
        reviewStaged?: boolean
        eventId?: string
        reviewId?: string
      }
      if (ambiguity.code === 'PUBLIC_INTEL_ENTITY_AMBIGUOUS' && ambiguity.reviewStaged) {
        res.status(202).json({
          lead: null,
          intel: result,
          eventId: ambiguity.eventId ?? captured.event.id,
          pipelineStatus: 'review',
          reviewId: ambiguity.reviewId ?? null,
          duplicateMatches: true,
          researchDecisionId: agentStages.research.decision.id,
          screeningDecisionId: agentStages.screening.decision.id,
        })
        return
      }
      throw error
    }
    void ingestLeadProfile(committed.lead)
    res.status(committed.status === 'created' ? 201 : 200).json({
      lead: await getLeadById(committed.lead.id),
      intel: result,
      eventId: committed.eventId,
      replayed: committed.replayed,
      duplicateMatches: committed.duplicateMatches,
      researchDecisionId: agentStages.research.decision.id,
      screeningDecisionId: agentStages.screening.decision.id,
    })
  } catch (err) { next(err) }
})

// 从主进程内「项目发现雷达」采集投影同步真实融资线索到线索池
const RADAR_PLACEHOLDER_TEXT = new Set([
  '',
  '待核验',
  '待核实',
  '未披露',
  '未披露/待核实',
  '未披露/待验证',
  '未识别/待核实',
  '融资轮次待核实',
  '不适用',
  '无',
  '-',
  'N/A',
  'null',
])
const meaningfulRadarText = (value: unknown): string => {
  const text = String(value ?? '').trim()
  return text && !RADAR_PLACEHOLDER_TEXT.has(text) ? text : ''
}
const firstMeaningfulRadarText = (...values: unknown[]): string => {
  for (const value of values) {
    const text = meaningfulRadarText(value)
    if (text) return text
  }
  return ''
}

function radarCandidateResearchEvidence(item: Record<string, unknown>, subjectName: string): PublicIntelResult {
  const title = firstMeaningfulRadarText(item.title, subjectName) || subjectName
  const snippet = firstMeaningfulRadarText(
    item.article_text,
    item.articleText,
    item.summary,
    item.description,
    item.title,
  ).slice(0, 12_000)
  const url = firstMeaningfulRadarText(item.link, item.url, (item.project_profile as Record<string, unknown> | undefined)?.source_url)
  const fundingRounds = extractLeadFinancingFacts({
    text: snippet,
    sourceUrl: url,
    publishedAt: firstMeaningfulRadarText(item.published_at, item.collected_at),
  }).map((fact) => ({
    round: fact.round,
    roundRaw: fact.roundRaw,
    date: fact.date,
    amount: fact.amount,
    amountRaw: fact.amountRaw,
    currency: fact.currency,
    valuation: fact.valuation,
    investors: fact.investors.join('；'),
    sourceUrl: fact.sourceUrl,
    leadInvestors: fact.leadInvestors,
    evidenceQuote: fact.evidenceQuote,
    evidenceStatus: fact.evidenceStatus,
    extractionMethod: fact.extractionMethod,
    extractorVersion: fact.extractorVersion,
    idempotencyKey: fact.idempotencyKey,
  }))
  return {
    positioning: snippet.slice(0, 2_000),
    registeredCapital: '',
    legalRepresentative: '',
    foundedAt: '',
    region: '',
    registeredAddress: '',
    fundingRounds,
    shareholders: [],
    competitors: [],
    companyNews: [],
    sources: url ? [{ title, url, reliability: '雷达已采集公开来源' }] : [],
    searchEvidence: [{
      query: subjectName,
      title,
      snippet,
      url,
      publisher: firstMeaningfulRadarText(item.source_name, item.account_name, item.wx_name, item.source),
      publishedAt: firstMeaningfulRadarText(item.published_at, item.collected_at),
      reliability: '雷达已采集公开来源，仍需按原文核验',
    }],
    confidence: 0.5,
    fetchedAt: firstMeaningfulRadarText(item.collected_at, item.published_at) || new Date().toISOString(),
  }
}

const radarCandidateSourceKey = (item: Record<string, unknown>): string => {
  let source = String(item.source || 'unknown').trim() || 'unknown'
  for (const field of ['source_id', 'fingerprint', 'link', 'title']) {
    let value = String(item[field] || '').trim()
    if (!value) continue
    // 同一篇 arxiv 论文可能在 arxiv 文件和 investment 文件中各出现一次，
    // 用统一的 arxiv:ID 作为去重键，避免被审查两次。
    if (source === 'investment') {
      const arxivId = value.match(/arxiv\.org\/abs\/([0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?)/)?.[1]
      if (arxivId) {
        source = 'arxiv'
        value = arxivId
      }
    }
    return `${source}:${value}`
  }
  return ''
}

let radarSyncRunning = false

export type RadarSyncInput = {
  limit?: number
  incrementalPages?: number
  backfillPages?: number
  source?: string
  cursor?: string
  candidateIds?: string[]
}

export class RadarSyncAlreadyRunningError extends Error {
  readonly code = 'RADAR_SYNC_ALREADY_RUNNING'

  constructor() {
    super('上一轮雷达同步仍在运行，请稍后重试')
    this.name = 'RadarSyncAlreadyRunningError'
  }
}

// HTTP 路由和 MySQL 持久化调度器共享同一个进程内领域函数，禁止通过
// localhost HTTP + 固定内部密钥调用自身。
export async function runRadarSyncImport(input: RadarSyncInput = {}, actorUserId?: string) {
  if (radarSyncRunning) {
    throw new RadarSyncAlreadyRunningError()
  }
  radarSyncRunning = true
  try {
    const limit = Math.max(1, Math.min(Number(input.limit) || 50, 200))
    const incrementalPages = Math.max(1, Math.min(Number(input.incrementalPages) || 1, 10))
    const requestedBackfillPages = Number(input.backfillPages)
    const backfillPages = Number.isFinite(requestedBackfillPages)
      ? Math.max(0, Math.min(requestedBackfillPages, 10))
      : 0
    const src = (input.source ?? 'all').toString()  // 默认全部渠道
    const explicitCursor = String(input.cursor || '').trim()
    const candidateIds = Array.isArray(input.candidateIds) ? input.candidateIds.slice(0, 100) : []
    const stateId = src === 'all' ? 'main' : `source:${src}`
    let nextState: { backfillCursor: string | null; backfillComplete: boolean } | null = null
    let candidateTotal = 0
    let pagesFetched = 0
    let nextCursor = ''
    let hasMore = false
    const fetchedItems: Record<string, unknown>[] = []

    if (candidateIds.length > 0) {
      const selected = await readRadarCandidatesByIds(candidateIds)
      fetchedItems.push(...selected)
      candidateTotal = selected.length
      pagesFetched = selected.length ? 1 : 0
    } else if (explicitCursor) {
      const window = await fetchRadarWindow({
        pageSize: limit,
        maxPages: incrementalPages,
        cursor: explicitCursor,
        source: src,
      })
      fetchedItems.push(...window.items)
      candidateTotal = window.total
      pagesFetched = window.pages
      nextCursor = window.nextCursor
      hasMore = window.hasMore
    } else {
      const incremental = await fetchRadarWindow({
        pageSize: limit,
        maxPages: incrementalPages,
        source: src,
      })
      fetchedItems.push(...incremental.items)
      candidateTotal = incremental.total
      pagesFetched += incremental.pages
      nextCursor = incremental.nextCursor
      hasMore = incremental.hasMore

      // “全部渠道”的最新候选常被高频创投新闻占满。论文单独拉取一个窗口，
      // 避免即使雷达已采集 arXiv，公共池同步仍永远看不到论文。
      if (src === 'all') {
        const papers = await fetchRadarWindow({
          pageSize: limit,
          maxPages: 1,
          group: '论文',
        })
        fetchedItems.push(...papers.items)
        pagesFetched += papers.pages
      }

      const state = await readRadarSyncState(stateId)
      if (!state.backfillComplete && backfillPages > 0 && incremental.hasMore) {
        const backfillCursor = state.backfillCursor || incremental.nextCursor
        if (backfillCursor) {
          const backfill = await fetchRadarWindow({
            pageSize: limit,
            maxPages: backfillPages,
            cursor: backfillCursor,
            source: src,
          })
          fetchedItems.push(...backfill.items)
          pagesFetched += backfill.pages
          nextState = {
            backfillCursor: backfill.hasMore ? backfill.nextCursor : null,
            backfillComplete: !backfill.hasMore,
          }
        }
      } else if (!incremental.hasMore) {
        nextState = { backfillCursor: null, backfillComplete: true }
      }
    }

    const uniqueItems = new Map<string, Record<string, unknown>>()
    for (const item of fetchedItems) {
      const key = radarCandidateSourceKey(item)
      uniqueItems.set(key || `anonymous:${uniqueItems.size}`, item)
    }
    const items: any[] = [...uniqueItems.values()]
    // Every candidate crosses the common immutable event boundary before filtering,
    // model review, entity matching or formal lead writes.
    const pipelineEvents: Awaited<ReturnType<typeof recordLeadPipelineRawEvent>>[] = new Array(items.length)
    const rawEventConcurrency = Math.max(1, Math.min(
      Number(process.env.RADAR_PIPELINE_EVENT_CONCURRENCY) || 8,
      16,
    ))
    let rawEventCursor = 0
    await Promise.all(Array.from(
      { length: Math.min(rawEventConcurrency, items.length) },
      async () => {
        while (rawEventCursor < items.length) {
          const index = rawEventCursor++
          const item = items[index]
          pipelineEvents[index] = await recordLeadPipelineRawEvent({
            sourceType: 'radar',
            sourceId: radarCandidateSourceKey(item) || null,
            sourceOccurredAt: String(item.collected_at || item.published_at || '') || null,
            payload: item,
          })
        }
      },
    ))
    const transitionRadarCandidate = async (
      index: number,
      transition: Parameters<typeof transitionLeadPipelineItem>[1],
    ) => await transitionLeadPipelineItem(pipelineEvents[index].event.id, transition)
    const createdNames = new Set<string>()
    const updatedNames = new Set<string>()
    const unchangedNames = new Set<string>()
    const seenBatchNames = new Set<string>()
    const countedDatabaseDuplicateNames = new Set<string>()
    let batchDuplicates = 0
    let databaseDuplicates = 0
    let filteredOut = 0
    let invalid = 0
    let aiAccepted = 0
    let aiRejected = 0
    let aiReview = 0
    let aiFailed = 0
    let aiDeferred = 0
    let workflowAccepted = 0
    let workflowRejected = 0
    let workflowReview = 0
    let workflowFailed = 0
    let previouslyResolved = 0
    const createdIds: string[] = []
    const scoringLeadIds = new Set<string>()
    const splitList = (s: unknown, n = 6) => (s ? String(s).split(/；|;|\n/).map((x) => x.trim()).filter(Boolean).slice(0, n) : [])
    // 雷达已明确过滤的候选无需再调用大模型；只审查仍有入池可能的数据，
    // 避免低价值论文等占用网关资源并拖慢最新融资线索。
    const reviewableEntries = items
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => item.decision_label !== '过滤'
        && ['discovered', 'failed'].includes(pipelineEvents[index].item.status))
    const reviewedCandidates = await reviewRadarCandidatesWithAi(
      reviewableEntries.map(({ item }) => item),
      { eventIds: reviewableEntries.map(({ index }) => pipelineEvents[index].event.id) },
    )
    const subjectReviews = new Map(
      reviewableEntries.map(({ index }, reviewIndex) => [index, reviewedCandidates[reviewIndex]]),
    )
    const workflowResults = new Map<number, Awaited<ReturnType<typeof evaluateRadarIntakeWorkflow>>>()
    const workflowEntries: Array<{
      index: number
      item: Record<string, unknown>
      subjectType: 'company' | 'project' | 'team' | 'lab' | 'paper'
      subjectName: string
      legalName?: string
      evidence: unknown[]
      confidence: number
      attempt: number
    }> = []
    const workflowNames = new Set<string>()
    for (const { item, index } of reviewableEntries) {
      const subjectReview = subjectReviews.get(index)
      const subjectName = subjectReview?.subjectName.trim().slice(0, 120) || ''
      if (subjectReview?.status !== 'accepted' || !subjectReview.subjectType || !subjectName || workflowNames.has(subjectName)) continue
      workflowNames.add(subjectName)
      workflowEntries.push({
        index,
        item,
        subjectType: subjectReview.subjectType,
        subjectName,
        legalName: subjectReview.legalName || undefined,
        evidence: subjectReview.evidence ? [{ excerpt: subjectReview.evidence }] : [],
        confidence: subjectReview.confidence * 100,
        attempt: pipelineEvents[index].item.status === 'failed'
          ? pipelineEvents[index].item.processingAttempts + 1
          : 1,
      })
    }
    // The workflow commits entity-match, decision and pipeline state in
    // transactions. Keep the default below the MySQL pool width to avoid
    // deadlocks when a newly inherited source produces a full page at once.
    const workflowConcurrency = Math.max(1, Math.min(Number(process.env.RADAR_WORKFLOW_CONCURRENCY) || 2, 16))
    let workflowCursor = 0
    await Promise.all(Array.from(
      { length: Math.min(workflowConcurrency, workflowEntries.length) },
      async () => {
        while (workflowCursor < workflowEntries.length) {
          const entry = workflowEntries[workflowCursor++]
          let result: Awaited<ReturnType<typeof evaluateRadarIntakeWorkflow>>
          let workflowAttempt = entry.attempt
          for (let deadlockRetry = 0; ; deadlockRetry += 1) {
            result = await evaluateRadarIntakeWorkflow({
              eventId: pipelineEvents[entry.index].event.id,
              subjectType: entry.subjectType,
              subjectName: entry.subjectName,
              legalName: entry.legalName,
              subjectEvidence: entry.evidence,
              subjectConfidence: entry.confidence,
              providedPublicIntel: radarCandidateResearchEvidence(entry.item, entry.subjectName),
              attempt: workflowAttempt,
            })
            if (result.status !== 'failed'
              || !/deadlock found/i.test(result.error || '')
              || deadlockRetry >= 1) break
            workflowAttempt += 1
          }
          workflowResults.set(entry.index, result)
        }
      },
    ))
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const it = items[itemIndex]
      const currentPipelineStatus = pipelineEvents[itemIndex].item.status
      if (currentPipelineStatus === 'ready') {
        previouslyResolved += 1
        continue
      }
      if (currentPipelineStatus === 'review') {
        aiDeferred += 1
        continue
      }
      if (currentPipelineStatus === 'rejected') {
        filteredOut += 1
        continue
      }
      // 雷达服务自身的过滤标记（如论文综合分低于阈值、无投资信息等），
      // 与 AI 主体审查互补——AI 审查只管“名称是否可识别”，雷达过滤只管“是否有投资价值”。
      if (it.decision_label === '过滤') {
        await transitionRadarCandidate(itemIndex, {
          status: 'rejected',
          reason: 'radar deterministic filter rejected candidate',
          evidence: [{ decisionLabel: it.decision_label, sourceKey: radarCandidateSourceKey(it) }],
          confidence: 100,
          actorType: 'system',
          actorId: 'radar-deterministic-filter',
        })
        filteredOut += 1
        continue
      }

      const subjectReview = subjectReviews.get(itemIndex)
      if (subjectReview?.status === 'accepted') aiAccepted += 1
      else if (subjectReview?.status === 'rejected') aiRejected += 1
      else if (subjectReview?.status === 'review') aiReview += 1
      else aiFailed += 1

      // 模型失败或要求人工复核不是业务拒绝。候选仍保留在雷达源中，且 failed
      // 缓存不会被复用，下一次同步会自动重试。
      if (!subjectReview || subjectReview.status === 'failed' || subjectReview.status === 'review') {
        await transitionRadarCandidate(itemIndex, {
          status: subjectReview?.status === 'review' ? 'review' : 'failed',
          reason: subjectReview?.status === 'review'
            ? (subjectReview.rejectReason || 'radar subject requires manual review')
            : 'radar subject review failed',
          evidence: subjectReview?.evidence ? [{ excerpt: subjectReview.evidence }] : [],
          confidence: subjectReview ? subjectReview.confidence * 100 : 0,
          error: subjectReview?.status === 'failed' ? subjectReview.rejectReason || 'subject review failed' : null,
          actorType: 'agent',
          actorId: subjectReview?.model || 'radar-subject-review',
        })
        aiDeferred += 1
        continue
      }
      if (subjectReview.status === 'rejected') {
        await transitionRadarCandidate(itemIndex, {
          status: 'rejected',
          reason: subjectReview.rejectReason || 'radar subject rejected by review',
          evidence: subjectReview.evidence ? [{ excerpt: subjectReview.evidence }] : [],
          confidence: subjectReview.confidence * 100,
          actorType: 'agent',
          actorId: subjectReview.model,
        })
        filteredOut += 1
        continue
      }

      const name = subjectReview.subjectName.trim().slice(0, 120)
      const subjectType = subjectReview.subjectType
      if (!name || !subjectType) {
        await transitionRadarCandidate(itemIndex, {
          status: 'rejected',
          reason: 'accepted radar review returned an empty subject name or type',
          evidence: subjectReview.evidence ? [{ excerpt: subjectReview.evidence }] : [],
          confidence: subjectReview.confidence * 100,
          actorType: 'system',
          actorId: 'radar-subject-contract',
        })
        invalid += 1
        continue
      }
      const prof = it.project_profile || {}
      const isPaper = isRadarPaperCandidate(it)
      const paperTitleZh = isPaper ? meaningfulRadarText(subjectReview.translatedTitle) : ''
      const paperSummaryZh = isPaper ? meaningfulRadarText(subjectReview.translatedSummary) : ''
      const paperProjectIdentity = isPaper ? resolvePaperProjectIdentity({
        titleOriginal: it.title || prof.paper_title || name,
        titleZh: paperTitleZh,
        modelProjectName: subjectReview.paperProjectName,
        modelProjectNameZh: subjectReview.paperProjectNameZh,
      }) : { projectName: '', projectNameOriginal: '' }
      const publisherNames = [it.source_name, it.school, it.account_name, it.wx_name]
        .map((value: unknown) => meaningfulRadarText(value))
        .filter(Boolean)
      const channel = deriveRadarChannel(it)
      const fundingRound = meaningfulRadarText(prof.project_round)
      const financingAmount = meaningfulRadarText(prof.financing_amount)
      const latestValuation = meaningfulRadarText(prof.latest_valuation)
      if (seenBatchNames.has(name)) {
        await transitionRadarCandidate(itemIndex, {
          status: 'review',
          reason: 'duplicate normalized subject in the same radar batch',
          evidence: [{ subjectName: name, sourceKey: radarCandidateSourceKey(it) }],
          confidence: subjectReview.confidence * 100,
          actorType: 'system',
          actorId: 'radar-batch-dedup',
        })
        batchDuplicates += 1
        continue
      }
      else seenBatchNames.add(name)
      const workflowResult = workflowResults.get(itemIndex)
      if (!workflowResult) {
        await transitionRadarCandidate(itemIndex, {
          status: 'failed',
          reason: 'radar research or screening result is missing',
          evidence: subjectReview.evidence ? [{ excerpt: subjectReview.evidence }] : [],
          confidence: subjectReview.confidence * 100,
          error: 'workflow result missing after bounded orchestration',
          actorType: 'system',
          actorId: 'radar-workflow-orchestrator',
        })
        workflowFailed += 1
        aiDeferred += 1
        continue
      }
      if (workflowResult.status === 'failed') {
        workflowFailed += 1
        aiDeferred += 1
        continue
      }
      if (workflowResult.status !== 'accept') {
        if (workflowResult.status === 'review') {
          workflowReview += 1
          aiDeferred += 1
        } else {
          workflowRejected += 1
          filteredOut += 1
        }
        continue
      }
      workflowAccepted += 1
      const highlights = splitList(prof.core_highlights, 5)
      const nextActions: string[] = Array.isArray(it.next_actions) ? it.next_actions.map((x: unknown) => String(x)) : []
      const risks = splitList(prof.risk_notes, 5)
      const dims: any[] = Array.isArray(it.score_dimensions) ? it.score_dimensions : []
      const companyName = (
        subjectReview.legalName
        || (subjectReview.subjectType === 'company' ? name : '')
      ).slice(0, 120)

      const rawFundingInstitutions = meaningfulRadarText(prof.institutions)
      // 历史高校/公众号画像曾把来源账号写入 institutions；来源方不是投资方。
      const fundingInstitutions = publisherNames.includes(rawFundingInstitutions) ? '' : rawFundingInstitutions
      const hasFundingData = Boolean(fundingRound || financingAmount || latestValuation || fundingInstitutions)
      const fundingExtraction = extractLeadFinancingFactsWithStatus({
        text: firstMeaningfulRadarText(it.article_text, it.articleText, it.summary),
        sourceUrl: firstMeaningfulRadarText(it.link, prof.source_url),
        publishedAt: firstMeaningfulRadarText(it.published_at, it.collected_at),
      })
      const articleFundingRounds = fundingExtraction.facts.map((fact) => ({
        round: fact.round,
        roundRaw: fact.roundRaw,
        date: fact.date,
        amount: fact.amount,
        amountRaw: fact.amountRaw,
        currency: fact.currency,
        valuation: fact.valuation,
        investors: fact.investors,
        leadInvestors: fact.leadInvestors,
        sourceUrl: fact.sourceUrl,
        evidenceQuote: fact.evidenceQuote,
        evidenceStatus: fact.evidenceStatus,
        extractionMethod: fact.extractionMethod,
        extractorVersion: fact.extractorVersion,
        idempotencyKey: fact.idempotencyKey,
      }))
      const fundingRounds = articleFundingRounds.length ? articleFundingRounds : hasFundingData ? [{
        round: fundingRound || '待核验',
        amount: financingAmount || '未披露',
        valuation: latestValuation || '未披露',
        investors: fundingInstitutions || '待核验',
        sourceUrl: it.link || prof.source_url || '',
      }] : []
      // 雷达情报画像：原样存全部字段，前端详情弹窗"雷达情报"板块还原展示。
      // 注意：这里 NOT 写 leads.scoring —— scoring 留给“点击 AI 评测”后的统一 AI 评分流程。
      const radarProfile = {
        sourceId: firstMeaningfulRadarText(it.source_id, it.fingerprint),
        radarSourceKey: radarCandidateSourceKey(it),
        sourceTitle: it.title || '',
        decisionLabel: it.decision_label || '',
        thesis: prof.private_market_thesis || '',
        sourceName: it.source_name || it.source || '',
        sourceGroup: it.source_group || '',
        channel,
        accountName: it.account_name || it.wx_name || '',
        publishedAt: it.published_at || '',
        aiSubjectReview: {
          decision: subjectReview.decision,
          subjectType: subjectReview.subjectType,
          subjectName: subjectReview.subjectName,
          legalName: subjectReview.legalName,
          evidence: subjectReview.evidence,
          translatedTitle: paperTitleZh,
          paperProjectName: paperProjectIdentity.projectNameOriginal,
          paperProjectNameZh: paperProjectIdentity.projectName,
          translatedSummary: paperSummaryZh,
          confidence: subjectReview.confidence,
          model: subjectReview.model,
          reviewedAt: subjectReview.reviewedAt,
          cacheHit: subjectReview.cacheHit,
        },
        qualityRejected: false,
        qualityRejectReason: '',
        profile: {
          projectName: paperProjectIdentity.projectName || paperTitleZh || name,
          companyName,
          projectRound: prof.project_round || '',
          financingAmount: prof.financing_amount || '',
          latestValuation: prof.latest_valuation || '',
          institutions: prof.institutions || '',
          affiliatedInstitutions: prof.affiliated_institutions || '',
          industry: prof.industry || '',
          region: firstMeaningfulRadarText(
            prof.region,
            prof.business_region,
            prof.location,
            it.region,
            it.business_region,
            it.location,
          ),
          regionSource: firstMeaningfulRadarText(prof.region_source, it.region_source),
          regionConfidence: firstMeaningfulRadarText(prof.region_confidence, it.region_confidence),
          coreHighlights: prof.core_highlights || '',
          riskNotes: prof.risk_notes || '',
          teamComposition: prof.team_composition || '',
          lab: prof.lab || '',
          contact: prof.contact || '',
        },
        // 雷达规则评分（多维），点击 AI 评测前先展示这套
        radarDimensions: dims.map((d) => ({ code: d.code, label: d.label || d.code, score: Number(d.score) || 0, maxScore: Number(d.max_score) || 0, detail: (d.detail || '').toString() })),
        radarScore: typeof it.attention_score === 'number' ? it.attention_score : 0,
        disclosure: it.disclosure_status || {},
        nextActions,
        signals: Array.isArray(it.signals) ? it.signals.map((s: any) => ({ code: s.code, score: s.score, detail: s.detail })) : [],
        articleText: (it.article_text || '').toString().slice(0, 20000),
        articleTextLength: it.article_text_length || 0,
        sourceFetch: {
          status: firstMeaningfulRadarText(it.fetch_status, it.content_status)
            || (firstMeaningfulRadarText(it.article_text, it.articleText) ? 'content_available' : 'content_unavailable'),
        },
        fundingExtraction: {
          status: fundingExtraction.status,
          extractorVersion: fundingExtraction.extractorVersion,
          error: fundingExtraction.error || '',
        },
        fundingRounds,
        link: it.link || prof.source_url || '',
        // 论文原文用于来源核验和评分，中文译文仅用于产品展示；两者不能互相覆盖。
        paperMeta: isPaper ? {
          title: it.title || prof.paper_title || name,
          titleOriginal: it.title || prof.paper_title || name,
          titleZh: paperTitleZh,
          projectName: paperProjectIdentity.projectName,
          projectNameOriginal: paperProjectIdentity.projectNameOriginal,
          authors: Array.isArray(it.authors) ? it.authors : String(it.authors || prof.paper_authors || '').split(/[,;，；]/).map((x: string) => x.trim()).filter(Boolean),
          firstAuthor: it.first_author || prof.paper_first_author || (Array.isArray(it.authors) ? it.authors[0] : ''),
          secondAuthor: it.second_author || prof.paper_second_author || (Array.isArray(it.authors) ? it.authors[1] : ''),
          categories: Array.isArray(it.categories) ? it.categories : String(it.categories || prof.paper_categories || '').split(/[,，;；]/).map((x: string) => x.trim()).filter(Boolean),
          venue: it.journal_ref || prof.paper_venue || '',
          comment: it.comment || prof.paper_comment || '',
          pdfUrl: it.pdf_url || prof.paper_pdf_url || '',
          abstract: (it.summary || '').toString().slice(0, 4000),
          abstractOriginal: (it.summary || '').toString().slice(0, 4000),
          abstractZh: paperSummaryZh,
          publishedAt: it.published_at || '',
          declaredPublishedAt: it.declared_published_at || '',
          publicationDateStatus: it.publication_date_status || 'confirmed',
          publicationDateBasis: it.publication_date_basis || 'publisher_published_at',
          doi: it.doi || '',
          resourceType: it.paper_resource_type || '',
          affiliations: Array.isArray(it.paper_affiliations) ? it.paper_affiliations : [],
          paperAuthors: Array.isArray(it.paper_authors) ? it.paper_authors : [],
          authorAffiliations: Array.isArray(it.paper_author_affiliations) ? it.paper_author_affiliations : [],
          researchTeam: it.paper_research_team && typeof it.paper_research_team === 'object' ? it.paper_research_team : undefined,
          authorContributions: Array.isArray(it.paper_author_contributions) ? it.paper_author_contributions : [],
          rights: it.paper_rights && typeof it.paper_rights === 'object' ? it.paper_rights : undefined,
          metadataSource: it.paper_metadata_source && typeof it.paper_metadata_source === 'object' ? it.paper_metadata_source : undefined,
        } : {},
      }
      const regionResolution = resolveLeadBusinessRegion({
        profile: radarProfile.profile,
        subjectName: name,
        companyName,
        sourceGroup: radarProfile.sourceGroup,
        channel: radarProfile.channel,
        sourceName: radarProfile.sourceName,
        accountName: radarProfile.accountName,
        sourceTitle: radarProfile.sourceTitle,
        summary: it.summary,
        articleText: radarProfile.articleText,
      })
      let syncResult: Awaited<ReturnType<typeof commitRadarLeadPipelineReady>> | null = null
      try {
        syncResult = await commitRadarLeadPipelineReady({
          lead: {
            name,
            companyName: companyName || null,
            industry: (isPaper
              ? arxivCategoriesToIndustry(it.categories)
              : (prof.industry || '待核验').toString().slice(0, 64)),
            businessRegion: regionResolution?.region,
            businessRegionSource: regionResolution?.source,
            businessRegionConfidence: regionResolution?.confidence,
            source: isPaper
              ? `项目发现雷达 · ${it.source_name || it.source || '论文'}`
              : `项目发现雷达 · ${it.source_name || it.source || '公开渠道'}`,
            poolStatus: '成功',
            summary: (isPaper
              ? (paperSummaryZh || it.summary || prof.core_highlights || '')
              : (it.summary || prof.core_highlights || '')).toString().slice(0, 1000),
            highlights,
            risks,
            team: [prof.team_composition, prof.lab && `实验室：${prof.lab}`].filter(Boolean).join('\n').slice(0, 800) || '待核验',
            fundingRounds,
            riskTags: (it.decision_label ? [it.decision_label] : []),
            radarSourceKeys: radarCandidateSourceKey(it) ? [radarCandidateSourceKey(it)] : [],
            radarProfile,
            sources: [{ title: it.title || name, url: it.link || prof.source_url || '', reliability: '中', category: it.source_group || '公开渠道', excerpt: (it.summary || '').toString().slice(0, 200) }],
          },
          eventId: pipelineEvents[itemIndex].event.id,
          transition: {
            reason: 'reviewed radar candidate committed by host service',
            evidence: [{
              subjectName: name,
              excerpt: subjectReview.evidence,
              sourceKey: radarCandidateSourceKey(it),
            }],
            confidence: subjectReview.confidence * 100,
            actorType: 'system',
            actorId: 'radar-sync-import',
          },
          userId: actorUserId,
        })
      } catch (syncErr) {
        const syncFailure = syncErr as Error & {
          code?: string
          duplicateMatches?: number
          reviewStaged?: boolean
        }
        if (syncFailure.code === 'RADAR_LEAD_ENTITY_AMBIGUOUS' && syncFailure.reviewStaged) {
          if (!countedDatabaseDuplicateNames.has(name)) {
            countedDatabaseDuplicateNames.add(name)
            databaseDuplicates += Math.max(1, Number(syncFailure.duplicateMatches) || 1)
          }
          aiDeferred += 1
          console.warn('[radar-sync] 主体命中多条正式线索，已转人工复核：', name)
          continue
        }
        await transitionRadarCandidate(itemIndex, {
          status: 'failed',
          reason: 'host service failed to commit reviewed radar candidate',
          evidence: subjectReview.evidence ? [{ excerpt: subjectReview.evidence }] : [],
          confidence: subjectReview.confidence * 100,
          error: syncFailure.message || String(syncErr),
          actorType: 'system',
          actorId: 'radar-sync-import',
        })
        console.error('[radar-sync] 跳过同步失败的候选项（不影响其他项）：', syncFailure.message.slice(0, 200))
        invalid += 1
        continue
      }

      if (syncResult!.duplicateMatches > 0 && !countedDatabaseDuplicateNames.has(name)) {
        countedDatabaseDuplicateNames.add(name)
        databaseDuplicates += syncResult!.duplicateMatches
      }
      if (syncResult!.status === 'created') {
        createdNames.add(name)
        updatedNames.delete(name)
        unchangedNames.delete(name)
        if (syncResult!.row?.id) {
          createdIds.push(syncResult!.row.id)
          scoringLeadIds.add(syncResult!.row.id)
        }
      } else if (syncResult!.status === 'updated') {
        if (!createdNames.has(name)) updatedNames.add(name)
        unchangedNames.delete(name)
        if (syncResult!.row?.id) scoringLeadIds.add(syncResult!.row.id)
      } else if (!createdNames.has(name) && !updatedNames.has(name)) {
        unchangedNames.add(name)
      }
    }
    const created = createdNames.size
    const updated = updatedNames.size
    const unchanged = unchangedNames.size
    const duplicates = batchDuplicates + databaseDuplicates
    const scoringIds = [...scoringLeadIds]
    let scoringQueued = 0
    for (const leadId of scoringIds) {
      if (await scheduleLeadScoring(leadId)) scoringQueued += 1
    }
    if (nextState && !explicitCursor) {
      await saveRadarSyncState({
        id: stateId,
        backfillCursor: nextState.backfillCursor,
        backfillComplete: nextState.backfillComplete,
      })
    }
    return {
      ok: true,
      fetched: items.length,
      reviewed: reviewableEntries.length,
      candidateTotal,
      pagesFetched,
      nextCursor,
      hasMore,
      backfillComplete: nextState?.backfillComplete ?? null,
      created,
      updated,
      unchanged,
      skipped: unchanged + filteredOut + aiDeferred + invalid + previouslyResolved,
      duplicates,
      batchDuplicates,
      databaseDuplicates,
      filtered: filteredOut,
      deferred: aiDeferred,
      invalid,
      aiAccepted,
      aiRejected,
      aiReview,
      aiFailed,
      workflowAccepted,
      workflowRejected,
      workflowReview,
      workflowFailed,
      previouslyResolved,
      createdIds,
      scoringIds,
      scoringQueued,
    }
  } finally {
    radarSyncRunning = false
  }
}

metaRouter.post('/leads/sync-radar', async (req: AuthedRequest, res, next) => {
  try {
    res.json(await runRadarSyncImport(req.body ?? {}, req.user?.uid))
  } catch (err) {
    if (err instanceof RadarSyncAlreadyRunningError) {
      res.status(409).json({ code: 'RADAR_SYNC_RUNNING', message: err.message })
      return
    }
    next(err)
  }
})

// 项目评分：HTTP 请求只负责写入 MySQL 队列并秒回。
// 排队、抢占、租约和延迟重试由 lead_score_jobs 驱动，leads.scoring.scoreJob 是前端展示快照。
const SCORE_MAX_ATTEMPTS = Math.max(1, Math.min(4, parseInt(process.env.SCORE_MAX_ATTEMPTS || '3', 10)))
const SCORE_REQUEST_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.SCORE_REQUEST_TIMEOUT_MS || '360000', 10))
const SCORE_RETRY_BASE_MS = Math.max(1_000, parseInt(process.env.SCORE_RETRY_BASE_MS || '5000', 10))
const SCORE_DEFERRED_RETRY_LIMIT = Math.max(0, Math.min(5, parseInt(process.env.SCORE_DEFERRED_RETRY_LIMIT || '3', 10)))
const SCORE_DEFERRED_RETRY_MS = Math.max(10_000, parseInt(process.env.SCORE_DEFERRED_RETRY_MS || '60000', 10))

export async function scheduleLeadScoring(
  leadId: string,
  options: {
    recovering?: boolean
    manualRetry?: boolean
    automaticCircuitRecovery?: boolean
    actor?: { userId?: string | null; userName: string }
  } = {},
): Promise<boolean> {
  const lead = await getLeadById(leadId)
  if (!lead) return false
  const radarProfile = (lead as { radarProfile?: Record<string, unknown> }).radarProfile ?? {}
  if (
    radarProfile.qualityRejected === true
    || String(radarProfile.qualityRejected ?? '') === 'true'
    || !(await isLeadEligibleForScoring(leadId))
  ) {
    await clearLeadScoreJob(leadId)
    console.warn(`[lead-score] skip ineligible lead=${leadId} name=${lead.name}`)
    return false
  }
  const isPaper = String(radarProfile.channel ?? '') === '论文'
  if (!isLeadScoringSubjectEligible(lead as unknown as Record<string, unknown>, isPaper)) {
    console.warn(`[lead-score] skip invalid subject lead=${leadId} name=${lead.name}`)
    return false
  }
  const previous = readLeadScoreJob((lead as { scoring?: unknown }).scoring)
  if (options.manualRetry && !['failed', 'dead_letter'].includes(previous?.status ?? '')) return false
  if (options.automaticCircuitRecovery && (
    previous?.status !== 'dead_letter'
    || leadScoreRetryPolicy(new Error(previous.error || '')).category !== 'circuit'
  )) return false
  if (!options.manualRetry && !options.automaticCircuitRecovery && previous?.status === 'dead_letter') return false
  const now = new Date().toISOString()
  const attempts = options.recovering
    ? Math.min(previous?.attempts ?? 0, SCORE_MAX_ATTEMPTS - 1)
    : 0
  const retryCycles = options.recovering ? previous?.retryCycles ?? 0 : 0
  const job: LeadScoreJob = {
    status: 'queued',
    attempts,
    maxAttempts: SCORE_MAX_ATTEMPTS,
    retryCycles,
    queuedAt: previous?.queuedAt ?? now,
    updatedAt: now,
    error: undefined,
  }
  const enrichment = await getLeadEnrichmentStatus(leadId)
  if (!enrichment.job) {
    const prerequisite = await enqueueLeadEnrichmentJob({
      leadId,
      triggerType: 'score-prerequisite',
      idempotencyToken: 'score-prerequisite-v1',
      priority: 40,
    })
    console.warn(`[lead-score] enrichment prerequisite lead=${leadId} queued=${prerequisite.queued} reason=${prerequisite.reason || 'none'}`)
    return false
  }
  if (enrichment.snapshot?.status !== 'ready') {
    console.warn(`[lead-score] wait for enrichment snapshot lead=${leadId} enrichment=${enrichment.status}`)
    return false
  }
  try {
    const queued = await enqueueLeadScoreJob(leadId, {
      recovering: options.recovering,
      manualRetry: options.manualRetry,
      manualRetryAudit: options.manualRetry ? {
        userId: options.actor?.userId,
        userName: options.actor?.userName ?? '（系统）',
        target: lead.name,
      } : undefined,
      automaticCircuitRecovery: options.automaticCircuitRecovery ? { target: lead.name } : undefined,
      snapshot: job as unknown as Record<string, unknown>,
      enrichmentSnapshotId: enrichment.snapshot.id,
      snapshotHash: enrichment.snapshot.hash,
      ratingSchemaVersion: LEAD_RATING_V3_SCHEMA_VERSION,
    })
    if (!queued) return false
  } catch (error) {
    console.error(`[lead-score] persist queued failed lead=${leadId}:`, (error as Error).message)
    return false
  }
  return true
}

export async function recoverLeadScoringQueue(limit = 500) {
  const leadIds = await listRecoverableLeadScoreIds(limit)
  const circuitDeadLetterIds = await listCircuitDeadLetterLeadScoreIds(limit)
  let recovered = 0
  for (const leadId of leadIds) {
    if (await scheduleLeadScoring(leadId, { recovering: true })) recovered += 1
  }
  let circuitDeadLettersRecovered = 0
  for (const leadId of circuitDeadLetterIds) {
    if (await scheduleLeadScoring(leadId, { automaticCircuitRecovery: true })) {
      recovered += 1
      circuitDeadLettersRecovered += 1
    }
  }
  return {
    found: leadIds.length + circuitDeadLetterIds.length,
    recovered,
    circuitDeadLettersFound: circuitDeadLetterIds.length,
    circuitDeadLettersRecovered,
  }
}

function scoreDelay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function deferLeadScoringRetry(
  leadId: string,
  input: {
    error: Error
    queuedAt?: string
    startedAt?: string
    retryCycles: number
    delayMs?: number
  },
): Promise<LeadScoreExecutionResult> {
  const retryCycles = input.retryCycles + 1
  const delayMs = Math.min(
    86_400_000,
    Math.max(
      input.delayMs ?? 0,
      SCORE_DEFERRED_RETRY_MS * retryCycles,
    ) + 10_000 + Math.floor(Math.random() * 20_001),
  )
  const now = new Date().toISOString()
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString()
  const retryingJob: LeadScoreJob = {
    status: 'retrying',
    attempts: SCORE_MAX_ATTEMPTS,
    maxAttempts: SCORE_MAX_ATTEMPTS,
    retryCycles,
    queuedAt: input.queuedAt ?? now,
    startedAt: input.startedAt,
    updatedAt: now,
    nextRetryAt,
    error: input.error.message,
  }
  await saveLeadScoreJob(leadId, retryingJob)
  return {
    status: 'retrying',
    nextAttemptAt: new Date(nextRetryAt),
    error: input.error.message,
  }
}

type ScoreWorkflowResult = {
  total: number
  verdict: string
  overall_comment: string
  dimensions: unknown[]
  projectName?: string
  [key: string]: unknown
}

async function requestScoreWorkflow(
  scoreWorkflow: typeof LEAD_RATING_V3_WORKFLOW,
  requestBody: Record<string, unknown>,
  audit: Awaited<ReturnType<typeof prepareLeadScoringAuditContext>>,
): Promise<ScoreWorkflowResult> {
  const detailed = await scoreWithAgentDetailed(
    scoreWorkflow,
    requestBody,
    { audit },
  )
  const result = detailed.result as ScoreWorkflowResult
  if (!Array.isArray(result.dimensions) || result.dimensions.length === 0) {
    throw new Error('评分服务返回空或缺少评分维度')
  }
  return {
    ...result,
    provenance: 'agent-run',
    evidenceChain: detailed.audit,
    scoringExecution: {
      workflow: detailed.workflow,
      model: detailed.model,
      promptVersion: detailed.promptVersion,
      runId: detailed.audit?.runId ?? null,
      decisionId: detailed.audit?.decisionId ?? null,
    },
  }
}

export async function executeLeadScoring(leadId: string): Promise<LeadScoreExecutionResult> {
  let runStartedAt: string | undefined
  let currentAttempt = 0
  let currentRetryCycles = 0
  try {
    // 评分需要 lead 完整字段(sources/radarProfile/scoring/fundingRounds),listLeads 不返回这些
    const lead = await getLeadById(leadId)
    if (!lead) throw new Error('线索不存在')
    // 只使用线索池和雷达已经入库的资料，不再在评分阶段发起外部检索。
    const rp = (lead as { radarProfile?: Record<string, unknown> }).radarProfile || {}
    const isPaper = String((rp as { channel?: string }).channel || '') === '论文'
    if (
      rp.qualityRejected === true
      || String(rp.qualityRejected ?? '') === 'true'
      || !isLeadScoringSubjectEligible(lead as unknown as Record<string, unknown>, isPaper)
      || !(await isLeadEligibleForScoring(leadId))
    ) {
      // 记录可能在入队后被质量回填标记为无效；执行前必须再次拦截，
      // 并清除持久化队列状态，避免重启恢复时反复入队。
      await clearLeadScoreJob(leadId)
      console.warn(`[lead-score] discard invalid queued lead=${leadId} name=${lead.name}`)
      return { status: 'discarded' }
    }
    // 共享线索统一走独立 V3 评级流程。专属项目继续使用 score-project，
    // 因而本次评级升级不会改变“我的专属项目”板块的既有评分契约。
    // 论文/科研成果由 V3 的阶段适配和 N/A 规则处理，不再用缺少融资资料机械扣分。
    const scoreWorkflow = LEAD_RATING_V3_WORKFLOW
    const scoreBinding = await getLeadScoreJobBinding(leadId)
    if (!scoreBinding?.enrichmentSnapshotId || !scoreBinding.snapshotHash
      || scoreBinding.ratingSchemaVersion !== LEAD_RATING_V3_SCHEMA_VERSION) {
      await enqueueLeadEnrichmentJob({
        leadId,
        triggerType: 'score-prerequisite',
        idempotencyToken: 'score-prerequisite-v1',
        priority: 40,
      })
      console.warn(`[lead-score] discard legacy unbound score job lead=${leadId}; enrichment prerequisite required`)
      return { status: 'discarded' }
    }
    const boundSnapshot = await loadLeadEnrichmentSnapshot(scoreBinding.enrichmentSnapshotId, leadId)
    if (
      !boundSnapshot
      || boundSnapshot.status !== 'ready'
      || boundSnapshot.snapshotHash !== scoreBinding.snapshotHash
    ) {
      throw new Error('评分任务绑定的补全快照缺失、未就绪或哈希不一致')
    }
    const ratingSubjectProfile = leadRatingSubjectProfile(boundSnapshot.subjectProfile)
    const requestBody = {
      projectName: ratingSubjectProfile.identity.name || lead.name,
      industry: ratingSubjectProfile.identity.industry,
      enrichmentSnapshot: {
        id: boundSnapshot.id,
        hash: boundSnapshot.snapshotHash,
        schemaVersion: boundSnapshot.schemaVersion,
        frozenAt: boundSnapshot.frozenAt,
        coverage: boundSnapshot.coverage,
        subjectProfile: ratingSubjectProfile,
        topicStates: boundSnapshot.topicStates,
        facts: boundSnapshot.facts,
        evidenceIndex: boundSnapshot.evidenceIndex,
        gaps: boundSnapshot.gaps,
        conflicts: boundSnapshot.conflicts,
      },
    }
    let result: ScoreWorkflowResult | null = null
    let finalError: Error | null = null
    const persisted = readLeadScoreJob((lead as { scoring?: unknown }).scoring)
    runStartedAt = persisted?.startedAt ?? new Date().toISOString()
    const retryCycles = persisted?.retryCycles ?? 0
    currentRetryCycles = retryCycles
    const initialAttempts = Math.min(persisted?.attempts ?? 0, SCORE_MAX_ATTEMPTS - 1)
    for (let attempt = initialAttempts + 1; attempt <= SCORE_MAX_ATTEMPTS; attempt += 1) {
      currentAttempt = attempt
      const now = new Date().toISOString()
      const runningJob: LeadScoreJob = {
        status: 'running',
        attempts: attempt,
        maxAttempts: SCORE_MAX_ATTEMPTS,
        retryCycles,
        queuedAt: persisted?.queuedAt ?? now,
        startedAt: runStartedAt,
        updatedAt: now,
      }
      await saveLeadScoreJob(leadId, runningJob)
      try {
        const audit = await prepareLeadScoringAuditContext({
          leadId,
          workflow: scoreWorkflow,
          scoringInput: requestBody,
          queueAttempt: attempt,
        })
        result = await requestScoreWorkflow(scoreWorkflow, requestBody, audit)
        finalError = null
        break
      } catch (error) {
        finalError = error as Error
        const retryPolicy = leadScoreRetryPolicy(error)
        if (attempt >= SCORE_MAX_ATTEMPTS || !retryPolicy.retryable || retryPolicy.deferImmediately) break
        const retryAt = new Date(Date.now() + SCORE_RETRY_BASE_MS * attempt).toISOString()
        const retryingJob: LeadScoreJob = {
          ...runningJob,
          status: 'retrying',
          updatedAt: new Date().toISOString(),
          nextRetryAt: retryAt,
          error: finalError.message,
        }
        await saveLeadScoreJob(leadId, retryingJob)
        await scoreDelay(SCORE_RETRY_BASE_MS * attempt)
      }
    }
    if (!result) {
      const error = finalError ?? new Error('评分服务未返回结果')
      const retryPolicy = leadScoreRetryPolicy(error)
      const waitsForCircuitRecovery = retryPolicy.category === 'circuit'
      if (retryPolicy.retryable && (waitsForCircuitRecovery || retryCycles < SCORE_DEFERRED_RETRY_LIMIT)) {
        console.warn(
          `[lead-score] ${retryPolicy.category} failure lead=${leadId}, deferred retry cycle=${retryCycles + 1}/${waitsForCircuitRecovery ? 'until-recovery' : SCORE_DEFERRED_RETRY_LIMIT}:`,
          error.message,
        )
        return await deferLeadScoringRetry(leadId, {
          error,
          queuedAt: persisted?.queuedAt,
          startedAt: runStartedAt,
          retryCycles,
          delayMs: retryPolicy.delayMs,
        })
      }
      throw error
    }
    if (boundSnapshot) {
      validateSnapshotBoundLeadRatingEvidence(result.ratingV3, boundSnapshot.facts)
      validateSnapshotBoundLeadRatingApplicability(result.ratingV3, boundSnapshot.topicStates)
    }

    const industry = lead.industry
    // 改用 listLeadScoresForRanking 拉全表 industry+total 极轻量列表(避免 listLeads 全表反序列化大 jsonb)
    const allScoresForRank = await listLeadScoresForRanking()
    const peers = allScoresForRank
      .filter((l) => l.industry === industry && l.id !== lead.id && l.total != null)
      .map((l) => l.total as number)
    const ratingV3ForRanking = result.ratingV3 as { computed?: { score?: number | null } } | undefined
    const formalRatingScore = ratingV3ForRanking?.computed?.score
    const rankableScore = result.ratingV3 ? formalRatingScore : result.total
    const allScores = (rankableScore == null ? peers : [...peers, rankableScore]).sort((a, b) => b - a)
    const rankIndex = rankableScore == null ? -1 : allScores.indexOf(rankableScore)
    const percentile = rankIndex < 0
      ? null
      : allScores.length > 1 ? Math.round((1 - rankIndex / (allScores.length - 1)) * 100) : 100
    const completedAt = new Date().toISOString()
    const completedScoreJob = {
      status: 'done',
      attempts: currentAttempt || 1,
      maxAttempts: SCORE_MAX_ATTEMPTS,
      retryCycles,
      queuedAt: persisted?.queuedAt,
      startedAt: runStartedAt,
      updatedAt: completedAt,
      completedAt,
      enrichmentSnapshotId: boundSnapshot?.id,
      snapshotHash: boundSnapshot?.snapshotHash,
      ratingSchemaVersion: boundSnapshot ? 'lead-rating-v3' : undefined,
    } satisfies LeadScoreJob
    const resultRatingV3 = result.ratingV3 && typeof result.ratingV3 === 'object'
      ? result.ratingV3 as Record<string, unknown>
      : null
    const scoring = {
      ...result,
      // 无法评级不是低分：V3 资料不足时不写入兼容总分，也不参与同赛道排名。
      total: result.ratingV3 && formalRatingScore == null ? null : result.total,
      ratingV3: resultRatingV3 ? {
        ...resultRatingV3,
        status: 'ready',
        scoredAt: completedAt,
        scoreJob: completedScoreJob,
        enrichmentSnapshotId: boundSnapshot?.id,
        snapshotHash: boundSnapshot?.snapshotHash,
        ratingSchemaVersion: boundSnapshot ? 'lead-rating-v3' : undefined,
      } : undefined,
      // 评分结果只补充判断字段；工商、团队、股东、融资及来源继续以入库资料为准。
      projectName: result.projectName || lead.name,
      whatIsIt: (rp as { profile?: { projectName?: string } }).profile?.projectName || lead.summary,
      officialSite: (rp.officialSite as string) || '待核验',
      registry: normalizeLeadRegistry(
        (lead.scoring as { registry?: unknown } | undefined)?.registry,
        rp.registry,
      ),
      structuredTeam: rp.team || [],
      structuredShareholders: rp.shareholders || [],
      fundingRoundsResearched: Array.isArray(lead.fundingRounds) && lead.fundingRounds.length
        ? lead.fundingRounds
        : (rp.fundingRounds || []),
      structuredNews: rp.news || [],
      researchSources: lead.sources || [],
      rank: { peers_count: allScores.length, position: rankIndex < 0 ? null : rankIndex + 1, percentile, industry: industry ?? '未分类' },
      scored_at: completedAt,
      scoreJob: completedScoreJob,
    }
    const { saveLeadScoring } = await import('../services/aiSummaryService.js')
    const scoringExecution = result.scoringExecution && typeof result.scoringExecution === 'object'
      ? result.scoringExecution as Record<string, unknown>
      : {}
    await saveLeadScoring(lead.id, scoring, rankableScore ?? lead.score, {
      ...(boundSnapshot ? {
        ratingHistory: {
          snapshotId: boundSnapshot.id,
          snapshotHash: boundSnapshot.snapshotHash,
          ratingSchemaVersion: LEAD_RATING_V3_SCHEMA_VERSION,
          workflow: LEAD_RATING_V3_WORKFLOW,
          promptVersion: String(scoringExecution.promptVersion || LEAD_RATING_V3_PROMPT_VERSION),
          model: String(scoringExecution.model || 'unknown'),
          status: 'ready',
          completedAt: new Date(completedAt),
        },
      } : {}),
    })
    return { status: 'done' }
  } catch (err) {
    console.error(`[lead-score] terminal failure lead=${leadId}:`, (err as Error).message)
    const failedJob: LeadScoreJob = {
      status: 'dead_letter',
      attempts: currentAttempt || SCORE_MAX_ATTEMPTS,
      maxAttempts: SCORE_MAX_ATTEMPTS,
      retryCycles: currentRetryCycles,
      startedAt: runStartedAt,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: (err as Error).message,
    }
    await saveLeadScoreJob(leadId, failedJob).catch((persistError) => {
      console.error(`[lead-score] persist failed status lead=${leadId}:`, (persistError as Error).message)
    })
    return { status: 'dead_letter', error: failedJob.error }
  }
}

// 触发评分：秒回，后台跑
metaRouter.post('/leads/:id/score', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    // 验证存在用 getLeadById 单条查(不拉全表),score 只需要 leadId
    const lead = await getLeadById(String(req.params.id))
    if (!lead) { res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' }); return }
    const persistedJob = readLeadScoreJob((lead as { scoring?: unknown }).scoring)
    if (persistedJob?.status === 'dead_letter') {
      res.status(409).json({
        code: 'DEAD_LETTER_RETRY_REQUIRED',
        message: '该评分任务已进入死信，请执行人工重试。',
      })
      return
    }
    const started = await scheduleLeadScoring(lead.id)
    if (!started) {
      const enrichment = await getLeadEnrichmentStatus(lead.id)
      if (enrichment.snapshot?.status !== 'ready') {
        res.status(202).json({
          code: 0,
          message: 'enrichment_required',
          status: enrichment.job ? 'enrichment_pending' : 'enrichment_not_queued',
          enrichmentJobId: enrichment.job?.id ?? null,
        })
        return
      }
    }
    const status = started ? 'queued' : persistedJob?.status ?? 'running'
    res.json({ code: 0, message: started ? 'started' : 'running', status })
  } catch (err) { next(err) }
})

// 死信只能通过显式人工操作重新入队，并与队列状态在同一事务写入审计。
metaRouter.post('/leads/:id/score/retry', requireSystemAdmin, async (req: AuthedRequest, res, next) => {
  try {
    const lead = await getLeadById(String(req.params.id))
    if (!lead) { res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' }); return }
    const persistedJob = readLeadScoreJob((lead as { scoring?: unknown }).scoring)
    if (!persistedJob || !['failed', 'dead_letter'].includes(persistedJob.status)) {
      res.status(409).json({ code: 'NOT_DEAD_LETTER', message: '该评分任务当前不在死信状态。' })
      return
    }
    const started = await scheduleLeadScoring(lead.id, {
      manualRetry: true,
      actor: { userId: req.user!.uid, userName: req.user!.name },
    })
    if (!started) {
      res.status(409).json({ code: 'RETRY_CONFLICT', message: '任务状态已变化，请刷新后重试。' })
      return
    }
    res.json({ code: 0, message: 'retried', status: 'queued' })
  } catch (err) { next(err) }
})

// 查询评分状态/结果：前端轮询
// 注意：用 getLeadById 单条查询全字段(包含 scoring),不要用 listLeads(列表接口已砍 jsonb 大字段,scoring 拿不到)
metaRouter.get('/leads/:id/score', async (req: AuthedRequest, res, next) => {
  try {
    const lead = await getLeadById(String(req.params.id))
    if (!lead) { res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' }); return }
    const scoring = (lead as { scoring?: { dimensions?: unknown; total?: unknown } }).scoring
    const persistedJob = readLeadScoreJob(scoring)
    // AI 深度分析产物特征:含 dimensions(维度打分)。入池时写的结构化 scoring 只有 registry/股东等,不算已分析。
    const hasAiScoring = !!(scoring && scoring.dimensions)
    // MySQL 任务执行器会同步 scoreJob 快照；已有 dimensions 的历史结果仍判定为完成。
    const status = persistedJob?.status ?? (hasAiScoring ? 'done' : 'idle')
    const publicError = status === 'retrying'
      ? publicLeadScoreError(persistedJob?.error) ?? 'AI 评分暂未完成，系统将自动重试'
      : ['failed', 'dead_letter'].includes(status)
        ? publicLeadScoreDeadLetterError(persistedJob?.error) ?? 'AI 评分暂未完成，可人工重试'
        : undefined
    res.json({
      code: 0,
      message: 'success',
      status,
      error: publicError,
      attempts: persistedJob?.attempts,
      maxAttempts: persistedJob?.maxAttempts,
      retryCycles: persistedJob?.retryCycles,
      nextRetryAt: persistedJob?.nextRetryAt,
      scoring: scoring ?? null,
    })
  } catch (err) { next(err) }
})

metaRouter.post('/leads/:id/convert', async (req: AuthedRequest, res, next) => {
  try {
    const leadId = String(req.params.id)
    const row = await convertLead(leadId, req.user!.uid)
    // 甲方要求"获取(领取)就分析"：领取为专属项目后自动触发 AI 深度分析(后台异步，秒回)。
    // 已在分析中则不重复触发。
    await scheduleLeadScoring(leadId).catch((error) => {
      console.error('[lead-convert] post-commit scoring enqueue failed:', (error as Error).message)
    })
    res.json(row)
  } catch (err) { next(err) }
})

// 简化的项目摘要查询（dashboard / 项目详情需要）
import { getSummary as getSummaryService, listAllSummaries, upsertSummary } from '../services/aiSummaryService.js'
metaRouter.get('/ai-summaries', async (req: AuthedRequest, res, next) => {
  try { res.json({ list: await listAllSummaries(req.user!) }) } catch (err) { next(err) }
})
metaRouter.post('/ai-summaries', async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({
      projectId: z.string().min(1),
      positioning: z.string().optional(),
      highlights: z.array(z.string()).optional(),
      risks: z.array(z.string()).optional(),
      questions: z.array(z.string()).optional(),
      missing: z.array(z.string()).optional(),
      confidence: z.coerce.number().int().min(0).max(100).optional(),
      sources: z.array(z.string()).optional(),
    }).parse(req.body)
    await requireAccessibleProject(req.user!.uid, body.projectId)
    res.json(await upsertSummary(body.projectId, body, req.user!.uid))
  } catch (err) { next(err) }
})
metaRouter.get('/projects/:id/ai-summary', async (req: AuthedRequest, res, next) => {
  try {
    const projectId = metaRouteId(req.params.id)
    await requireAccessibleProject(req.user!.uid, projectId)
    res.json({ summary: await getSummaryService(projectId, req.user!.uid) ?? null })
  } catch (err) { next(err) }
})
