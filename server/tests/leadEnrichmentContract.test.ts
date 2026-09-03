import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS,
  LEAD_ENRICHMENT_TOPIC_KEYS,
  canonicalEnrichmentJson,
  classifyPaperContent,
  curateLeadResearchMetadata,
  enrichmentSnapshotHash,
  initialTopicStates,
  leadDeepEnrichmentFactKeyAllowed,
  leadEnrichmentRuntimePolicy,
  normalizePaperIdentity,
  normalizePaperPublicationDate,
  topicRequiresConfirmedEntity,
} from '../src/services/leadEnrichmentContract.js'
import {
  buildLeadEntityGraphPlan,
  buildLeadEnrichmentSnapshot,
  leadEvidenceLevelRank,
  leadEntityTypeForLead,
  leadFactEntityRelationType,
  leadFactSubjectEntityType,
  leadRatingSubjectProfile,
  validateLeadFactCandidate,
  verifiedSubjectIntroductions,
} from '../src/services/leadEnrichmentService.js'
import { leadTopicSearchCacheIdentity } from '../src/services/leadTopicSearchCacheService.js'
import {
  LEAD_TOPIC_UNTRUSTED_SOURCE_POLICY,
  LEAD_TOPIC_PRIMARY_SOURCE_POLICY,
  enforceLeadTopicFactSetContract,
  leadTopicResearchContract,
  validateLeadTopicResearchConflict,
  validateLeadTopicResearchFact,
  validateLeadTopicResearchBudget,
  validateLeadTopicResearchValueEvidence,
} from '../src/services/leadTopicWebResearchService.js'

test('normalizes OpenAlex independently from misleading display labels', () => {
  const identity = normalizePaperIdentity({
    sourceName: '项目发现雷达 · arXiv',
    sourceId: 'W1234567890',
    link: 'https://openalex.org/W1234567890',
    doi: 'https://doi.org/10.1000/example',
  })
  assert.equal(identity.provider, 'openalex')
  assert.equal(identity.canonicalId, 'W1234567890')
  assert.equal(identity.doi, '10.1000/example')
  assert.equal(identity.sourceStatus, 'review')
  assert.ok(identity.reviewReasons.some((reason) => reason.includes('错误标记为arXiv')))
})

test('keeps arXiv versions and rejects supplements as paper bodies', () => {
  const identity = normalizePaperIdentity({
    provider: 'arxiv',
    sourceId: '2608.20220v3',
    landingPageUrl: 'https://arxiv.org/abs/2608.20220v3',
    pdfUrl: 'https://arxiv.org/pdf/2608.20220v3',
  })
  assert.equal(identity.provider, 'arxiv')
  assert.equal(identity.version, 'v3')
  assert.equal(identity.sourceStatus, 'confirmed')
  assert.equal(classifyPaperContent({ url: 'https://example.org/supplement.xlsx' }), 'supplement')
  assert.equal(classifyPaperContent({ url: 'https://arxiv.org/pdf/2608.20220v3' }), 'paper_pdf')
})

test('future paper dates enter review and use record creation date', () => {
  const date = normalizePaperPublicationDate({
    declaredPublishedAt: '2035-09-05',
    recordCreatedAt: '2026-08-20T10:00:00Z',
    now: new Date('2026-08-25T00:00:00Z'),
  })
  assert.equal(date.publishedAt, '2026-08-20')
  assert.equal(date.status, 'review')
  assert.equal(date.basis, 'metadata_record_created_at')
})

test('research projects run only the retained core detail topics', () => {
  const states = initialTopicStates({ entityType: 'research', hasCommercialCompany: false })
  assert.equal(Object.keys(states).length, LEAD_ENRICHMENT_TOPIC_KEYS.length)
  assert.equal(states.basic_profile, 'queued')
  assert.equal(states.financing, 'not_applicable')
  assert.equal(states.ownership, 'not_applicable')
  assert.equal(states.financial_operations, 'not_applicable')
  assert.equal(states.transaction_exit, 'not_applicable')
  assert.equal(states.customers_contracts, 'not_applicable')
  assert.equal(states.technology_ip, 'not_applicable')
  assert.equal(states.industrialization, 'not_applicable')
  assert.equal(states.competition, 'not_applicable')
  assert.equal(states.team, 'queued')
  assert.equal(states.products, 'queued')
  assert.equal(states.latest_developments, 'queued')
})

