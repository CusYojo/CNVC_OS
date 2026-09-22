import assert from 'node:assert/strict'
import test from 'node:test'
import type { LeadListItem } from '../../src/types/index.js'
import {
  buildProjectDiscoveryKeywords,
  buildProjectDiscoveryBrief,
  filterProjectDiscoveryCandidates,
  loadProjectDiscoveryPage,
  projectDiscoveryDay,
  projectDiscoveryPrimaryDate,
  projectDiscoveryStatusLabel,
  shouldLoadNextProjectDiscoveryPage,
} from '../../src/lib/projectDiscovery.js'

const company = {
  id: 'company-1',
  name: '光河芯存',
  companyName: '光河芯存科技有限公司',
  region: '上海',
  leadType: 'company',
  poolEnteredAt: '2026-09-21T01:30:00.000Z',
  dataUpdatedAt: '2026-09-21T04:00:00.000Z',
  latestUpdates: [{ occurredAt: '2026-09-21', title: '完成 A 轮融资' }],
  investmentProfile: {
    schemaVersion: 'lead-investment-profile-v1',
    industry: { level1: '半导体/芯片', level2: '光存储', segment: '存算一体' },
    products: [{ name: '光电混合存储芯片', productRoute: '存算一体', productionStage: '中试', productionStageStatus: 'realized' }],
    institutions: [{ name: '星河创投', round: 'A轮', role: 'lead', major: true }],
    academicLinks: [],
    financing: { status: '已完成融资', latestRound: 'A轮', latestRoundDate: '2026-09-20', latestAmount: '1亿元', completedRoundCount: 1 },
    valuation: {},
    customers: { verifiedCount: 0, tierACount: 0, tierBCount: 0, tierCCount: 0, representatives: [] },
    dataStatus: { verifiedDimensions: 5, applicableDimensions: 6, conflictCount: 0, status: 'partial', updatedAt: '2026-09-21' },
  },
} as LeadListItem

const research = {
  id: 'research-1',
  name: '柔性触觉传感项目',
  companyName: '浦江实验室',
  region: '上海',
  leadType: 'research',
  poolEnteredAt: '2026-09-18T03:00:00.000Z',
  dataUpdatedAt: '2026-09-18T03:00:00.000Z',
  latestUpdates: [{ occurredAt: '2026-09-18', title: '论文公开' }],
  radarProfile: { channel: '论文', profile: { lab: '浦江实验室' } },
  researchProfile: {
    schemaVersion: 'lead-research-profile-v1',
    projectionVersion: 'lead-research-profile-projection-v1',
    subject: { leadId: 'research-1', type: 'research', name: '柔性触觉传感项目', providerIds: {} },
    researchDirection: '具身智能触觉感知',
  },
} as LeadListItem

const vcHunterCandidate = {
  id: 'vc-hunter-1',
  name: '弋途科技',
  companyName: '上海弋途科技有限公司',
  region: '上海',
  leadType: 'company',
  poolStatus: '公共池',
  poolEnteredAt: '2026-09-21T08:00:00.000Z',
  dataUpdatedAt: '2026-09-21T08:00:00.000Z',
  businessTags: { industry: ['其他'], region: ['上海'] },
  latestUpdates: [{ occurredAt: '2026-09-21', title: '完成近亿元 Pre-B 轮融资' }],
  radarProfile: {
    channel: 'VC_Hunter',
    publishedAt: '2026-09-21',
    profile: {
      teamComposition: 'CEO 吴小航、CTO 陈震、COO 夏永峰均毕业于上海交大。',
      sourceIndustries: ['人工智能', '智能座舱'],
    },
  },
  availableData: {
    dataStatus: 'candidate',
    verificationStatus: 'unverified',
    displayLabel: '已有资料 · 待核验',
    sourceKinds: ['intake'],
    conflictFields: [],
    industryTags: ['人工智能', '智能座舱'],
    products: [{ name: '心界 AIOS' }],
    institutions: [
      { name: '上海半导体装备材料产业投资基金', round: 'Pre-B轮', role: 'lead', major: false },
      { name: 'Sands Talk Capital', round: 'Pre-B轮', role: 'lead', major: false },
    ],
    academicLinks: [],
    financing: {
      status: '已融资',
      latestRound: 'Pre-B轮',
      latestRoundDate: '2026-09-21',
      latestAmount: '近亿元',
      completedRoundCount: 1,
    },
  },
} as unknown as LeadListItem

test('project discovery day uses Asia/Shanghai instead of UTC boundaries', () => {
  assert.equal(projectDiscoveryDay('2026-09-20T16:30:00.000Z'), '2026-09-21')
})

test('project discovery filters by local time window, type, and searchable investment facts', () => {
  const now = new Date('2026-09-21T08:00:00.000Z')
  const rescoredOldLead = {
    ...company,
    id: 'company-rescored',
    poolEnteredAt: '2026-09-10T01:30:00.000Z',
    dataUpdatedAt: '2026-09-21T06:00:00.000Z',
    radarProfile: { publishedAt: '2026-09-10T01:30:00.000Z' },
    latestUpdates: [{ occurredAt: '2026-09-10T01:30:00.000Z', title: '旧事件今日重新评分' }],
  }
  const lateIngestedOldLead = {
    ...company,
    id: 'company-late-ingest',
    poolEnteredAt: '2026-09-21T05:00:00.000Z',
    radarProfile: { publishedAt: '2026-09-10T01:30:00.000Z' },
    latestUpdates: [{ occurredAt: '2026-09-10T01:30:00.000Z', title: '旧事件今日才入池' }],
  }
  assert.deepEqual(
    filterProjectDiscoveryCandidates([research, company, rescoredOldLead, lateIngestedOldLead], { period: 'today', query: '', kind: 'all', now }).map((item) => item.id),
    ['company-1'],
  )
  assert.deepEqual(
    filterProjectDiscoveryCandidates([research, company], { period: 'week', query: '星河创投', kind: 'company', now }).map((item) => item.id),
    ['company-1'],
  )
  assert.deepEqual(
    filterProjectDiscoveryCandidates([research, company], { period: 'week', query: '触觉', kind: 'research', now }).map((item) => item.id),
    ['research-1'],
  )
  assert.deepEqual(
    filterProjectDiscoveryCandidates([research, company, rescoredOldLead], { period: 'all', query: '', kind: 'all', now }).map((item) => item.id),
    ['company-1', 'research-1', 'company-rescored'],
    '全部项目应解除近 7 天时间限制，并继续按资料时间倒序排列',
  )
})

