import { Router } from 'express'
import { desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { auditLogs, users, leads } from '../db/schema.js'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { createLead, convertLead, getLeadById, listLeads, listLeadScoresForRanking, syncRadarLeadByName, leadPoolStats } from '../services/aiSummaryService.js'
import { FLUE_BASE_URL } from '../config/agentRuntime.js'

export const metaRouter = Router()

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

metaRouter.post('/leads', async (req: AuthedRequest, res, next) => {
  try {
    const body = LeadCreateSchema.parse(req.body)
    const row = await createLead(body as never, req.user!.uid)
    res.status(201).json(row)
  } catch (err) { next(err) }
})

// 情报采集：输入公司名 → 调 flue 情报采集 agent 真抓公开信息 → 结构化写入 leads 库
metaRouter.post('/leads/collect', async (req: AuthedRequest, res, next) => {
  try {
    const { company } = z.object({ company: z.string().min(2) }).parse(req.body)
    const resp = await fetch(`${FLUE_BASE_URL}/workflows/intel-collect?wait=result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company }),
      signal: AbortSignal.timeout(180000),
    })
    if (!resp.ok) throw new Error(`情报采集服务 ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    const { result } = (await resp.json()) as { result?: {
      positioning: string; registeredCapital: string; legalRepresentative: string; foundedAt: string;
      fundingRounds: Array<{ round: string; amount: string; investors: string; sourceUrl: string }>;
      companyNews: Array<{ title: string; summary: string; sourceUrl: string }>;
      sources: Array<{ title: string; url: string; reliability: string }>;
      confidence: number;
    } }
    if (!result) throw new Error('情报采集返回空结果')

    const score = Math.round((result.confidence ?? 0) * 100)
    const lead = await createLead({
      name: company,
      companyName: company,
      industry: '待核验',
      source: 'AI 情报采集（必应公开信息）',
      poolStatus: score > 0 ? '成功' : '待处理',
      score,
      summary: result.positioning,
      highlights: [
        `注册资本：${result.registeredCapital}`,
        `法定代表人：${result.legalRepresentative}`,
        `成立时间：${result.foundedAt}`,
      ],
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
metaRouter.post('/leads/sync-radar', async (req: AuthedRequest, res, next) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.body?.limit) || 100, 200))
    const src = (req.body?.source ?? 'all').toString()  // 默认全部渠道
    const srcParam = src === 'all' ? '' : `&source=${encodeURIComponent(src)}`
    const resp = await fetch(`${RADAR_BASE}/api/candidates?limit=${limit}&attention_only=false${srcParam}`, { signal: AbortSignal.timeout(15000) })
    if (!resp.ok) throw new Error(`雷达服务 ${resp.status}`)
    const raw = await resp.json() as unknown
    const items: any[] = Array.isArray(raw) ? raw : ((raw as any).items || (raw as any).candidates || (raw as any).data || [])
    const createdNames = new Set<string>()
    const updatedNames = new Set<string>()
    const unchangedNames = new Set<string>()
    const seenBatchNames = new Set<string>()
    const countedDatabaseDuplicateNames = new Set<string>()
    let batchDuplicates = 0
    let databaseDuplicates = 0
    let filteredOut = 0
    let invalid = 0
    const createdIds: string[] = []
    const scoringLeadIds = new Set<string>()
    const splitList = (s: unknown, n = 6) => (s ? String(s).split(/；|;|\n/).map((x) => x.trim()).filter(Boolean).slice(0, n) : [])
    for (const it of items) {
      const prof = it.project_profile || {}
      // 【批次3·需求D】公司主体名优先用雷达结构化抽取的 project_name(比标题片段准),
      // 仅当 project_name 为空/占位时才退回标题解析;标题解析出的 name 若明显是句子片段则标记低质量。
      const isPlaceholderName = (v: unknown) => {
        return !meaningfulRadarText(v)
      }
      const segs = (it.title || prof.project_name || '').toString().split(/\||｜/).map((x: string) => x.trim()).filter(Boolean)
      const rawTitle = segs.sort((a: string, b: string) => b.length - a.length)[0] || ''
      const titleName = rawTitle.slice(0, 120).trim()
      // 标题解析出的 name 是否明显不是公司/项目名(完整句子:过长+含虚词,或以句读标点结尾)
      const looksLikeSentence = (n: string) => {
        if (!n) return true
        if (/[，。！？、；：,.!?;:]$/.test(n)) return true
        // 明显是句子片段/连接词残片,不是公司主体名(甲方点名的坏例:"合作伙伴等信息""其中不乏投资孵化网络")
        if (/^(其中|其|是|以|与|及|从|在|为|把|被|对于|关于|据|另|此外|同时|不乏|包括|例如)/.test(n)) return true
        if (/(等信息|等方面|不乏|多半|汇聚|弥漫|建设性|下半场)$/.test(n)) return true
        if (/(等信息|其中不乏|建设性战略|集群经济与网络|合作伙伴等)/.test(n)) return true
        // 宏观资讯/评述型开头或用语,几乎不可能是公司主体名
        if (/(近年来|我国|国家(战略|各个|层面)|美国对于?|中美|投身|原始创新|有力支撑|从实验室到|聚焦|直击|跨越式|开局之年|借力|对于)/.test(n)) return true
        if (n.length > 22 && /(的|了|是|等|与|及|以|在|为|将|把|被|对于|关于|之|其|正在|构建|支撑|各个|阶段)/.test(n)) return true
        return false
      }
      const projName = String(prof.project_name || '').trim()
      const useProjName = !isPlaceholderName(projName)
      const name = useProjName ? projName.slice(0, 120) : titleName
      // 最终 name 若是句子片段即低质量(无论来自 project_name 还是标题)——雷达抽取质量参差,project_name 也可能是句子。
      const nameLowQuality = looksLikeSentence(name)
      if (!name) { invalid += 1; continue }
      // 【批次2·需求A 放宽过滤】此前"无融资轮次即丢弃"太严,把大量无轮次的优质线索(如高校/机构公众号项目)全扔了,
      // 导致甲方"点从雷达同步没新项目"。新规则:显著提高留存,只挡明显噪音——
      //   1) arxiv 论文:全留(技术/团队线索,无轮次不适用);
      //   2) 有真实融资轮次(REAL_ROUND):留;
      //   3) 无轮次(badRound)但达标者也留: attention_score>=阈值(ATTN_KEEP) 或 有 decision_label 或 有实质项目画像
      //      (project_name/institutions/core_highlights 至少一项非空且非占位);
      //   4) 明显噪音(纯党建/招生/无项目实体:无轮次 且 无 attention 达标 且 无 decision_label 且 画像空)才丢弃。
      const isArxiv = /arxiv/i.test(String(it.source || ''))
      const roundStr = String(prof.project_round || '')
      const REAL_ROUND = /(天使|种子|Pre-?A|A\+?轮|A1|B\+?轮|C\+?轮|D轮|E轮|Pre-?IPO|战略投资|战略融资|新一轮融资|数亿|千万|亿元|万元融资)/i
      const badRound = ['未披露/待核实', '未披露', '待核实', '融资轮次待核实', ''].includes(roundStr)
      const hasRealRound = !badRound && REAL_ROUND.test(roundStr)
      const attnScore = typeof it.attention_score === 'number' ? it.attention_score : 0
      const ATTN_KEEP = 55  // 雷达 attention_score 达标阈值(0-100),达标即视为优质线索保留
      const hasDecision = Boolean(it.decision_label && String(it.decision_label).trim())
      const isPlaceholder = (v: unknown) => {
        return !meaningfulRadarText(v)
      }
      const hasSubstance = !isPlaceholder(prof.project_name) || !isPlaceholder(prof.institutions)
        || !isPlaceholder(prof.affiliated_institutions) || !isPlaceholder(prof.core_highlights)
      const keep = isArxiv || hasRealRound || attnScore >= ATTN_KEEP || hasDecision || hasSubstance
      if (!keep) { filteredOut += 1; continue }
      // 【批次3·需求E】噪音闸:批次2放宽后引入大量非项目文章(政策/评论/周报/论坛综述/党建招生等)被雷达打高分放进来。
      // 若无真实融资轮次(!hasRealRound)且(标题或项目名命中噪音特征 或 D 判定为低质量句子片段),则丢弃。
      // 保留有真实融资轮次的(即使命中噪音词,只要是真实投资事件就留);arxiv 论文亦豁免(走论文渠道)。
      // 强噪音词:资讯/评论/政策/活动类,出现在标题或项目名里都基本是非投资线索 → 作用于 title+project_name
      const NOISE_RE = /(政策(解读|导向|环境|风向)?|战略框架|管理评论|资本市场动态|(周|月|季|年)报|好文|达沃斯|学科交叉|(?<![A-Za-z0-9])召开(?![A-Za-z0-9])|论坛|(峰会|大会)(综述|回顾|观察|纪实)|观察$|解读$|盘点|回顾$|展望$|综述$|党建|招生|校友会(通知|活动)?|通知$|倡议书?|本土化战略|开局之年|借力)/
      // 弱噪音词:易误伤真项目名(如"某公司技术负责人专访"、"以合成生物学为核心的…"、"战略布局"),
      // 仅当出现在【标题】里才当噪音,不作用于 project_name(结构化抽取的项目名相对干净) →
      const TITLE_NOISE_RE = /(负责人|战略(规划|布局|路径)|发展路径|以.{0,20}为(核心|例)|——以)/
      const titleStr = String(it.title || '')
      const hitNoise = NOISE_RE.test(`${titleStr} ${projName}`) || TITLE_NOISE_RE.test(titleStr)
      if (!isArxiv && !hasRealRound && (hitNoise || nameLowQuality)) { filteredOut += 1; continue }
      // 先通过现有质量/噪音过滤，再进入增量合并；同批同名仍参与合并，以免丢失后续来源。
      if (seenBatchNames.has(name)) batchDuplicates += 1
      else seenBatchNames.add(name)
      // 渠道：直接用雷达 source_group 原值（机构公众号/高校公众号/创投新闻/微信群聊/arxiv→论文），
      // 与前端筛选项一一对应，公众号可单独召回。
      const sg = String(it.source_group || '')
      const channel = /arxiv/i.test(String(it.source || '')) ? '论文'
        : (sg || '其他')
      const highlights = splitList(prof.core_highlights, 5)
      const nextActions: string[] = Array.isArray(it.next_actions) ? it.next_actions.map((x: unknown) => String(x)) : []
      const risks = splitList(prof.risk_notes, 5)
      const dims: any[] = Array.isArray(it.score_dimensions) ? it.score_dimensions : []
      // 项目名用于稳定匹配；公司主体只接受 Radar 明确字段，缺失时才退回
      // 一个非句子型项目名。不得凭空补“有限公司”等法定后缀。
      const explicitCompanyName = firstMeaningfulRadarText(
        prof.company_name,
        prof.legal_entity,
        prof.company_full_name,
        it.company_name,
        it.legal_entity,
        it.company_full_name,
      )
      const fallbackCompanyName = useProjName && !looksLikeSentence(projName)
        ? projName
        : (!looksLikeSentence(name) ? name : '')
      const companyName = (explicitCompanyName || fallbackCompanyName).slice(0, 120)

      const fundingRound = meaningfulRadarText(prof.project_round)
      const financingAmount = meaningfulRadarText(prof.financing_amount)
      const latestValuation = meaningfulRadarText(prof.latest_valuation)
      const rawFundingInstitutions = meaningfulRadarText(prof.institutions)
      const publisherNames = [it.source_name, it.school, it.account_name, it.wx_name]
        .map((value: unknown) => meaningfulRadarText(value))
        .filter(Boolean)
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
        decisionLabel: it.decision_label || '',
        thesis: prof.private_market_thesis || '',
        sourceName: it.source_name || it.source || '',
        sourceGroup: it.source_group || '',
        channel,
        accountName: it.account_name || it.wx_name || '',
        publishedAt: it.published_at || '',
        profile: {
          projectName: useProjName ? projName : name,
          companyName,
          projectRound: prof.project_round || '',
          financingAmount: prof.financing_amount || '',
          latestValuation: prof.latest_valuation || '',
          institutions: prof.institutions || '',
          affiliatedInstitutions: prof.affiliated_institutions || '',
          industry: prof.industry || '',
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
        // 【批次3·需求G】论文(arxiv)元数据:作者/分类/pdf/摘要,供后续 AI 中文解读+作者背景+技术落地分析复用。
        // 仅 arxiv 线索有值;其他渠道为空对象。摘要(abstract)取雷达 summary(英文原文)。
        paperMeta: isArxiv ? {
          title: it.title || prof.paper_title || name,
          authors: Array.isArray(it.authors) ? it.authors : String(it.authors || prof.paper_authors || '').split(/[,;，；]/).map((x: string) => x.trim()).filter(Boolean),
          firstAuthor: it.first_author || prof.paper_first_author || (Array.isArray(it.authors) ? it.authors[0] : ''),
          secondAuthor: it.second_author || prof.paper_second_author || (Array.isArray(it.authors) ? it.authors[1] : ''),
          categories: Array.isArray(it.categories) ? it.categories : String(it.categories || prof.paper_categories || '').split(/[,，;；]/).map((x: string) => x.trim()).filter(Boolean),
          venue: it.journal_ref || prof.paper_venue || '',
          comment: it.comment || prof.paper_comment || '',
          pdfUrl: it.pdf_url || prof.paper_pdf_url || '',
          abstract: (it.summary || '').toString().slice(0, 4000),
          publishedAt: it.published_at || '',
        } : {},
      }
      const syncResult = await syncRadarLeadByName({
        name,
        companyName: companyName || null,
        industry: (isArxiv
          ? (Array.isArray(it.categories) ? it.categories.slice(0, 3).join(', ') : String(it.categories || prof.industry || '待核验').toString().slice(0, 64))
          : (prof.industry || '待核验').toString().slice(0, 64)),
        source: isArxiv
          ? `项目发现雷达 · arxiv`
          : `项目发现雷达 · ${it.source_name || it.source || '公开渠道'}`,
        poolStatus: '成功',
        summary: (it.summary || prof.core_highlights || '').toString().slice(0, 1000),
        highlights,
        risks,
        team: [prof.team_composition, prof.lab && `实验室：${prof.lab}`].filter(Boolean).join('\n').slice(0, 800) || '待核验',
        fundingRounds,
        riskTags: (it.decision_label ? [it.decision_label] : []),
        radarProfile,
        sources: [{ title: it.title || name, url: it.link || prof.source_url || '', reliability: '中', category: it.source_group || '公开渠道', excerpt: (it.summary || '').toString().slice(0, 200) }],
      }, req.user!.uid)

      if (syncResult.duplicateMatches > 0 && !countedDatabaseDuplicateNames.has(name)) {
        countedDatabaseDuplicateNames.add(name)
        databaseDuplicates += syncResult.duplicateMatches
      }
      if (syncResult.status === 'created') {
        createdNames.add(name)
        updatedNames.delete(name)
        unchangedNames.delete(name)
        if (syncResult.row?.id) {
          createdIds.push(syncResult.row.id)
          scoringLeadIds.add(syncResult.row.id)
        }
      } else if (syncResult.status === 'updated') {
        if (!createdNames.has(name)) updatedNames.add(name)
        unchangedNames.delete(name)
        if (syncResult.row?.id) scoringLeadIds.add(syncResult.row.id)
      } else if (!createdNames.has(name) && !updatedNames.has(name)) {
        unchangedNames.add(name)
      }
    }
    const created = createdNames.size
    const updated = updatedNames.size
    const unchanged = unchangedNames.size
    const duplicates = batchDuplicates + databaseDuplicates
    const scoringIds = [...scoringLeadIds]
    const scoringQueued = scoringIds.filter(scheduleLeadScoring).length
    res.json({
      ok: true,
      fetched: items.length,
      created,
      updated,
      unchanged,
      skipped: unchanged + filteredOut + invalid,
      duplicates,
      batchDuplicates,
      databaseDuplicates,
      filtered: filteredOut,
      invalid,
      createdIds,
      scoringIds,
      scoringQueued,
    })
  } catch (err) { next(err) }
})

// 项目评分：异步模式 —— 点击秒回，后台调 flue 评分并存库，前端轮询 lead.scoring。
// 内存态评分状态（进程级即可：running/done/failed），前端可轮询
const scoreStatus = new Map<string, { status: 'running' | 'done' | 'failed'; error?: string; startedAt: number }>()

// SearXNG 联网检索(自托管:8888,免费无key,境内引擎360/搜狗/夸克)。返回 top 结果拼成文本。
async function searchWeb(query: string): Promise<string> {
  try {
    const url = `http://127.0.0.1:8888/search?q=${encodeURIComponent(query)}&format=json&engines=360search,sogou,quark`
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!r.ok) return ''
    const d = await r.json() as { results?: Array<{ title?: string; content?: string; url?: string }> }
    const rows = (d.results ?? []).slice(0, 8)
      .map((x) => `· ${(x.title ?? '').trim()}：${(x.content ?? '').trim()}${x.url ? `（来源：${x.url}）` : ''}`)
      .filter((s) => s.length > 10)
    return rows.join('\n')
  } catch { return '' }
}

// —— 全局评分队列：N 个并发 worker 消费,N=SCORE_QUEUE_CONCURRENCY(默认3)。
// 适度并发提速批量重评;上限受 flue/zeelin/searxng 承载能力约束,默认3是安全值。
const scoreQueue: string[] = []
const SCORE_QUEUE_CONCURRENCY = Math.max(1, parseInt(process.env.SCORE_QUEUE_CONCURRENCY || '3', 10))
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
    void worker().finally(() => { activeWorkers-- })
  }
}
function enqueueScore(leadId: string): void {
  if (!scoreQueue.includes(leadId)) scoreQueue.push(leadId)
  drainQueue()
}