test('V8 web-hit scope rejects removed topics and explicitly excluded fact keys', () => {
  for (const factKey of [
    'customer.formal', 'contract.value', 'order.status', 'delivery.capability', 'cash_collection.amount',
    'financial.revenue', 'market.size', 'policy.name', 'license.code', 'ip.owner',
    'technology.route', 'patent.owner', 'patent.applicant', 'production.capacity',
    'qualification.name', 'certification.status', 'supply_chain',
    'competition.direct', 'transaction.valuation',
    'ownership.snapshot_date', 'ownership.shareholder_type', 'ownership.beneficial_owner',
    'financing.investors', 'financing.lead_investor', 'financing.investor_role',
    'team.institution_period', 'team.full_time_status', 'team.institution_relation',
    'team.historical_employment', 'product.parameter', 'product.performance',
    'product.use_case', 'product.matrix',
  ]) assert.equal(leadDeepEnrichmentFactKeyAllowed(factKey), false, factKey)
  for (const factKey of [
    'profile.company_introduction', 'registry.founded_at', 'financing.amount',
    'ownership.shareholder', 'team.member', 'product.stage', 'news.event',
  ]) assert.equal(leadDeepEnrichmentFactKeyAllowed(factKey), true, factKey)
  const removedTopic = enforceLeadTopicFactSetContract('industrialization', [{
    factKey: 'research.prototype', instanceKey: 'prototype-a',
  }])
  assert.deepEqual(removedTopic.facts, [])
  assert.equal(removedTopic.rejectedFactCount, 1)
  assert.match(removedTopic.reasons[0] ?? '', /topic industrialization is excluded/)
  assert.deepEqual(curateLeadResearchMetadata({
    title: '论文', rights: { articleLicense: 'excluded' }, authors: ['甲'],
  }), { title: '论文', authors: ['甲'] })
})

test('material topics require a confirmed or at least claimed entity after basic profile resolution', () => {
  assert.equal(topicRequiresConfirmedEntity('financing'), true)
  assert.equal(topicRequiresConfirmedEntity('ownership'), true)
  assert.equal(topicRequiresConfirmedEntity('financial_operations'), true)
  assert.equal(topicRequiresConfirmedEntity('basic_profile'), false)
  assert.equal(topicRequiresConfirmedEntity('team'), false)
})

test('explicit project subjects remain projects when an operating company is also known', () => {
  assert.equal(leadEntityTypeForLead({
    company_name: '项目运营有限公司',
    radar_profile: { aiSubjectReview: { subjectType: 'project' } },
  }), 'project')
  const plan = buildLeadEntityGraphPlan({
    id: 'lead-project', name: '火种项目', company_name: '项目运营有限公司',
    radar_profile: {
      aiSubjectReview: { subjectType: 'project' }, projectName: '火种项目', teamName: '火种核心团队',
      shortName: '项目运营', brandName: '火种运营', formerNames: ['原火种运营中心'],
    },
    scoring: { registry: { companyName: '项目运营有限公司' } },
  }, 'project', 'inferred')
  assert.deepEqual(plan.entities.map((entity) => entity.entityType).sort(), ['company', 'project', 'team'])
  assert.equal(plan.entities.find((entity) => entity.key === 'company')?.aliases.includes('火种项目'), false)
  assert.deepEqual(plan.entities.find((entity) => entity.key === 'company')?.identifiers, {
    legalName: '项目运营有限公司', shortNames: ['项目运营'], brandNames: ['火种运营'],
    formerNames: ['原火种运营中心'],
  })
  assert(plan.relations.some((relation) => (
    relation.from === 'primary' && relation.to === 'company' && relation.relationType === 'operated_by'
  )))
  assert(plan.relations.some((relation) => (
    relation.from === 'team' && relation.to === 'primary' && relation.relationType === 'core_team_of'
  )))
})

test('fact subjects route to team, company, project and research entities without cross-binding', () => {
  const available = ['company', 'project', 'team'] as const
  assert.equal(leadFactSubjectEntityType({
    factKey: 'team.member', topicKey: 'team', primaryType: 'project', availableTypes: available,
  }), 'team')
  assert.equal(leadFactSubjectEntityType({
    factKey: 'financial.revenue', topicKey: 'financial_operations', primaryType: 'project', availableTypes: available,
  }), 'company')
  assert.equal(leadFactSubjectEntityType({
    factKey: 'product.performance', topicKey: 'products', primaryType: 'company', availableTypes: available,
  }), 'project')
  assert.equal(leadFactSubjectEntityType({
    factKey: 'patent.owner', topicKey: 'technology_ip', primaryType: 'research',
    availableTypes: ['research', 'company', 'team'],
  }), 'research')
  assert.equal(leadFactSubjectEntityType({
    factKey: 'research.grant', topicKey: 'financing', primaryType: 'research',
    availableTypes: ['research', 'company', 'team'],
  }), 'research')
})

test('only explicit relationship facts can bind evidence to directional entity relations', () => {
  assert.equal(leadFactEntityRelationType('profile.operating_company', 'project'), 'operated_by')
  assert.equal(leadFactEntityRelationType('profile.commercialization_subject', 'research'), 'commercialization_subject')
  assert.equal(leadFactEntityRelationType('profile.technology_source', 'project'), 'technology_source')
  assert.equal(leadFactEntityRelationType('financing.subject', 'project'), 'financing_subject')
  assert.equal(leadFactEntityRelationType('patent.owner', 'research'), 'ip_owner')
  assert.equal(leadFactEntityRelationType('profile.forming_company', 'team'), 'forming_company')
  assert.equal(leadFactEntityRelationType('profile.forming_company', 'project'), null)
  assert.equal(leadFactEntityRelationType('team.member', 'team'), null)
})

