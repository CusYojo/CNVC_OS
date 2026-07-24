import { asc, desc, eq, sql, getTableColumns } from 'drizzle-orm'
import { db } from '../db/client.js'
import { aiSummaries, leads, auditLogs } from '../db/schema.js'
import {
  buildRadarLeadMergePatch,
  shouldBackfillCompanyName,
  type RadarLeadSyncFields,
} from './leadRadarMerge.js'

export async function getSummary(projectId: string) {
  const rows = await db.select().from(aiSummaries).where(eq(aiSummaries.projectId, projectId)).orderBy(desc(aiSummaries.updatedAt)).limit(1)
  return rows[0]
}

export async function listAllSummaries() {
  return db.select().from(aiSummaries).orderBy(desc(aiSummaries.updatedAt))
}

export async function upsertSummary(projectId: string, payload: Partial<typeof aiSummaries.$inferInsert>, userId: string) {
  const existing = await getSummary(projectId)
  let row
  if (existing) {
    ;[row] = await db.update(aiSummaries).set({ ...payload, updatedAt: new Date() }).where(eq(aiSummaries.id, existing.id)).returning()
  } else {
    ;[row] = await db.insert(aiSummaries).values({ projectId, ...payload } as typeof aiSummaries.$inferInsert).returning()
  }
  if (row) await db.insert(auditLogs).values({ userId, userName: '（系统）', module: 'AI 工具箱', action: '保存项目摘要', target: projectId })
  return row
}

// 为线索派生完整度与核验状态（DB 未单独存这些字段，按已有信息推导）。
// 完整度 SQL 表达式(列表 listLeads + 详情 getLeadById 共用,保证两处算出同一个值)。
// 定义: 8 个纯"资料齐全度"位(不掺 AI 评分产物 dimensions/competitors——那是分析结果不是资料)。
// 每位在 top-level 列 OR radar_profile OR scoring 里的结构化资料(抓取时写入,非AI产物)任一有值即计 1。
// 用 SQL 直接读原始列,不受列表接口精简字段影响 → 列表和详情完整度必然一致。
const PLACEHOLDER = "('','待核验','待核实','未披露','未披露/待核实','无','-','N/A','null')"
const completenessExpr = sql<number>`(
  ( (${leads.companyName} IS NOT NULL AND ${leads.companyName} <> '')::int
  + (${leads.industry} IS NOT NULL AND ${leads.industry} <> '')::int
  + (${leads.summary} IS NOT NULL AND ${leads.summary} <> '')::int
  + ( (${leads.team} IS NOT NULL AND ${leads.team} NOT IN ${sql.raw(PLACEHOLDER)})
      OR jsonb_array_length(COALESCE(${leads.scoring}->'structuredTeam','[]'::jsonb)) > 0
      OR jsonb_array_length(COALESCE(${leads.radarProfile}->'team','[]'::jsonb)) > 0 )::int
  + ( jsonb_path_exists(COALESCE(${leads.fundingRounds},'[]'::jsonb), '$[*] ? (@.round <> "未披露/待核实" && @.round <> "待核验" && @.round <> "未披露" && @.round <> "待核实")')
      OR jsonb_path_exists(COALESCE(${leads.scoring}->'fundingRoundsResearched','[]'::jsonb), '$[*] ? (@.round <> "待核验" && @.round <> "未披露/待核实" && @.round <> "未披露" && @.round <> "待核实")')
      OR jsonb_path_exists(COALESCE(${leads.radarProfile}->'fundingRounds','[]'::jsonb), '$[*] ? (@.round <> "待核验" && @.round <> "未披露/待核实" && @.round <> "未披露" && @.round <> "待核实")') )::int
  + ( jsonb_path_exists(COALESCE(${leads.scoring}->'structuredShareholders','[]'::jsonb), '$[*] ? (@.name <> "待核验" && @.name <> "未披露" && @.name <> "待核实")')
      OR jsonb_path_exists(COALESCE(${leads.radarProfile}->'shareholders','[]'::jsonb), '$[*] ? (@.name <> "待核验" && @.name <> "未披露" && @.name <> "待核实")') )::int
  + ( (${leads.scoring}->'registry' IS NOT NULL AND ${leads.scoring}->'registry' <> '{}'::jsonb)
      OR (${leads.radarProfile}->'registry' IS NOT NULL AND ${leads.radarProfile}->'registry' <> '{}'::jsonb) )::int
  + ( jsonb_array_length(COALESCE(${leads.sources},'[]'::jsonb)) > 0
      OR (${leads.radarProfile}->>'link' IS NOT NULL AND ${leads.radarProfile}->>'link' <> '') )::int
  ) * 100 / 8
)`

