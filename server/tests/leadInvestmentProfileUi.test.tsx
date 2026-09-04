import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  canManageLeadPool,
  canReviewLeadInvestmentProfileConflicts,
  investmentProfileEvidenceSources,
  leadDetailSectionVisibility,
  shouldRetainLeadConflictReview,
} from '../../src/pages/LeadDetailPage.js'
import { LeadRow } from '../../src/pages/SourcingPage.js'
import type { Lead, LeadListItem } from '../../src/types/index.js'

function leadFixture(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-ui-1',
    name: '星河设备',
    companyName: '星河设备有限公司',
    region: '上海',
    summary: 'THIS_LEGACY_SUMMARY_MUST_NOT_RENDER',
    leadType: 'company',
    poolEnteredAt: '2026-08-31T08:00:00.000Z',
    dataUpdatedAt: '2026-09-01T08:00:00.000Z',
    latestUpdates: [{ occurredAt: '2026-08-30T08:00:00.000Z', title: '完成首批设备交付' }],
    investmentProfile: {
      schemaVersion: 'lead-investment-profile-v1',
      snapshotId: 'snapshot-ui-1',
      snapshotHash: 'hash-ui-1',
      industry: { level1: '先进制造', level2: '半导体设备', segment: '薄膜沉积设备', chainPosition: '上游设备' },
      products: [
        { name: 'PEALD 设备', productRoute: '原子层沉积', technologyRoute: '等离子增强', productionStage: '小批量', productionStageStatus: 'realized' },
        { name: 'PECVD 设备', productRoute: '化学气相沉积', productionStage: '中试', productionStageStatus: 'realized' },
        { name: '测试平台', productRoute: '薄膜测试', productionStage: '样机', productionStageStatus: 'realized' },
      ],
      institutions: [
        { name: '深创投', round: 'A轮', role: 'lead', type: '市场化VC/PE', tier: '一级', major: true },
        { name: '产业资本甲', round: 'A轮', role: 'strategic', major: false },
      ],
      academicLinks: [{ institution: '清华大学', relationType: '成果转化', commercialization: true }],
      financing: {
        status: '已完成融资', latestRound: 'A轮', latestRoundDate: '2026-01-02', latestAmount: '1亿元',
        latestAmountValue: 100_000_000, latestAmountCurrency: 'CNY', cumulativeAmount: '1.5亿元',
        cumulativeAmountValue: 150_000_000, completedRoundCount: 2,
      },
      valuation: { value: '8亿元', numericValue: 800_000_000, type: 'post_money', currency: 'CNY', date: '2026-01-02', round: 'A轮' },
      customers: {
        highestStage: 'L5', verifiedCount: 3, tierACount: 1, tierBCount: 1, tierCCount: 1,
        representatives: [
          { name: '宁德时代', tier: 'A', stage: 'L5', anonymized: false },
          { name: '某头部汽车客户', tier: 'B', stage: 'L4', anonymized: true },
        ],
      },
      dataStatus: { verifiedDimensions: 6, applicableDimensions: 6, conflictCount: 0, status: 'verified', updatedAt: '2026-09-02' },
    },
    ...overrides,
  } as Lead
}

test('enterprise lead row renders the approved six data columns without valuation or legacy summary', () => {
  const html = renderToStaticMarkup(React.createElement(LeadRow, { lead: leadFixture(), onOpen: () => {} }))
  for (const expected of [
    '星河设备', '薄膜沉积设备', 'PEALD 设备', '已实现：小批量', '深创投 · 重点机构', 'A轮', '1亿元',
    '清华大学', '完成首批设备交付', '2026.09.01', '入池', '+1 个产品', '+1 项背景',
  ]) assert.match(html, new RegExp(expected.replace(/[+]/g, '\\+')))
  assert.equal((html.match(/role="cell"/g) ?? []).length, 6)
  assert.doesNotMatch(html, /THIS_LEGACY_SUMMARY_MUST_NOT_RENDER/)
  assert.doesNotMatch(html, /一句话摘要|核心信息|推荐理由|宁德时代|某头部汽车客户|覆盖 6\/6|累计|1\.5亿元|8亿元/)
})