test('enrichment runtime has independent intake and worker switches', () => {
  assert.deepEqual(leadEnrichmentRuntimePolicy({}), {
    workerEnabled: true, acceptNewJobs: true,
  })
  assert.deepEqual(leadEnrichmentRuntimePolicy({
    LEAD_ENRICHMENT_ENABLED: 'false',
    LEAD_ENRICHMENT_ACCEPT_NEW_JOBS: 'false',
  }), {
    workerEnabled: false, acceptNewJobs: false,
  })
})

test('evidence priority is deterministic', () => {
  assert(leadEvidenceLevelRank('E1') > leadEvidenceLevelRank('E2'))
  assert(leadEvidenceLevelRank('E2') > leadEvidenceLevelRank('E3'))
  assert.equal(leadEvidenceLevelRank('unknown'), 0)
})

test('topic search cache identity normalizes the subject and binds prompt plus query plan', () => {
  const base = {
    entityType: 'company', topicKey: 'financing' as const, promptVersion: 'prompt-v1',
    queryPlan: ['融资 金额', '投资方'],
  }
  const first = leadTopicSearchCacheIdentity({ ...base, subjectName: '示例 科技有限公司' })
  const replay = leadTopicSearchCacheIdentity({ ...base, subjectName: '  示例   科技有限公司  ' })
  const changed = leadTopicSearchCacheIdentity({ ...base, subjectName: '示例 科技有限公司', promptVersion: 'prompt-v2' })
  assert.equal(first.cacheKey, replay.cacheKey)
  assert.notEqual(first.cacheKey, changed.cacheKey)
})

test('web research treats external prompt injection as untrusted data and keeps a fixed tool boundary', () => {
  assert.match(LEAD_TOPIC_UNTRUSTED_SOURCE_POLICY, /不可信数据/)
  assert.match(LEAD_TOPIC_UNTRUSTED_SOURCE_POLICY, /调用额外工具/)
  assert.match(LEAD_TOPIC_UNTRUSTED_SOURCE_POLICY, /字段白名单和本轮搜索URL放行/)
})

test('web conflict contract requires two independently sourced and context-complete candidates', () => {
  assert.equal(leadTopicResearchContract('financing').promptVersion, 'lead-topic-web-research-v13-web-hit')
  assert.match(LEAD_TOPIC_PRIMARY_SOURCE_POLICY, /一手来源/)
  assert.match(LEAD_TOPIC_PRIMARY_SOURCE_POLICY, /site:gov\.cn/)
  assert.match(LEAD_TOPIC_PRIMARY_SOURCE_POLICY, /低等级来源冒充/)
  const base = {
    topicKey: 'financing' as const,
    allowedFactKeys: ['financing.amount'],
    allowedSourceUrls: ['https://example.com/a', 'https://example.com/b'],
  }
  const accepted = validateLeadTopicResearchConflict({
    ...base,
    conflict: {
      factKey: 'financing.amount', instanceKey: '2026 A轮', reason: '两份披露金额不一致',
      candidates: [
        {
          value: '1亿元', quote: '公司完成A轮融资1亿元', sourceUrls: ['https://example.com/a'],
          period: '2026', unit: '亿元', currency: 'CNY', scope: 'A轮融资金额',
        },
        {
          value: '2亿元', quote: '本次A轮融资金额为2亿元', sourceUrls: ['https://example.com/b'],
          period: '2026', unit: '亿元', currency: 'CNY', scope: 'A轮融资金额',
        },
      ],
    },
  })
  assert.equal(accepted.conflict?.candidates.length, 2)
  assert.equal(accepted.rejectedCandidateCount, 0)

  const rejected = validateLeadTopicResearchConflict({
    ...base,
    conflict: {
      factKey: 'financing.amount', instanceKey: '2026 A轮', reason: '来源不可追溯',
      candidates: [
        {
          value: '1亿元', quote: '公司完成A轮融资1亿元', sourceUrls: ['https://example.com/a'],
          period: '2026', unit: '亿元', currency: 'CNY', scope: 'A轮融资金额',
        },
        {
          value: '2亿元', quote: '网页声称融资2亿元', sourceUrls: ['https://untrusted.example/b'],
          period: '2026', unit: '亿元', currency: 'CNY', scope: 'A轮融资金额',
        },
      ],
    },
  })
  assert.equal(rejected.conflict, null)
  assert.equal(rejected.rejectedCandidateCount, 2)
})