const BUSINESS_INDUSTRY_RULES: Array<{ label: string; terms: string[] }> = [
  { label: '人工智能', terms: ['人工智能', '大模型', '机器学习'] },
  { label: '具身智能/机器人', terms: ['具身智能', '机器人'] },
  { label: '半导体/芯片', terms: ['半导体', '芯片', '集成电路'] },
  { label: '前沿技术', terms: ['前沿技术', '量子', '航空航天'] },
  { label: '产业升级', terms: ['产业升级', '数字化转型'] },
  { label: '先进制造', terms: ['先进制造', '智能制造', '工业自动化'] },
  { label: '企业服务', terms: ['企业服务', 'SaaS', '工业软件'] },
  { label: '医疗健康', terms: ['医疗健康', '医疗器械', '数字医疗'] },
  { label: '生物医药', terms: ['生物医药', '创新药', '生物技术'] },
  { label: '新能源', terms: ['新能源', '储能', '光伏', '氢能'] },
  { label: '新材料', terms: ['新材料'] },
  { label: '汽车出行', terms: ['汽车', '出行', '自动驾驶'] },
  { label: '消费科技', terms: ['消费科技', '消费', '零售'] },
  { label: '文化娱乐', terms: ['文化娱乐', '游戏', '内容'] },
  { label: '教育', terms: ['教育'] },
  { label: '农业科技', terms: ['农业科技', '农业'] },
]

const BUSINESS_REGIONS = [
  '北京', '上海', '浙江', '江苏', '广东', '安徽', '湖北', '四川',
  '山东', '福建', '湖南', '河南', '天津', '重庆', '陕西',
]
const PRESENTATION_PLACEHOLDERS = new Set(['', '待核验', '待核实', '未披露', '未披露/待核实', '融资轮次待核实', '无', '-', 'N/A', 'null', '不适用'])

function meaningfulPresentationText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = meaningfulPresentationText(item)
      if (text) return text
    }
    return undefined
  }
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).trim()
  return PRESENTATION_PLACEHOLDERS.has(text) ? undefined : text
}

export function deriveIndustryTags(industry: unknown): string[] {
  const text = meaningfulPresentationText(industry)
  if (!text) return ['待确认']
  const matched = BUSINESS_INDUSTRY_RULES
    .filter((rule) => rule.terms.some((term) => text.toLocaleLowerCase().includes(term.toLocaleLowerCase())))
    .map((rule) => rule.label)
  return matched.length ? matched.slice(0, 2) : ['其他']
}

export function deriveRegion(scoring: Record<string, unknown>, radarProfile: Record<string, unknown>): string {
  const registry = (scoring.registry && typeof scoring.registry === 'object' ? scoring.registry : {}) as Record<string, unknown>
  const profile = (radarProfile.profile && typeof radarProfile.profile === 'object' ? radarProfile.profile : {}) as Record<string, unknown>
  const locationText = [
    registry.regLocation,
    registry.registeredAddress,
    registry.address,
    profile.regLocation,
    profile.registeredAddress,
    profile.region,
    profile.location,
  ].map((value) => meaningfulPresentationText(value)).filter(Boolean).join(' ')
  return BUSINESS_REGIONS.find((region) => locationText.includes(region)) ?? '待确认'
}

