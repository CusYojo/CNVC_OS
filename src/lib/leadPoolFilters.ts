export const LEAD_POOL_CHANNELS = [
  '36氪', '机构公众号', '高校公众号', '论文',
] as const

export const LEAD_POOL_INDUSTRIES = [
  '人工智能', '具身智能/机器人', '半导体/芯片', '前沿技术', '产业升级', '先进制造',
  '企业服务', '医疗健康', '生物医药', '新能源', '新材料', '汽车出行',
  '消费科技', '文化娱乐', '教育', '农业科技',
  '自然语言处理', '计算机视觉', '网络安全', '数据科学', '软件工程',
  '金融', '智能硬件/传感器', '工具软件', '算力基础设施', '能源环保', '物联网/硬件',
  '低空经济', '本地生活', '跨境出海', '物流', '旅游', '其他',
] as const

export const LEAD_POOL_REGIONS = [
  '北京', '上海', '天津', '重庆', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东',
  '广西', '海南', '四川', '贵州', '云南', '西藏', '陕西', '甘肃', '青海', '宁夏',
  '新疆', '香港', '澳门', '台湾',
] as const

export const LEAD_POOL_STAGES = [
  '种子轮', '天使轮', 'Pre-A轮', 'A轮', 'Pre-B轮', 'B轮', 'C轮及以后',
  '战略融资', '股权融资/轮次未披露', '科研成果',
] as const

export const LEAD_POOL_UPDATED_RANGES = [
  { value: '7d', label: '近7天' },
  { value: '30d', label: '近30天' },
  { value: '90d', label: '近90天' },
] as const

export const LEAD_POOL_PAGE_SIZES = [10, 20, 50] as const
export const LEAD_POOL_TYPES = ['company', 'research'] as const
export const LEAD_POOL_CUSTOMER_STAGES = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as const
export const LEAD_POOL_PROFILE_STATUSES = ['never', 'verified', 'partial', 'conflicted', 'missing', 'not_applicable', 'stale'] as const
export const LEAD_POOL_BOOLEAN_FILTERS = ['true', 'false'] as const
export const LEAD_POOL_SORTS = ['latest', 'funding', 'valuation', 'customer', 'profileUpdated'] as const
export const LEAD_POOL_VALUATION_CURRENCIES = ['CNY', 'USD', 'HKD', 'EUR'] as const
export const LEAD_POOL_VALUATION_TYPES = ['pre_money', 'post_money', 'undisclosed'] as const
export const LEAD_POOL_CUSTOMER_TIERS = ['A', 'B', 'C'] as const

export type LeadPoolChannel = typeof LEAD_POOL_CHANNELS[number]
export type LeadPoolIndustry = typeof LEAD_POOL_INDUSTRIES[number]
export type LeadPoolRegion = typeof LEAD_POOL_REGIONS[number]
export type LeadPoolStage = typeof LEAD_POOL_STAGES[number]
export type LeadPoolUpdatedRange = typeof LEAD_POOL_UPDATED_RANGES[number]['value']
export type LeadPoolPageSize = typeof LEAD_POOL_PAGE_SIZES[number]
export type LeadPoolType = typeof LEAD_POOL_TYPES[number]
export type LeadPoolCustomerStage = typeof LEAD_POOL_CUSTOMER_STAGES[number]
export type LeadPoolProfileStatus = typeof LEAD_POOL_PROFILE_STATUSES[number]
export type LeadPoolSort = typeof LEAD_POOL_SORTS[number]

function oneOf<T extends string>(value: string, values: readonly T[]): T | '' {
  return values.includes(value as T) ? value as T : ''
}