test('structured model values cannot hide string claims that are absent from the cited quote', () => {
  const unsupported = validateLeadTopicResearchValueEvidence({
    value: {
      name: '竞品A', sameTargetUser: true, sameUseCase: true, sameDeliverable: true,
      comparisonBasis: '均面向工业客户交付同类质量检测软件',
    },
    quote: '公司将竞品A列为同行。',
    sourceUrls: ['https://example.com/competition'],
  })
  assert.equal(unsupported.ok, false)
  assert.match(unsupported.errors.join(';'), /均面向工业客户/)
  assert.equal(validateLeadTopicResearchValueEvidence({
    value: {
      name: '竞品A', sameTargetUser: true, sameUseCase: true, sameDeliverable: true,
      comparisonBasis: '均面向工业客户交付同类质量检测软件',
    },
    quote: '竞品A与本项目均面向工业客户交付同类质量检测软件。',
    sourceUrls: ['https://example.com/competition'],
  }).ok, true)
})

test('web research rejects financing amounts without period and unit context', () => {
  const invalid = validateLeadTopicResearchFact({
    topicKey: 'financing', factKey: 'financing.amount', value: '2亿元',
  })
  assert.equal(invalid.ok, false)
  assert.match(invalid.errors.join(';'), /period or scope/)
  assert.match(invalid.errors.join(';'), /unit, currency or scope/)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'financing', factKey: 'financing.amount', value: '2亿元',
    instanceKey: '2026-08 A轮', period: '2026-08', unit: '亿元', currency: 'CNY', scope: '本轮融资金额',
  }).ok, true)
})

test('web research rejects product performance without version or test-condition scope', () => {
  const invalid = validateLeadTopicResearchFact({
    topicKey: 'products', factKey: 'product.performance', value: '准确率95%', period: '2026', unit: '%',
  })
  assert.equal(invalid.ok, false)
  assert.match(invalid.errors.join(';'), /version or test-condition scope/)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'products', factKey: 'product.performance', value: '准确率95%',
    instanceKey: '产品A v2.1 公开测试集A', period: '2026', unit: '%', scope: 'v2.1在公开测试集A上的测试结果',
  }).ok, true)
})

test('web research requires current or historical scope for team employment', () => {
  const invalid = validateLeadTopicResearchFact({
    topicKey: 'team', factKey: 'team.historical_employment', value: '曾任示例大学研究员',
  })
  assert.equal(invalid.ok, false)
  assert.match(invalid.errors.join(';'), /current\/historical scope/)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'team', factKey: 'team.historical_employment', value: '曾任示例大学研究员',
    instanceKey: '张三 示例大学 2019-2023', period: '2019-2023', scope: '历史任职',
  }).ok, true)
})

test('web research keeps customer relationship types explicit', () => {
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'customers_contracts', factKey: 'customer.intent', value: '接洽中',
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'customers_contracts', factKey: 'customer.intent', value: '接洽中',
    instanceKey: '客户A 2026-07 意向', period: '2026-07', scope: '意向洽谈，未签合同',
  }).ok, true)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'customers_contracts', factKey: 'customer.pilot', value: '已启动试点',
    instanceKey: '客户A 2026-07 试点', period: '2026-07', scope: '试点合作，非正式采购客户',
  }).ok, true)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'customers_contracts', factKey: 'customer.formal', value: '客户A',
    instanceKey: '客户A 2026', period: '2026', scope: '官网展示案例',
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'customers_contracts', factKey: 'customer.formal', value: '客户A',
    instanceKey: '客户A 2026 采购', period: '2026', scope: '已签采购合同',
  }).ok, true)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'customers_contracts', factKey: 'customer.formal', value: '客户A',
    instanceKey: '客户A 2026 采购', period: '2026', scope: '已签采购合同',
    quote: '客户A出现在公司官网案例列表中。', sourceUrls: ['https://example.com/cases'],
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'customers_contracts', factKey: 'customer.formal', value: '客户A',
    instanceKey: '客户A 2026 采购', period: '2026', scope: '已签采购合同',
    quote: '客户A已与公司签署采购合同。', sourceUrls: ['https://example.com/contract'],
  }).ok, true)
})

test('investment profile metadata facts remain evidence-bound and reject invalid lifecycle semantics', () => {
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'customers_contracts', factKey: 'customer.name', value: '客户A',
    instanceKey: '客户A 2026', quote: '客户A已开展试点。', sourceUrls: ['https://example.com/customer'],
  }).ok, true)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'customers_contracts', factKey: 'customer.confidentiality', value: '顶级客户',
    instanceKey: '客户A 2026', quote: '该客户为顶级客户。', sourceUrls: ['https://example.com/customer'],
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'financing', factKey: 'financing.investor_role', value: '跟投',
    instanceKey: '2026 A轮', quote: '甲基金跟投本轮融资。', sourceUrls: ['https://example.com/funding'],
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'financing', factKey: 'financing.investor_role', value: '跟投', scope: '甲基金',
    instanceKey: '2026 A轮', quote: '甲基金跟投本轮融资。', sourceUrls: ['https://example.com/funding'],
  }).ok, true)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'products', factKey: 'product.stage', value: '行业领先',
    instanceKey: '产品A', quote: '产品A行业领先。', sourceUrls: ['https://example.com/product'],
  }).ok, false)
})

