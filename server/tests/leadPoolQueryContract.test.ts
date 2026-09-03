import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  LEAD_POOL_CHANNELS,
  LEAD_POOL_CUSTOMER_STAGES,
  LEAD_POOL_CUSTOMER_TIERS,
  LEAD_POOL_INDUSTRIES,
  LEAD_POOL_REGIONS,
  LEAD_POOL_SORTS,
  LEAD_POOL_STAGES,
  LEAD_POOL_PROFILE_STATUSES,
  LEAD_POOL_VALUATION_CURRENCIES,
  LEAD_POOL_VALUATION_TYPES,
  leadPoolFilterSearchParams,
  leadPoolKeywordSearchParams,
  legacySourcingRedirectTarget,
  normalizedLeadPoolSearchParams,
  readLeadPoolUrlQuery,
  syncLeadPoolKeywordInput,
} from '../../src/lib/leadPoolFilters.js'
import { executeLeadPoolRequest } from '../../src/lib/leadPoolRequest.js'
import {
  SERVER_LEAD_POOL_CHANNELS,
  SERVER_LEAD_CUSTOMER_STAGES,
  SERVER_LEAD_CUSTOMER_TIERS,
  SERVER_LEAD_POOL_INDUSTRIES,
  SERVER_LEAD_POOL_SORTS,
  SERVER_LEAD_POOL_STAGES,
  SERVER_LEAD_PROFILE_STATUSES,
  SERVER_LEAD_VALUATION_CURRENCIES,
  SERVER_LEAD_VALUATION_TYPES,
  listLeadsQuery,
  normalizeLeadListPage,
} from '../src/contracts/leadPoolQueryContract.js'
import {
  BUSINESS_REGIONS,
  businessRegionStorageAliases,
  normalizeBusinessRegion,
} from '../src/services/leadRegion.js'

test('front end and API expose the same lead-pool filter values', () => {
  assert.deepEqual(LEAD_POOL_CHANNELS, SERVER_LEAD_POOL_CHANNELS)
  assert.deepEqual(LEAD_POOL_INDUSTRIES, SERVER_LEAD_POOL_INDUSTRIES)
  assert.deepEqual(LEAD_POOL_REGIONS, BUSINESS_REGIONS)
  assert.deepEqual(LEAD_POOL_STAGES, SERVER_LEAD_POOL_STAGES)
  assert.deepEqual(LEAD_POOL_PROFILE_STATUSES, SERVER_LEAD_PROFILE_STATUSES)
  assert.deepEqual(LEAD_POOL_SORTS, SERVER_LEAD_POOL_SORTS)
  assert.deepEqual(LEAD_POOL_CUSTOMER_STAGES, SERVER_LEAD_CUSTOMER_STAGES)
  assert.deepEqual(LEAD_POOL_CUSTOMER_TIERS, SERVER_LEAD_CUSTOMER_TIERS)
  assert.deepEqual(LEAD_POOL_VALUATION_CURRENCIES, SERVER_LEAD_VALUATION_CURRENCIES)
  assert.deepEqual(LEAD_POOL_VALUATION_TYPES, SERVER_LEAD_VALUATION_TYPES)
})

test('API rejects invalid and unbounded lead-pool query values', () => {
  assert.deepEqual(listLeadsQuery.parse({}), { page: 1, pageSize: 20 })
  for (const input of [
    { page: 0 }, { page: 1.5 }, { page: 10_001 },
    { pageSize: 0 }, { pageSize: 1.5 }, { pageSize: 101 },
    { channel: '未知渠道' }, { channel: '新闻' }, { channel: '微信群聊' },
    { industry: '%' }, { region: '火星' }, { stage: '未知阶段' },
    { keyword: 'x'.repeat(101) }, { source: 'x'.repeat(1_001) },
    { institutionType: 'x'.repeat(65) },
    { hasConflict: '1' }, { customerStageMin: 'L6' }, { profileStatus: 'ready' },
    { fundingDateFrom: '2026/01/01' }, { valuationMin: -1 },
    { page: '1e2' }, { pageSize: '0x10' },
    { keyword: '   ' }, { source: ',,,' },
    { source: Array.from({ length: 21 }, (_, index) => `来源${index}`).join(',') },
    { valuationMin: '' }, { valuationMin: '   ' }, { valuationMin: '0x10' },
    { valuationMin: '1e3' }, { valuationMin: '+10' }, { valuationMin: '.5' },
    { fundingDateFrom: '2026-02-30' }, { unexpected: 'value' },
    { fundingDateFrom: '2026-09-02', fundingDateTo: '2026-01-01' },
    { valuationMin: 100, valuationMax: 99 },
    { valuationMin: 100 },
    { sort: 'valuation' },
  ]) assert.equal(listLeadsQuery.safeParse(input).success, false, JSON.stringify(input))
  assert.equal(listLeadsQuery.safeParse({ pageSize: 1 }).success, true)
  assert.equal(listLeadsQuery.safeParse({ pageSize: 100 }).success, true)
  assert.equal(listLeadsQuery.safeParse({ profileStatus: 'never' }).success, true)
  assert.deepEqual(listLeadsQuery.parse({ page: '2', pageSize: '50' }), { page: 2, pageSize: 50 })
  assert.deepEqual(listLeadsQuery.parse({
    hasMajorInstitution: 'true', hasConflict: 'false', valuationMin: '100', valuationMax: '200', valuationCurrency: 'CNY',
    fundingDateFrom: '2026-01-01', fundingDateTo: '2026-12-31', customerStageMin: 'L3',
  }), {
    page: 1, pageSize: 20, hasMajorInstitution: true, hasConflict: false,
    valuationMin: 100, valuationMax: 200, valuationCurrency: 'CNY', fundingDateFrom: '2026-01-01', fundingDateTo: '2026-12-31',
    customerStageMin: 'L3',
  })
})