test('lead row no longer renders customer profile values after restoring latest updates', () => {
  const lead = leadFixture()
  const html = renderToStaticMarkup(React.createElement(LeadRow, {
    lead: {
      ...lead,
      investmentProfile: {
        ...lead.investmentProfile!,
        customers: {
          ...lead.investmentProfile!.customers,
          representatives: [{ name: '秘密客户真实名', tier: 'A', stage: 'L4', anonymized: true }],
        },
      },
    },
    onOpen: () => {},
  }))
  assert.doesNotMatch(html, /秘密客户真实名|某保密客户/)
  assert.match(html, /完成首批设备交付/)
})

test('enterprise capital background hides the generic source-confirmed relation label', () => {
  const lead = leadFixture()
  const html = renderToStaticMarkup(React.createElement(LeadRow, {
    lead: {
      ...lead,
      investmentProfile: {
        ...lead.investmentProfile!,
        academicLinks: [{ institution: '清华大学', person: '张三', relationType: '来源确认关系', commercialization: false }],
      },
    },
    onOpen: () => {},
  }))
  assert.match(html, /清华大学/)
  assert.match(html, /张三/)
  assert.doesNotMatch(html, /来源确认关系/)
})

test('research lead row does not present company financing, valuation or customer values', () => {
  const html = renderToStaticMarkup(React.createElement(LeadRow, {
    lead: {
      ...leadFixture({ leadType: 'research' }),
      radarProfile: {
        channel: '论文', link: 'https://example.com/paper',
        paperMeta: { projectName: '开源视觉模型', titleZh: '一种高效视觉基础模型', pdfUrl: 'https://example.com/paper.pdf', authors: ['张三', '李四'] },
      },
      researchProfile: {
        schemaVersion: 'lead-research-profile-v1', projectionVersion: 'lead-research-profile-projection-v1',
        subject: { leadId: 'lead-ui-1', type: 'research', name: '开源视觉模型', title: '一种高效视觉基础模型', providerIds: { arxivId: '2609.00001' } },
        direction: { categories: ['计算机视觉'], researchProblem: '降低视觉模型训练和推理成本', methods: [] },
        team: { authors: [{ name: '张三' }, { name: '李四' }], affiliations: ['示例大学'] },
        progress: { publishedAt: '2026-09-01', codeUrl: 'https://github.com/example/model' },
        valueAndTransfer: { applicationScenarios: [], partners: [] },
        rights: { articleLicense: 'CC BY 4.0', patents: [] },
        latestDevelopments: [{ occurredAt: '2026-09-01', title: '论文公开' }],
        dataStatus: { status: 'partial', verifiedDimensions: 5, applicableDimensions: 6, conflictCount: 0, source: 'paper_metadata', updatedAt: '2026-09-02' },
      },
    },
    onOpen: () => {},
    researchLayout: true,
  }))
  for (const expected of ['科研项目', '开源视觉模型', '一种高效视觉基础模型', '计算机视觉', '张三', '示例大学', '论文公开', '资料 5\/6']) {
    assert.match(html, new RegExp(expected))
  }
  for (const hidden of ['1亿元', '1.5亿元', '8亿元', '宁德时代', '某头部汽车客户', 'CC BY 4.0', '>原文<', '>PDF<', '>代码<']) {
    assert.doesNotMatch(html, new RegExp(hidden))
  }
})

test('detail sections hide paper commercialization and hide investment profile for every channel', () => {
  assert.deepEqual(
    leadDetailSectionVisibility(leadFixture({ radarProfile: { channel: '论文' } })),
    { productCommercialization: false, investmentProfile: false },
  )
  assert.deepEqual(
    leadDetailSectionVisibility(leadFixture({ radarProfile: { channel: '36氪' } })),
    { productCommercialization: true, investmentProfile: false },
  )
})

test('evidence-backed industry column does not display legacy industry fields', () => {
  const html = renderToStaticMarkup(React.createElement(LeadRow, {
    lead: leadFixture({
      industry: '旧行业标签',
      businessTags: { industry: ['旧归一化赛道'], region: [] },
    }),
    onOpen: () => {},
  }))
  assert.match(html, /先进制造/)
  assert.match(html, /半导体设备/)
  assert.doesNotMatch(html, /旧行业标签|旧归一化赛道/)
})

