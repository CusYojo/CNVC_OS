import { Router } from 'express'
import { desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { auditLogs, users, leads } from '../db/schema.js'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import {
  createLead,
  convertLead,
  getLeadById,
  leadPoolStats,
  listLeads,
  listLeadScoresForRanking,
  listRecoverableLeadScoreIds,
  clearLeadScoreJob,
  isLeadEligibleForScoring,
  readLeadScoreJob,
  saveLeadScoreJob,
  syncRadarLeadByName,
  type LeadScoreJob,
  type LeadScoreJobStatus,
} from '../services/aiSummaryService.js'
import { FLUE_BASE_URL } from '../config/agentRuntime.js'
import { isSpecificLeadSubjectName } from '../services/leadSubjectName.js'
import {
  meaningfulPublicIntelText,
  mergeLeadPublicIntel,
  type PublicIntelResult,
} from '../services/leadPublicIntelService.js'
import {
  fetchRadarWindow,
  readRadarSyncState,
  saveRadarSyncState,
} from '../services/radarSyncService.js'
import { resolveLeadBusinessRegion } from '../services/leadRegion.js'
import { reviewRadarCandidatesWithAi } from '../services/radarAiReviewService.js'
import { deriveRadarChannel, isRadarPaperCandidate } from '../services/radarChannel.js'

export const metaRouter = Router()

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
): Promise<PublicIntelResult> {
  const resp = await fetch(`${FLUE_BASE_URL}/workflows/intel-collect?wait=result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company, contextEvidence }),
    signal: AbortSignal.timeout(180000),
  })
  if (!resp.ok) throw new Error(`情报采集服务 ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  const { result } = await resp.json() as { result?: PublicIntelResult }
  if (!result) throw new Error('情报采集返回空结果')
  return result
}

metaRouter.get('/users', async (_req, res, next) => {
  try {
    const rows = await db.select({
      id: users.id, email: users.email, name: users.name,
      role: users.role, department: users.department,
      status: users.status, lastLogin: users.lastLogin,
    }).from(users).orderBy(users.email)
    res.json({ list: rows, total: rows.length, page: 1, pageSize: rows.length })
  } catch (err) { next(err) }
})

metaRouter.get('/audit-logs', async (_req, res, next) => {
  try {
    const rows = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(200)
    res.json({ list: rows, total: rows.length })
  } catch (err) { next(err) }
})

metaRouter.get('/templates', async (_req, res) => {
  res.json({ list: [
    { id: 'pptx-standard', name: 'PPT 投资建议书（标准）', type: 'pptx' },
    { id: 'docx-memo', name: 'DOCX 投资备忘录', type: 'docx' },
    { id: 'xlsx-finmodel', name: 'XLSX 财务分析模型', type: 'xlsx' },
    { id: 'pptx-ic', name: 'IC 精简版 PPT', type: 'ic' },
  ], total: 4 })
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
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  channel: z.string().optional(),
  sort: z.enum(['latest', 'score']).optional(),
  keyword: z.string().optional(),  // 关键词全库跨字段检索
  source: z.string().optional(),   // 渠道二级标签(按 sourceName 模糊匹配)
  industry: z.string().optional(), // 行业检索(按 leads.industry ILIKE 模糊匹配)
  region: z.string().optional(),   // 地区业务标签（按注册地/项目画像匹配）
})
metaRouter.get('/leads', async (req, res, next) => {
  try {
    const { page, pageSize, channel, sort, keyword, source, industry, region } = ListLeadsQuery.parse(req.query)
    res.json(await listLeads({ page, pageSize, channel, sort, keyword, source, industry, region }))
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

// 对已入池公司再次检索公开来源，只合并带来源的有效字段，不覆盖现有 AI 评分。
metaRouter.post('/leads/:id/enrich-public-info', async (req: AuthedRequest, res, next) => {
  try {
    const leadId = String(req.params.id)
    const lead = await getLeadById(leadId)
    if (!lead) return res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' })
    const company = meaningfulPublicIntelText(lead.companyName)
      || meaningfulPublicIntelText(lead.name)
    if (!company) return res.status(400).json({ code: 'INVALID_SUBJECT', message: '公司主体名称尚未确认，无法检索公开信息' })

    const intel = await collectPublicIntel(company, publicIntelContextEvidence(lead.sources))
    await mergeLeadPublicIntel(leadId, intel, req.user!.uid)
    const updated = await getLeadById(leadId)
    res.json({ lead: updated, intel })
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
    res.status(201).json(row)
  } catch (err) { next(err) }
})

// 情报采集：输入公司名 → 调 flue 情报采集 agent 真抓公开信息 → 结构化写入 leads 库
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

    const score = Math.round((result.confidence ?? 0) * 100)
    const regionResolution = resolveLeadBusinessRegion({
      registry: {
        regLocation: result.region,
        registeredAddress: result.registeredAddress,
      },
      subjectName: company,
      companyName: company,
    })
    const lead = await createLead({
      name: company,
      companyName: company,
      industry: '待核验',
      businessRegion: regionResolution?.region,
      businessRegionSource: regionResolution?.source,
      businessRegionConfidence: regionResolution?.confidence,
      source: 'AI 情报采集（必应公开信息）',
      poolStatus: score > 0 ? '成功' : '待处理',
      radarProfile: { qualityRejected: false },
      score,
      summary: result.positioning,
      highlights: [
        `注册资本：${result.registeredCapital}`,
        `法定代表人：${result.legalRepresentative}`,
        `成立时间：${result.foundedAt}`,
      ].filter((item) => meaningfulPublicIntelText(item.split('：').slice(1).join('：'))),
      risks: [],
      team: result.legalRepresentative && result.legalRepresentative !== '待核验' ? result.legalRepresentative : null,
      fundingRounds: result.fundingRounds ?? [],
      riskTags: [],
      sources: [
        ...(result.sources ?? []).map((x) => ({ title: x.title, url: x.url, reliability: x.reliability, category: '公开来源' })),
        ...(result.companyNews ?? []).map((n) => ({ title: n.title, url: n.sourceUrl, reliability: '中', category: '公司动态', excerpt: n.summary })),
      ],
    } as never, req.user!.uid)
    res.status(201).json({ lead, intel: result })
  } catch (err) { next(err) }
})

// 从「项目发现雷达」(project-discovery :8121) 同步真实融资线索到线索池
const RADAR_BASE = process.env.RADAR_BASE_URL || 'http://127.0.0.1:8121'
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

metaRouter.post('/leads/sync-radar', async (req: AuthedRequest, res, next) => {
  if (radarSyncRunning) {
    res.status(409).json({
      code: 'RADAR_SYNC_RUNNING',
      message: '上一轮雷达同步仍在运行，请稍后重试',
    })
    return
  }
  radarSyncRunning = true
  try {
    const limit = Math.max(1, Math.min(Number(req.body?.limit) || 50, 200))
    const incrementalPages = Math.max(1, Math.min(Number(req.body?.incrementalPages) || 1, 10))
    const requestedBackfillPages = Number(req.body?.backfillPages)
    const backfillPages = Number.isFinite(requestedBackfillPages)
      ? Math.max(0, Math.min(requestedBackfillPages, 10))
      : 0
    const src = (req.body?.source ?? 'all').toString()  // 默认全部渠道
    const explicitCursor = String(req.body?.cursor || '').trim()
    const stateId = src === 'all' ? 'main' : `source:${src}`
    let nextState: { backfillCursor: string | null; backfillComplete: boolean } | null = null
    let candidateTotal = 0
    let pagesFetched = 0
    let nextCursor = ''
    let hasMore = false
    const fetchedItems: Record<string, unknown>[] = []

    if (explicitCursor) {
      const window = await fetchRadarWindow({
        baseUrl: RADAR_BASE,
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
        baseUrl: RADAR_BASE,
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
          baseUrl: RADAR_BASE,
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
            baseUrl: RADAR_BASE,
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
    const createdIds: string[] = []
    const scoringLeadIds = new Set<string>()
    const actorUserId = req.user?.uid
    const splitList = (s: unknown, n = 6) => (s ? String(s).split(/；|;|\n/).map((x) => x.trim()).filter(Boolean).slice(0, n) : [])
    // 雷达已明确过滤的候选无需再调用大模型；只审查仍有入池可能的数据，
    // 避免低价值论文等占用网关资源并拖慢最新融资线索。
    const reviewableEntries = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.decision_label !== '过滤')
    const reviewedCandidates = await reviewRadarCandidatesWithAi(
      reviewableEntries.map(({ item }) => item),
    )
    const subjectReviews = new Map(
      reviewableEntries.map(({ index }, reviewIndex) => [index, reviewedCandidates[reviewIndex]]),
    )
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const it = items[itemIndex]
      // 雷达服务自身的过滤标记（如论文综合分低于阈值、无投资信息等），
      // 与 AI 主体审查互补——AI 审查只管“名称是否可识别”，雷达过滤只管“是否有投资价值”。
      if (it.decision_label === '过滤') {
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
        aiDeferred += 1
        continue
      }
      if (subjectReview.status === 'rejected') {
        filteredOut += 1
        continue
      }

      const name = subjectReview.subjectName.trim().slice(0, 120)
      if (!name) {
        invalid += 1
        continue
      }
      const prof = it.project_profile || {}
      const isPaper = isRadarPaperCandidate(it)
      const paperTitleZh = isPaper ? meaningfulRadarText(subjectReview.translatedTitle) : ''
      const paperSummaryZh = isPaper ? meaningfulRadarText(subjectReview.translatedSummary) : ''
      const publisherNames = [it.source_name, it.school, it.account_name, it.wx_name]
        .map((value: unknown) => meaningfulRadarText(value))
        .filter(Boolean)
      const channel = deriveRadarChannel(it)
      const fundingRound = meaningfulRadarText(prof.project_round)
      const financingAmount = meaningfulRadarText(prof.financing_amount)
      const latestValuation = meaningfulRadarText(prof.latest_valuation)
      if (seenBatchNames.has(name)) { batchDuplicates += 1; continue }
      else seenBatchNames.add(name)
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
      const fundingRounds = hasFundingData ? [{
        round: fundingRound || '待核验',
        amount: financingAmount || '未披露',
        valuation: latestValuation || '未披露',
        investors: fundingInstitutions || '待核验',
        sourceUrl: it.link || prof.source_url || '',
      }] : []
      // 雷达情报画像：原样存全部字段，前端详情弹窗"雷达情报"板块还原展示。
      // 注意：这里 NOT 写 leads.scoring —— scoring 留给"点击 AI 评测"后的 flue 深度 7 维评分。
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
          translatedSummary: paperSummaryZh,
          confidence: subjectReview.confidence,
          model: subjectReview.model,
          reviewedAt: subjectReview.reviewedAt,
          cacheHit: subjectReview.cacheHit,
        },
        qualityRejected: false,
        qualityRejectReason: '',
        profile: {
          projectName: paperTitleZh || name,
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
        link: it.link || prof.source_url || '',
        // 论文原文用于来源核验和评分，中文译文仅用于产品展示；两者不能互相覆盖。
        paperMeta: isPaper ? {
          title: it.title || prof.paper_title || name,
          titleOriginal: it.title || prof.paper_title || name,
          titleZh: paperTitleZh,
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
      let syncResult: Awaited<ReturnType<typeof syncRadarLeadByName>> | null = null
      try {
        syncResult = await syncRadarLeadByName({
        name,
        companyName: companyName || null,
        industry: (isPaper
          ? (Array.isArray(it.categories) ? it.categories.slice(0, 3).join(', ') : String(it.categories || prof.industry || '待核验').toString().slice(0, 64))
          : (prof.industry || '待核验').toString().slice(0, 64)),
        businessRegion: regionResolution?.region,
        businessRegionSource: regionResolution?.source,
        businessRegionConfidence: regionResolution?.confidence,
        source: isPaper
          ? `项目发现雷达 · arxiv`
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
      }, actorUserId)
      } catch (syncErr) {
        console.error('[radar-sync] 跳过同步失败的候选项（不影响其他项）：', (syncErr as Error).message.slice(0, 200))
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
    res.json({
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
      skipped: unchanged + filteredOut + aiDeferred + invalid,
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
      createdIds,
      scoringIds,
      scoringQueued,
    })
  } catch (err) {
    next(err)
  } finally {
    radarSyncRunning = false
  }
})

// 项目评分：异步模式 —— 点击秒回，后台调 flue 评分并存库，前端轮询 lead.scoring。
// 内存状态只负责当前进程调度；任务状态同时写入 leads.scoring.scoreJob，供重启恢复和前端展示。
const scoreStatus = new Map<string, {
  status: LeadScoreJobStatus
  error?: string
  startedAt: number
  attempts: number
  maxAttempts: number
  retryCycles: number
}>()

// —— 全局评分队列：N 个并发 worker 消费,N=SCORE_QUEUE_CONCURRENCY(默认2)。
// 本地模型网关是评分链路的瓶颈，默认并发 2，避免 50 条雷达同步后同时压垮网关。
const scoreQueue: string[] = []
const SCORE_QUEUE_CONCURRENCY = Math.max(1, parseInt(process.env.SCORE_QUEUE_CONCURRENCY || '2', 10))
const SCORE_MAX_ATTEMPTS = Math.max(1, Math.min(4, parseInt(process.env.SCORE_MAX_ATTEMPTS || '1', 10)))
const SCORE_REQUEST_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.SCORE_REQUEST_TIMEOUT_MS || '360000', 10))
const SCORE_RETRY_BASE_MS = Math.max(1_000, parseInt(process.env.SCORE_RETRY_BASE_MS || '5000', 10))
const SCORE_DEFERRED_RETRY_LIMIT = Math.max(0, Math.min(5, parseInt(process.env.SCORE_DEFERRED_RETRY_LIMIT || '1', 10)))
const SCORE_DEFERRED_RETRY_MS = Math.max(10_000, parseInt(process.env.SCORE_DEFERRED_RETRY_MS || '60000', 10))
const deferredScoreRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
let activeWorkers = 0
async function worker(): Promise<void> {
  while (scoreQueue.length) {
    const id = scoreQueue.shift() as string
    await doScore(id)
  }
}
function drainQueue(): void {
  // 补足到 CONCURRENCY 个 worker(每个 worker 跑空队列后自然退出)
  while (activeWorkers < SCORE_QUEUE_CONCURRENCY && scoreQueue.length > 0) {
    activeWorkers++
    void worker().finally(() => {
      activeWorkers--
      // enqueueScore 可能恰好发生在 worker 看到空队列与 finally 之间。
      // 退出后再次 drain，避免该竞态留下永久 queued 的任务。
      drainQueue()
    })
  }
}
function enqueueScore(leadId: string): void {
  if (!scoreQueue.includes(leadId)) scoreQueue.push(leadId)
  drainQueue()
}

async function scheduleLeadScoring(leadId: string, options: { recovering?: boolean } = {}): Promise<boolean> {
  const current = scoreStatus.get(leadId)
  if (current && ['queued', 'running', 'retrying'].includes(current.status)) return false
  const lead = await getLeadById(leadId)
  if (!lead) return false
  const radarProfile = (lead as { radarProfile?: Record<string, unknown> }).radarProfile ?? {}
  if (
    radarProfile.qualityRejected === true
    || String(radarProfile.qualityRejected ?? '') === 'true'
    || !(await isLeadEligibleForScoring(leadId))
  ) {
    await clearLeadScoreJob(leadId)
    scoreStatus.delete(leadId)
    console.warn(`[lead-score] skip ineligible lead=${leadId} name=${lead.name}`)
    return false
  }
  const isPaper = String(radarProfile.channel ?? '') === '论文'
  if (!isSpecificLeadSubjectName(lead.name, isPaper)) {
    console.warn(`[lead-score] skip invalid subject lead=${leadId} name=${lead.name}`)
    return false
  }
  const previous = readLeadScoreJob((lead as { scoring?: unknown }).scoring)
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
  try {
    await saveLeadScoreJob(leadId, job)
  } catch (error) {
    console.error(`[lead-score] persist queued failed lead=${leadId}:`, (error as Error).message)
    return false
  }
  scoreStatus.set(leadId, {
    status: 'queued',
    startedAt: Date.now(),
    attempts,
    maxAttempts: SCORE_MAX_ATTEMPTS,
    retryCycles,
  })
  enqueueScore(leadId)
  return true
}

export async function recoverLeadScoringQueue(limit = 500) {
  const leadIds = await listRecoverableLeadScoreIds(limit)
  let recovered = 0
  for (const leadId of leadIds) {
    if (await scheduleLeadScoring(leadId, { recovering: true })) recovered += 1
  }
  return { found: leadIds.length, recovered }
}

function retryableScoreError(error: unknown) {
  const value = error as Error & { retryable?: boolean }
  return value.retryable !== false
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
  },
) {
  const retryCycles = input.retryCycles + 1
  const delayMs = SCORE_DEFERRED_RETRY_MS * retryCycles
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
  scoreStatus.set(leadId, {
    status: 'retrying',
    error: input.error.message,
    startedAt: Date.now(),
    attempts: SCORE_MAX_ATTEMPTS,
    maxAttempts: SCORE_MAX_ATTEMPTS,
    retryCycles,
  })

  const existingTimer = deferredScoreRetryTimers.get(leadId)
  if (existingTimer) clearTimeout(existingTimer)
  const timer = setTimeout(() => {
    deferredScoreRetryTimers.delete(leadId)
    void (async () => {
      const current = scoreStatus.get(leadId)
      if (!current || current.status !== 'retrying' || current.retryCycles !== retryCycles) return
      const queuedAt = new Date().toISOString()
      const queuedJob: LeadScoreJob = {
        ...retryingJob,
        status: 'queued',
        attempts: 0,
        updatedAt: queuedAt,
        nextRetryAt: undefined,
        error: undefined,
      }
      await saveLeadScoreJob(leadId, queuedJob)
      scoreStatus.set(leadId, {
        status: 'queued',
        startedAt: Date.now(),
        attempts: 0,
        maxAttempts: SCORE_MAX_ATTEMPTS,
        retryCycles,
      })
      enqueueScore(leadId)
    })().catch((error) => {
      console.error(`[lead-score] deferred retry enqueue failed lead=${leadId}:`, (error as Error).message)
    })
  }, delayMs)
  deferredScoreRetryTimers.set(leadId, timer)
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
  scoreWorkflow: string,
  requestBody: Record<string, unknown>,
): Promise<ScoreWorkflowResult> {
  const resp = await fetch(`${FLUE_BASE_URL}/workflows/${scoreWorkflow}?wait=result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(SCORE_REQUEST_TIMEOUT_MS),
  })
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 300)
    const error = new Error(`评分服务(${scoreWorkflow}) ${resp.status}${detail ? `: ${detail}` : ''}`) as Error & { retryable?: boolean }
    error.retryable = resp.status === 408 || resp.status === 429 || resp.status >= 500
    throw error
  }
  const { result } = await resp.json() as { result?: ScoreWorkflowResult }
  if (!result || !Array.isArray(result.dimensions) || result.dimensions.length === 0) {
    throw new Error('评分服务返回空或缺少评分维度')
  }
  return result
}

async function doScore(leadId: string): Promise<void> {
  let runStartedAt: string | undefined
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
      || !isSpecificLeadSubjectName(lead.name, isPaper)
      || !(await isLeadEligibleForScoring(leadId))
    ) {
      // 记录可能在入队后被质量回填标记为无效；执行前必须再次拦截，
      // 并清除持久化队列状态，避免重启恢复时反复入队。
      await clearLeadScoreJob(leadId)
      scoreStatus.delete(leadId)
      console.warn(`[lead-score] discard invalid queued lead=${leadId} name=${lead.name}`)
      return
    }
    const facts: string[] = []
    const reg = rp.registry as Record<string, string> | undefined
    if (reg) facts.push(`工商信息：公司=${reg.companyName || ''}，成立=${reg.foundedAt || ''}，注册资本=${reg.registeredCapital || ''}，法人=${reg.legalRepresentative || ''}，地址=${reg.regLocation || ''}`)
    const tm = rp.team as Array<{ name?: string; title?: string; background?: string }> | undefined
    if (Array.isArray(tm) && tm.length) facts.push(`核心团队：${tm.map((t) => `${t.name}(${t.title})${t.background ? '-' + t.background : ''}`).join('；')}`)
    const sh = rp.shareholders as Array<{ name?: string; percentage?: string }> | undefined
    if (Array.isArray(sh) && sh.length) facts.push(`股东：${sh.map((s) => `${s.name} ${s.percentage}`).join('；')}`)
    const leadFundingRounds = lead.fundingRounds as Array<{ round?: string; date?: string; amount?: string; investors?: string }> | undefined
    const fr = Array.isArray(leadFundingRounds) && leadFundingRounds.length
      ? leadFundingRounds
      : (rp.fundingRounds as Array<{ round?: string; date?: string; amount?: string; investors?: string }> | undefined)
    if (Array.isArray(fr) && fr.length) facts.push(`融资历史：${fr.map((f) => `${f.round} ${f.date} ${f.amount} 投资方:${f.investors}`).join('；')}`)
    const baseArticle = [
      (rp.articleText as string) || '',
      facts.length ? `\n【已有结构化资料(来自36氪/雷达)】\n${facts.join('\n')}` : '',
    ].join('')
    // 【论文专属分析流程路由】radar_profile.channel==='论文' 的线索走 score-paper workflow
    // (5维:技术实力/落地可能/市场空间/学术背景/商业化经验,放宽对团队/估值/融资的要求),
    // 其余线索仍走通用 score-project(7维)。把 paperMeta 的作者/分类/摘要喂进论文评分输入。
    const paperMeta = (rp as { paperMeta?: Record<string, unknown> }).paperMeta || {}
    const scoreWorkflow = isPaper ? 'score-paper' : 'score-project'
    // 【review P0 修复】论文走 score-paper 时,必须传它 input schema 认的 typed 字段
    // (title/authors/categories/abstract 等,从 paperMeta 取)+ articleText(读取已入库资料);
    // 之前只塞 articleText，而 score-paper 无该字段时会被 valibot 静默丢弃，导致摘要、作者和入库补充资料丢失。
    const commonBody = {
      projectName: lead.name,
      industry: lead.industry ?? undefined,
      summary: lead.summary ?? undefined,
      highlights: Array.isArray(lead.highlights) ? lead.highlights : [],
      risks: Array.isArray(lead.risks) ? lead.risks : [],
      sources: Array.isArray(lead.sources)
        ? (lead.sources as Array<{ title?: string; url?: string }>).map((item) => [item.title, item.url].filter(Boolean).join('｜')).filter(Boolean)
        : [],
    }
    const requestBody = isPaper
      ? {
          ...commonBody,
          // score-paper 论文专属 typed 字段(从雷达 paperMeta 取)
          title: (paperMeta.title as string) || lead.name,
          authors: Array.isArray(paperMeta.authors) ? (paperMeta.authors as string[]) : undefined,
          firstAuthor: (paperMeta.firstAuthor as string) || undefined,
          categories: Array.isArray(paperMeta.categories) ? (paperMeta.categories as string[]) : undefined,
          venue: (paperMeta.venue as string) || undefined,
          abstract: (paperMeta.abstract as string) || undefined,
          pdfUrl: (paperMeta.pdfUrl as string) || undefined,
          // 已入库论文正文和工商结构化资料。
          articleText: baseArticle || undefined,
        }
      : {
          ...commonBody,
          // score-project 通用 7 维字段
          round: (lead as { round?: string }).round,
          team: (lead as { team?: string }).team ?? undefined,
          articleText: baseArticle || undefined,
        }
    let result: ScoreWorkflowResult | null = null
    let finalError: Error | null = null
    const persisted = readLeadScoreJob((lead as { scoring?: unknown }).scoring)
    runStartedAt = persisted?.startedAt ?? new Date().toISOString()
    const retryCycles = persisted?.retryCycles ?? 0
    const initialAttempts = Math.min(persisted?.attempts ?? 0, SCORE_MAX_ATTEMPTS - 1)
    for (let attempt = initialAttempts + 1; attempt <= SCORE_MAX_ATTEMPTS; attempt += 1) {
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
      scoreStatus.set(leadId, {
        status: 'running',
        startedAt: Date.now(),
        attempts: attempt,
        maxAttempts: SCORE_MAX_ATTEMPTS,
        retryCycles,
      })
      await saveLeadScoreJob(leadId, runningJob)
      try {
        result = await requestScoreWorkflow(scoreWorkflow, requestBody)
        finalError = null
        break
      } catch (error) {
        finalError = error as Error
        if (attempt >= SCORE_MAX_ATTEMPTS || !retryableScoreError(error)) break
        const retryAt = new Date(Date.now() + SCORE_RETRY_BASE_MS * attempt).toISOString()
        const retryingJob: LeadScoreJob = {
          ...runningJob,
          status: 'retrying',
          updatedAt: new Date().toISOString(),
          nextRetryAt: retryAt,
          error: finalError.message,
        }
        scoreStatus.set(leadId, {
          status: 'retrying',
          error: finalError.message,
          startedAt: Date.now(),
          attempts: attempt,
          maxAttempts: SCORE_MAX_ATTEMPTS,
          retryCycles,
        })
        await saveLeadScoreJob(leadId, retryingJob)
        await scoreDelay(SCORE_RETRY_BASE_MS * attempt)
      }
    }
    if (!result) {
      const error = finalError ?? new Error('评分服务未返回结果')
      if (retryableScoreError(error) && retryCycles < SCORE_DEFERRED_RETRY_LIMIT) {
        console.warn(
          `[lead-score] transient failure lead=${leadId}, deferred retry cycle=${retryCycles + 1}/${SCORE_DEFERRED_RETRY_LIMIT}:`,
          error.message,
        )
        await deferLeadScoringRetry(leadId, {
          error,
          queuedAt: persisted?.queuedAt,
          startedAt: runStartedAt,
          retryCycles,
        })
        return
      }
      throw error
    }

    const industry = lead.industry
    // 改用 listLeadScoresForRanking 拉全表 industry+total 极轻量列表(避免 listLeads 全表反序列化大 jsonb)
    const allScoresForRank = await listLeadScoresForRanking()
    const peers = allScoresForRank
      .filter((l) => l.industry === industry && l.id !== lead.id && l.total != null)
      .map((l) => l.total as number)
    const allScores = [...peers, result.total].sort((a, b) => b - a)
    const rankIndex = allScores.indexOf(result.total)
    const percentile = allScores.length > 1 ? Math.round((1 - rankIndex / (allScores.length - 1)) * 100) : 100
    const scoring = {
      ...result,
      // 评分结果只补充判断字段；工商、团队、股东、融资及来源继续以入库资料为准。
      projectName: result.projectName || lead.name,
      whatIsIt: (rp as { profile?: { projectName?: string } }).profile?.projectName || lead.summary,
      officialSite: (rp.officialSite as string) || '待核验',
      registry: (rp.registry || {}) as Record<string, string>,
      structuredTeam: rp.team || [],
      structuredShareholders: rp.shareholders || [],
      fundingRoundsResearched: Array.isArray(lead.fundingRounds) && lead.fundingRounds.length
        ? lead.fundingRounds
        : (rp.fundingRounds || []),
      structuredNews: rp.news || [],
      researchSources: lead.sources || [],
      rank: { peers_count: allScores.length, position: rankIndex + 1, percentile, industry: industry ?? '未分类' },
      scored_at: new Date().toISOString(),
      scoreJob: {
        status: 'done',
        attempts: scoreStatus.get(leadId)?.attempts ?? 1,
        maxAttempts: SCORE_MAX_ATTEMPTS,
        retryCycles,
        queuedAt: persisted?.queuedAt,
        startedAt: runStartedAt,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      } satisfies LeadScoreJob,
    }
    const { saveLeadScoring } = await import('../services/aiSummaryService.js')
    await saveLeadScoring(lead.id, scoring, result.total)
    scoreStatus.set(leadId, {
      status: 'done',
      startedAt: scoreStatus.get(leadId)?.startedAt ?? Date.now(),
      attempts: scoreStatus.get(leadId)?.attempts ?? 1,
      maxAttempts: SCORE_MAX_ATTEMPTS,
      retryCycles,
    })
  } catch (err) {
    const current = scoreStatus.get(leadId)
    console.error(`[lead-score] terminal failure lead=${leadId}:`, (err as Error).message)
    const failedJob: LeadScoreJob = {
      status: 'failed',
      attempts: current?.attempts ?? SCORE_MAX_ATTEMPTS,
      maxAttempts: current?.maxAttempts ?? SCORE_MAX_ATTEMPTS,
      retryCycles: current?.retryCycles ?? 0,
      startedAt: runStartedAt,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: (err as Error).message,
    }
    await saveLeadScoreJob(leadId, failedJob).catch((persistError) => {
      console.error(`[lead-score] persist failed status lead=${leadId}:`, (persistError as Error).message)
    })
    scoreStatus.set(leadId, {
      status: 'failed',
      error: failedJob.error,
      startedAt: current?.startedAt ?? Date.now(),
      attempts: failedJob.attempts,
      maxAttempts: failedJob.maxAttempts,
      retryCycles: failedJob.retryCycles ?? 0,
    })
  }
}

// 触发评分：秒回，后台跑
metaRouter.post('/leads/:id/score', async (req: AuthedRequest, res, next) => {
  try {
    // 验证存在用 getLeadById 单条查(不拉全表),score 只需要 leadId
    const lead = await getLeadById(String(req.params.id))
    if (!lead) { res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' }); return }
    const started = await scheduleLeadScoring(lead.id)
    const persistedJob = readLeadScoreJob((lead as { scoring?: unknown }).scoring)
    const status = started ? 'queued' : persistedJob?.status ?? scoreStatus.get(lead.id)?.status ?? 'running'
    res.json({ code: 0, message: started ? 'started' : 'running', status })
  } catch (err) { next(err) }
})

// 查询评分状态/结果：前端轮询
// 注意：用 getLeadById 单条查询全字段(包含 scoring),不要用 listLeads(列表接口已砍 jsonb 大字段,scoring 拿不到)
metaRouter.get('/leads/:id/score', async (req: AuthedRequest, res, next) => {
  try {
    const lead = await getLeadById(String(req.params.id))
    if (!lead) { res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' }); return }
    const st = scoreStatus.get(lead.id)
    const scoring = (lead as { scoring?: { dimensions?: unknown; total?: unknown } }).scoring
    const persistedJob = readLeadScoreJob(scoring)
    // AI 深度分析产物特征:含 dimensions(维度打分)。入池时写的结构化 scoring 只有 registry/股东等,不算已分析。
    const hasAiScoring = !!(scoring && scoring.dimensions)
    // 状态判定:内存态优先(running/failed 以内存为准),避免被入池的旧结构化 scoring 误判成 done。
    // 只有内存 done、或已有 AI 分析产物(dimensions)且不在跑,才算 done。
    let status: string
    if (st && ['queued', 'running', 'retrying'].includes(st.status)) status = st.status
    else if (st?.status === 'failed') status = 'failed'
    else if (st?.status === 'done' || hasAiScoring) status = 'done'
    else if (persistedJob?.status) status = persistedJob.status
    else status = 'idle'
    const publicError = status === 'failed' ? 'AI 评分暂未完成，可重新生成' : undefined
    res.json({
      code: 0,
      message: 'success',
      status,
      error: publicError,
      attempts: st?.attempts ?? persistedJob?.attempts,
      maxAttempts: st?.maxAttempts ?? persistedJob?.maxAttempts,
      retryCycles: st?.retryCycles ?? persistedJob?.retryCycles,
      scoring: scoring ?? null,
    })
  } catch (err) { next(err) }
})

metaRouter.post('/leads/:id/convert', async (req: AuthedRequest, res, next) => {
  try {
    const leadId = String(req.params.id)
    const row = await convertLead(leadId, req.body.projectId, req.user!.uid)
    // 甲方要求"获取(领取)就分析"：领取为专属项目后自动触发 AI 深度分析(后台异步，秒回)。
    // 已在分析中则不重复触发。
    await scheduleLeadScoring(leadId)
    res.json(row)
  } catch (err) { next(err) }
})

// 简化的项目摘要查询（dashboard / 项目详情需要）
import { getSummary as getSummaryService, listAllSummaries } from '../services/aiSummaryService.js'
metaRouter.get('/ai-summaries', async (_req, res, next) => {
  try { res.json({ list: await listAllSummaries() }) } catch (err) { next(err) }
})
metaRouter.get('/projects/:id/ai-summary', async (req, res, next) => {
  try { res.json({ summary: await getSummaryService(req.params.id) ?? null }) } catch (err) { next(err) }
})