test('pagination returns the actual final page and normalizes empty results', () => {
  assert.deepEqual(normalizeLeadListPage(10_000, 20, 2_235), {
    page: 112, pageSize: 20, total: 2_235, totalPages: 112,
  })
  assert.deepEqual(normalizeLeadListPage(8, 20, 0), {
    page: 1, pageSize: 20, total: 0, totalPages: 1,
  })
  assert.deepEqual(normalizeLeadListPage(2, 20, 21), {
    page: 2, pageSize: 20, total: 21, totalPages: 2,
  })
})

test('URL parser removes invalid filters and malformed pagination', () => {
  assert.equal(readLeadPoolUrlQuery(new URLSearchParams({ page: 'abc' })).page, 1)
  assert.equal(readLeadPoolUrlQuery(new URLSearchParams({ page: '1.5' })).page, 1)
  assert.equal(readLeadPoolUrlQuery(new URLSearchParams({ page: '1e2' })).page, 1)
  assert.equal(readLeadPoolUrlQuery(new URLSearchParams({ page: '0x10' })).page, 1)
  assert.equal(readLeadPoolUrlQuery(new URLSearchParams({ pageSize: '0x14' })).pageSize, 20)
  const input = new URLSearchParams({
    page: '3', pageSize: '999', keyword: '  团队  ', industry: '%', region: '火星',
    stage: '未知阶段', channel: '未知渠道', leadType: 'research', updatedRange: '7d',
  })
  assert.deepEqual(readLeadPoolUrlQuery(input), {
    page: 3,
    pageSize: 20,
    keyword: '团队',
    source: '',
    leadType: 'research',
    industry: '',
    industryLevel1: '',
    industryLevel2: '',
    industrySegment: '',
    stage: '',
    region: '',
    channel: '',
    updatedRange: '7d',
    productRoute: '',
    institution: '',
    institutionType: '',
    academicInstitution: '',
    latestRound: '',
    customerStageMin: '',
    profileStatus: '',
    hasConflict: '',
    sort: '',
    productionStage: '',
    hasMajorInstitution: '',
    academicRelation: '',
    hasCommercializationLink: '',
    fundingDateFrom: '',
    fundingDateTo: '',
    valuationMin: '',
    valuationMax: '',
    valuationCurrency: '',
    valuationType: '',
    customerTier: '',
    hasVerifiedCustomer: '',
  })
  const normalized = normalizedLeadPoolSearchParams(input)
  assert.equal(normalized.get('page'), '1')
  assert.equal(normalized.get('pageSize'), '20')
  assert.equal(normalized.get('keyword'), '团队')
  for (const key of ['industry', 'region', 'stage', 'channel']) assert.equal(normalized.has(key), false)

  const valuationRange = normalizedLeadPoolSearchParams(new URLSearchParams({ valuationMin: '100000000' }))
  assert.equal(valuationRange.get('valuationCurrency'), 'CNY')

  const valuationSort = normalizedLeadPoolSearchParams(new URLSearchParams({ page: '4', sort: 'valuation' }))
  assert.equal(valuationSort.get('valuationCurrency'), 'CNY')
  assert.equal(valuationSort.get('page'), '4')

  const institutionType = normalizedLeadPoolSearchParams(new URLSearchParams({ page: '2', institutionType: '  产业资本  ' }))
  assert.equal(institutionType.get('institutionType'), '产业资本')
  assert.equal(institutionType.get('page'), '2')
  const invalidInstitutionType = normalizedLeadPoolSearchParams(new URLSearchParams({ page: '2', institutionType: 'x'.repeat(65) }))
  assert.equal(invalidInstitutionType.has('institutionType'), false)
  assert.equal(invalidInstitutionType.get('page'), '1')

  const reversedFunding = normalizedLeadPoolSearchParams(new URLSearchParams({
    page: '3', fundingDateFrom: '2026-09-02', fundingDateTo: '2026-01-01',
  }))
  assert.equal(reversedFunding.get('page'), '1')
  assert.equal(reversedFunding.get('fundingDateFrom'), '2026-09-02')
  assert.equal(reversedFunding.has('fundingDateTo'), false)

  const reversedValuation = normalizedLeadPoolSearchParams(new URLSearchParams({
    page: '3', valuationMin: '200', valuationMax: '100', valuationCurrency: 'CNY',
  }))
  assert.equal(reversedValuation.get('page'), '1')
  assert.equal(reversedValuation.get('valuationMin'), '200')
  assert.equal(reversedValuation.has('valuationMax'), false)
})