function strictDate(value: string | null): string {
  const normalized = value?.trim() ?? ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return ''
  const parsed = new Date(`${normalized}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized ? normalized : ''
}

function strictNonnegativeNumber(value: string | null): string {
  const normalized = value?.trim() ?? ''
  if (!normalized || !/^\d+(?:\.\d+)?$/.test(normalized)) return ''
  const parsed = Number(normalized)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? normalized : ''
}

function strictSource(value: string | null): string {
  const normalized = value?.trim() ?? ''
  if (!normalized || normalized.length > 1_000) return ''
  const tokens = normalized.split(',').map((token) => token.trim()).filter(Boolean)
  if (!tokens.length || tokens.length > 20 || tokens.some((token) => token.length > 100)) return ''
  return tokens.join(',')
}

function strictBoundedText(value: string | null, maxLength: number): string {
  const normalized = value?.trim() ?? ''
  return normalized && normalized.length <= maxLength ? normalized : ''
}

export function leadPoolPage(value: string | null): number {
  const normalized = (value ?? '1').trim()
  if (!/^\d+$/.test(normalized)) return 1
  const page = Number(normalized)
  return Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1
}

export function leadPoolPageSize(value: string | null): LeadPoolPageSize {
  const normalized = (value ?? '20').trim()
  if (!/^\d+$/.test(normalized)) return 20
  const pageSize = Number(normalized)
  return LEAD_POOL_PAGE_SIZES.includes(pageSize as LeadPoolPageSize)
    ? pageSize as LeadPoolPageSize
    : 20
}

export type LeadPoolUrlQuery = {
  page: number
  pageSize: LeadPoolPageSize
  keyword: string
  source: string
  leadType: LeadPoolType | ''
  industry: LeadPoolIndustry | ''
  industryLevel1: string
  industryLevel2: string
  industrySegment: string
  stage: LeadPoolStage | ''
  region: LeadPoolRegion | ''
  channel: LeadPoolChannel | ''
  updatedRange: LeadPoolUpdatedRange | ''
  productRoute: string
  institution: string
  institutionType: string
  academicInstitution: string
  latestRound: LeadPoolStage | ''
  customerStageMin: LeadPoolCustomerStage | ''
  profileStatus: LeadPoolProfileStatus | ''
  hasConflict: 'true' | 'false' | ''
  sort: LeadPoolSort | ''
  productionStage: string
  hasMajorInstitution: 'true' | 'false' | ''
  academicRelation: string
  hasCommercializationLink: 'true' | 'false' | ''
  fundingDateFrom: string
  fundingDateTo: string
  valuationMin: string
  valuationMax: string
  valuationCurrency: typeof LEAD_POOL_VALUATION_CURRENCIES[number] | ''
  valuationType: typeof LEAD_POOL_VALUATION_TYPES[number] | ''
  customerTier: typeof LEAD_POOL_CUSTOMER_TIERS[number] | ''
  hasVerifiedCustomer: 'true' | 'false' | ''
}

export function readLeadPoolUrlQuery(params: Pick<URLSearchParams, 'get'>): LeadPoolUrlQuery {
  const keyword = (params.get('keyword') ?? '').trim()
  return {
    page: leadPoolPage(params.get('page')),
    pageSize: leadPoolPageSize(params.get('pageSize')),
    keyword: keyword.length <= 100 ? keyword : '',
    source: strictSource(params.get('source')),
    leadType: oneOf(params.get('leadType') ?? '', LEAD_POOL_TYPES),
    industry: oneOf(params.get('industry') ?? '', LEAD_POOL_INDUSTRIES),
    industryLevel1: (params.get('industryLevel1') ?? '').trim().slice(0, 128),
    industryLevel2: (params.get('industryLevel2') ?? '').trim().slice(0, 128),
    industrySegment: (params.get('industrySegment') ?? '').trim().slice(0, 255),
    stage: oneOf(params.get('stage') ?? '', LEAD_POOL_STAGES),
    region: oneOf(params.get('region') ?? '', LEAD_POOL_REGIONS),
    channel: oneOf(params.get('channel') ?? '', LEAD_POOL_CHANNELS),
    updatedRange: oneOf(
      params.get('updatedRange') ?? '',
      LEAD_POOL_UPDATED_RANGES.map((option) => option.value),
    ),
    productRoute: (params.get('productRoute') ?? '').trim().slice(0, 100),
    institution: (params.get('institution') ?? '').trim().slice(0, 100),
    institutionType: strictBoundedText(params.get('institutionType'), 64),
    academicInstitution: (params.get('academicInstitution') ?? '').trim().slice(0, 100),
    latestRound: oneOf(params.get('latestRound') ?? '', LEAD_POOL_STAGES.filter((stage) => stage !== '科研成果')),
    customerStageMin: oneOf(params.get('customerStageMin') ?? '', LEAD_POOL_CUSTOMER_STAGES),
    profileStatus: oneOf(params.get('profileStatus') ?? '', LEAD_POOL_PROFILE_STATUSES),
    hasConflict: oneOf(params.get('hasConflict') ?? '', LEAD_POOL_BOOLEAN_FILTERS),
    sort: oneOf(params.get('sort') ?? '', LEAD_POOL_SORTS),
    productionStage: (params.get('productionStage') ?? '').trim().slice(0, 100),
    hasMajorInstitution: oneOf(params.get('hasMajorInstitution') ?? '', LEAD_POOL_BOOLEAN_FILTERS),
    academicRelation: (params.get('academicRelation') ?? '').trim().slice(0, 100),
    hasCommercializationLink: oneOf(params.get('hasCommercializationLink') ?? '', LEAD_POOL_BOOLEAN_FILTERS),
    fundingDateFrom: strictDate(params.get('fundingDateFrom')),
    fundingDateTo: strictDate(params.get('fundingDateTo')),
    valuationMin: strictNonnegativeNumber(params.get('valuationMin')),
    valuationMax: strictNonnegativeNumber(params.get('valuationMax')),
    valuationCurrency: oneOf(params.get('valuationCurrency') ?? '', LEAD_POOL_VALUATION_CURRENCIES),
    valuationType: oneOf(params.get('valuationType') ?? '', LEAD_POOL_VALUATION_TYPES),
    customerTier: oneOf(params.get('customerTier') ?? '', LEAD_POOL_CUSTOMER_TIERS),
    hasVerifiedCustomer: oneOf(params.get('hasVerifiedCustomer') ?? '', LEAD_POOL_BOOLEAN_FILTERS),
  }
}

export function normalizedLeadPoolSearchParams(params: URLSearchParams): URLSearchParams {
  const query = readLeadPoolUrlQuery(params)
  const next = new URLSearchParams(params)
  const invalidFundingRange = Boolean(query.fundingDateFrom && query.fundingDateTo && query.fundingDateFrom > query.fundingDateTo)
  const invalidValuationRange = Boolean(query.valuationMin && query.valuationMax && Number(query.valuationMin) > Number(query.valuationMax))
  const invalidFilter = [
    ['keyword', query.keyword],
    ['source', query.source],
    ['leadType', query.leadType],
    ['industry', query.industry],
    ['industryLevel1', query.industryLevel1],
    ['industryLevel2', query.industryLevel2],
    ['industrySegment', query.industrySegment],
    ['stage', query.stage],
    ['region', query.region],
    ['channel', query.channel],
    ['updatedRange', query.updatedRange],
    ['productRoute', query.productRoute],
    ['institution', query.institution],
    ['institutionType', query.institutionType],
    ['academicInstitution', query.academicInstitution],
    ['latestRound', query.latestRound],
    ['customerStageMin', query.customerStageMin],
    ['profileStatus', query.profileStatus],
    ['hasConflict', query.hasConflict],
    ['sort', query.sort],
    ['productionStage', query.productionStage],
    ['hasMajorInstitution', query.hasMajorInstitution],
    ['academicRelation', query.academicRelation],
    ['hasCommercializationLink', query.hasCommercializationLink],
    ['fundingDateFrom', query.fundingDateFrom],
    ['fundingDateTo', query.fundingDateTo],
    ['valuationMin', query.valuationMin],
    ['valuationMax', query.valuationMax],
    ['valuationCurrency', query.valuationCurrency],
    ['valuationType', query.valuationType],
    ['customerTier', query.customerTier],
    ['hasVerifiedCustomer', query.hasVerifiedCustomer],
  ].some(([key, value]) => Boolean((params.get(key) ?? '').trim()) && !value)
    || invalidFundingRange || invalidValuationRange
  next.set('page', String(invalidFilter ? 1 : query.page))
  next.set('pageSize', String(query.pageSize))
  for (const [key, value] of [
    ['keyword', query.keyword],
    ['source', query.source],
    ['leadType', query.leadType],
    ['industry', query.industry],
    ['industryLevel1', query.industryLevel1],
    ['industryLevel2', query.industryLevel2],
    ['industrySegment', query.industrySegment],
    ['stage', query.stage],
    ['region', query.region],
    ['channel', query.channel],
    ['updatedRange', query.updatedRange],
    ['productRoute', query.productRoute],
    ['institution', query.institution],
    ['institutionType', query.institutionType],
    ['academicInstitution', query.academicInstitution],
    ['latestRound', query.latestRound],
    ['customerStageMin', query.customerStageMin],
    ['profileStatus', query.profileStatus],
    ['hasConflict', query.hasConflict],
    ['sort', query.sort],
    ['productionStage', query.productionStage],
    ['hasMajorInstitution', query.hasMajorInstitution],
    ['academicRelation', query.academicRelation],
    ['hasCommercializationLink', query.hasCommercializationLink],
    ['fundingDateFrom', query.fundingDateFrom],
    ['fundingDateTo', query.fundingDateTo],
    ['valuationMin', query.valuationMin],
    ['valuationMax', query.valuationMax],
    ['valuationCurrency', query.valuationCurrency],
    ['valuationType', query.valuationType],
    ['customerTier', query.customerTier],
    ['hasVerifiedCustomer', query.hasVerifiedCustomer],
  ] as const) {
    if (value) next.set(key, value)
    else next.delete(key)
  }
  // 保留合法的下界，移除与之矛盾的上界；API 对未经过浏览器规范化的同类请求仍返回 400。
  if (invalidFundingRange) next.delete('fundingDateTo')
  if (invalidValuationRange) next.delete('valuationMax')
  if ((query.valuationMin || query.valuationMax || query.sort === 'valuation') && !query.valuationCurrency) {
    next.set('valuationCurrency', 'CNY')
  }
  return next
}

export function syncLeadPoolKeywordInput(current: string, urlKeyword: string): string {
  return current === urlKeyword ? current : urlKeyword
}

export function leadPoolKeywordSearchParams(params: URLSearchParams, input: string): URLSearchParams | null {
  const currentKeyword = readLeadPoolUrlQuery(params).keyword
  const nextKeyword = input.trim().slice(0, 100)
  if (nextKeyword === currentKeyword) return null
  const next = new URLSearchParams(params)
  if (nextKeyword) next.set('keyword', nextKeyword)
  else next.delete('keyword')
  next.set('page', '1')
  return next
}