export function deriveValuationDisplay(
  scoring: Record<string, unknown>,
  radarProfile: Record<string, unknown>,
  analysisStatus: 'pending' | 'ready',
  fundingRounds: unknown = [],
) {
  const rounds = Array.isArray(scoring.fundingRoundsResearched) ? scoring.fundingRoundsResearched : []
  const researched = rounds
    .map((round) => (round && typeof round === 'object' ? meaningfulPresentationText((round as Record<string, unknown>).valuation) : undefined))
    .find(Boolean)
  const profile = (radarProfile.profile && typeof radarProfile.profile === 'object' ? radarProfile.profile : {}) as Record<string, unknown>
  const historical = (Array.isArray(fundingRounds) ? fundingRounds : [])
    .map((round) => (round && typeof round === 'object' ? meaningfulPresentationText((round as Record<string, unknown>).valuation) : undefined))
    .find(Boolean)
  const value = researched ?? meaningfulPresentationText(profile.latestValuation) ?? historical
  if (value) return { value, status: 'available' as const }
  return { status: analysisStatus === 'pending' ? 'pending' as const : 'unavailable' as const }
}

export function deriveTechnicalScore(scoring: Record<string, unknown>) {
  const dimensions = Array.isArray(scoring.dimensions) ? scoring.dimensions : []
  const technical = dimensions.find((item) => {
    if (!item || typeof item !== 'object') return false
    const dimension = item as Record<string, unknown>
    const key = String(dimension.key ?? '').toLocaleLowerCase()
    const name = String(dimension.name ?? '')
    return ['technology', 'technical', 'tech', 'differentiation'].some((part) => key.includes(part))
      || /技术|产品差异化/.test(name)
  }) as Record<string, unknown> | undefined
  const score = Number(technical?.score)
  const maxScore = Number(technical?.max)
  return technical && Number.isFinite(score) && Number.isFinite(maxScore) && maxScore > 0
    ? { score, maxScore, status: 'ready' as const }
    : { status: 'pending' as const }
}

export function deriveDataUpdatedAt(scoring: Record<string, unknown>, radarProfile: Record<string, unknown>, createdAt: Date | null) {
  const candidates = [
    meaningfulPresentationText(scoring.scored_at),
    meaningfulPresentationText(radarProfile.publishedAt),
    createdAt?.toISOString(),
  ].filter((value): value is string => Boolean(value))
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()))
  const latest = candidates.sort((a, b) => b.getTime() - a.getTime())[0]
  return latest ? latest.toISOString().slice(0, 10) : ''
}

function enrichLead(row: typeof leads.$inferSelect) {
  const arr = (v: unknown) => Array.isArray(v) ? v : []
  const has = (v: unknown) => typeof v === 'string' ? v.trim().length > 0 : !!v
  // 完整度: 优先用 SQL 层算好并随行传入的 completeness(列表/详情一致);
  // 兜底(直接传 $inferSelect 无 completeness 字段时): 用纯资料 8 位在 JS 里重算,口径与 SQL 一致。
  const sc = (row as { scoring?: Record<string, unknown> }).scoring || {}
  const rpForComp = (row as { radarProfile?: Record<string, unknown> }).radarProfile || {}
  const teamText = (row as { team?: string }).team
  const PLACEHOLDERS = ['', '待核验', '待核实', '未披露', '未披露/待核实', '无', '-', 'N/A', 'null']
  const passedComp = (row as { completeness?: number }).completeness
  let completeness: number
  if (typeof passedComp === 'number') {
    completeness = passedComp
  } else {
    const checks = [
      has(row.companyName),
      has(row.industry),
      has(row.summary),
      (has(teamText) && !PLACEHOLDERS.includes(String(teamText).trim())) || arr(sc.structuredTeam).length > 0 || arr(rpForComp.team).length > 0,
      arr(row.fundingRounds).length > 0 || arr(sc.fundingRoundsResearched).length > 0 || arr(rpForComp.fundingRounds).length > 0,
      arr(sc.structuredShareholders).length > 0 || arr(rpForComp.shareholders).length > 0,
      !!(sc.registry && Object.keys(sc.registry as object).length > 0) || !!(rpForComp.registry && Object.keys(rpForComp.registry as object).length > 0),
      arr(row.sources).length > 0 || (typeof rpForComp.link === 'string' && rpForComp.link.length > 0),
    ]
    completeness = Math.round((checks.filter(Boolean).length / checks.length) * 100)
  }
  // 核验状态：有可核验来源→部分核验；否则待核验（真正“已核验”需人工确认）
  const srcCount = arr(row.sources).length
  const verificationStatus: '已核验' | '部分核验' | '待核验' =
    srcCount >= 2 && has(row.companyName) ? '部分核验' : '待核验'
  // AI 分析状态不单独落库：以 scoring.dimensions 是否存在作为完成标志。
  // 新同步线索会立即展示，由前端用该字段明确标注“待分析”。
  const analysisStatus: 'pending' | 'ready' =
    Array.isArray(sc.dimensions) && sc.dimensions.length > 0 ? 'ready' : 'pending'
  // 渠道：从 source 文本粗判；地区：暂无独立字段，留空由前端展示占位
  const src = String(row.source ?? '')
  // 优先用雷达同步时写入的真实渠道(radarProfile.channel)，避免被"项目发现雷达"前缀误判成新闻
  const rp = (row as { radarProfile?: Record<string, unknown> }).radarProfile || {}
  const channel = (rp && rp.channel) ? rp.channel
    : /情报|必应|公开信息/.test(src) ? '重点机构'
    : /论文|专利|arxiv/i.test(src) ? '论文专利'
    : /院校|大学|高校|实验室/.test(src) ? '院校'
    : /微信|群/.test(src) ? '微信群' : '新闻'
  const region = deriveRegion(sc, rp)
  return {
    ...row,
    completeness,
    verificationStatus,
    analysisStatus,
    lastVerifiedAt: row.createdAt ? new Date(row.createdAt).toISOString().slice(0, 10) : '',
    channel,
    region,
    businessTags: {
      industry: deriveIndustryTags(row.industry),
      region: [region],
    },
    valuationDisplay: deriveValuationDisplay(sc, rp, analysisStatus, row.fundingRounds),
    technicalScore: deriveTechnicalScore(sc),
    dataUpdatedAt: deriveDataUpdatedAt(sc, rp, row.createdAt),
  }
}

