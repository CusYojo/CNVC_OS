import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLeadInvestmentProfile, isLeadInvestmentProfileFactKey } from '../src/services/leadInvestmentProfileService.js'
import { buildLeadInvestmentProfileDictionaries } from '../src/services/leadInvestmentProfileDictionary.js'

const fact = (id: string, factKey: string, instanceKey: string, value: unknown, extra: Record<string, unknown> = {}) => ({
  id, factKey, instanceKey, value, verificationStatus: 'verified', ...extra,
})

test('investment profile fact-key boundary excludes unrelated enrichment topics', () => {
  for (const key of ['industry.segment', 'product.route', 'financing.round', 'transaction.post_money', 'team.institution', 'customer.intent', 'customer.pilot', 'delivery.status']) {
    assert.equal(isLeadInvestmentProfileFactKey(key), true, key)
  }
  for (const key of ['competitor.name', 'news.event', 'market.size', 'financial.revenue', 'ip.owner']) {
    assert.equal(isLeadInvestmentProfileFactKey(key), false, key)
  }
})

test('investment profile binds financing, investors and valuation by event and date', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-1', snapshotId: 'snapshot-1', snapshotHash: 'hash-1', entityType: 'company', frozenAt: '2026-09-02T00:00:00Z',
    dictionaries: { institutions: { '深创投': { tier: '头部机构', type: '市场化VC/PE', major: true } } },
    facts: [
      fact('f1', 'financing.round', '2024-a', 'A轮'),
      fact('f2', 'financing.date', '2024-a', '2024-05-01'),
      fact('f3', 'financing.amount', '2024-a', '5000万元', { currency: 'CNY' }),
      fact('f4', 'financing.investors', '2024-a', ['某基金']),
      fact('f5', 'financing.round', '2025-b', 'B轮'),
      fact('f6', 'financing.date', '2025-b', '2025-03-15'),
      fact('f7', 'financing.amount', '2025-b', '1亿元', { currency: 'CNY' }),
      fact('f8', 'financing.investors', '2025-b', ['深创投', '产业资本']),
      fact('f9', 'financing.lead_investor', '2025-b', '深创投'),
      fact('f10', 'transaction.round', '2025-b', 'B轮'),
      fact('f11', 'transaction.post_money', '2025-b', '8亿元', { currency: 'CNY', periodEnd: '2025-03-15' }),
    ],
  })
  assert.equal(profile.financing.latestRound, 'B轮')
  assert.equal(profile.financing.latestAmountValue, 100_000_000)
  assert.equal(profile.financing.cumulativeAmountValue, 150_000_000)
  assert.equal(profile.financing.cumulativeAmount, '1.5亿元')
  assert.equal(profile.valuation.value, '8亿元')
  assert.equal(profile.valuation.type, 'post_money')
  const institution = profile.institutions.find((item) => item.name === '深创投')
  assert.match(institution?.institutionId ?? '', /^institution_[a-f0-9]{20}$/)
  assert.deepEqual({ ...institution, institutionId: undefined }, {
    institutionId: undefined, name: '深创投', round: 'B轮', role: 'lead', type: '市场化VC/PE', tier: '头部机构', major: true,
  })
})

test('investment profile derives customer stage from evidence facts and masks confidential names', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-2', entityType: 'company',
    dictionaries: { customers: { '宁德时代': { tier: 'A' } } },
    facts: [
      fact('c1', 'customer.name', 'catl', '宁德时代'),
      fact('c2', 'delivery.status', 'catl', '已验收'),
      fact('c3', 'customer.name', 'secret', '真实客户名称'),
      fact('c4', 'customer.confidentiality', 'secret', 'confidential'),
      fact('c5', 'customer.anonymized_label', 'secret', '某头部动力电池企业'),
      fact('c6', 'cash_collection.status', 'secret', '已回款'),
      { ...fact('c7', 'customer.name', 'ignored', '无证据客户'), verificationStatus: 'unverified' },
    ],
  })
  assert.equal(profile.customers.highestStage, 'L5')
  assert.equal(profile.customers.verifiedCount, 2)
  assert.equal(profile.customers.tierACount, 1)
  assert.equal(profile.customers.tierBCount, 0)
  assert.equal(profile.customers.tierCCount, 0)
  assert.deepEqual(profile.customers.representatives.map((item) => item.name), ['某头部动力电池企业', '宁德时代'])
  assert.equal(JSON.stringify(profile).includes('真实客户名称'), false)
})