test('research-only filters cannot remain combined with company lead type', () => {
  const channelConflict = normalizedLeadPoolSearchParams(new URLSearchParams({
    view: 'leads', page: '3', leadType: 'company', channel: '论文',
  }))
  assert.equal(channelConflict.get('leadType'), 'research')
  assert.equal(channelConflict.get('channel'), '论文')

  const stageConflict = normalizedLeadPoolSearchParams(new URLSearchParams({
    view: 'leads', page: '2', leadType: 'company', stage: '科研成果',
  }))
  assert.equal(stageConflict.get('leadType'), 'research')
  assert.equal(stageConflict.get('stage'), '科研成果')

  const researchWithCompanyFilters = normalizedLeadPoolSearchParams(new URLSearchParams({
    leadType: 'research', channel: '36氪', stage: 'A轮',
  }))
  assert.equal(researchWithCompanyFilters.get('leadType'), 'research')
  assert.equal(researchWithCompanyFilters.has('channel'), false)
  assert.equal(researchWithCompanyFilters.has('stage'), false)
})

test('changing type, channel, or stage keeps research mode filters consistent', () => {
  const paperChannel = leadPoolFilterSearchParams(new URLSearchParams({
    view: 'leads', page: '6', leadType: 'company', stage: 'A轮',
  }), 'channel', '论文')
  assert.equal(paperChannel.get('leadType'), 'research')
  assert.equal(paperChannel.get('channel'), '论文')
  assert.equal(paperChannel.has('stage'), false)
  assert.equal(paperChannel.get('page'), '1')

  const researchStage = leadPoolFilterSearchParams(new URLSearchParams({
    leadType: 'company', channel: '36氪',
  }), 'stage', '科研成果')
  assert.equal(researchStage.get('leadType'), 'research')
  assert.equal(researchStage.get('stage'), '科研成果')
  assert.equal(researchStage.has('channel'), false)

  const backToCompany = leadPoolFilterSearchParams(new URLSearchParams({
    leadType: 'research', channel: '论文', stage: '科研成果',
  }), 'leadType', 'company')
  assert.equal(backToCompany.get('leadType'), 'company')
  assert.equal(backToCompany.has('channel'), false)
  assert.equal(backToCompany.has('stage'), false)
})

test('legacy sourcing route preserves lead-pool filters while redirecting into project center', () => {
  const target = legacySourcingRedirectTarget('?leadType=research&page=4&pageSize=50&keyword=world-model')
  const [pathname, search = ''] = target.split('?')
  const params = new URLSearchParams(search)
  assert.equal(pathname, '/projects')
  assert.equal(params.get('view'), 'leads')
  assert.equal(params.get('leadType'), 'research')
  assert.equal(params.get('page'), '4')
  assert.equal(params.get('pageSize'), '50')
  assert.equal(params.get('keyword'), 'world-model')
})