test('lead row falls back to existing list data when an investment profile dimension is missing', () => {
  const lead = {
    ...leadFixture({ investmentProfile: undefined }),
    availableData: {
      dataStatus: 'candidate',
      verificationStatus: 'unverified',
      displayLabel: '已有资料 · 待核验',
      sourceKinds: ['intake'],
      conflictFields: [],
      industryTags: ['人工智能', '企业服务'],
      products: [{ name: '智能审计平台', productRoute: 'SaaS' }],
      institutions: [{ name: '示例创投', round: 'A轮', role: 'undisclosed' as const, major: false }],
      academicLinks: [{ institution: '清华系', relationType: '联网候选', commercialization: false }],
      financing: { status: '已融资', latestRound: 'A轮', latestRoundDate: '2026-06-01', latestAmount: '5000万元' },
      valuation: { value: '5亿元', round: 'A轮', date: '2026-06-01' },
    },
  } as LeadListItem
  const html = renderToStaticMarkup(React.createElement(LeadRow, { lead, onOpen: () => {} }))
  for (const expected of ['人工智能', '企业服务', '智能审计平台', 'SaaS', '示例创投', '清华系', '已融资', '5000万元']) {
    assert.match(html, new RegExp(expected))
  }
  assert.doesNotMatch(html, /已有资料|已有\/联网资料|联网候选|待核验|累计|5亿元/)
})

