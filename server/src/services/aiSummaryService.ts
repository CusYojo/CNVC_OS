import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, ne, sql, getTableColumns } from 'drizzle-orm'
import type { SQLWrapper } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import type { RowDataPacket } from 'mysql2'
import type { PoolConnection } from 'mysql2/promise'
import { db, pool, schema } from '../db/client.js'
import { aiSummaries, leads, auditLogs, leadScoreJobs, migrationEntityMappings, projectMembers, projects } from '../db/schema.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { projectAccessCondition, type ProjectAccessActor } from './projectAccessService.js'
import {
  buildRadarLeadMergePatch,
  mergeRadarFundingRounds,
  mergeRadarSources,
  mergeUniqueValues,
  shouldBackfillCompanyName,
  type RadarLeadSyncFields,
} from './leadRadarMerge.js'
import {
  applyLeadFieldPolicy,
  initialLeadFieldProvenance,
} from './leadFieldProvenance.js'
import {
  deriveRadarSubjectName,
  isBetterLeadSubjectName,
  isSpecificLeadSubjectName,
} from './leadSubjectName.js'
import {
  BUSINESS_REGIONS,
  resolveLeadBusinessRegion,
} from './leadRegion.js'
import { sanitizeScoringCompetitors } from './competitorEvidence.js'
import { transitionLeadPipelineItem, type LeadPipelineTransitionInput } from './leadPipelineEventService.js'
import { openLeadPipelineReview, recordLeadPipelineDecision } from './leadPipelineAuditService.js'
import { recordLeadPipelineEntityMatch } from './leadPipelineEntityMatchService.js'
import { formatShanghaiDateKey } from '../utils/shanghaiTime.js'
import { resolvePaperProjectIdentity } from './paperIdentity.js'
import { publicLeadScoreDeadLetterError, publicLeadScoreError } from './leadScoreRetryPolicy.js'

export async function getSummary(projectId: string) {
  const rows = await db.select().from(aiSummaries).where(eq(aiSummaries.projectId, projectId)).orderBy(desc(aiSummaries.updatedAt)).limit(1)
  return rows[0]
}

export async function listAllSummaries(actor?: ProjectAccessActor) {
  const where = actor
    ? inArray(
        aiSummaries.projectId,
        db.select({ id: projects.id }).from(projects).where(projectAccessCondition(actor)),
      )
    : undefined
  return db.select().from(aiSummaries).where(where).orderBy(desc(aiSummaries.updatedAt))
}

export async function upsertSummary(projectId: string, payload: Partial<typeof aiSummaries.$inferInsert>, userId: string) {
  const existing = await getSummary(projectId)
  if (existing) {
    await db.update(aiSummaries).set({ ...payload, updatedAt: new Date() }).where(eq(aiSummaries.id, existing.id))
  } else {
    await db.insert(aiSummaries).values({ projectId, ...payload } as typeof aiSummaries.$inferInsert)
  }
  const row = await getSummary(projectId)
  if (row) await db.insert(auditLogs).values({ userId, userName: '（系统）', module: 'AI 工具箱', action: '保存项目摘要', target: projectId })
  return row
}

// 为线索派生完整度与核验状态（DB 未单独存这些字段，按已有信息推导）。
// 完整度 SQL 表达式(列表 listLeads + 详情 getLeadById 共用,保证两处算出同一个值)。
// 定义: 8 个纯"资料齐全度"位(不掺 AI 评分产物 dimensions/competitors——那是分析结果不是资料)。
// 每位在 top-level 列 OR radar_profile OR scoring 里的结构化资料(抓取时写入,非AI产物)任一有值即计 1。
// 用 SQL 直接读原始列,不受列表接口精简字段影响 → 列表和详情完整度必然一致。
const PLACEHOLDER = "('','待核验','待核实','未披露','未披露/待核实','无','-','N/A','null')"

function jsonValue(column: SQLWrapper, path: string) {
  return sql`JSON_EXTRACT(${column}, ${path})`
}

function jsonText(column: SQLWrapper, path: string) {
  return sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${column}, ${path}))`
}

function jsonArrayHasDisclosedValue(column: SQLWrapper, path: string, field: string) {
  if (!/^[A-Za-z0-9_]+$/.test(field)) throw new Error(`unsafe JSON field: ${field}`)
  return sql`EXISTS (
    SELECT 1
    FROM JSON_TABLE(
      COALESCE(JSON_EXTRACT(${column}, ${path}), JSON_ARRAY()),
      '$[*]' COLUMNS(value VARCHAR(128) PATH ${sql.raw(`'$.${field}'`)})
    ) AS jt
    WHERE COALESCE(jt.value, '') NOT IN ('', '待核验', '待核实', '未披露', '未披露/待核实')
  )`
}

const completenessExpr = sql<number>`(
  ( (${leads.companyName} IS NOT NULL AND ${leads.companyName} <> '')
  + (${leads.industry} IS NOT NULL AND ${leads.industry} <> '')
  + (${leads.summary} IS NOT NULL AND ${leads.summary} <> '')
  + ( (${leads.team} IS NOT NULL AND ${leads.team} NOT IN ${sql.raw(PLACEHOLDER)})
      OR JSON_LENGTH(COALESCE(${jsonValue(leads.scoring, '$.structuredTeam')}, JSON_ARRAY())) > 0
      OR JSON_LENGTH(COALESCE(${jsonValue(leads.radarProfile, '$.team')}, JSON_ARRAY())) > 0 )
  + ( ${jsonArrayHasDisclosedValue(leads.fundingRounds, '$', 'round')}
      OR ${jsonArrayHasDisclosedValue(leads.scoring, '$.fundingRoundsResearched', 'round')}
      OR ${jsonArrayHasDisclosedValue(leads.radarProfile, '$.fundingRounds', 'round')} )
  + ( ${jsonArrayHasDisclosedValue(leads.scoring, '$.structuredShareholders', 'name')}
      OR ${jsonArrayHasDisclosedValue(leads.radarProfile, '$.shareholders', 'name')} )
  + ( JSON_LENGTH(COALESCE(${jsonValue(leads.scoring, '$.registry')}, JSON_OBJECT())) > 0
      OR JSON_LENGTH(COALESCE(${jsonValue(leads.radarProfile, '$.registry')}, JSON_OBJECT())) > 0 )
  + ( JSON_LENGTH(COALESCE(${leads.sources}, JSON_ARRAY())) > 0
      OR COALESCE(${jsonText(leads.radarProfile, '$.link')}, '') <> '' )
  ) * 100 / 8
)`

// 综合 AI 评分以评分产物中的 total 为准。leads.score 是历史冗余列，
// 个别存量数据可能未随最近一次评分结果同步，不能再作为统计和排序的首选值。
const overallScoreExpr = sql<number>`CASE
  WHEN COALESCE(${jsonText(leads.scoring, '$.total')}, '') REGEXP '^[0-9]+([.][0-9]+)?$'
    THEN ROUND(CAST(${jsonText(leads.scoring, '$.total')} AS DECIMAL(10,2)))
  ELSE ${leads.score}