test('detail-visible topic dictionaries expose only the fields consumed by the detail page', () => {
  const required: Record<string, string[]> = {
    basic_profile: [
      'profile.company_introduction', 'profile.team_introduction', 'profile.project_introduction',
      'profile.website', 'profile.industry', 'industry.level1', 'industry.segment',
      'registry.company_name', 'registry.registration_status',
    ],
    financing: ['financing.status', 'financing.round', 'financing.date', 'financing.amount'],
    ownership: ['ownership.shareholder', 'ownership.percentage'],
    team: ['team.member', 'team.role', 'team.education', 'team.current_employment', 'team.institution'],
    products: ['product.name', 'product.route', 'product.form', 'product.stage'],
    latest_developments: ['news.event', 'news.event_date'],
  }
  assert.deepEqual(Object.keys(required), [...LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS])
  for (const [topicKey, factKeys] of Object.entries(required)) {
    const contract = leadTopicResearchContract(topicKey as Parameters<typeof leadTopicResearchContract>[0])
    for (const factKey of factKeys) assert(contract.factKeys.includes(factKey), `${topicKey} missing ${factKey}`)
  }
  const activeFactKeys = LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS.flatMap((topicKey) => (
    leadTopicResearchContract(topicKey).factKeys
  ))
  assert.equal(activeFactKeys.length, 51)
  assert.equal(new Set(activeFactKeys).size, 51)
  assert.equal(activeFactKeys.every(leadDeepEnrichmentFactKeyAllowed), true)
})

test('web research requires financial basis, market scope and production stage', () => {
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'financial_operations', factKey: 'financial.revenue', value: '1亿元',
    period: '2025', unit: '亿元', currency: 'CNY',
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'financial_operations', factKey: 'financial.revenue', value: '1亿元',
    instanceKey: '2025 公开披露未经审计', period: '2025', unit: '亿元', currency: 'CNY', scope: '公司口径，公开披露，未经审计',
  }).ok, true)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'market_policy', factKey: 'market.size', value: '100亿元', unit: '亿元', scope: '中国市场',
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'industrialization', factKey: 'production.yield', value: '95%', period: '2026', unit: '%',
  }).ok, false)
})

test('host semantic gates keep financing, operating, contract and market amounts separate', () => {
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'financing', factKey: 'financing.amount', instanceKey: '2026 拟融资',
    value: '2亿元', period: '2026', unit: '亿元', currency: 'CNY', scope: '计划融资需求2亿元',
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'financing', factKey: 'financing.amount', instanceKey: '2026 A轮',
    value: '2亿元', period: '2026', unit: '亿元', currency: 'CNY', scope: '已完成A轮融资金额',
  }).ok, true)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'financial_operations', factKey: 'financial.revenue', instanceKey: '2025 审计',
    value: '3亿元', period: '2025', unit: '亿元', currency: 'CNY', scope: '市场规模3亿元',
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'market_policy', factKey: 'market.size', instanceKey: '2025 中国市场',
    value: '100亿元', period: '2025', unit: '亿元', currency: 'CNY',
    scope: '中国市场，企业营业收入口径',
  }).ok, false)
})

test('date and lifecycle facts require concrete host-recognized semantics', () => {
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'latest_developments', factKey: 'news.reported_date', instanceKey: '产品发布', value: '最近',
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'latest_developments', factKey: 'news.reported_date', instanceKey: '2026-08-20 产品发布', value: '2026-08-20',
  }).ok, true)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'customers_contracts', factKey: 'contract.period', instanceKey: '客户A 框架合同',
    value: '2025-01至2025-12', scope: '框架合同有效期',
  }).ok, true)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'technology_ip', factKey: 'patent.status', instanceKey: 'CN202410123456.7', value: '拥有专利',
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'technology_ip', factKey: 'patent.status', instanceKey: 'CN202410123456.7', value: '已公开，实质审查中',
  }).ok, true)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'products', factKey: 'product.release_status', instanceKey: '产品A', value: '领先产品',
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'products', factKey: 'product.release_status', instanceKey: '产品A v1', value: '已发布',
  }).ok, true)
})