test('negative or planned customer actions never promote L2 through L5', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-negative-customer-actions', entityType: 'company',
    facts: [
      fact('negative-1', 'customer.name', 'planned-pilot', '客户甲'),
      fact('negative-2', 'customer.pilot', 'planned-pilot', '计划试点'),
      fact('negative-3', 'customer.name', 'unsigned-contract', '客户乙'),
      fact('negative-4', 'contract.status', 'unsigned-contract', '尚未签署'),
      fact('negative-5', 'customer.name', 'unordered', '客户丙'),
      fact('negative-6', 'order.status', 'unordered', '未下单'),
      fact('negative-7', 'customer.name', 'undelivered', '客户丁'),
      fact('negative-8', 'delivery.status', 'undelivered', '未交付'),
      fact('negative-9', 'customer.name', 'unpaid', '客户戊'),
      fact('negative-10', 'cash_collection.status', 'unpaid', '未回款'),
    ],
  })
  assert.equal(profile.customers.highestStage, 'L0')
  assert.equal(profile.customers.verifiedCount, 0)
  assert.equal(profile.customers.mentionedCount, 5)
})

test('an unconfirmed formal-customer flag does not promote a named account to L3', () => {
  for (const formalStatus of ['否', 'false', '待确认', '潜在客户']) {
    const profile = buildLeadInvestmentProfile({
      leadId: `lead-unconfirmed-formal-${formalStatus}`, entityType: 'company',
      facts: [
        fact('formal-name', 'customer.name', 'candidate-customer', '客户甲'),
        fact('formal-status', 'customer.formal', 'candidate-customer', formalStatus),
      ],
    })
    assert.equal(profile.customers.highestStage, 'L0')
    assert.equal(profile.customers.verifiedCount, 0)
  }
})

test('only affirmative formal-customer facts promote a named account to L3', () => {
  for (const formalStatus of ['正式客户', '已转正', '已确认', 'true']) {
    const profile = buildLeadInvestmentProfile({
      leadId: `lead-confirmed-formal-${formalStatus}`, entityType: 'company',
      facts: [
        fact('formal-name', 'customer.name', 'confirmed-customer', '客户甲'),
        fact('formal-status', 'customer.formal', 'confirmed-customer', formalStatus),
      ],
    })
    assert.equal(profile.customers.highestStage, 'L3')
    assert.equal(profile.customers.verifiedCount, 1)
  }
})

test('a formal-customer identity supported by contract scope becomes the representative account', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-formal-customer-identity', entityType: 'company',
    facts: [fact('formal-identity', 'customer.formal', 'signed-customer', '客户甲', { scope: '采购合同已签署' })],
  })
  assert.equal(profile.customers.highestStage, 'L3')
  assert.equal(profile.customers.verifiedCount, 1)
  assert.equal(profile.customers.contractedCount, 1)
  assert.equal(profile.customers.representatives[0]?.name, '客户甲')
})