END`

const publicLeadSignalTextExpr = sql<string>`CONCAT_WS(
  ' ',
  COALESCE(${leads.name}, ''),
  COALESCE(${jsonText(leads.radarProfile, '$.sourceTitle')}, ''),
  LEFT(COALESCE(${jsonText(leads.sources, '$[0].title')}, ''), 500),
  LEFT(COALESCE(${leads.summary}, ''), 1600),
  LEFT(COALESCE(${jsonText(leads.radarProfile, '$.profile.projectName')}, ''), 500),
  LEFT(COALESCE(${jsonText(leads.radarProfile, '$.profile.coreHighlights')}, ''), 1600),
  LEFT(COALESCE(${jsonText(leads.radarProfile, '$.profile.teamComposition')}, ''), 800)
)`

const publicLeadTitleExpr = sql<string>`COALESCE(
  NULLIF(${jsonText(leads.radarProfile, '$.sourceTitle')}, ''),
  NULLIF(${jsonText(leads.sources, '$[0].title')}, ''),
  COALESCE(${leads.name}, '')
)`

const publicLeadPrimaryTextExpr = sql<string>`CONCAT_WS(
  ' ',
  ${publicLeadTitleExpr},
  LEFT(COALESCE(${leads.summary}, ''), 1200),
  LEFT(COALESCE(${jsonText(leads.radarProfile, '$.profile.projectName')}, ''), 300)
)`

const publicLeadHasCompanyExpr = sql<boolean>`(
  COALESCE(${leads.companyName}, '') REGEXP '(股份有限公司|有限责任公司|有限公司)$'
  OR COALESCE(${jsonText(leads.scoring, '$.registry.companyName')}, '') REGEXP '(股份有限公司|有限责任公司|有限公司)$'
)`

const PUBLIC_LEAD_INVESTMENT_PATTERN = '(完成|获得|获|宣布|官宣).{0,40}(融资|投资)|(融资|投资).{0,28}(完成|领投|跟投|亿元|万元|美元|天使轮|种子轮|pre-?a|a轮|b轮|c轮|d轮)|估值.{0,20}(亿元|万美元|亿美元|万元)'
const PUBLIC_LEAD_COMMERCIAL_PATTERN = '(成果转化|技术转移|转化落地|产业化|中试|技术平台|工程化|技术许可|专利转让|孵化(成立|企业|公司)|创办公司|成立公司|产品获批|注册证|临床应用|应用新场景|示范应用|产业应用|客户验证|客户订单|采购|中标|签约|量产|营收|商业化)'
const PUBLIC_LEAD_LOW_VALUE_PATTERN = '(院系之声.{0,30}(荣誉|获奖|award)|(教授|研究员|学者).{0,30}(获颁|获评|荣获|获奖|award|荣誉|发文|发表文章)|(获得|获评|入选|荣获|获).{0,24}(奖|荣誉|称号|教学团队|表彰|标兵|勋章)|(科学技术奖|科技奖|自然科学奖|技术发明奖|科技进步奖).{0,40}(揭晓|获奖|表彰)|[0-9]+[[:space:]]*项.{0,12}(获奖|获表彰)|(国家级|省级|全国高校).{0,16}(教学团队|教学成果|荣誉|奖|标兵)|奖学金|受试者招募|招募(研究参与者|受试者)|参与本研究|临床试验.{0,50}(招募|受试者|研究参与者)|实践成果.{0,24}(申请|硕士学位)|学位答辩|专业学位培养改革|论文.{0,40}(期刊|发表|刊发|接受|接收|accepted)|学术成果|研究论文|文章来源|转载全文|毕业(季|典礼|致辞|生|倒计时|设计)|毕业生去哪儿|校友招聘|社会招聘|诚聘|实习生|招聘|党支部|党员|党务|党建|革命先辈|校史|悼念|缅怀|研修班|训练营|课程|移动课堂|工作坊|讲座(预告)?|活动(预告|抢先知)|information session|参访|探访|参观|调研|走访|到访|企业走访交流活动|师生校友|院友沙龙|创新大赛|参赛队伍|[0-9]+[[:space:]]*家.{0,24}(企业|公司).{0,30}(融资|投资)|专场(科创)?路演|路演举办|加速计划.{0,20}(招募|启动)|最前线|解码硬科技|罚单|行业进入强监管|([0-9]+点[0-9]*氪|氪星|创投|财经)(晚报|早报)?|为什么资本|什么样的.{0,20}(能|会)|行业观察|赛道观察|赴港上市|登陆资本市场|ipo认购|上市获|融资净买入|股息率|榜单|合作会议|专题会议|世界顶尖科学家论坛|院士云集|共议|要报.{0,12}专业吗|招生(简章|宣传|咨询|专业|对象)?|培养方案|课程介绍|实验班介绍|培训班|结业证书|能力提升计划|名家面对面|学员企业|发表致辞|兼任|受聘|履新|任命|(记者|人物)?专访|人物访谈|观点访谈|深度解读|系统剖析)'
const PUBLIC_LEAD_CONCRETE_SUBJECT_PATTERN = '(股份有限公司|有限责任公司|有限公司|公司|企业|项目|团队|实验室|研究院|研究所|研究中心|工程中心|课题组|创新群体|创新联合体|中试基地|产业基地|创新平台|技术平台|研发平台|试验平台|装置|系统|产品|计划)$'
const PUBLIC_LEAD_INVALID_SUBJECT_PATTERN = '^(数据|小时|主持|学员们|购票观众即|6氪|新股王|信息系统|文章来源|全新突破|近期|36氪首发|技术团队|二季度普华汇|AI下半场|外部危机和人工智能|核聚变装置)$'

// 存量 Radar 噪音不做物理删除，但从公共池列表和统计中排除。
// 无明确公司、融资或估值时，获奖/教学/任职资讯直接隐藏。
// “论文”是独立线索类型，不套用公司线索的融资/商业化门槛；其标题作为项目名称展示，
// 并继续走论文专属评分。qualityRejected 和 poolStatus 检查仍对所有来源生效。
const visiblePublicLeadExpr = sql<boolean>`NOT (
  COALESCE(${leads.source}, '') REGEXP '^项目发现雷达'
  AND COALESCE(${jsonText(leads.radarProfile, '$.channel')}, '') <> '论文'
  AND (
    COALESCE(${leads.name}, '') REGEXP ${PUBLIC_LEAD_INVALID_SUBJECT_PATTERN}
    OR ${publicLeadTitleExpr} REGEXP ${PUBLIC_LEAD_LOW_VALUE_PATTERN}
    OR (
      NOT (${publicLeadPrimaryTextExpr} REGEXP ${PUBLIC_LEAD_INVESTMENT_PATTERN})
      AND ${publicLeadSignalTextExpr} REGEXP ${PUBLIC_LEAD_LOW_VALUE_PATTERN}
    )
    OR (
      NOT (${publicLeadPrimaryTextExpr} REGEXP ${PUBLIC_LEAD_INVESTMENT_PATTERN})
      AND
      NOT ${publicLeadHasCompanyExpr}
      AND (
        NOT (${publicLeadPrimaryTextExpr} REGEXP ${PUBLIC_LEAD_COMMERCIAL_PATTERN})
        OR NOT (COALESCE(${leads.name}, '') REGEXP ${PUBLIC_LEAD_CONCRETE_SUBJECT_PATTERN})
      )
    )
  )
  OR COALESCE(${jsonText(leads.radarProfile, '$.qualityRejected')}, '') = 'true'
  OR ${leads.poolStatus} = '解析失败'
  OR ${leads.poolStatus} = '已合并'
  OR ${leads.poolStatus} = '已删除'
)`

export type LeadScoreJobStatus = 'queued' | 'running' | 'retrying' | 'done' | 'failed' | 'dead_letter'

export interface LeadScoreJob {
  status: LeadScoreJobStatus
  attempts: number
  maxAttempts: number
  retryCycles?: number
  queuedAt?: string
  startedAt?: string
  updatedAt: string
  completedAt?: string
  nextRetryAt?: string
  error?: string
}

const LEAD_SCORE_JOB_STATUSES = new Set<LeadScoreJobStatus>(['queued', 'running', 'retrying', 'done', 'failed', 'dead_letter'])

export function readLeadScoreJob(scoring: unknown): LeadScoreJob | null {
  if (!scoring || typeof scoring !== 'object' || Array.isArray(scoring)) return null
  const raw = (scoring as Record<string, unknown>).scoreJob
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const status = String(value.status ?? '') as LeadScoreJobStatus
  if (!LEAD_SCORE_JOB_STATUSES.has(status)) return null
  return {
    status,
    attempts: Math.max(0, Number(value.attempts) || 0),
    maxAttempts: Math.max(1, Number(value.maxAttempts) || 1),
    retryCycles: Math.max(0, Number(value.retryCycles) || 0),
    queuedAt: typeof value.queuedAt === 'string' ? value.queuedAt : undefined,
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : undefined,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
    completedAt: typeof value.completedAt === 'string' ? value.completedAt : undefined,
    nextRetryAt: typeof value.nextRetryAt === 'string' ? value.nextRetryAt : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
  }
}

export async function saveLeadScoreJob(leadId: string, job: LeadScoreJob) {
  const payload = JSON.stringify({
    ...job,
    error: job.error?.slice(0, 500),
  })
  await db.update(leads).set({
    scoring: sql`JSON_SET(COALESCE(${leads.scoring}, JSON_OBJECT()), '$.scoreJob', CAST(${payload} AS JSON))` as never,
  }).where(eq(leads.id, leadId))
  const [row] = await db.select({ id: leads.id }).from(leads).where(eq(leads.id, leadId)).limit(1)
  return row ?? null
}

export async function clearLeadScoreJob(leadId: string) {
  await db.update(leads).set({
    scoring: sql`CASE
      WHEN ${leads.scoring} IS NULL THEN NULL
      ELSE JSON_REMOVE(${leads.scoring}, '$.scoreJob')
    END` as never,
  }).where(eq(leads.id, leadId))
  const [row] = await db.select({ id: leads.id }).from(leads).where(eq(leads.id, leadId)).limit(1)
  return row ?? null
}

export async function isLeadEligibleForScoring(leadId: string) {
  const [row] = await db.select({ id: leads.id }).from(leads)
    .where(sql`${leads.id} = ${leadId} AND ${visiblePublicLeadExpr}`)
    .limit(1)
  return Boolean(row)
}

export async function listRecoverableLeadScoreIds(limit = 500) {
  const rows = await db.select({ id: leads.id }).from(leads)
    .where(sql`
      ${visiblePublicLeadExpr}
      AND NOT (
        COALESCE(JSON_TYPE(${jsonValue(leads.scoring, '$.dimensions')}) = 'ARRAY', false)
        AND COALESCE(JSON_LENGTH(${jsonValue(leads.scoring, '$.dimensions')}), 0) > 0
      )
      AND (
        COALESCE(${jsonText(leads.scoring, '$.scoreJob.status')}, '') IN ('queued', 'running', 'retrying', 'failed')
        OR ${jsonValue(leads.scoring, '$.scoreJob')} IS NULL
      )
    `)
    .orderBy(desc(leads.createdAt))
    .limit(Math.max(1, Math.min(limit, 1000)))
  return rows.map((row) => row.id)
}

const BUSINESS_INDUSTRY_RULES: Array<{ label: string; terms: string[] }> = [
  { label: '人工智能', terms: ['人工智能', '大模型', '机器学习'] },
  { label: '自然语言处理', terms: ['自然语言处理'] },
  { label: '计算机视觉', terms: ['计算机视觉'] },
  { label: '具身智能/机器人', terms: ['具身智能', '机器人'] },
  { label: '网络安全', terms: ['网络安全'] },
  { label: '半导体/芯片', terms: ['半导体', '芯片', '集成电路'] },
  { label: '数据科学', terms: ['数据科学', '信息检索', '社交网络', '信息论', '计算与社会'] },
  { label: '软件工程', terms: ['软件工程', '计算逻辑', '计算经济', '多智能体系统'] },
  { label: '前沿技术', terms: ['前沿技术', '量子', '航空航天', '数学与计算'] },
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

function comparableSubjectText(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')
}

export function readAcceptedAiSubjectReview(
  radarProfile: Record<string, unknown>,
): { subjectName: string; companyName: string | null } | null {
  const review = radarProfile.aiSubjectReview
  if (!review || typeof review !== 'object' || Array.isArray(review)) return null
  const value = review as Record<string, unknown>
  if (value.decision !== 'accept' || Number(value.confidence) < 0.8) return null
  const subjectName = meaningfulPresentationText(value.subjectName)
  const evidence = meaningfulPresentationText(value.evidence)
  if (!subjectName || !evidence) return null
  const comparableSubject = comparableSubjectText(subjectName)
  if (!comparableSubject || !comparableSubjectText(evidence).includes(comparableSubject)) return null
  const subjectType = String(value.subjectType ?? '')
  const legalName = meaningfulPresentationText(value.legalName)
  return {
    subjectName,
    companyName: subjectType === 'company' ? (legalName || subjectName) : null,
  }
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
  return resolveLeadBusinessRegion({ registry, profile })?.region ?? '待确认'
}

export function deriveValuationDisplay(
  scoring: Record<string, unknown>,
  radarProfile: Record<string, unknown>,
  analysisStatus: 'pending' | 'ready',
  fundingRounds: unknown = [],
) {
  const rounds = Array.isArray(scoring.fundingRoundsResearched) ? scoring.fundingRoundsResearched : []
  const researched = rounds
    .map((round) => {
      const item = round && typeof round === 'object' ? round as Record<string, unknown> : {}
      return {
        value: meaningfulPresentationText(item.valuation),
        sourceUrl: meaningfulPresentationText(item.sourceUrl),
      }
    })
    .find((item) => Boolean(item.value))
  const profile = (radarProfile.profile && typeof radarProfile.profile === 'object' ? radarProfile.profile : {}) as Record<string, unknown>
  const historical = (Array.isArray(fundingRounds) ? fundingRounds : [])
    .map((round) => {
      const item = round && typeof round === 'object' ? round as Record<string, unknown> : {}
      return {
        value: meaningfulPresentationText(item.valuation),
        sourceUrl: meaningfulPresentationText(item.sourceUrl),
      }
    })
    .find((item) => Boolean(item.value))
  const profileValue = meaningfulPresentationText(profile.latestValuation)
  if (researched?.value) {
    return {
      value: researched.value,
      status: 'available' as const,
      sourceUrl: researched.sourceUrl,
      sourceLabel: researched.sourceUrl ? '公开融资来源' : 'AI 评分资料',
    }
  }
  if (profileValue) {
    return {
      value: profileValue,
      status: 'available' as const,
      sourceUrl: meaningfulPresentationText(radarProfile.link),
      sourceLabel: '雷达原文',
    }
  }
  if (historical?.value) {
    return {
      value: historical.value,
      status: 'available' as const,
      sourceUrl: historical.sourceUrl,
      sourceLabel: historical.sourceUrl ? '融资来源' : '历史融资资料',
    }
  }
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

export function deriveOverallScore(scoring: Record<string, unknown>, fallbackScore: number) {
  const rawTotal = scoring.total
  const total = (
    typeof rawTotal === 'number'
    || (typeof rawTotal === 'string' && rawTotal.trim().length > 0)
  ) ? Number(rawTotal) : Number.NaN
  return Number.isFinite(total) && total >= 0
    ? Math.round(total)
    : (Number.isFinite(fallbackScore) ? fallbackScore : 0)
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
  return latest ? formatShanghaiDateKey(latest) : ''
}

export function derivePoolEnteredAt(createdAt: Date | null) {
  return createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : ''
}

function enrichLead(row: typeof leads.$inferSelect) {
  const arr = (v: unknown) => Array.isArray(v) ? v : []
  const has = (v: unknown) => typeof v === 'string' ? v.trim().length > 0 : !!v
  // 完整度: 优先用 SQL 层算好并随行传入的 completeness(列表/详情一致);
  // 兜底(直接传 $inferSelect 无 completeness 字段时): 用纯资料 8 位在 JS 里重算,口径与 SQL 一致。
  const sc = sanitizeScoringCompetitors((row as { scoring?: Record<string, unknown> }).scoring)
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
  const profile = (rp.profile && typeof rp.profile === 'object' ? rp.profile : {}) as Record<string, unknown>
  const isRadarLead = /^项目发现雷达(?:\s|·|$)/.test(src)
  const isPaper = String(rp.channel ?? '') === '论文'
  const paperMeta = (rp.paperMeta && typeof rp.paperMeta === 'object' ? rp.paperMeta : {}) as Record<string, unknown>
  const paperTitleZh = isPaper ? meaningfulPresentationText(paperMeta.titleZh) : undefined
  const sourceTitle = String(rp.sourceTitle || ((arr(row.sources)[0] as Record<string, unknown> | undefined)?.title ?? '')).trim()
  const paperProjectIdentity = isPaper ? resolvePaperProjectIdentity({
    titleOriginal: paperMeta.titleOriginal || paperMeta.title || sourceTitle || row.name,
    titleZh: paperTitleZh,
    modelProjectName: paperMeta.projectNameOriginal,
    modelProjectNameZh: paperMeta.projectName || profile.projectName,
  }) : { projectName: '', projectNameOriginal: '' }
  const paperProjectName = meaningfulPresentationText(paperProjectIdentity.projectName)
  const paperAbstractZh = isPaper ? meaningfulPresentationText(paperMeta.abstractZh) : undefined
  const acceptedAiSubject = isRadarLead ? readAcceptedAiSubjectReview(rp) : null
  const derivedSubjectName = deriveRadarSubjectName({
    isPaper,
    existingName: row.name,
    companyNames: [
      (sc.registry as Record<string, unknown> | undefined)?.companyName,
      row.companyName,
      profile.companyName,
    ],
    projectName: profile.projectName,
    lab: profile.lab,
    team: profile.teamComposition || row.team,
    title: sourceTitle || row.name,
    articleText: rp.articleText || row.summary,
    excludedNames: [rp.sourceName, rp.accountName],
  })
  // 新数据优先使用入池前已通过原文证据校验的 AI 主体。只有没有 AI 审查结果的
  // 历史数据才使用旧推断逻辑兜底，避免英文品牌等有效名称被改成“主体待确认”。
  const subjectName = isRadarLead
    ? (
        acceptedAiSubject?.subjectName
        || derivedSubjectName
        || (isSpecificLeadSubjectName(row.name, isPaper) ? row.name : '主体待确认')
      )
    : row.name
  const isResearchSubjectFallback = isRadarLead
    && row.companyName === row.name
    && /(?:大学|学院|研究院|研究所|医院|实验室|课题组|教授团队|研究员团队|科研团队|研究团队)$/.test(String(row.companyName ?? ''))
  const subjectCompanyName = acceptedAiSubject?.companyName
    || (
      isRadarLead && (!isSpecificLeadSubjectName(row.companyName) || isResearchSubjectFallback)
        ? null
        : row.companyName
    )
  // 主体名称与项目名称是两个语义：例如主体“海昶生物”对应
  // “创新多肽偶联药物 PDC 平台项目”。Drawer 标题使用 subjectName，
  // 项目字段保留 Radar 原始结构化项目名，不能为了表面一致而互相覆盖。
  const displayRadarProfile = rp
  const channel = (rp && rp.channel) ? rp.channel
    : /情报|必应|公开信息/.test(src) ? '重点机构'
    : /论文|专利|arxiv/i.test(src) ? '论文专利'
    : /院校|大学|高校|实验室/.test(src) ? '院校'
    : /微信|群/.test(src) ? '微信群' : '新闻'
  const regionResolution = resolveLeadBusinessRegion({
    businessRegion: (row as { businessRegion?: string | null }).businessRegion,
    businessRegionSource: (row as { businessRegionSource?: string | null }).businessRegionSource,
    businessRegionConfidence: (row as { businessRegionConfidence?: string | null }).businessRegionConfidence,
    registry: (sc.registry && typeof sc.registry === 'object' ? sc.registry : {}) as Record<string, unknown>,
    profile,
    subjectName,
    companyName: subjectCompanyName,
    sourceGroup: rp.sourceGroup,
    channel: rp.channel,
    sourceName: rp.sourceName,
    accountName: rp.accountName,
    sourceTitle,
    summary: row.summary,
    articleText: rp.articleText,
  })
  const region = regionResolution?.region ?? '待确认'
  const scoreJob = readLeadScoreJob(sc)
  const publicScoreJob = analysisStatus === 'ready'
    ? {
        ...(scoreJob ?? {
          attempts: 1,
          maxAttempts: 1,
          updatedAt: meaningfulPresentationText(sc.scored_at) ?? new Date(0).toISOString(),
        }),
        status: 'done' as const,
        error: undefined,
      }
    : scoreJob
    ? {
        ...scoreJob,
        error: scoreJob.error
          ? ['failed', 'dead_letter'].includes(scoreJob.status)
            ? publicLeadScoreDeadLetterError(scoreJob.error)
            : publicLeadScoreError(scoreJob.error)
          : undefined,
      }
    : null
  const { fieldProvenance: _fieldProvenance, ...publicRow } = row
  return {
    ...publicRow,
    scoring: sc,
    name: paperProjectName || paperTitleZh || subjectName,
    summary: paperAbstractZh || row.summary,
    companyName: subjectCompanyName,
    score: deriveOverallScore(sc, row.score),
    radarProfile: displayRadarProfile,
    completeness,
    verificationStatus,
    analysisStatus,
    lastVerifiedAt: row.createdAt ? formatShanghaiDateKey(row.createdAt) : '',
    channel,
    region,
    regionSource: regionResolution?.source,
    regionConfidence: regionResolution?.confidence,
    businessTags: {
      industry: deriveIndustryTags(row.industry),
      region: [region],
    },
    valuationDisplay: deriveValuationDisplay(sc, rp, analysisStatus, row.fundingRounds),
    technicalScore: deriveTechnicalScore(sc),
    scoreJob: publicScoreJob,
    // “最新入池”只认首次进入公共线索池的数据库时间，不受原文发布时间、
    // AI 评分完成时间或后续资料补全影响。
    poolEnteredAt: derivePoolEnteredAt(row.createdAt),
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
  // 渠道过滤:通常按 radar_profile.channel 精确匹配。36氪历史数据曾被 source_group
  // 错标为“创投新闻”，查询时同时依据具体来源字段识别，避免回填前筛选漏数。
  // 空值 = 不过滤；没有 radar channel 且也无法从来源识别的非雷达数据会被排除。
  const channel = (options.channel ?? '').trim()
  // 关键词全库跨字段模糊检索（依赖 MySQL 当前不区分大小写排序规则）；source 二级标签按 sourceName 模糊匹配。
  // channel/keyword/source 可叠加,均进 whereClause 用 and() 合并。
  const keyword = (options.keyword ?? '').trim()
  const source = (options.source ?? '').trim()
  const industry = (options.industry ?? '').trim()
  const region = (options.region ?? '').trim()
  const conds: ReturnType<typeof sql>[] = [visiblePublicLeadExpr]
  // 已入库线索全部可见；未完成 AI 分析的记录由 enrichLead 标为 pending。
  // 同步和 AI 评分解耦，避免“已经同步但列表看不到”。
  const is36KrSource = sql`(
    COALESCE(${jsonText(leads.radarProfile, '$.sourceName')}, '') LIKE '%36氪%'
    OR COALESCE(${jsonText(leads.radarProfile, '$.radarSourceKey')}, '') LIKE '%36kr%'
  )`
  if (channel === '36氪') {
    conds.push(sql`(${jsonText(leads.radarProfile, '$.channel')} = '36氪' OR ${is36KrSource})`)
  } else if (channel === '创投新闻') {
    // 前端渠道需要互斥：“创投新闻”只展示非 36氪的其他创投媒体。
    // 同时检查 channel 和具体来源字段，兼容历史数据中 channel 尚未正确回填的记录。
    conds.push(sql`(
      (
        ${jsonText(leads.radarProfile, '$.sourceGroup')} = '创投新闻'
        OR ${jsonText(leads.radarProfile, '$.channel')} = '创投新闻'
      )
      AND COALESCE(${jsonText(leads.radarProfile, '$.channel')}, '') <> '36氪'
      AND NOT ${is36KrSource}
    )`)
  } else if (channel) {
    conds.push(sql`${jsonText(leads.radarProfile, '$.channel')} = ${channel}`)
  }
  if (source) {
    // source 可为逗号分隔的多个关键词(前端二级标签把一个标准机构映射到多个杂乱账号名),任一命中即算该机构
    const srcKws = source.split(',').map((x) => x.trim()).filter(Boolean)
    if (srcKws.length === 1) {
      conds.push(sql`${jsonText(leads.radarProfile, '$.sourceName')} LIKE ${'%' + srcKws[0] + '%'}`)
    } else if (srcKws.length > 1) {
      const ors = srcKws.map((kw) => sql`${jsonText(leads.radarProfile, '$.sourceName')} LIKE ${'%' + kw + '%'}`)
      conds.push(sql`(${sql.join(ors, sql` OR `)})`)
    }
  }
  if (industry) {
    // 行业检索：LIKE 模糊匹配 leads.industry（行业值杂乱，多为逗号拼接的多标签如“企业服务、前沿技术”），
    // 选"前沿技术"用 %前沿技术% 即可命中所有含该词的多标签行。支持逗号分隔多关键词(任一命中)。
    const selectedTerms = BUSINESS_INDUSTRY_RULES.find((rule) => rule.label === industry)?.terms ?? [industry]
    const indKws = selectedTerms.map((x) => x.trim()).filter(Boolean)
    if (indKws.length === 1) {
      conds.push(sql`${leads.industry} LIKE ${'%' + indKws[0] + '%'}`)
    } else if (indKws.length > 1) {
      const ors = indKws.map((kw) => sql`${leads.industry} LIKE ${'%' + kw + '%'}`)
      conds.push(sql`(${sql.join(ors, sql` OR `)})`)
    }
  }
  if (region && BUSINESS_REGIONS.some((candidate) => candidate === region)) {
    conds.push(sql`${leads.businessRegion} = ${region}`)
  }
  if (keyword) {
    const kw = '%' + keyword + '%'
    // 跨字段: 主展示列 + radar_profile/scoring 全文(投资方/团队/机构/来源账号等都在里面)
    conds.push(sql`(
      ${leads.name} LIKE ${kw}
      OR ${leads.companyName} LIKE ${kw}
      OR ${leads.industry} LIKE ${kw}
      OR ${leads.summary} LIKE ${kw}
      OR ${leads.source} LIKE ${kw}
      OR CAST(${leads.radarProfile} AS CHAR) LIKE ${kw}
      OR CAST(${leads.scoring} AS CHAR) LIKE ${kw}
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
      businessRegion: leads.businessRegion,
      businessRegionSource: leads.businessRegionSource,
      businessRegionConfidence: leads.businessRegionConfidence,
      source: leads.source,
      poolStatus: leads.poolStatus,
      score: overallScoreExpr,
      summary: leads.summary,
      // 轻量 scoring 摘要:只挑 completeness 计算需要的数组长度/存在性(不拉整个 scoring 大 jsonb)
      scoring: sql<unknown>`CASE WHEN ${leads.scoring} IS NULL THEN NULL ELSE JSON_OBJECT(
        'dimensions', COALESCE(${jsonValue(leads.scoring, '$.dimensions')}, JSON_ARRAY()),
        'structuredTeam', COALESCE(${jsonValue(leads.scoring, '$.structuredTeam')}, JSON_ARRAY()),
        'structuredShareholders', COALESCE(${jsonValue(leads.scoring, '$.structuredShareholders')}, JSON_ARRAY()),
        'competitors', COALESCE(${jsonValue(leads.scoring, '$.competitors')}, JSON_ARRAY()),
        'fundingRoundsResearched', COALESCE(${jsonValue(leads.scoring, '$.fundingRoundsResearched')}, JSON_ARRAY()),
        'researchSources', COALESCE(${jsonValue(leads.scoring, '$.researchSources')}, JSON_ARRAY()),
        'total', ${jsonValue(leads.scoring, '$.total')},
        'overall_comment', ${jsonValue(leads.scoring, '$.overall_comment')},
        'scored_at', ${jsonValue(leads.scoring, '$.scored_at')},
        'scoreJob', ${jsonValue(leads.scoring, '$.scoreJob')},
        'registry', COALESCE(${jsonValue(leads.scoring, '$.registry')}, JSON_OBJECT())
      ) END`,
      // 列表只取 radar_profile 里列表渲染需要的字段,保持与详情接口"同构"({profile,channel,sourceName,...})
      // 否则前端 setSelected(列表lead) 后 Drawer 按嵌套结构访问会拿到 undefined,导致弹窗渲染异常
      // 只构造 profile + 几个行内展示字段，避免返回完整 JSON 大字段，大小从 8-37KB 降到 <1KB。
      radarProfile: sql<unknown>`CASE WHEN ${leads.radarProfile} IS NULL THEN NULL ELSE JSON_OBJECT(
        'profile', ${jsonValue(leads.radarProfile, '$.profile')},
        'channel', ${jsonValue(leads.radarProfile, '$.channel')},
        'sourceName', ${jsonValue(leads.radarProfile, '$.sourceName')},
        'sourceGroup', ${jsonValue(leads.radarProfile, '$.sourceGroup')},
        'sourceTitle', COALESCE(${jsonValue(leads.radarProfile, '$.sourceTitle')}, ${jsonValue(leads.sources, '$[0].title')}),
        'publishedAt', ${jsonValue(leads.radarProfile, '$.publishedAt')},
        'aiSubjectReview', ${jsonValue(leads.radarProfile, '$.aiSubjectReview')},
        'paperMeta', CASE
          WHEN ${jsonValue(leads.radarProfile, '$.paperMeta')} IS NULL THEN NULL
          ELSE JSON_OBJECT(
            'titleZh', ${jsonValue(leads.radarProfile, '$.paperMeta.titleZh')},
            'projectName', ${jsonValue(leads.radarProfile, '$.paperMeta.projectName')},
            'projectNameOriginal', ${jsonValue(leads.radarProfile, '$.paperMeta.projectNameOriginal')},
            'authors', ${jsonValue(leads.radarProfile, '$.paperMeta.authors')},
            'categories', ${jsonValue(leads.radarProfile, '$.paperMeta.categories')}
          )
        END
      ) END`,
      // 列表估值兜底：仅保留第一条历史融资的轮次/估值，避免返回完整 funding_rounds。
      fundingRounds: sql<unknown[]>`CASE
        WHEN JSON_LENGTH(COALESCE(${leads.fundingRounds}, JSON_ARRAY())) > 0 THEN JSON_ARRAY(JSON_OBJECT(
          'round', ${jsonValue(leads.fundingRounds, '$[0].round')},
          'valuation', ${jsonValue(leads.fundingRounds, '$[0].valuation')}
        ))
        ELSE JSON_ARRAY()
      END`,
      completeness: completenessExpr,
      createdAt: leads.createdAt,
    }).from(leads).where(whereClause).orderBy(
      options.sort === 'score' ? desc(overallScoreExpr) : desc(leads.createdAt),
      desc(leads.id),
    ).limit(pageSize).offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(leads).where(whereClause),
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
    score: overallScoreExpr,
    scoring: sql<unknown>`CASE WHEN ${leads.scoring} IS NULL THEN NULL ELSE JSON_OBJECT(
      'dimensions', COALESCE(${jsonValue(leads.scoring, '$.dimensions')}, JSON_ARRAY()),
      'structuredTeam', COALESCE(${jsonValue(leads.scoring, '$.structuredTeam')}, JSON_ARRAY()),
      'structuredShareholders', COALESCE(${jsonValue(leads.scoring, '$.structuredShareholders')}, JSON_ARRAY()),
      'competitors', COALESCE(${jsonValue(leads.scoring, '$.competitors')}, JSON_ARRAY()),
      'fundingRoundsResearched', COALESCE(${jsonValue(leads.scoring, '$.fundingRoundsResearched')}, JSON_ARRAY()),
      'researchSources', COALESCE(${jsonValue(leads.scoring, '$.researchSources')}, JSON_ARRAY()),
      'total', ${jsonValue(leads.scoring, '$.total')},
      'overall_comment', ${jsonValue(leads.scoring, '$.overall_comment')},
      'registry', COALESCE(${jsonValue(leads.scoring, '$.registry')}, JSON_OBJECT())
    ) END`,
  }).from(leads).where(visiblePublicLeadExpr)
  let total = 0, verified = 0, highPriority = 0, compSum = 0
  for (const r of rows) {
    total++
    const e = enrichLead(r as typeof leads.$inferSelect)
    compSum += e.completeness
    if (e.verificationStatus !== '待核验') verified++
    if (e.score >= 60) highPriority++
  }
  return {
    total,
    verified,
    highPriority,
    avgCompleteness: total ? Math.round(compSum / total) : 0,
  }
}