// 公共池分页:默认每页 50,pageSize 上限 100(防止误用全量拉爆接口)
// 返回 { list, total, page, pageSize, totalPages }
// 并行两条 query:数据页 + 计数。count(*) over() 在 offset 越界时不会计算 total,不能用
// 性能关键:列表只 SELECT 必要展示列,排除 jsonb 大字段(scoring/radar_profile/sources/funding_rounds/highlights/risks/risk_tags)
// 这些字段详情页按需走 GET /leads/:id
export async function listLeads(options: { page?: number; pageSize?: number; channel?: string; sort?: string; keyword?: string; source?: string; industry?: string; region?: string } = {}) {
  const page = Math.max(1, Math.floor(options.page ?? 1))
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 50)))
  const offset = (page - 1) * pageSize
  // 渠道过滤:服务端按 radar_profile->>'channel' 精确匹配(雷达数据的真实渠道值正好是筛选器那 5 个选项)
  // 空值 = 不过滤;非雷达数据(36氪/BP)没有 radar channel,选任一渠道时会被排除(符合预期:那些不属于这 5 类)
  const channel = (options.channel ?? '').trim()
  // 关键词全库跨字段模糊检索(Postgres ILIKE 大小写不敏感);source 二级标签按 sourceName 模糊匹配。
  // channel/keyword/source 可叠加,均进 whereClause 用 and() 合并。
  const keyword = (options.keyword ?? '').trim()
  const source = (options.source ?? '').trim()
  const industry = (options.industry ?? '').trim()
  const region = (options.region ?? '').trim()
  const conds: ReturnType<typeof sql>[] = []
  // 已入库线索全部可见；未完成 AI 分析的记录由 enrichLead 标为 pending。
  // 同步和 AI 评分解耦，避免“已经同步但列表看不到”。
  if (channel) conds.push(sql`${leads.radarProfile}->>'channel' = ${channel}`)
  if (source) {
    // source 可为逗号分隔的多个关键词(前端二级标签把一个标准机构映射到多个杂乱账号名),任一命中即算该机构
    const srcKws = source.split(',').map((x) => x.trim()).filter(Boolean)
    if (srcKws.length === 1) {
      conds.push(sql`${leads.radarProfile}->>'sourceName' ILIKE ${'%' + srcKws[0] + '%'}`)
    } else if (srcKws.length > 1) {
      const ors = srcKws.map((kw) => sql`${leads.radarProfile}->>'sourceName' ILIKE ${'%' + kw + '%'}`)
      conds.push(sql`(${sql.join(ors, sql` OR `)})`)
    }
  }
  if (industry) {
    // 行业检索:ILIKE 模糊匹配 leads.industry(行业值杂乱,多为逗号拼接的多标签如"企业服务、前沿技术"),
    // 选"前沿技术"用 %前沿技术% 即可命中所有含该词的多标签行。支持逗号分隔多关键词(任一命中)。
    const selectedTerms = BUSINESS_INDUSTRY_RULES.find((rule) => rule.label === industry)?.terms ?? [industry]
    const indKws = selectedTerms.map((x) => x.trim()).filter(Boolean)
    if (indKws.length === 1) {
      conds.push(sql`${leads.industry} ILIKE ${'%' + indKws[0] + '%'}`)
    } else if (indKws.length > 1) {
      const ors = indKws.map((kw) => sql`${leads.industry} ILIKE ${'%' + kw + '%'}`)
      conds.push(sql`(${sql.join(ors, sql` OR `)})`)
    }
  }
  if (region && BUSINESS_REGIONS.includes(region)) {
    const regionKw = `%${region}%`
    conds.push(sql`(
      COALESCE(${leads.scoring}->'registry'->>'regLocation', '') ILIKE ${regionKw}
      OR COALESCE(${leads.scoring}->'registry'->>'registeredAddress', '') ILIKE ${regionKw}
      OR COALESCE(${leads.scoring}->'registry'->>'address', '') ILIKE ${regionKw}
      OR COALESCE(${leads.radarProfile}->'profile'->>'regLocation', '') ILIKE ${regionKw}
      OR COALESCE(${leads.radarProfile}->'profile'->>'registeredAddress', '') ILIKE ${regionKw}
      OR COALESCE(${leads.radarProfile}->'profile'->>'region', '') ILIKE ${regionKw}
      OR COALESCE(${leads.radarProfile}->'profile'->>'location', '') ILIKE ${regionKw}
    )`)
  }
  if (keyword) {
    const kw = '%' + keyword + '%'
    // 跨字段: 主展示列 + radar_profile/scoring 全文(投资方/团队/机构/来源账号等都在里面)
    conds.push(sql`(
      ${leads.name} ILIKE ${kw}
      OR ${leads.companyName} ILIKE ${kw}
      OR ${leads.industry} ILIKE ${kw}
      OR ${leads.summary} ILIKE ${kw}
      OR ${leads.source} ILIKE ${kw}
      OR ${leads.radarProfile}::text ILIKE ${kw}
      OR ${leads.scoring}::text ILIKE ${kw}
    )`)
  }
  const whereClause = conds.length === 0 ? undefined
    : conds.length === 1 ? conds[0]
    : sql.join(conds, sql` AND `)
  const [rows, totalRow] = await Promise.all([
    db.select({
      id: leads.id,
      name: leads.name,
      companyName: leads.companyName,
      industry: leads.industry,
      source: leads.source,
      poolStatus: leads.poolStatus,
      score: leads.score,
      summary: leads.summary,
      // 轻量 scoring 摘要:只挑 completeness 计算需要的数组长度/存在性(不拉整个 scoring 大 jsonb)
      scoring: sql<unknown>`CASE WHEN ${leads.scoring} IS NULL THEN NULL ELSE jsonb_build_object(
        'dimensions', COALESCE(${leads.scoring}->'dimensions','[]'::jsonb),
        'structuredTeam', COALESCE(${leads.scoring}->'structuredTeam','[]'::jsonb),
        'structuredShareholders', COALESCE(${leads.scoring}->'structuredShareholders','[]'::jsonb),
        'competitors', COALESCE(${leads.scoring}->'competitors','[]'::jsonb),
        'fundingRoundsResearched', COALESCE(${leads.scoring}->'fundingRoundsResearched','[]'::jsonb),
        'researchSources', COALESCE(${leads.scoring}->'researchSources','[]'::jsonb),
        'overall_comment', ${leads.scoring}->'overall_comment',
        'scored_at', ${leads.scoring}->'scored_at',
        'registry', COALESCE(${leads.scoring}->'registry','{}'::jsonb)
      ) END`,
      // 列表只取 radar_profile 里列表渲染需要的字段,保持与详情接口"同构"({profile,channel,sourceName,...})
      // 否则前端 setSelected(列表lead) 后 Drawer 按嵌套结构访问会拿到 undefined,导致弹窗渲染异常
      // 用 jsonb_build_object 只挑 profile + 几个行内展示字段,大小从 8-37KB 砍到 <1KB
      radarProfile: sql<unknown>`CASE WHEN ${leads.radarProfile} IS NULL THEN NULL ELSE jsonb_build_object(
        'profile', ${leads.radarProfile}->'profile',
        'channel', ${leads.radarProfile}->'channel',
        'sourceName', ${leads.radarProfile}->'sourceName',
        'sourceGroup', ${leads.radarProfile}->'sourceGroup',
        'publishedAt', ${leads.radarProfile}->'publishedAt'
      ) END`,
      // 列表估值兜底：仅保留第一条历史融资的轮次/估值，避免返回完整 funding_rounds。
      fundingRounds: sql<unknown[]>`CASE
        WHEN jsonb_array_length(COALESCE(${leads.fundingRounds}, '[]'::jsonb)) > 0 THEN jsonb_build_array(jsonb_build_object(
          'round', ${leads.fundingRounds}->0->'round',
          'valuation', ${leads.fundingRounds}->0->'valuation'
        ))
        ELSE '[]'::jsonb
      END`,
      completeness: completenessExpr,
      createdAt: leads.createdAt,
    }).from(leads).where(whereClause).orderBy(options.sort === 'score' ? desc(leads.score) : desc(leads.createdAt)).limit(pageSize).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(leads).where(whereClause),
  ])
  const total = totalRow[0]?.n ?? 0
  return {
    list: rows.map((r) => enrichLead(r as unknown as typeof leads.$inferSelect)),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

// 详情接口:返回全字段(包含 jsonb 大字段),按 leadId 单条查询
// 公共池全局统计（不分页，聚合全库）——给顶部统计卡片用
// 完整度需按 enrichLead 同口径算,故拉最小必要字段在 JS 里复用 enrichLead 的完整度逻辑
export async function leadPoolStats() {
  // 只 SELECT completeness 计算 + score/verification 需要的字段(带 scoring 摘要),避免全字段大 jsonb
  const rows = await db.select({
    companyName: leads.companyName,
    industry: leads.industry,
    summary: leads.summary,
    team: leads.team,
    highlights: leads.highlights,
    risks: leads.risks,
    fundingRounds: leads.fundingRounds,
    sources: leads.sources,
    score: leads.score,
    scoring: sql<unknown>`CASE WHEN ${leads.scoring} IS NULL THEN NULL ELSE jsonb_build_object(
      'dimensions', COALESCE(${leads.scoring}->'dimensions','[]'::jsonb),
      'structuredTeam', COALESCE(${leads.scoring}->'structuredTeam','[]'::jsonb),
      'structuredShareholders', COALESCE(${leads.scoring}->'structuredShareholders','[]'::jsonb),
      'competitors', COALESCE(${leads.scoring}->'competitors','[]'::jsonb),
      'fundingRoundsResearched', COALESCE(${leads.scoring}->'fundingRoundsResearched','[]'::jsonb),
      'researchSources', COALESCE(${leads.scoring}->'researchSources','[]'::jsonb),
      'overall_comment', ${leads.scoring}->'overall_comment',
      'registry', COALESCE(${leads.scoring}->'registry','{}'::jsonb)
    ) END`,
  }).from(leads)
  let total = 0, verified = 0, highPriority = 0, compSum = 0
  for (const r of rows) {
    total++
    const e = enrichLead(r as typeof leads.$inferSelect)
    compSum += e.completeness
    if (e.verificationStatus !== '待核验') verified++
    if ((r.score ?? 0) >= 60) highPriority++
  }
  return {
    total,
    verified,
    highPriority,
    avgCompleteness: total ? Math.round(compSum / total) : 0,
  }
}

export async function getLeadById(leadId: string) {
  const [row] = await db.select({ ...getTableColumns(leads), completeness: completenessExpr }).from(leads).where(eq(leads.id, leadId)).limit(1)
  return row ? enrichLead(row as typeof leads.$inferSelect & { completeness: number }) : null
}

export async function createLead(input: typeof leads.$inferInsert, userId: string) {
  const [row] = await db.insert(leads).values(input).returning()
  if (row) { await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '项目获取池', action: '上传并解析 BP', target: row.name }); void ingestLeadProfile(row) }
  return row
}