test('distinct confidential customer instances keep accurate counts without exposing their names', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-confidential-customer-count', entityType: 'company',
    dictionaries: {
      customers: {
        '客户甲': { canonicalName: '客户甲', tier: 'A', confidentiality: 'confidential' },
        '客户乙': { canonicalName: '客户乙', tier: 'B', confidentiality: 'restricted' },
      },
    },
    facts: [
      fact('cc1', 'customer.name', 'confidential-customer-a', '客户甲'),
      fact('cc2', 'delivery.status', 'confidential-customer-a', '已验收'),
      fact('cc3', 'customer.name', 'confidential-customer-b', '客户乙'),
      fact('cc4', 'cash_collection.status', 'confidential-customer-b', '已回款'),
    ],
  })
  assert.equal(profile.customers.verifiedCount, 2)
  assert.equal(profile.customers.tierACount, 1)
  assert.equal(profile.customers.tierBCount, 1)
  assert.deepEqual(profile.customers.representatives.map((item) => item.name), ['某保密客户'])
  assert.equal(JSON.stringify(profile).includes('客户甲'), false)
  assert.equal(JSON.stringify(profile).includes('客户乙'), false)
})

test('a confidential customer label containing the real identity falls back to the generic label', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-unsafe-anonymized-label', entityType: 'company',
    dictionaries: {
      customers: {
        'secretco': { canonicalName: '秘密客户', tier: 'A', confidentiality: 'restricted' },
      },
    },
    facts: [
      fact('unsafe-label-1', 'customer.name', 'restricted-customer', 'SecretCo'),
      fact('unsafe-label-2', 'customer.anonymized_label', 'restricted-customer', '秘密客户（保密）'),
      fact('unsafe-label-3', 'customer.pilot', 'restricted-customer', '已启动试点'),
    ],
  })
  assert.equal(profile.customers.verifiedCount, 0)
  assert.equal(profile.customers.trialCount, 1)
  assert.equal(profile.customers.representatives[0]?.name, '某保密客户')
  assert.equal(JSON.stringify(profile).includes('SecretCo'), false)
  assert.equal(JSON.stringify(profile).includes('秘密客户'), false)
})

test('planned production targets stay distinct from realized industrialization stages', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-production-stage', entityType: 'company',
    facts: [
      fact('planned-name', 'product.name', 'planned-product', '设备甲'),
      fact('planned-stage', 'production.stage', 'planned-product', '计划量产'),
      fact('realized-name', 'product.name', 'realized-product', '设备乙'),
      fact('realized-stage', 'production.stage', 'realized-product', '小批量'),
      fact('unknown-name', 'product.name', 'unknown-product', '设备丙'),
      fact('unknown-stage', 'production.stage', 'unknown-product', '客户导入阶段'),
    ],
  })
  assert.equal(profile.products.find((product) => product.name === '设备甲')?.productionStageStatus, 'planned')
  assert.equal(profile.products.find((product) => product.name === '设备乙')?.productionStageStatus, 'realized')
  assert.equal(profile.products.find((product) => product.name === '设备丙')?.productionStageStatus, 'undisclosed')
})

test('investment profile does not treat plans, intent or research partners as completed financing or verified customers', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-3', entityType: 'company',
    facts: [
      fact('p1', 'financing.status', 'planned', '计划融资'),
      fact('p2', 'financing.amount', 'planned', '2亿元', { currency: 'CNY' }),
      fact('p3', 'transaction.valuation', 'planned', '计划估值10亿元', { currency: 'CNY' }),
      fact('p4', 'customer.name', 'partner', '某高校'),
      fact('p5', 'customer.research_partner', 'partner', '某高校'),
    ],
  })
  assert.equal(profile.financing.completedRoundCount, 0)
  assert.equal(profile.financing.status, '计划融资')
  assert.equal(profile.financing.latestAmount, undefined)
  assert.equal(profile.valuation.value, undefined)
  assert.equal(profile.customers.highestStage, 'L0')
  assert.equal(profile.customers.verifiedCount, 0)
  assert.equal(profile.customers.mentionedCount, 1)
})