test('latest-development web hits can persist independently when only one field is found', () => {
  const incomplete = enforceLeadTopicFactSetContract('latest_developments', [{
    factKey: 'news.event', instanceKey: '2026-08 产品发布', period: '2026-08',
  }])
  assert.equal(incomplete.facts.length, 1)
  assert.equal(incomplete.rejectedFactCount, 0)
  const complete = enforceLeadTopicFactSetContract('latest_developments', [
    { factKey: 'news.event', instanceKey: '2026-08 产品发布', period: '2026-08' },
    { factKey: 'news.event_date', instanceKey: '2026-08 产品发布' },
  ])
  assert.equal(complete.rejectedFactCount, 0)
  assert.equal(complete.facts.length, 2)
})

test('direct competitors require three-way product-market matching and a comparison basis', () => {
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'competition', factKey: 'competition.direct', value: { name: '同赛道公司' },
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'competition', factKey: 'competition.direct',
    instanceKey: '直接竞品',
    value: {
      name: '直接竞品', sameTargetUser: true, sameUseCase: true, sameDeliverable: true,
      comparisonBasis: '均面向工业客户交付同类质量检测软件',
    },
  }).ok, true)
})

test('company website facts require an HTTP or HTTPS URL', () => {
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'basic_profile', factKey: 'profile.website', value: '示例公司官网',
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'basic_profile', factKey: 'profile.website', value: 'https://example.com/about',
  }).ok, true)
})

test('basic registry and official identifier facts use deterministic format gates', () => {
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'basic_profile', factKey: 'registry.credit_code', value: '91110108MA01ABCX2Y',
  }).ok, true)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'basic_profile', factKey: 'registry.credit_code', value: '待核验123',
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'technology_ip', factKey: 'patent.number', instanceKey: 'CN202410123456.7', value: 'CN202410123456.7',
  }).ok, true)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'technology_ip', factKey: 'patent.number', value: '已申请多项专利',
  }).ok, false)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'industrialization', factKey: 'certification.number', instanceKey: 'CERT-2026-001', value: 'CERT-2026-001', scope: '产品A',
  }).ok, true)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'industrialization', factKey: 'certification.number', value: '待核验', scope: '产品A',
  }).ok, false)
})

test('repeatable web facts require stable instance keys while basic profile remains singleton', () => {
  const missingInstance = validateLeadTopicResearchFact({
    topicKey: 'ownership', factKey: 'ownership.shareholder', value: '股东A',
  })
  assert.equal(missingInstance.ok, false)
  assert.match(missingInstance.errors.join(';'), /stable instanceKey/)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'ownership', factKey: 'ownership.shareholder', instanceKey: '2026-08-26 股东A', value: '股东A',
  }).ok, true)
  assert.equal(validateLeadTopicResearchFact({
    topicKey: 'basic_profile', factKey: 'profile.positioning', value: '工业质检软件',
  }).ok, true)
})

test('web research budget fails closed on token or configured cost overflow', () => {
  assert.equal(validateLeadTopicResearchBudget({ inputTokens: 100, outputTokens: 50 }, {}).ok, true)
  const tokenOverflow = validateLeadTopicResearchBudget({ inputTokens: 101, outputTokens: 20 }, {
    LEAD_ENRICHMENT_MAX_INPUT_TOKENS_PER_TOPIC: '100',
    LEAD_ENRICHMENT_MAX_OUTPUT_TOKENS_PER_TOPIC: '100',
  })
  assert.equal(tokenOverflow.ok, false)
  assert.match(tokenOverflow.reasons.join(';'), /input tokens/)
  const costOverflow = validateLeadTopicResearchBudget({ inputTokens: 1_000_000, outputTokens: 0 }, {
    LEAD_ENRICHMENT_INPUT_USD_PER_MILLION: '2',
    LEAD_ENRICHMENT_MAX_ESTIMATED_COST_USD_PER_TOPIC: '1',
  })
  assert.equal(costOverflow.ok, false)
  assert.match(costOverflow.reasons.join(';'), /estimated cost/)
})

test('snapshot hashing is stable across key order and changes with facts', () => {
  assert.equal(canonicalEnrichmentJson({ b: 2, a: 1 }), canonicalEnrichmentJson({ a: 1, b: 2 }))
  assert.equal(enrichmentSnapshotHash({ b: 2, a: 1 }), enrichmentSnapshotHash({ a: 1, b: 2 }))
  assert.notEqual(enrichmentSnapshotHash({ facts: [1] }), enrichmentSnapshotHash({ facts: [1, 2] }))
})

test('snapshot hash ignores topic execution metadata while retaining it for audit', () => {
  const topicStates = Object.fromEntries(LEAD_ENRICHMENT_TOPIC_KEYS.map((key) => [key, 'missing'])) as Record<typeof LEAD_ENRICHMENT_TOPIC_KEYS[number], 'missing'>
  const base = {
    leadId: 'lead-1', entityType: 'company' as const, topicStates,
    facts: [], evidenceIndex: {}, gaps: [], conflicts: [],
  }
  const first = buildLeadEnrichmentSnapshot({
    ...base, jobId: 'job-1',
    topicRuns: [{ id: 'run-1', topicKey: 'basic_profile', attempts: 1, completedAt: '2026-08-26T01:00:00.000Z' }],
  })
  const replay = buildLeadEnrichmentSnapshot({
    ...base, jobId: 'job-2',
    topicRuns: [{ id: 'run-2', topicKey: 'basic_profile', attempts: 3, completedAt: '2026-08-26T02:00:00.000Z' }],
  })
  assert.equal(replay.snapshotHash, first.snapshotHash)
  assert.notDeepEqual(replay.topicRuns, first.topicRuns)
})