export async function syncRadarLeadByName(input: RadarLeadSyncFields, userId: string): Promise<{
  status: 'created' | 'updated' | 'unchanged'
  row: typeof leads.$inferSelect
  duplicateMatches: number
}> {
  // 本期按产品给定的保守默认，仅以 name 精确匹配。若库中已有同名重复记录，
  // 更新最早入库的一条并把其余数量反馈给调用方，不擅自合并/删除历史数据。
  const matches = await db.select().from(leads)
    .where(eq(leads.name, input.name))
    .orderBy(asc(leads.createdAt))
  const existing = matches[0]
  if (!existing) {
    const row = await createLead({
      ...input,
      score: 0,
    } as typeof leads.$inferInsert, userId)
    if (!row) throw new Error(`新增 Radar 线索失败：${input.name}`)
    return { status: 'created', row, duplicateMatches: 0 }
  }

  const patch = buildRadarLeadMergePatch(existing, input as RadarLeadSyncFields & Record<string, unknown>)
  if (Object.keys(patch).length === 0) {
    return { status: 'unchanged', row: existing, duplicateMatches: Math.max(0, matches.length - 1) }
  }

  const [row] = await db.update(leads)
    .set(patch as Partial<typeof leads.$inferInsert>)
    .where(eq(leads.id, existing.id))
    .returning()
  if (!row) throw new Error(`更新 Radar 线索失败：${input.name}`)
  await db.insert(auditLogs).values({
    userId,
    userName: '（系统）',
    module: '项目获取池',
    action: 'Radar 增量更新',
    target: row.name,
  })
  void ingestLeadProfile(row)
  return { status: 'updated', row, duplicateMatches: Math.max(0, matches.length - 1) }
}