test('project discovery loads every page because ingestion order can differ from publication order', () => {
  const now = new Date('2026-09-21T08:00:00.000Z')
  assert.equal(shouldLoadNextProjectDiscoveryPage([company], 1, 3, now), true)
  assert.equal(shouldLoadNextProjectDiscoveryPage([{ ...company, poolEnteredAt: '2026-09-10T01:30:00.000Z', latestUpdates: [{ occurredAt: '2026-09-10T01:30:00.000Z', title: '旧事件' }] }], 2, 3, now), true)
  assert.equal(shouldLoadNextProjectDiscoveryPage([company], 3, 3, now), false)
})

test('project discovery renders page one without preloading later pages', async () => {
  type Page = { list: LeadListItem[]; page: number; totalPages: number }
  const requestedPages: number[] = []
  const renderedBatches: string[][] = []

  const fetchPage = async (page: number): Promise<Page> => {
    requestedPages.push(page)
    if (page === 1) return { list: [company], page: 1, totalPages: 2 }
    return { list: [research], page: 2, totalPages: 2 }
  }
  const render = (items: LeadListItem[]) => {
    renderedBatches.push(items.map((item) => item.id))
  }

  const first = await loadProjectDiscoveryPage(fetchPage, 1, [], render)
  assert.deepEqual(requestedPages, [1], '首次打开只能读取第一页')
  assert.deepEqual(renderedBatches, [['company-1']], '首批数据库结果应立即呈现，不能等待全库分页完成')

  await loadProjectDiscoveryPage(fetchPage, 2, first?.items ?? [], render)
  assert.deepEqual(requestedPages, [1, 2], '只有打开全部项目后才读取下一页')
  assert.deepEqual(renderedBatches, [['company-1'], ['company-1', 'research-1']])
})

test('project discovery company cards expose the same six-field investment brief as VC Hunter', () => {
  assert.deepEqual(buildProjectDiscoveryBrief(company), {
    summary: '完成 A 轮融资',
    facts: [
      { label: '行业分类', value: '半导体/芯片 / 光存储' },
      { label: '最新融资日期', value: '2026-09-20' },
      { label: '融资金额', value: '1亿元' },
      { label: '融资轮次', value: 'A轮' },
      { label: '投资方', value: '星河创投', wide: true },
      { label: '核心团队背景', value: '待补充', wide: true },
    ],
  })
})

test('project discovery uses imported VC Hunter candidate facts when a verified projection is not available yet', () => {
  assert.deepEqual(buildProjectDiscoveryBrief(vcHunterCandidate), {
    summary: '完成近亿元 Pre-B 轮融资',
    facts: [
      { label: '行业分类', value: '人工智能 / 智能座舱' },
      { label: '最新融资日期', value: '2026-09-21' },
      { label: '融资金额', value: '近亿元' },
      { label: '融资轮次', value: 'Pre-B轮' },
      { label: '投资方', value: '上海半导体装备材料产业投资基金、Sands Talk Capital', wide: true },
      { label: '核心团队背景', value: 'CEO 吴小航、CTO 陈震、COO 夏永峰均毕业于上海交大。', wide: true },
    ],
  })
})

test('project discovery promotes the financing date and turns priority facts into labeled keyword bubbles', () => {
  assert.deepEqual(projectDiscoveryPrimaryDate(vcHunterCandidate), {
    label: '融资日期',
    value: '2026-09-21',
  })
  assert.deepEqual(buildProjectDiscoveryKeywords(vcHunterCandidate), [
    { kind: 'institution', label: '机构', value: '上海半导体装备材料产业投资基金' },
    { kind: 'institution', label: '机构', value: 'Sands Talk Capital' },
    { kind: 'academic', label: '院校', value: '上海交大' },
    { kind: 'industry', label: '产业', value: '智能座舱' },
    { kind: 'technology', label: '技术', value: '心界 AIOS' },
  ])
})

test('project discovery research cards keep the same compact two-column brief format', () => {
  assert.deepEqual(buildProjectDiscoveryBrief(research), {
    summary: '论文公开',
    facts: [
      { label: '研究方向', value: '具身智能触觉感知' },
      { label: '公开日期', value: '2026-09-18' },
      { label: '成果类型', value: '科研成果' },
      { label: '公开场合', value: '未披露' },
      { label: '所属机构', value: '浦江实验室', wide: true },
      { label: '核心团队背景', value: '待补充', wide: true },
    ],
  })
})

test('project discovery status badge follows the real lead-pool lifecycle', () => {
  assert.equal(projectDiscoveryStatusLabel('已转专属项目'), '已入库')
  assert.equal(projectDiscoveryStatusLabel('已合并'), '已合并')
  assert.equal(projectDiscoveryStatusLabel('公共池'), '待审核')
  assert.equal(projectDiscoveryStatusLabel(undefined), '待审核')
})