test('pending financing and planned or third-party valuations do not become completed capital facts', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-pending-capital-semantics', entityType: 'company',
    facts: [
      fact('pending-1', 'financing.round', 'pending-round', 'A轮待交割'),
      fact('pending-2', 'financing.date', 'pending-round', '2026-06-01'),
      fact('pending-3', 'financing.amount', 'pending-round', '1亿元', { currency: 'CNY' }),
      fact('complete-1', 'financing.round', 'completed-round', 'Pre-A轮'),
      fact('complete-2', 'financing.date', 'completed-round', '2026-05-01'),
      fact('complete-3', 'transaction.post_money', 'completed-round', '目标投后估值10亿元', { currency: 'CNY' }),
      fact('complete-4', 'transaction.valuation', 'completed-round', '第三方推算8亿元', { currency: 'CNY' }),
    ],
  })
  assert.equal(profile.financing.completedRoundCount, 1)
  assert.equal(profile.financing.latestRound, 'Pre-A轮')
  assert.equal(profile.financing.latestRoundDate, '2026-05-01')
  assert.equal(profile.valuation.value, undefined)
})

test('ongoing rounds stay separate from completed financing events', () => {
  for (const ongoingRound of ['B轮融资中', '正在进行B轮融资', 'B轮在融', 'B round in progress']) {
    const profile = buildLeadInvestmentProfile({
      leadId: `lead-ongoing-round-${ongoingRound}`, entityType: 'company',
      facts: [
        fact('ongoing-round', 'financing.round', 'ongoing-event', ongoingRound),
        fact('ongoing-date', 'financing.date', 'ongoing-event', '2026-08-01'),
        fact('ongoing-amount', 'financing.amount', 'ongoing-event', '2亿元', { currency: 'CNY' }),
        fact('ongoing-valuation', 'transaction.post_money', 'ongoing-event', '10亿元', { currency: 'CNY' }),
      ],
    })
    assert.equal(profile.financing.completedRoundCount, 0)
    assert.equal(profile.financing.latestRound, undefined)
    assert.equal(profile.financing.latestAmount, undefined)
    assert.equal(profile.valuation.value, undefined)
  }
})

test('a planned post-money value cannot hide a confirmed pre-money value in the same financing event', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-mixed-valuation-candidates', entityType: 'company',
    facts: [
      fact('mixed-1', 'financing.round', 'mixed-valuation-round', 'A轮'),
      fact('mixed-2', 'financing.date', 'mixed-valuation-round', '2026-07-01'),
      fact('mixed-3', 'transaction.post_money', 'mixed-valuation-round', '目标投后估值10亿元', { currency: 'CNY' }),
      fact('mixed-4', 'transaction.pre_money', 'mixed-valuation-round', '6亿元', { currency: 'CNY' }),
    ],
  })
  assert.equal(profile.valuation.type, 'pre_money')
  assert.equal(profile.valuation.value, '6亿元')
  assert.equal(profile.valuation.numericValue, 600_000_000)
})

test('unfinanced is a status rather than a completed financing event', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-unfinanced', entityType: 'company',
    facts: [fact('u1', 'financing.status', 'current', '未融资')],
  })
  assert.equal(profile.financing.status, '未融资')
  assert.equal(profile.financing.completedRoundCount, 0)
  assert.equal(profile.financing.latestAmount, undefined)
  assert.equal(profile.valuation.value, undefined)
})

test('orphan amounts and undated generic valuations do not become completed capital events', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-orphan-capital', entityType: 'company',
    facts: [
      fact('o1', 'financing.amount', 'orphan', '5000万元', { currency: 'CNY' }),
      fact('o2', 'transaction.valuation', 'orphan', '10亿元', { currency: 'CNY' }),
    ],
  })
  assert.equal(profile.financing.completedRoundCount, 0)
  assert.equal(profile.financing.latestAmount, undefined)
  assert.equal(profile.valuation.value, undefined)
})

test('pre-money and post-money valuations require a completed financing event with the same instance key', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-orphan-transaction-valuations', entityType: 'company',
    facts: [
      fact('v1', 'transaction.pre_money', 'pre-money-without-financing', '8亿元', { currency: 'CNY' }),
      fact('v2', 'transaction.date', 'pre-money-without-financing', '2026-01-01'),
      fact('v3', 'transaction.post_money', 'post-money-without-financing', '12亿元', { currency: 'CNY' }),
      fact('v4', 'transaction.date', 'post-money-without-financing', '2026-02-01'),
      fact('v5', 'financing.round', 'different-completed-financing', 'A轮'),
      fact('v6', 'financing.date', 'different-completed-financing', '2026-02-01'),
    ],
  })
  assert.equal(profile.financing.completedRoundCount, 1)
  assert.equal(profile.valuation.value, undefined)
})