test('enterprise list and detail source follow the approved display-only information architecture', async () => {
  const [listSource, detailSource] = await Promise.all([
    readFile(new URL('../../src/pages/SourcingPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/pages/LeadDetailPage.tsx', import.meta.url), 'utf8'),
  ])
  for (const heading of ['企业主体', '方向 / 产品', '团队 / 资本背景', '进展 / 阶段', '最新动态', '更新时间']) {
    assert.match(listSource, new RegExp(`columnheader">${heading.replace('/', '\\/')}`))
  }
  assert.doesNotMatch(listSource, /columnheader">价值 \/ 转化/)
  assert.match(listSource, /const effectiveLeadType = leadTypeValue \|\| 'company'/)
  assert.match(listSource, /leadType: effectiveLeadType as LeadListQuery/)

  const sectionTokens = [
    { title: '项目简介', token: ": '项目简介'" },
    { title: '关键概览', token: 'title="关键概览"' },
    { title: '主体基础信息', token: ": '主体基础信息'" },
    ...['产品与商业化', '融资历史', '核心团队', '最近动态', '相关来源']
      .map((title) => ({ title, token: `title="${title}"` })),
  ]
  for (const item of sectionTokens) assert.ok(detailSource.includes(item.token), item.title)
  for (let index = 1; index < sectionTokens.length; index += 1) {
    assert.ok(detailSource.indexOf(sectionTokens[index - 1].token) < detailSource.indexOf(sectionTokens[index].token), `${sectionTokens[index - 1].title} should precede ${sectionTokens[index].title}`)
  }
  assert.doesNotMatch(detailSource, /<ReviewSection title="投资证据画像"/)
  assert.doesNotMatch(detailSource, /投资初筛|title="数据质量"|加入关注|竞争格局|股权结构|核心团队与股权|sourceBoundShareholders|companyCompetitors/)
  assert.doesNotMatch(detailSource, /暂无经过来源验证的产品参数或性能数据|暂无经过来源验证的客户类型或用户问题/)
  assert.match(detailSource, /hasDescription && <p>\{displayedDescription\}<\/p>/)
  assert.match(detailSource, /'转为我的专属项目'/)
  assert.match(detailSource, /<Trash2 \/>删除线索/)
})

test('lead row renders pending and undisclosed placeholders as a dash', () => {
  const lead = {
    ...leadFixture({ investmentProfile: undefined, companyName: '待核验', region: '待确认' }),
    availableData: {
      dataStatus: 'candidate',
      verificationStatus: 'unverified',
      displayLabel: '已有资料 · 待核验',
      sourceKinds: ['intake'],
      conflictFields: [],
      industryTags: ['待核实'],
      products: [{ name: '待核验' }],
      institutions: [],
      academicLinks: [],
      financing: { status: '融资信息未披露', latestRound: '融资轮次待核实', latestAmount: '未披露' },
      valuation: { value: '待确认', round: '待核验', date: '待确认' },
    },
  } as LeadListItem
  const html = renderToStaticMarkup(React.createElement(LeadRow, { lead, onOpen: () => {} }))
  assert.match(html, />-</)
  assert.doesNotMatch(html, /<em>-<\/em>/)
  assert.doesNotMatch(html, /待核验|待核实|待确认|未披露/)
})

test('detail investment profile groups only verified public evidence into the matching card', () => {
  const evidence = (sourceUrl: string, title: string) => ({ sourceUrl, title })
  const facts = [
    { id: 'industry', subjectType: 'company', factKey: 'industry.segment', value: '半导体设备', verificationStatus: 'verified', investmentProfileSource: true, evidence: [evidence('https://example.com/industry', '行业来源')] },
    { id: 'product', subjectType: 'company', factKey: 'product.route', value: '原子层沉积', verificationStatus: 'verified', investmentProfileSource: true, evidence: [evidence('https://example.com/industry', '重复来源')] },
    { id: 'funding', subjectType: 'company', factKey: 'financing.round', value: 'A轮', verificationStatus: 'verified', investmentProfileSource: true, evidence: [evidence('https://example.com/funding', '融资来源')] },
    { id: 'newer-funding', subjectType: 'company', factKey: 'financing.round', value: 'B轮', verificationStatus: 'verified', investmentProfileSource: false, evidence: [evidence('https://example.com/newer-funding', '尚未进入当前画像的来源')] },
    { id: 'customer-unverified', subjectType: 'company', factKey: 'customer.formal', value: '客户甲', verificationStatus: 'unverified', investmentProfileSource: true, evidence: [evidence('https://example.com/customer', '未验证客户来源')] },
    { id: 'invalid', subjectType: 'company', factKey: 'industry.level1', value: '先进制造', verificationStatus: 'verified', investmentProfileSource: true, evidence: [evidence('file:///tmp/internal', '内部路径')] },
  ]
  const industrySources = investmentProfileEvidenceSources(facts, 'industryProduct')
  assert.deepEqual(industrySources.map((source) => source.sourceUrl), ['https://example.com/industry'])
  assert.deepEqual(investmentProfileEvidenceSources(facts, 'financing').map((source) => source.sourceUrl), ['https://example.com/funding'])
  assert.deepEqual(investmentProfileEvidenceSources(facts, 'customers'), [])
})

test('lead management actions follow effective system.manage permission', () => {
  assert.equal(canManageLeadPool({ role: '投资经理', permissionCodes: ['system.manage'] }), true)
  assert.equal(canManageLeadPool({ role: '系统管理员', permissionCodes: [] }), true)
  assert.equal(canManageLeadPool({ role: '投资经理', permissionCodes: ['project.read'] }), false)
  assert.equal(canManageLeadPool(null), false)
})

test('conflict review requires both effective permission and an actual profile conflict', () => {
  assert.equal(canReviewLeadInvestmentProfileConflicts({ role: '投资经理', permissionCodes: ['system.manage'] }, 1), true)
  assert.equal(canReviewLeadInvestmentProfileConflicts({ role: '系统管理员', permissionCodes: [] }, 2), true)
  assert.equal(canReviewLeadInvestmentProfileConflicts({ role: '投资经理', permissionCodes: ['system.manage'] }, 0), false)
  assert.equal(canReviewLeadInvestmentProfileConflicts({ role: '投资经理', permissionCodes: [] }, 1), false)
})

test('conflict review state fails closed when permission, route identity or conflict eligibility changes', () => {
  const allowed = {
    user: { role: '投资经理', permissionCodes: ['system.manage'] },
    routeLeadId: 'lead-ui-1',
    loadedLeadId: 'lead-ui-1',
    conflictCount: 1,
  }
  assert.equal(shouldRetainLeadConflictReview(allowed), true)
  assert.equal(shouldRetainLeadConflictReview({ ...allowed, user: { role: '投资经理', permissionCodes: [] } }), false)
  assert.equal(shouldRetainLeadConflictReview({ ...allowed, routeLeadId: 'lead-ui-2' }), false)
  assert.equal(shouldRetainLeadConflictReview({ ...allowed, loadedLeadId: undefined }), false)
  assert.equal(shouldRetainLeadConflictReview({ ...allowed, conflictCount: 0 }), false)
})