export async function convertLead(leadId: string, projectId: string, userId: string) {
  const [row] = await db.update(leads).set({
    poolStatus: '已转专属项目',
    convertedProjectId: projectId,
    claimedBy: '（系统）',
  }).where(eq(leads.id, leadId)).returning()
  if (row) await db.insert(auditLogs).values({ userId, userName: '（系统）', module: '项目获取池', action: '领取为我的专属项目', target: row.name })
  return row
}

export async function saveLeadScoring(leadId: string, scoring: unknown, score: number) {
  // AI 分析(联网补全后)产出的结构化维度,回填到 leads 的独立列 —— 让完整度/前端各维度都反映
  // 联网补全后的真实数据,而不是入池时的原始缺失值。仅当 AI 拿到了实质内容才回填(不用空值冲掉原有)。
  const sc = (scoring ?? {}) as Record<string, unknown>
  const arr = (v: unknown) => (Array.isArray(v) ? v : [])
  const nonEmpty = (a: unknown[]) => a.length > 0
  const patch: Record<string, unknown> = { scoring: scoring as never, score }

  // 团队: scoring.structuredTeam -> team(text) 拼成可读文本
  const team = arr(sc.structuredTeam) as Array<{ name?: string; title?: string; background?: string }>
  if (nonEmpty(team)) {
    patch.team = team.map((t) => `${t.name ?? ''}${t.title ? `（${t.title}）` : ''}${t.background ? '：' + t.background : ''}`).filter((x) => x.trim()).join('；').slice(0, 2000)
  }
  // 融资历史: scoring.fundingRoundsResearched -> funding_rounds(jsonb)
  const fr = arr(sc.fundingRoundsResearched)
  if (nonEmpty(fr)) patch.fundingRounds = fr as never
  // 来源证据: scoring.researchSources -> sources(jsonb)
  const srcs = arr(sc.researchSources)
  if (nonEmpty(srcs)) patch.sources = srcs as never
  // 亮点/风险: 评分 overall_comment 拆不出结构化亮点,但若 scoring 里带了 highlights/risks 就回填
  const hl = arr(sc.highlights)
  if (nonEmpty(hl)) patch.highlights = hl as never
  const rk = arr(sc.risks)
  if (nonEmpty(rk)) patch.risks = rk as never
  // 摘要: scoring.whatIsIt(AI 概括的一句话) -> summary(仅当原 summary 为空/占位时补)
  const whatIsIt = typeof sc.whatIsIt === 'string' ? sc.whatIsIt.trim() : ''
  const registry = sc.registry && typeof sc.registry === 'object' && !Array.isArray(sc.registry)
    ? sc.registry as Record<string, unknown>
    : {}
  const registryCompanyName = typeof registry.companyName === 'string' ? registry.companyName.trim() : ''
  if (registryCompanyName) {
    const [current] = await db.select({
      name: leads.name,
      companyName: leads.companyName,
      source: leads.source,
    }).from(leads).where(eq(leads.id, leadId)).limit(1)
    // 空主体可以补齐；Radar 的 name/companyName 同值兜底可被明确法定全称升级。
    // 人工/BP 已有主体以及其他 Radar 有效主体一律不覆盖。
    if (shouldBackfillCompanyName(current, registryCompanyName)) {
      patch.companyName = registryCompanyName.slice(0, 128)
    }
  }

  const [row] = await db.update(leads).set(patch as never).where(eq(leads.id, leadId)).returning()
  // summary 单独处理:只在原来为空/占位时用 AI 的 whatIsIt 补,不覆盖已有摘要
  if (row && whatIsIt && (!row.summary || ['', '待核验', '待核实', '未披露'].includes(String(row.summary).trim()))) {
    await db.update(leads).set({ summary: whatIsIt.slice(0, 1000) }).where(eq(leads.id, leadId))
  }
  if (row) void ingestLeadProfile(row)
  return row
}

