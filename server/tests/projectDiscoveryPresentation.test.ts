import assert from 'node:assert/strict'
import test from 'node:test'
import type { LeadListItem } from '../../src/types/index.js'
import {
  buildProjectDiscoverySummary,
  filterProjectDiscoveryCandidates,
  projectDiscoveryDay,
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
  assert.deepEqual(
    filterProjectDiscoveryCandidates([research, company], { period: 'today', query: '', kind: 'all', now }).map((item) => item.id),
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

test('project discovery summary reports actionable counts from the visible result set', () => {
  assert.deepEqual(buildProjectDiscoverySummary([company, research]), {
    total: 2,
    companies: 1,
    research: 1,
    verified: 1,
  })
})