test('an undated round is not guessed as the latest financing event', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-undated-round', entityType: 'company',
    facts: [
      fact('u1', 'financing.round', 'round-without-date', 'A轮'),
      fact('u2', 'financing.amount', 'round-without-date', '5000万元', { currency: 'CNY' }),
    ],
  })
  assert.equal(profile.financing.status, '已完成融资（日期待核验）')
  assert.equal(profile.financing.completedRoundCount, 1)
  assert.equal(profile.financing.latestRound, undefined)
  assert.equal(profile.financing.latestAmount, undefined)
})

test('an undated completed round is not overwritten by a planned or unfinanced declaration', () => {
  for (const declaredStatus of ['计划融资', '未融资']) {
    const profile = buildLeadInvestmentProfile({
      leadId: `lead-undated-completed-${declaredStatus}`, entityType: 'company',
      facts: [
        fact('s1', 'financing.status', `declaration-${declaredStatus}`, declaredStatus),
        fact('s2', 'financing.round', 'completed-without-date', 'A轮'),
        fact('s3', 'financing.amount', 'completed-without-date', '5000万元', { currency: 'CNY' }),
      ],
    })
    assert.equal(profile.financing.status, '已完成融资（日期待核验）')
    assert.equal(profile.financing.completedRoundCount, 1)
    assert.equal(profile.financing.latestRound, undefined)
  }
})

test('partial or invalid dates do not invent an exact financing or valuation date', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-imprecise-dates', entityType: 'company',
    facts: [
      fact('date-1', 'financing.round', 'year-only', 'A轮'),
      fact('date-2', 'financing.date', 'year-only', '2025'),
      fact('date-3', 'transaction.post_money', 'year-only', '8亿元', { currency: 'CNY' }),
      fact('date-4', 'financing.round', 'invalid-calendar-date', 'B轮'),
      fact('date-5', 'financing.date', 'invalid-calendar-date', '2026-02-30'),
    ],
  })
  assert.equal(profile.financing.completedRoundCount, 2)
  assert.equal(profile.financing.status, '已完成融资（日期待核验）')
  assert.equal(profile.financing.latestRound, undefined)
  assert.equal(profile.financing.latestRoundDate, undefined)
  assert.equal(profile.valuation.value, undefined)
})

test('same-day financing and valuation events do not pick a latest value by input order', () => {
  const facts = [
    fact('same-a1', 'financing.round', 'same-day-a', 'A轮'),
    fact('same-a2', 'financing.date', 'same-day-a', '2026-04-01'),
    fact('same-a3', 'financing.amount', 'same-day-a', '5000万元', { currency: 'CNY' }),
    fact('same-a4', 'transaction.post_money', 'same-day-a', '5亿元', { currency: 'CNY' }),
    fact('same-b1', 'financing.round', 'same-day-b', 'B轮'),
    fact('same-b2', 'financing.date', 'same-day-b', '2026-04-01'),
    fact('same-b3', 'financing.amount', 'same-day-b', '1亿元', { currency: 'CNY' }),
    fact('same-b4', 'transaction.post_money', 'same-day-b', '8亿元', { currency: 'CNY' }),
  ]
  for (const orderedFacts of [facts, [...facts].reverse()]) {
    const profile = buildLeadInvestmentProfile({ leadId: 'lead-same-day-events', entityType: 'company', facts: orderedFacts })
    assert.equal(profile.financing.status, '已完成融资（同日多事件待核验）')
    assert.equal(profile.financing.completedRoundCount, 2)
    assert.equal(profile.financing.latestRound, undefined)
    assert.equal(profile.financing.latestAmount, undefined)
    assert.equal(profile.financing.cumulativeAmountValue, 150_000_000)
    assert.equal(profile.valuation.value, undefined)
  }
})