test('rating subject profile excludes raw summaries and keeps verified introductions', () => {
  const profile = leadRatingSubjectProfile({
    entityType: 'company', entityStatus: 'confirmed', entities: [{ id: 'entity-1' }], relations: [],
    identity: {
      name: '证据边界验收项目', companyName: '证据边界验收有限公司', industry: '企业服务',
      summary: '未经证据确认的宣传摘要', team: '未经证据确认的团队宣传',
    },
    introductions: {
      companyIntroduction: '来自已验证事实的企业介绍', teamIntroduction: null, projectIntroduction: null,
    },
    topicRuns: [{ id: 'audit-only-run' }],
  })
  assert.deepEqual(profile.identity, {
    name: '证据边界验收项目', companyName: '证据边界验收有限公司', industry: '企业服务',
  })
  assert.equal(profile.introductions.companyIntroduction, '来自已验证事实的企业介绍')
  assert.equal('summary' in profile.identity, false)
  assert.equal('team' in profile.identity, false)
  assert.equal('topicRuns' in profile, false)
})

test('generated subject introductions remain separated and retain their contributing fact ids', () => {
  const introductions = verifiedSubjectIntroductions([
    { id: 'company-fact', subject_type: 'company', fact_key: 'profile.main_business', value: '企业主营业务', verification_status: 'verified' },
    { id: 'team-fact', subject_type: 'team', fact_key: 'team.member', value: '团队成员甲', verification_status: 'verified' },
    { id: 'project-fact', subject_type: 'project', fact_key: 'technology.route', value: '项目技术路线', verification_status: 'verified' },
    { id: 'unverified-fact', subject_type: 'company', fact_key: 'profile.positioning', value: '未经核验宣传', verification_status: 'unverified' },
  ])
  assert.equal(introductions.companyIntroduction, '企业主营业务')
  assert.deepEqual(introductions.companyFactIds, ['company-fact'])
  assert.equal(introductions.teamIntroduction, '团队成员甲')
  assert.deepEqual(introductions.teamFactIds, ['team-fact'])
  assert.equal(introductions.projectIntroduction, '项目技术路线')
  assert.deepEqual(introductions.projectFactIds, ['project-fact'])
  assert.doesNotMatch(JSON.stringify(introductions), /未经核验宣传/)
})

test('formal facts require evidence and E3 material claims stay unverified', () => {
  const base = {
    leadId: 'lead-1', topicKey: 'financing' as const, subjectType: 'company', subjectId: 'company-1',
    factKey: 'financing.round', value: { round: 'A轮' }, evidenceLevel: 'E3' as const,
    verificationStatus: 'verified' as const,
  }
  assert.throws(() => validateLeadFactCandidate({ ...base, evidence: [] }), /requires source URL and quote/)
  assert.throws(() => validateLeadFactCandidate({
    ...base,
    evidence: [{ sourceUrl: 'https://example.com/funding', sourceType: 'news', quote: '完成A轮融资' }],
  }), /E3 evidence cannot be verified/)
  const accepted = validateLeadFactCandidate({
    ...base,
    verificationStatus: 'unverified',
    evidence: [{ sourceUrl: 'https://example.com/funding?utm_source=test', sourceType: 'news', quote: '完成A轮融资' }],
  })
  assert.equal(accepted.evidence[0]?.sourceUrl, 'https://example.com/funding')
})

test('web-hit facts keep actual values and bypass strict quote, period and unit validation', () => {
  const accepted = validateLeadFactCandidate({
    leadId: 'lead-web-hit', topicKey: 'financing', subjectType: 'company', subjectId: 'company-web-hit',
    factKey: 'financing.amount', value: '2亿元', evidenceLevel: 'E3', verificationStatus: 'verified',
    acceptanceMode: 'web_hit',
    evidence: [{ sourceUrl: 'https://example.com/search-result', sourceType: 'web_search', quote: '该公司完成新一轮融资' }],
  })
  assert.equal(accepted.value, '2亿元')
  assert.equal(accepted.verificationStatus, 'verified')
  assert.equal(accepted.acceptanceMode, 'web_hit')
  assert.doesNotThrow(() => validateLeadFactCandidate({
    ...accepted,
    evidence: [{ sourceUrl: 'https://example.com/search-result-only', sourceType: 'web_search', quote: '' }],
  }))
})