export async function getLeadById(leadId: string) {
  const [mapping] = await db.select({ targetId: migrationEntityMappings.targetId })
    .from(migrationEntityMappings)
    .where(and(
      eq(migrationEntityMappings.sourceSystem, 'business_decision'),
      eq(migrationEntityMappings.sourceTable, 'lead_duplicate_merge'),
      eq(migrationEntityMappings.sourceId, leadId),
    )).limit(1)
  const canonicalLeadId = mapping?.targetId || leadId
  const [row] = await db.select({ ...getTableColumns(leads), completeness: completenessExpr })
    .from(leads).where(eq(leads.id, canonicalLeadId)).limit(1)
  return row ? enrichLead(row as typeof leads.$inferSelect & { completeness: number }) : null
}

export async function deleteLeadFromPublicPool(
  leadId: string,
  actor: { userId: string; userName: string },
) {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT ${leads.id} FROM ${leads} WHERE ${leads.id}=${leadId} FOR UPDATE`)
    const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId)).limit(1)
    if (!lead) return null
    if (lead.poolStatus === '已删除') {
      return { id: lead.id, name: lead.name, alreadyDeleted: true }
    }

    await tx.update(leads).set({ poolStatus: '已删除' }).where(eq(leads.id, lead.id))
    // 已领取的评分任务不应继续占用队列；原始 Pipeline、导入和实体匹配记录
    // 通过外键或不可变审计继续保留，已转专属项目也不受影响。
    await tx.delete(leadScoreJobs).where(eq(leadScoreJobs.leadId, lead.id))
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      userName: actor.userName,
      module: '项目获取池',
      action: '删除公共线索',
      target: `${lead.name} · ${lead.id}`,
    })
    return { id: lead.id, name: lead.name, alreadyDeleted: false }
  })
}

type AppDatabase = typeof db

async function createLeadRecord(
  input: typeof leads.$inferInsert,
  userId: string | undefined,
  database: AppDatabase,
  ingest = true,
) {
  const [inserted] = await database.insert(leads).values(input).$returningId()
  const [row] = await database.select().from(leads).where(eq(leads.id, inserted.id)).limit(1)
  if (row) {
    await database.insert(auditLogs).values({
      userId: userId ?? null,
      userName: '（系统）',
      module: '项目获取池',
      action: '上传并解析 BP',
      target: row.name,
    })
    if (ingest) void ingestLeadProfile(row)
  }
  return row
}

export async function createLead(input: typeof leads.$inferInsert, userId?: string) {
  return await createLeadRecord({
    ...input,
    fieldProvenance: initialLeadFieldProvenance(input as Record<string, unknown>, userId ? 'manual' : 'legacy_import'),
  }, userId, db, true)
}

type RadarLeadSyncResult = {
  status: 'created' | 'updated' | 'unchanged'
  row: typeof leads.$inferSelect
  duplicateMatches: number
  entityMatchType: 'radar_source_key' | 'exact_name' | 'source_url' | 'no_match'
}

type RadarLeadAmbiguityError = Error & {
  code: 'RADAR_LEAD_ENTITY_AMBIGUOUS'
  duplicateMatches: number
  reviewStaged?: boolean
  candidates: Array<typeof leads.$inferSelect>
  matchType: 'radar_source_key' | 'exact_name' | 'source_url'
}

function radarLeadAmbiguityError(
  name: string,
  candidates: Array<typeof leads.$inferSelect>,
  matchType: RadarLeadAmbiguityError['matchType'],
): RadarLeadAmbiguityError {
  const error = Object.assign(new Error(`Radar 主体匹配到多条正式线索，必须人工指定目标: ${name}`), {
    code: 'RADAR_LEAD_ENTITY_AMBIGUOUS' as const,
    duplicateMatches: Math.max(1, candidates.length - 1),
    reviewStaged: false,
    matchType,
  }) as RadarLeadAmbiguityError
  Object.defineProperty(error, 'candidates', { value: candidates, enumerable: false })
  return error
}

function radarLeadLockNames(input: RadarLeadSyncFields) {
  const normalizedName = input.name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  const identities = [
    normalizedName ? `name:${normalizedName}` : '',
    ...(input.radarSourceKeys ?? [])
      .map((sourceKey) => sourceKey.normalize('NFKC').trim().toLocaleLowerCase())
      .filter(Boolean)
      .map((sourceKey) => `source:${sourceKey}`),
  ].filter(Boolean)
  return [...new Set(identities)]
    .map((identity) => `radar-lead:${createHash('sha256').update(identity).digest('hex').slice(0, 48)}`)
    .sort()
}

async function withRadarLeadLocks<T>(
  input: RadarLeadSyncFields,
  task: (connection: PoolConnection) => Promise<T>,
  suppliedConnection?: PoolConnection,
): Promise<T> {
  const lockNames = radarLeadLockNames(input)
  const connection = suppliedConnection ?? await pool.getConnection()
  const acquired: string[] = []
  try {
    for (const lockName of lockNames) {
      const [rows] = await connection.query<Array<RowDataPacket & { acquired: number | null }>>(
        'SELECT GET_LOCK(?, 15) AS acquired',
        [lockName],
      )
      if (Number(rows[0]?.acquired) !== 1) {
        throw Object.assign(new Error('Radar 线索同步互斥锁等待超时，请稍后重试'), {
          code: 'RADAR_SYNC_LOCK_TIMEOUT',
          retryable: true,
        })
      }
      acquired.push(lockName)
    }
    return await task(connection)
  } finally {
    for (const lockName of acquired.reverse()) {
      await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {})
    }
    if (!suppliedConnection) connection.release()
  }
}

async function syncRadarLeadByNameUnlocked(
  input: RadarLeadSyncFields,
  userId?: string,
  database: AppDatabase = db,
  ingest = true,
): Promise<RadarLeadSyncResult> {
  // 主体名称优化后可能与历史错误短语不同：先按明确名称匹配，匹配不到时
  // 再按 Radar 原文链接定位同一条线索，使历史模糊名称可被安全升级而不新建重复记录。
  const radarSourceKey = input.radarSourceKeys?.find((value) => value.trim())?.trim() ?? ''
  let entityMatchType: RadarLeadSyncResult['entityMatchType'] = radarSourceKey ? 'radar_source_key' : 'exact_name'
  let matches = radarSourceKey
    ? await database.select().from(leads)
      .where(and(
        sql`JSON_CONTAINS(${leads.radarSourceKeys}, JSON_ARRAY(${radarSourceKey}))`,
        ne(leads.poolStatus, '已合并'),
      ))
      .orderBy(asc(leads.createdAt))
    : []
  if (!matches.length) {
    entityMatchType = 'exact_name'
    matches = await database.select().from(leads)
      .where(and(eq(leads.name, input.name), ne(leads.poolStatus, '已合并')))
      .orderBy(asc(leads.createdAt))
  }
  const inputRadarProfile = input.radarProfile && typeof input.radarProfile === 'object'
    ? input.radarProfile as Record<string, unknown>
    : {}
  const sourceLink = typeof inputRadarProfile.link === 'string' ? inputRadarProfile.link.trim() : ''
  if (!matches.length && sourceLink) {
    entityMatchType = 'source_url'
    matches = await database.select().from(leads)
      .where(and(sql`${jsonText(leads.radarProfile, '$.link')} = ${sourceLink}`, ne(leads.poolStatus, '已合并')))
      .orderBy(asc(leads.createdAt))
  }
  if (matches.length > 1) {
    throw radarLeadAmbiguityError(input.name, matches, entityMatchType)
  }
  const existing = matches[0]
  if (!existing) {
    try {
      const row = await createLeadRecord({
        ...input,
        score: 0,
        fieldProvenance: initialLeadFieldProvenance(input as unknown as Record<string, unknown>, 'radar'),
      } as typeof leads.$inferInsert, userId, database, ingest)
      if (!row) throw new Error(`新增 Radar 线索失败：${input.name}`)
      return { status: 'created', row, duplicateMatches: 0, entityMatchType: 'no_match' }
    } catch (createErr) {
      // 并发竞态：唯一约束冲突 → 另一并发请求已创建同名记录，退化为 merge
      if ((createErr as Error & { code?: string }).code === 'ER_DUP_ENTRY') {
        const [fallback] = await database.select().from(leads)
          .where(and(eq(leads.name, input.name), ne(leads.poolStatus, '已合并')))
          .orderBy(asc(leads.createdAt))
        if (fallback) {
          // 复用下面的 merge 逻辑
          matches = [fallback]
        } else {
          throw createErr
        }
      } else {
        throw createErr
      }
    }
  }

  // 此时 existing = matches[0] 一定有值（可能是并发的另一条记录）
  const merged = matches[0]
  const patch: Record<string, unknown> = {
    ...buildRadarLeadMergePatch(merged, input as RadarLeadSyncFields & Record<string, unknown>),
  }
  const canUpgradeSubjectName = /^项目发现雷达(?:\s|·|$)/.test(String(merged.source ?? ''))
    && isBetterLeadSubjectName(merged.name, input.name)
  if (canUpgradeSubjectName && input.name !== merged.name) {
    // 防止名称升级撞上已有记录的唯一约束
    const nameConflict = await database.select({ id: leads.id }).from(leads)
      .where(and(eq(leads.name, input.name), ne(leads.poolStatus, '已合并')))
      .limit(1)
    if (nameConflict.length === 0) {
      patch.name = input.name
      if (!isSpecificLeadSubjectName(merged.companyName) && input.companyName) {
        patch.companyName = input.companyName
      }
    }
  }
  if (Object.keys(patch).length === 0) {
    return { status: 'unchanged', row: merged, duplicateMatches: Math.max(0, matches.length - 1), entityMatchType }
  }

  const protectedPatch = applyLeadFieldPolicy(
    merged as unknown as Record<string, unknown>,
    patch,
    'radar',
    {
      additiveFields: ['fundingRounds', 'sources', 'highlights', 'risks', 'riskTags'],
      alwaysReplaceFields: ['radarProfile', 'radarSourceKeys'],
      linkedFields: [['businessRegion', 'businessRegionSource', 'businessRegionConfidence']],
      operation: 'machine_refresh',
    },
  )
  if (Object.keys(protectedPatch).length === 0) {
    return { status: 'unchanged', row: merged, duplicateMatches: Math.max(0, matches.length - 1), entityMatchType }
  }
  await database.update(leads)
    .set(protectedPatch as Partial<typeof leads.$inferInsert>)
    .where(eq(leads.id, merged.id))
  const [row] = await database.select().from(leads).where(eq(leads.id, merged.id)).limit(1)
  if (!row) throw new Error(`更新 Radar 线索失败：${input.name}`)
  await database.insert(auditLogs).values({
    userId: userId ?? null,
    userName: '（系统）',
    module: '项目获取池',
    action: 'Radar 增量更新',
    target: row.name,
  })
  if (ingest) void ingestLeadProfile(row)
  return { status: 'updated', row, duplicateMatches: Math.max(0, matches.length - 1), entityMatchType }
}

export async function syncRadarLeadByName(
  input: RadarLeadSyncFields,
  userId?: string,
): Promise<RadarLeadSyncResult> {
  return await withRadarLeadLocks(input, async () => await syncRadarLeadByNameUnlocked(input, userId))
}

export async function commitRadarLeadPipelineReady(input: {
  lead: RadarLeadSyncFields
  eventId: string
  transition: Omit<LeadPipelineTransitionInput, 'status' | 'leadId'>
  userId?: string
}): Promise<RadarLeadSyncResult> {
  const connection = await pool.getConnection()
  let result: RadarLeadSyncResult | null = null
  try {
    return await withRadarLeadLocks(input.lead, async () => {
      await connection.beginTransaction()
      try {
        const transactionDb = drizzle({ client: connection, schema, mode: 'default' }) as unknown as AppDatabase
        result = await syncRadarLeadByNameUnlocked(input.lead, input.userId, transactionDb, false)
        const transition = await transitionLeadPipelineItem(input.eventId, {
          ...input.transition,
          status: 'ready',
          leadId: result.row.id,
        }, connection)
        if (transition.blocked || transition.item.leadId !== result.row.id) {
          throw new Error('Radar Pipeline ready transition did not bind the committed lead')
        }
        await recordLeadPipelineEntityMatch({
          idempotencyKey: `${input.eventId}:radar-entity-resolution:${result.row.id}:v1`,
          eventId: input.eventId,
          subjectName: input.lead.name,
          matchType: result.entityMatchType,
          candidateLeadId: result.row.id,
          candidateName: result.row.name,
          candidateCompanyName: result.row.companyName,
          score: 10_000,
          status: result.status === 'created' ? 'created' : 'selected',
          resolutionType: result.status === 'created' ? 'created' : 'automatic',
          aliases: [input.lead.name, input.lead.companyName ?? ''].filter(Boolean),
          metadata: { syncStatus: result.status },
        }, connection)
        await connection.commit()
        void ingestLeadProfile(result.row)
        return result
      } catch (error) {
        await connection.rollback()
        const ambiguity = error as Partial<RadarLeadAmbiguityError>
        if (ambiguity.code === 'RADAR_LEAD_ENTITY_AMBIGUOUS') {
          const reason = `Radar 主体“${input.lead.name}”匹配到多条正式线索，必须人工选择合并目标`
          await connection.beginTransaction()
          try {
            const decision = await recordLeadPipelineDecision({
              idempotencyKey: `${input.eventId}:radar-entity-ambiguity:v1`,
              eventId: input.eventId,
              decisionType: 'entity_resolution',
              outcome: 'review',
              subjectName: input.lead.name,
              confidence: input.transition.confidence,
              reason,
              output: { duplicateMatches: ambiguity.duplicateMatches ?? 1 },
              actorType: 'system',
              actorId: 'radar-entity-resolution',
              evidence: [{
                sourceType: 'radar',
                claim: reason,
                verificationStatus: 'conflicted',
              }],
            }, connection)
            const review = await openLeadPipelineReview({
              idempotencyKey: `${input.eventId}:radar-entity-ambiguity:v1`,
              eventId: input.eventId,
              triggerDecisionId: decision.id,
              reason,
            }, connection)
            for (const candidate of ambiguity.candidates ?? []) {
              await recordLeadPipelineEntityMatch({
                idempotencyKey: `${input.eventId}:radar-entity-ambiguity:${candidate.id}:v1`,
                eventId: input.eventId,
                decisionId: decision.id,
                reviewId: review.id,
                subjectName: input.lead.name,
                matchType: ambiguity.matchType ?? 'exact_name',
                candidateLeadId: candidate.id,
                candidateName: candidate.name,
                candidateCompanyName: candidate.companyName,
                score: 10_000,
                status: 'ambiguous',
                metadata: { poolStatus: candidate.poolStatus },
              }, connection)
            }
            const transition = await transitionLeadPipelineItem(input.eventId, {
              status: 'review',
              reason,
              evidence: input.transition.evidence,
              confidence: input.transition.confidence,
              actorType: 'system',
              actorId: 'radar-entity-resolution',
            }, connection)
            if (transition.blocked || transition.item.status !== 'review' || transition.item.leadId) {
              throw new Error('Radar duplicate review transition did not preserve an unbound review item')
            }
            await connection.commit()
            ambiguity.reviewStaged = true
          } catch (reviewError) {
            await connection.rollback()
            throw reviewError
          }
        }
        throw error
      }
    }, connection)
  } finally {
    connection.release()
  }
}

function leadConversionError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code })
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function textValue(value: unknown): string | undefined {
  const valueText = typeof value === 'string' ? value.trim() : ''
  return valueText || undefined
}

export async function convertLead(leadId: string, userId: string) {
  const converted = await db.transaction(async (tx) => {
    const actor = await createMySqlIdentityRepositoryContext(tx).users.findById(userId)
    if (!actor || actor.status !== '启用') {
      throw leadConversionError(403, 'LEAD_CONVERT_ACTOR_INVALID', '当前账号不可执行线索转项目')
    }

    const [mapping] = await tx.select({ targetId: migrationEntityMappings.targetId })
      .from(migrationEntityMappings)
      .where(and(
        eq(migrationEntityMappings.sourceSystem, 'business_decision'),
        eq(migrationEntityMappings.sourceTable, 'lead_duplicate_merge'),
        eq(migrationEntityMappings.sourceId, leadId),
      )).limit(1)
    const canonicalLeadId = mapping?.targetId || leadId
    await tx.execute(sql`SELECT ${leads.id} FROM ${leads} WHERE ${leads.id}=${canonicalLeadId} FOR UPDATE`)
    const [lead] = await tx.select().from(leads).where(eq(leads.id, canonicalLeadId)).limit(1)
    if (!lead) throw leadConversionError(404, 'LEAD_NOT_FOUND', '线索不存在')
    if (lead.convertedProjectId) {
      throw leadConversionError(409, 'LEAD_ALREADY_CONVERTED', '该线索已转为专属项目，请刷新后查看')
    }

    const radarProfile = objectValue(lead.radarProfile)
    const profile = objectValue(radarProfile.profile)
    const firstFunding = objectValue(Array.isArray(lead.fundingRounds) ? lead.fundingRounds[0] : undefined)
    const riskTags = Array.isArray(lead.riskTags)
      ? lead.riskTags.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []
    const tags = [...new Set([textValue(lead.industry), ...riskTags].filter((item): item is string => Boolean(item)))]
    const [inserted] = await tx.insert(projects).values({
      name: lead.name,
      companyName: textValue(lead.companyName),
      industry: textValue(lead.industry),
      round: textValue(firstFunding.round) ?? textValue(profile.project_round),
      stage: '线索',
      stageSource: '线索转入',
      owner: actor.name,
      ownerUserId: actor.id,
      collaborators: [],
      source: textValue(lead.source),
      financing: textValue(firstFunding.amount) ?? textValue(profile.financing_amount),
      valuation: textValue(firstFunding.valuation) ?? textValue(profile.latest_valuation),
      riskLevel: riskTags.length > 1 ? '中' : '低',
      score: lead.score,
      progress: 12,
      summary: textValue(lead.summary),
      businessModel: null,
      market: null,
      team: textValue(lead.team),
      tags,
      scoring: lead.scoring,
      createdBy: actor.id,
    }).$returningId()
    await tx.insert(projectMembers).values({
      projectId: inserted.id,
      userId: actor.id,
      memberRole: 'owner',
      sourceName: actor.name,
    })
    await tx.update(leads).set({
      poolStatus: '已转专属项目',
      convertedProjectId: inserted.id,
      claimedBy: actor.name,
    }).where(eq(leads.id, lead.id))
    await tx.insert(auditLogs).values([
      { userId: actor.id, userName: actor.name, module: '项目管理', action: '从线索创建项目', target: lead.name },
      { userId: actor.id, userName: actor.name, module: '项目获取池', action: '领取为我的专属项目', target: lead.name },
    ])
    return { projectId: inserted.id, leadId: lead.id }
  })

  const [[project], [lead]] = await Promise.all([
    db.select().from(projects).where(eq(projects.id, converted.projectId)).limit(1),
    db.select().from(leads).where(eq(leads.id, converted.leadId)).limit(1),
  ])
  return {
    project: project.scoring ? { ...project, scoring: sanitizeScoringCompetitors(project.scoring) } : project,
    lead,
  }
}

export async function saveLeadScoring(
  leadId: string,
  scoring: unknown,
  score: number,
  options: { ingest?: boolean } = {},
) {
  // AI 分析只使用已入库资料。结构化维度回填到 leads 独立列时，
  // 仅用实质内容更新，不以空值覆盖原始资料。
  const sc = (scoring ?? {}) as Record<string, unknown>
  const arr = (v: unknown) => (Array.isArray(v) ? v : [])
  const nonEmpty = (a: unknown[]) => a.length > 0
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT ${leads.id} FROM ${leads} WHERE ${leads.id}=${leadId} FOR UPDATE`)
    const [current] = await tx.select().from(leads).where(eq(leads.id, leadId)).limit(1)
    if (!current) return undefined
    const proposed: Record<string, unknown> = { scoring: scoring as never, score }

    // AI 只能刷新自身拥有的标量；人工/人工复核/旧源字段受来源优先级保护。
    const team = arr(sc.structuredTeam) as Array<{ name?: string; title?: string; background?: string }>
    if (nonEmpty(team)) {
      proposed.team = team.map((t) => `${t.name ?? ''}${t.title ? `（${t.title}）` : ''}${t.background ? '：' + t.background : ''}`).filter((x) => x.trim()).join('；').slice(0, 2000)
    }
    const fundingRounds = arr(sc.fundingRoundsResearched)
    if (nonEmpty(fundingRounds)) proposed.fundingRounds = mergeRadarFundingRounds(current.fundingRounds, fundingRounds)
    const sources = arr(sc.researchSources)
    if (nonEmpty(sources)) proposed.sources = mergeRadarSources(current.sources, sources)
    const highlights = arr(sc.highlights)
    if (nonEmpty(highlights)) proposed.highlights = mergeUniqueValues(current.highlights, highlights)
    const risks = arr(sc.risks)
    if (nonEmpty(risks)) proposed.risks = mergeUniqueValues(current.risks, risks)

    const whatIsIt = typeof sc.whatIsIt === 'string' ? sc.whatIsIt.trim() : ''
    if (whatIsIt) proposed.summary = whatIsIt.slice(0, 1000)
    const registry = sc.registry && typeof sc.registry === 'object' && !Array.isArray(sc.registry)
      ? sc.registry as Record<string, unknown>
      : {}
    const regionResolution = resolveLeadBusinessRegion({ registry })
    if (regionResolution) {
      proposed.businessRegion = regionResolution.region
      proposed.businessRegionSource = regionResolution.source
      proposed.businessRegionConfidence = regionResolution.confidence
    }
    const registryCompanyName = typeof registry.companyName === 'string' ? registry.companyName.trim() : ''
    if (registryCompanyName && shouldBackfillCompanyName(current, registryCompanyName)) {
      proposed.companyName = registryCompanyName.slice(0, 128)
    }

    const protectedPatch = applyLeadFieldPolicy(
      current as unknown as Record<string, unknown>,
      proposed,
      'ai_scoring',
      {
        additiveFields: ['fundingRounds', 'sources', 'highlights', 'risks'],
        alwaysReplaceFields: ['scoring', 'score'],
        linkedFields: [['businessRegion', 'businessRegionSource', 'businessRegionConfidence']],
        operation: 'machine_refresh',
      },
    )
    if (Object.keys(protectedPatch).length) {
      await tx.update(leads).set(protectedPatch as never).where(eq(leads.id, leadId))
    }
    const [updated] = await tx.select().from(leads).where(eq(leads.id, leadId)).limit(1)
    return updated
  })
  if (row && options.ingest !== false) void ingestLeadProfile(row)
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
    .select({ id: leads.id, industry: leads.industry, total: sql<number | null>`CAST(${jsonText(leads.scoring, '$.total')} AS SIGNED)` })
    .from(leads)
  return rows as Array<{ id: string; industry: string | null; total: number | null }>
}