test('numeric financing and valuation values honor their declared money units', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-unit', entityType: 'company',
    facts: [
      fact('n1', 'financing.round', 'unit-round', 'A轮'),
      fact('n2', 'financing.date', 'unit-round', '2026-01-01'),
      fact('n3', 'financing.amount', 'unit-round', 2, { unit: '亿元', currency: '人民币' }),
      fact('n4', 'transaction.post_money', 'unit-round', 12, { unit: '亿元', currency: 'RMB' }),
    ],
  })
  assert.equal(profile.financing.latestAmountValue, 200_000_000)
  assert.equal(profile.financing.latestAmount, '2亿元')
  assert.equal(profile.financing.latestAmountCurrency, 'CNY')
  assert.equal(profile.valuation.numericValue, 1_200_000_000)
  assert.equal(profile.valuation.value, '12亿元')
  assert.equal(profile.valuation.currency, 'CNY')
})

test('money ranges remain display text but do not become sortable point values', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-money-range', entityType: 'company',
    facts: [
      fact('range-1', 'financing.round', 'range-round', 'A轮'),
      fact('range-2', 'financing.date', 'range-round', '2026-03-01'),
      fact('range-3', 'financing.amount', 'range-round', '1—2亿元', { currency: 'CNY' }),
      fact('range-4', 'transaction.post_money', 'range-round', '10至12亿元', { currency: 'CNY' }),
    ],
  })
  assert.equal(profile.financing.latestAmount, '1—2亿元')
  assert.equal(profile.financing.latestAmountValue, undefined)
  assert.equal(profile.financing.cumulativeAmountValue, undefined)
  assert.equal(profile.valuation.value, '10至12亿元')
  assert.equal(profile.valuation.numericValue, undefined)
})

test('money bounds and approximations remain display text without sortable point values', () => {
  for (const [amount, valuation] of [
    ['约1亿元', '约10亿元'],
    ['不超过1亿元', '10亿元以上'],
    ['至少5000万元', '近10亿美元'],
    ['1亿元+', 'up to USD 100 million'],
  ]) {
    const profile = buildLeadInvestmentProfile({
      leadId: `lead-money-bound-${amount}`, entityType: 'company',
      facts: [
        fact('bound-1', 'financing.round', 'bound-round', 'A轮'),
        fact('bound-2', 'financing.date', 'bound-round', '2026-03-02'),
        fact('bound-3', 'financing.amount', 'bound-round', amount, { currency: 'CNY' }),
        fact('bound-4', 'transaction.post_money', 'bound-round', valuation, { currency: 'CNY' }),
      ],
    })
    assert.equal(profile.financing.latestAmount, amount)
    assert.equal(profile.financing.latestAmountValue, undefined)
    assert.equal(profile.financing.cumulativeAmountValue, undefined)
    assert.equal(profile.valuation.value, valuation)
    assert.equal(profile.valuation.numericValue, undefined)
  }
})

test('investment profile keeps academic relation types separate from commercialization', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-4', entityType: 'company',
    facts: [
      fact('a1', 'team.institution', 'founder', '清华大学'),
      fact('a2', 'team.institution_relation', 'founder', '博士学历'),
      fact('a3', 'team.member', 'founder', '张三'),
      fact('a4', 'team.institution', 'project', '中国科学院'),
      fact('a5', 'team.institution_relation', 'project', '成果转化'),
      fact('a6', 'technology.transfer_status', 'project', '已完成技术转让'),
    ],
  })
  assert.equal(profile.academicLinks[0]?.commercialization, false)
  assert.equal(profile.academicLinks[1]?.commercialization, true)
})