// 把一条线索的画像组装成文本，写入统一知识库 scope='lead'（供助手跨库比对）
export async function ingestLeadProfile(lead: typeof leads.$inferSelect) {
  try {
    const { ingestToKnowledge } = await import('./ragService.js')
    const sc = (lead as { scoring?: { total?: number; verdict?: string; overall_comment?: string } }).scoring
    const parts = [
      `线索名称：${lead.name}`,
      lead.companyName ? `公司主体：${lead.companyName}` : '',
      lead.industry ? `行业：${lead.industry}` : '',
      lead.summary ? `摘要：${lead.summary}` : '',
      Array.isArray(lead.highlights) && lead.highlights.length ? `亮点：${(lead.highlights as string[]).join('；')}` : '',
      Array.isArray(lead.risks) && lead.risks.length ? `风险：${(lead.risks as string[]).join('；')}` : '',
      (lead as { team?: string }).team ? `团队：${(lead as { team?: string }).team}` : '',
      (lead as { financing?: string }).financing ? `融资：${(lead as { financing?: string }).financing}` : '',
      typeof lead.score === 'number' ? `AI评分：${lead.score}` : '',
      sc?.verdict ? `评分结论：${sc.verdict}` : '',
      sc?.overall_comment ? `总体评价：${sc.overall_comment}` : '',
    ].filter(Boolean).join('\n')
    await ingestToKnowledge({ scope: 'lead', refId: lead.id, sourceType: 'lead_profile', sourceId: lead.id, sourceName: lead.name, text: parts })
  } catch { /* 不阻断主流程 */ }
}

// 列出所有 lead 的 industry 和 scoring.total —— 给同赛道分位计算用
// 极轻量:只 SELECT 2 列,无 jsonb
export async function listLeadScoresForRanking(): Promise<Array<{ id: string; industry: string | null; total: number | null }>> {
  const rows = await db
    .select({ id: leads.id, industry: leads.industry, total: sql<number | null>`(${leads.scoring}->>'total')::int` })
    .from(leads)
  return rows as Array<{ id: string; industry: string | null; total: number | null }>
}