test('rejects E3 numeric values that are absent from quotes or lack period and unit context', () => {
  const base = {
    leadId: 'lead', topicKey: 'financial_operations' as const, subjectType: 'company', subjectId: 'company',
    factKey: 'financial.revenue', evidenceLevel: 'E3' as const, verificationStatus: 'unverified' as const,
    evidence: [{ sourceUrl: 'https://example.com/report', sourceType: 'web', quote: '2025年营业收入为1亿元。' }],
  }
  assert.throws(() => validateLeadFactCandidate({ ...base, value: '2亿元', periodStart: '2025', unit: '亿元' }), /not present/)
  assert.throws(() => validateLeadFactCandidate({ ...base, value: '1亿元', unit: '亿元' }), /period or scope/)
  assert.throws(() => validateLeadFactCandidate({ ...base, value: '1亿元', periodStart: '2025' }), /unit, currency or scope/)
  assert.doesNotThrow(() => validateLeadFactCandidate({ ...base, value: '1亿元', periodStart: '2025', unit: '亿元', currency: 'CNY' }))
})

test('E1 and E2 material numeric facts also require period and unit context', () => {
  const base = {
    leadId: 'lead', topicKey: 'financial_operations' as const, subjectType: 'company', subjectId: 'company',
    factKey: 'financial.revenue', evidenceLevel: 'E2' as const, verificationStatus: 'verified' as const,
    evidence: [{ sourceUrl: 'https://example.com/audit', sourceType: 'filing', quote: '2025年营业收入为1亿元。' }],
  }
  assert.throws(() => validateLeadFactCandidate({ ...base, value: '1亿元', unit: '亿元' }), /period or scope/)
  assert.throws(() => validateLeadFactCandidate({ ...base, value: '1亿元', periodStart: '2025' }), /unit, currency or scope/)
  assert.doesNotThrow(() => validateLeadFactCandidate({ ...base, value: '1亿元', periodStart: '2025', unit: '亿元' }))
})

test('E1 and E2 numeric values must also occur in the cited quote', () => {
  for (const evidenceLevel of ['E1', 'E2'] as const) {
    assert.throws(() => validateLeadFactCandidate({
      leadId: 'lead', topicKey: 'financial_operations', subjectType: 'company', subjectId: 'company',
      factKey: 'financial.revenue', value: '2亿元', unit: '亿元', periodStart: '2025', periodEnd: '2025',
      evidenceLevel, verificationStatus: 'verified',
      evidence: [{ sourceUrl: 'https://example.org/filing', sourceType: 'official', quote: '2025年营业收入1亿元' }],
    }), /numeric fact value is not present/)
  }
})

test('primitive string fact values must occur in the cited quote after harmless text normalization', () => {
  const base = {
    leadId: 'lead', topicKey: 'basic_profile' as const, subjectType: 'company', subjectId: 'company',
    factKey: 'registry.registration_status', evidenceLevel: 'E1' as const, verificationStatus: 'verified' as const,
    evidence: [{ sourceUrl: 'https://example.org/registry', sourceType: 'official', quote: '登记状态：存 续。' }],
  }
  assert.doesNotThrow(() => validateLeadFactCandidate({ ...base, value: '存续' }))
  assert.throws(() => validateLeadFactCandidate({ ...base, value: '注销' }), /string fact value is not present/)
  assert.doesNotThrow(() => validateLeadFactCandidate({
    ...base,
    factKey: 'profile.website',
    value: 'https://example.org/',
    evidence: [{ sourceUrl: 'https://example.org/about', sourceType: 'official', quote: '企业官网首页' }],
  }))
})

test('freezes only terminal topic states and routes open conflicts to review', () => {
  const topicStates = initialTopicStates({ entityType: 'research', hasCommercialCompany: false })
  for (const topic of LEAD_ENRICHMENT_TOPIC_KEYS) {
    if (topicStates[topic] === 'queued') topicStates[topic] = 'missing'
  }
  const ready = buildLeadEnrichmentSnapshot({
    leadId: 'lead-1', jobId: 'job-1', entityType: 'research', topicStates,
    facts: [], evidenceIndex: {}, gaps: [], conflicts: [],
  })
  assert.equal(ready.status, 'ready')
  const review = buildLeadEnrichmentSnapshot({
    leadId: 'lead-1', jobId: 'job-1', entityType: 'research', topicStates,
    facts: [], evidenceIndex: {}, gaps: [], conflicts: [{ factKey: 'ip.owner' }],
  })
  assert.equal(review.status, 'review')
  assert.throws(() => buildLeadEnrichmentSnapshot({
    leadId: 'lead-1', jobId: 'job-1', entityType: 'research',
    topicStates: { ...topicStates, technology_ip: 'queued' },
    facts: [], evidenceIndex: {}, gaps: [], conflicts: [],
  }), /non-terminal topics/)
})