test('negative lifecycle wording cannot become lead investment, commercialization or realized production', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-negative-lifecycle-semantics', entityType: 'company',
    facts: [
      fact('negative-role-1', 'financing.round', 'negative-role', 'A轮'),
      fact('negative-role-2', 'financing.date', 'negative-role', '2026-05-01'),
      fact('negative-role-3', 'financing.investors', 'negative-role', ['机构甲']),
      fact('negative-role-4', 'financing.investor_role', 'negative-role', '非领投', { scope: '机构甲' }),
      fact('negative-transfer-1', 'team.institution', 'negative-transfer', '示例大学'),
      fact('negative-transfer-2', 'team.institution_relation', 'negative-transfer', '科研合作'),
      fact('negative-transfer-3', 'technology.transfer_status', 'negative-transfer', '尚未完成技术转让'),
      fact('negative-production-1', 'product.name', 'negative-production', '设备甲'),
      fact('negative-production-2', 'production.stage', 'negative-production', '尚未量产'),
    ],
  })
  assert.equal(profile.institutions[0]?.role, 'undisclosed')
  assert.equal(profile.academicLinks[0]?.commercialization, false)
  assert.equal(profile.products[0]?.productionStageStatus, 'planned')
})

test('investment profile is deterministic and dictionary aliases cannot self-promote a major institution', () => {
  const input = {
    leadId: 'lead-5', snapshotId: 'snapshot-5', snapshotHash: 'hash-5', entityType: 'company',
    dictionaries: {
      institutions: {
        'scvc': { canonicalName: '深创投', tier: '一级', type: '市场化VC/PE', major: false },
      },
      customers: {
        'catl': { canonicalName: '宁德时代', tier: 'A' as const },
      },
    },
    facts: [
      fact('d1', 'financing.round', 'round-a', 'A轮'),
      fact('d2', 'financing.date', 'round-a', '2025-01-01'),
      fact('d3', 'financing.investors', 'round-a', ['SCVC']),
      fact('d4', 'financing.investor_role', 'round-a', '跟投', { scope: 'SCVC' }),
      fact('d5', 'customer.name', 'customer-a', 'CATL'),
      fact('d6', 'contract.status', 'customer-a', '已签署'),
    ],
  }
  const first = buildLeadInvestmentProfile(input)
  const replay = buildLeadInvestmentProfile(input)
  assert.deepEqual(replay, first)
  assert.equal(first.institutions[0]?.name, '深创投')
  assert.equal(first.institutions[0]?.role, 'follow')
  assert.match(first.institutions[0]?.institutionId ?? '', /^institution_[a-f0-9]{20}$/)
  assert.equal(first.institutions.some((item) => item.name === '跟投'), false)
  assert.equal(first.customers.representatives[0]?.name, '宁德时代')
})

test('marketing customer names without commercial evidence do not enter the customer projection', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-6', entityType: 'team', conflictCount: 2,
    facts: [
      fact('m1', 'customer.name', 'logo-wall', '某知名客户'),
      { ...fact('m2', 'contract.status', 'unverified-contract', '已签署'), verificationStatus: 'unverified' },
    ],
  })
  assert.equal(profile.customers.verifiedCount, 0)
  assert.equal(profile.dataStatus.status, 'conflicted')
})

test('research profiles use only technical and academic dimensions', () => {
  const profile = buildLeadInvestmentProfile({
    leadId: 'lead-7', entityType: 'research',
    facts: [
      fact('r1', 'product.name', 'paper-product', '新型催化材料'),
      fact('r2', 'technology.route', 'paper-product', '低温合成路线'),
      fact('r3', 'team.institution', 'research-team', '某研究院'),
      fact('r4', 'team.institution_relation', 'research-team', '当前研究机构'),
    ],
  })
  assert.equal(profile.dataStatus.applicableDimensions, 2)
  assert.equal(profile.dataStatus.verifiedDimensions, 2)
  assert.equal(profile.dataStatus.status, 'verified')
  assert.equal(profile.financing.status, '不适用')
})