function scheduleLeadScoring(leadId: string): boolean {
  const current = scoreStatus.get(leadId)
  if (current?.status === 'running') return false
  scoreStatus.set(leadId, { status: 'running', startedAt: Date.now() })
  enqueueScore(leadId)
  return true
}

async function doScore(leadId: string): Promise<void> {
  try {
    // 评分需要 lead 完整字段(sources/radarProfile/scoring/fundingRounds),listLeads 不返回这些
    const lead = await getLeadById(leadId)
    if (!lead) throw new Error('线索不存在')
    // 评分前先联网检索该项目公开信息，拼接进资料再评分(甲方要求:一定联网)
    const webQuery = [lead.name, (lead as { round?: string }).round, '融资'].filter(Boolean).join(' ')
    const webResults = await searchWeb(webQuery)
    // 把 CSV/雷达已有的结构化资料(工商/团队/股东/融资)也拼进分析输入，让 agent 综合已有资料+联网结果
    const rp = (lead as { radarProfile?: Record<string, unknown> }).radarProfile || {}
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
    const enrichedArticle = webResults
      ? `${baseArticle}\n\n【联网检索补充(SearXNG·公开信息，需二次核验)】\n${webResults}`
      : baseArticle
    // 【论文专属分析流程路由】radar_profile.channel==='论文' 的线索走 score-paper workflow
    // (5维:技术实力/落地可能/市场空间/学术背景/商业化经验,放宽对团队/估值/融资的要求),
    // 其余线索仍走通用 score-project(7维)。把 paperMeta 的作者/分类/摘要喂进论文评分输入。
    const isPaper = String((rp as { channel?: string }).channel || '') === '论文'
    const paperMeta = (rp as { paperMeta?: Record<string, unknown> }).paperMeta || {}
    const scoreWorkflow = isPaper ? 'score-paper' : 'score-project'
    // 【review P0 修复】论文走 score-paper 时,必须传它 input schema 认的 typed 字段
    // (title/authors/categories/abstract 等,从 paperMeta 取)+ articleText(吃联网补充资料);
    // 之前只塞 articleText,而 score-paper 无该字段被 valibot 静默丢弃,导致摘要/作者/联网资料全丢。
    const commonBody = {
      projectName: lead.name,
      industry: lead.industry ?? undefined,
      summary: lead.summary ?? undefined,
      highlights: Array.isArray(lead.highlights) ? lead.highlights : [],
      risks: Array.isArray(lead.risks) ? lead.risks : [],
      sources: Array.isArray(lead.sources) ? (lead.sources as Array<{ title?: string }>).map((x) => x.title || '').filter(Boolean) : [],
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
          // 联网检索 + 工商结构化补充(score-paper 新增 articleText 字段接收)
          articleText: enrichedArticle || undefined,
        }
      : {
          ...commonBody,
          // score-project 通用 7 维字段
          round: (lead as { round?: string }).round,
          team: (lead as { team?: string }).team ?? undefined,
          articleText: enrichedArticle || undefined,
        }
    const resp = await fetch(`${FLUE_BASE_URL}/workflows/${scoreWorkflow}?wait=result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(600000),
    })
    if (!resp.ok) throw new Error(`评分服务(${scoreWorkflow}) ${resp.status}`)
    const { result } = await resp.json() as { result?: { total: number; verdict: string; overall_comment: string; dimensions: unknown[] } }
    if (!result) throw new Error('评分服务返回空')

    // 信源研究 workflow：联网检索 → 6维度结构化(公司官网/工商/团队/股权融资/动态/来源证据)
    let research: Record<string, unknown> = {}
    try {
      const rResp = await fetch(`${FLUE_BASE_URL}/workflows/research-project?wait=result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: lead.name, hint: lead.summary ?? undefined, articleText: enrichedArticle || undefined }),
        signal: AbortSignal.timeout(600000),
      })
      if (rResp.ok) {
        const rj = await rResp.json() as { result?: Record<string, unknown> }
        if (rj.result) research = rj.result
      }
    } catch { /* 信源研究失败不阻断评分 */ }

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
      // 信源研究结果并入 scoring；CSV/雷达已有资料作兜底，AI 留空的字段不丢失原始数据
      projectName: (research.projectName as string) || (result as { projectName?: string }).projectName,
      whatIsIt: research.whatIsIt || (rp as { profile?: { projectName?: string } }).profile?.projectName,
      officialSite: (research.officialSite && research.officialSite !== '待核验') ? research.officialSite : ((rp.officialSite as string) || '待核验'),
      registry: (() => {
        const aiReg = (research.registry || {}) as Record<string, string>
        const csvReg = (rp.registry || {}) as Record<string, string>
        const merged: Record<string, string> = { ...csvReg }
        for (const k of Object.keys(aiReg)) { if (aiReg[k] && aiReg[k] !== '待核验') merged[k] = aiReg[k] }
        return merged
      })(),
      structuredTeam: (Array.isArray(research.team) && research.team.length) ? research.team : (rp.team || []),
      structuredShareholders: (Array.isArray(research.shareholders) && research.shareholders.length) ? research.shareholders : (rp.shareholders || []),
      fundingRoundsResearched: (Array.isArray(research.fundingRounds) && research.fundingRounds.length)
        ? research.fundingRounds
        : (Array.isArray(lead.fundingRounds) && lead.fundingRounds.length ? lead.fundingRounds : (rp.fundingRounds || [])),
      structuredNews: research.news,
      researchSources: research.sources,
      rank: { peers_count: allScores.length, position: rankIndex + 1, percentile, industry: industry ?? '未分类' },
      scored_at: new Date().toISOString(),
    }
    const { saveLeadScoring } = await import('../services/aiSummaryService.js')
    await saveLeadScoring(lead.id, scoring, result.total)
    scoreStatus.set(leadId, { status: 'done', startedAt: scoreStatus.get(leadId)?.startedAt ?? Date.now() })
  } catch (err) {
    scoreStatus.set(leadId, { status: 'failed', error: (err as Error).message, startedAt: scoreStatus.get(leadId)?.startedAt ?? Date.now() })
  }
}

