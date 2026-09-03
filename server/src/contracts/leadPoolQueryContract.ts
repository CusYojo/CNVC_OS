import { z } from 'zod'
import { BUSINESS_REGIONS } from '../services/leadRegion.js'

export const SERVER_LEAD_POOL_CHANNELS = [
  '36氪', '机构公众号', '高校公众号', '论文',
] as const

export const SERVER_LEAD_POOL_INDUSTRIES = [
  '人工智能', '具身智能/机器人', '半导体/芯片', '前沿技术', '产业升级', '先进制造',
  '企业服务', '医疗健康', '生物医药', '新能源', '新材料', '汽车出行',
  '消费科技', '文化娱乐', '教育', '农业科技',
  '自然语言处理', '计算机视觉', '网络安全', '数据科学', '软件工程',
  '金融', '智能硬件/传感器', '工具软件', '算力基础设施', '能源环保', '物联网/硬件',
  '低空经济', '本地生活', '跨境出海', '物流', '旅游', '其他',
] as const

export const SERVER_LEAD_POOL_STAGES = [
  '种子轮', '天使轮', 'Pre-A轮', 'A轮', 'Pre-B轮', 'B轮', 'C轮及以后',
  '战略融资', '股权融资/轮次未披露', '科研成果',
] as const

export const SERVER_LEAD_PROFILE_STATUSES = [
  'never', 'verified', 'partial', 'conflicted', 'missing', 'not_applicable', 'stale',
] as const
export const SERVER_LEAD_CUSTOMER_STAGES = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as const
export const SERVER_LEAD_VALUATION_CURRENCIES = ['CNY', 'USD', 'HKD', 'EUR'] as const
export const SERVER_LEAD_VALUATION_TYPES = ['pre_money', 'post_money', 'undisclosed'] as const
export const SERVER_LEAD_POOL_SORTS = ['latest', 'funding', 'valuation', 'customer', 'profileUpdated'] as const
export const SERVER_LEAD_CUSTOMER_TIERS = ['A', 'B', 'C'] as const
const strictBooleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true')
const strictDateQuery = z.iso.date()
const strictPositiveIntegerQuery = (max: number, fallback: number) => z.union([
  z.number().int().min(1).max(max),
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(max)),
]).default(fallback)
const strictNonnegativeDecimalQuery = z.union([
  z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number)
    .pipe(z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)),
])
const sourceQuery = z.string().trim().min(1).max(1_000).superRefine((value, ctx) => {
  const tokens = value.split(',').map((token) => token.trim()).filter(Boolean)
  if (!tokens.length) ctx.addIssue({ code: 'custom', message: 'source must contain at least one non-empty value' })
  if (tokens.length > 20) ctx.addIssue({ code: 'custom', message: 'source supports at most 20 values' })
  if (tokens.some((token) => token.length > 100)) ctx.addIssue({ code: 'custom', message: 'each source value must be at most 100 characters' })
})

export const listLeadsQuery = z.object({
  page: strictPositiveIntegerQuery(10_000, 1),
  pageSize: strictPositiveIntegerQuery(100, 20),
  channel: z.enum(SERVER_LEAD_POOL_CHANNELS).optional(),
  sort: z.enum(SERVER_LEAD_POOL_SORTS).optional(),
  keyword: z.string().trim().min(1).max(100).optional(),
  source: sourceQuery.optional(),
  industry: z.enum(SERVER_LEAD_POOL_INDUSTRIES).optional(),
  region: z.enum(BUSINESS_REGIONS).optional(),
  leadType: z.enum(['company', 'research']).optional(),
  stage: z.enum(SERVER_LEAD_POOL_STAGES).optional(),
  updatedRange: z.enum(['7d', '30d', '90d']).optional(),
  industryLevel1: z.string().trim().min(1).max(128).optional(),
  industryLevel2: z.string().trim().min(1).max(128).optional(),
  industrySegment: z.string().trim().min(1).max(255).optional(),
  productRoute: z.string().trim().min(1).max(100).optional(),
  productionStage: z.string().trim().min(1).max(100).optional(),
  institution: z.string().trim().min(1).max(100).optional(),
  institutionType: z.string().trim().min(1).max(64).optional(),
  hasMajorInstitution: strictBooleanQuery.optional(),
  academicInstitution: z.string().trim().min(1).max(100).optional(),
  academicRelation: z.string().trim().min(1).max(100).optional(),
  hasCommercializationLink: strictBooleanQuery.optional(),
  latestRound: z.enum(SERVER_LEAD_POOL_STAGES.filter((stage) => stage !== '科研成果') as [string, ...string[]]).optional(),
  fundingDateFrom: strictDateQuery.optional(),
  fundingDateTo: strictDateQuery.optional(),
  valuationMin: strictNonnegativeDecimalQuery.optional(),
  valuationMax: strictNonnegativeDecimalQuery.optional(),
  valuationCurrency: z.enum(SERVER_LEAD_VALUATION_CURRENCIES).optional(),
  valuationType: z.enum(SERVER_LEAD_VALUATION_TYPES).optional(),
  customerTier: z.enum(SERVER_LEAD_CUSTOMER_TIERS).optional(),
  customerStageMin: z.enum(SERVER_LEAD_CUSTOMER_STAGES).optional(),
  hasVerifiedCustomer: strictBooleanQuery.optional(),
  profileStatus: z.enum(SERVER_LEAD_PROFILE_STATUSES).optional(),
  hasConflict: strictBooleanQuery.optional(),
}).strict().superRefine((query, ctx) => {
  if (query.fundingDateFrom && query.fundingDateTo && query.fundingDateFrom > query.fundingDateTo) {
    ctx.addIssue({ code: 'custom', path: ['fundingDateTo'], message: 'fundingDateTo must be on or after fundingDateFrom' })
  }
  if (query.valuationMin !== undefined && query.valuationMax !== undefined && query.valuationMin > query.valuationMax) {
    ctx.addIssue({ code: 'custom', path: ['valuationMax'], message: 'valuationMax must be greater than or equal to valuationMin' })
  }
  if ((query.valuationMin !== undefined || query.valuationMax !== undefined) && !query.valuationCurrency) {
    ctx.addIssue({ code: 'custom', path: ['valuationCurrency'], message: 'valuationCurrency is required for valuation ranges' })
  }
  if (query.sort === 'valuation' && !query.valuationCurrency) {
    ctx.addIssue({ code: 'custom', path: ['valuationCurrency'], message: 'valuationCurrency is required for valuation sorting' })
  }
})

export type ListLeadsQuery = z.infer<typeof listLeadsQuery>

export function normalizeLeadListPage(requestedPage: number, pageSize: number, total: number) {
  const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / pageSize))
  return {
    page: total === 0 ? 1 : Math.min(Math.max(1, Math.floor(requestedPage)), totalPages),
    pageSize,
    total: Math.max(0, total),
    totalPages,
  }
}
