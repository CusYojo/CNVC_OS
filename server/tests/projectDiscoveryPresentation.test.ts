import assert from 'node:assert/strict'
import test from 'node:test'
import type { LeadListItem } from '../../src/types/index.js'
import {
  buildProjectDiscoveryBrief,
  buildProjectDiscoverySummary,
  filterProjectDiscoveryCandidates,
  projectDiscoveryDay,
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
})

test('project discovery loads every page because ingestion order can differ from publication order', () => {
  const now = new Date('2026-09-21T08:00:00.000Z')
  assert.equal(shouldLoadNextProjectDiscoveryPage([company], 1, 3, now), true)
  assert.equal(shouldLoadNextProjectDiscoveryPage([{ ...company, poolEnteredAt: '2026-09-10T01:30:00.000Z', latestUpdates: [{ occurredAt: '2026-09-10T01:30:00.000Z', title: '旧事件' }] }], 2, 3, now), true)
  assert.equal(shouldLoadNextProjectDiscoveryPage([company], 3, 3, now), false)
})

test('project discovery summary reports actionable counts from the visible result set', () => {
  assert.deepEqual(buildProjectDiscoverySummary([company, research]), {
    total: 2,
    companies: 1,
    research: 1,
    verified: 1,
  })
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