test('dictionary hash and aliases are deterministic and collisions fail closed', () => {
  const first = buildLeadInvestmentProfileDictionaries({
    institutions: [
      { canonical_name: '深创投', aliases: ['SCVC', '深圳创投'], institution_type: '市场化VC/PE', tier: '一级', major: 1 },
      { canonical_name: '国投创合', aliases: ['SDIC Ventures'], institution_type: '国资基金', tier: null, major: false },
    ],
    customers: [
      { canonical_name: '宁德时代', aliases: ['CATL'], tier: 'A', confidentiality: 'public' },
      { canonical_name: '秘密客户', aliases: ['SecretCo'], tier: 'A', confidentiality: 'restricted' },
    ],
    industries: [{ canonical_name: '薄膜沉积设备', aliases: ['ALD设备'], level1: '先进制造', level2: '半导体设备', segment: '薄膜沉积设备', chain_position: '上游设备' }],
    academicInstitutions: [{ canonical_name: '清华大学', aliases: ['清华'], institution_type: '高校' }],
  })
  const replay = buildLeadInvestmentProfileDictionaries({
    institutions: [
      { canonical_name: '国投创合', aliases: ['SDIC Ventures'], institution_type: '国资基金', tier: null, major: false },
      { canonical_name: '深创投', aliases: ['深圳创投', 'SCVC'], institution_type: '市场化VC/PE', tier: '一级', major: 1 },
    ],
    customers: [
      { canonical_name: '秘密客户', aliases: ['SecretCo'], tier: 'A', confidentiality: 'restricted' },
      { canonical_name: '宁德时代', aliases: ['CATL'], tier: 'A', confidentiality: 'public' },
    ],
    industries: [{ canonical_name: '薄膜沉积设备', aliases: ['ALD设备'], level1: '先进制造', level2: '半导体设备', segment: '薄膜沉积设备', chain_position: '上游设备' }],
    academicInstitutions: [{ canonical_name: '清华大学', aliases: ['清华'], institution_type: '高校' }],
  })
  assert.equal(replay.hash, first.hash)
  assert.equal(first.institutions.scvc?.canonicalName, '深创投')
  assert.equal(first.customers.catl?.tier, 'A')
  assert.equal(first.industries.ald设备?.level2, '半导体设备')
  assert.equal(first.academicInstitutions.清华?.canonicalName, '清华大学')
  const normalizedProfile = buildLeadInvestmentProfile({
    leadId: 'dictionary-normalization',
    facts: [
      fact('industry-alias', 'industry.segment', 'singleton', 'ALD设备'),
      fact('academic-alias', 'team.institution', 'founder', '清华'),
      fact('academic-relation', 'team.institution_relation', 'founder', '成果转化'),
      fact('restricted-customer', 'customer.name', 'customer-1', 'SecretCo'),
      fact('restricted-pilot', 'customer.pilot', 'customer-1', 'SecretCo试点'),
    ],
    dictionaries: first,
  })
  assert.deepEqual(normalizedProfile.industry, {
    level1: '先进制造', level2: '半导体设备', segment: '薄膜沉积设备', chainPosition: '上游设备',
  })
  assert.equal(normalizedProfile.academicLinks[0]?.institution, '清华大学')
  assert.equal(normalizedProfile.customers.verifiedCount, 0)
  assert.equal(normalizedProfile.customers.representatives[0]?.name, '某保密客户')
  assert.equal(normalizedProfile.customers.representatives[0]?.stage, 'L2')
  assert.match(normalizedProfile.customers.representatives[0]?.customerId ?? '', /^customer_[a-f0-9]{20}$/)
  assert.throws(() => buildLeadInvestmentProfileDictionaries({
    institutions: [
      { canonical_name: '机构甲', aliases: ['共同别名'], institution_type: '其他', tier: null, major: false },
      { canonical_name: '机构乙', aliases: ['共同别名'], institution_type: '其他', tier: null, major: false },
    ],
    customers: [],
  }), /dictionary alias collision/)
})