test('keyword filtering avoids unbounded full-JSON text scans', async () => {
  const source = await readFile(new URL('../src/services/aiSummaryService.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /CAST\(\$\{leads\.(?:radarProfile|scoring)\} AS CHAR\) LIKE/)
  for (const path of [
    '$.sourceName', '$.sourceTitle', '$.profile.projectName', '$.profile.companyName',
    '$.profile.lab', '$.profile.teamComposition', '$.registry.companyName',
  ]) assert.match(source, new RegExp(path.replaceAll('.', '\\.').replaceAll('$', '\\$')))
})

test('institution type filtering uses an exact bounded projection-array predicate', async () => {
  const source = await readFile(new URL('../src/services/aiSummaryService.ts', import.meta.url), 'utf8')
  assert.match(source, /institutionType\?\.trim\(\)/)
  assert.match(source, /JSON_TABLE\([\s\S]*leadInvestmentProfileProjections\.institutions[\s\S]*institution_type VARCHAR\(64\) PATH '\$\.type'/)
  assert.match(source, /institution_item\.institution_type = \$\{institutionType\}/)
})

test('list DTO omits V3 scoring and exposes only the six-column enterprise identity fields', async () => {
  const source = await readFile(new URL('../src/services/aiSummaryService.ts', import.meta.url), 'utf8')
  const listProjection = source.slice(
    source.indexOf('function leadPoolListItem'),
    source.indexOf('// 公共池分页'),
  )
  assert.doesNotMatch(listProjection, /\brating:|\bscoring:/)
  assert.match(listProjection, /radarProfileCore\.lab/)
  for (const forbidden of [
    'dimensions', 'structuredTeam', 'registry', 'dataQualityV1', 'ratingV3',
    'competitors', 'fundingRoundsResearched', 'researchSources', 'structuredNews',
  ]) {
    assert.doesNotMatch(listProjection, new RegExp(`\\b${forbidden}\\b`))
  }
  assert.match(source, /profilePayload/)
})

test('canonical regions include accepted storage suffixes', () => {
  assert.deepEqual(businessRegionStorageAliases('北京'), ['北京', '北京市'])
  assert.deepEqual(businessRegionStorageAliases('江苏'), ['江苏', '江苏省'])
  assert.deepEqual(businessRegionStorageAliases('香港'), ['香港', '香港特别行政区'])
  assert.equal(normalizeBusinessRegion('吉林'), '吉林')
  assert.equal(normalizeBusinessRegion('吉林省'), '吉林')
})

test('external URL keywords synchronize without a write-back loop', () => {
  const external = new URLSearchParams({ view: 'leads', page: '3', pageSize: '20', keyword: '外部搜索词' })
  const input = syncLeadPoolKeywordInput('旧输入', readLeadPoolUrlQuery(external).keyword)
  assert.equal(input, '外部搜索词')
  assert.equal(leadPoolKeywordSearchParams(external, input), null)

  const changed = leadPoolKeywordSearchParams(external, ' 新搜索词 ')
  assert.ok(changed)
  assert.equal(changed.get('view'), 'leads')
  assert.equal(changed.get('page'), '1')
  assert.equal(changed.get('keyword'), '新搜索词')
  assert.equal(syncLeadPoolKeywordInput(input, readLeadPoolUrlQuery(changed).keyword), '新搜索词')
  assert.equal(leadPoolKeywordSearchParams(changed, '新搜索词'), null)
})

test('source filters survive direct URLs and fail closed on malformed values', () => {
  const direct = new URLSearchParams({ view: 'leads', page: '3', pageSize: '20', source: ' 36氪, 高校公众号 ' })
  assert.equal(readLeadPoolUrlQuery(direct).source, '36氪,高校公众号')
  const normalized = normalizedLeadPoolSearchParams(direct)
  assert.equal(normalized.get('source'), '36氪,高校公众号')
  assert.equal(normalized.get('page'), '3')

  const malformed = normalizedLeadPoolSearchParams(new URLSearchParams({
    view: 'leads', page: '4', source: Array.from({ length: 21 }, (_, index) => `来源${index}`).join(','),
  }))
  assert.equal(malformed.has('source'), false)
  assert.equal(malformed.get('page'), '1')
})

test('repeated request failures remain errors until a later retry succeeds', async () => {
  let attempts = 0
  const load = async () => {
    attempts += 1
    if (attempts <= 2) throw new Error(`读取失败-${attempts}`)
    return { total: 0 }
  }
  assert.deepEqual(await executeLeadPoolRequest(load, () => true), { status: 'error', message: '读取失败-1' })
  assert.deepEqual(await executeLeadPoolRequest(load, () => true), { status: 'error', message: '读取失败-2' })
  assert.deepEqual(await executeLeadPoolRequest(load, () => true), { status: 'success', response: { total: 0 } })
})

test('stale request failures do not overwrite the active error state', async () => {
  assert.deepEqual(await executeLeadPoolRequest(
    async () => { throw new Error('旧请求失败') },
    () => false,
  ), { status: 'stale' })
})