// 触发评分：秒回，后台跑
metaRouter.post('/leads/:id/score', async (req: AuthedRequest, res, next) => {
  try {
    // 验证存在用 getLeadById 单条查(不拉全表),score 只需要 leadId
    const lead = await getLeadById(String(req.params.id))
    if (!lead) { res.status(404).json({ code: 'NOT_FOUND', message: '线索不存在' }); return }
    const started = scheduleLeadScoring(lead.id)
    res.json({ code: 0, message: started ? 'started' : 'running', status: 'running' })
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
    // AI 深度分析产物特征:含 dimensions(维度打分)。入池时写的结构化 scoring 只有 registry/股东等,不算已分析。
    const hasAiScoring = !!(scoring && scoring.dimensions)
    // 状态判定:内存态优先(running/failed 以内存为准),避免被入池的旧结构化 scoring 误判成 done。
    // 只有内存 done、或已有 AI 分析产物(dimensions)且不在跑,才算 done。
    let status: string
    if (st?.status === 'running') status = 'running'
    else if (st?.status === 'failed') status = 'failed'
    else if (st?.status === 'done' || hasAiScoring) status = 'done'
    else status = 'idle'
    res.json({ code: 0, message: 'success', status, error: st?.error, scoring: scoring ?? null })
  } catch (err) { next(err) }
})

metaRouter.post('/leads/:id/convert', async (req: AuthedRequest, res, next) => {
  try {
    const leadId = String(req.params.id)
    const row = await convertLead(leadId, req.body.projectId, req.user!.uid)
    // 甲方要求"获取(领取)就分析"：领取为专属项目后自动触发 AI 深度分析(后台异步，秒回)。
    // 已在分析中则不重复触发。
    scheduleLeadScoring(leadId)
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
