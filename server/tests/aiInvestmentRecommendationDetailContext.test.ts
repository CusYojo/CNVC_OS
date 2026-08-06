import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildInvestmentRecommendationDetailContext,
  finalizeInvestmentRecommendationPptContent,
  investmentRecommendationContentQualityIssues,
  type EvidenceSource,
} from '../src/services/aiBusinessContentService.js'
import { AI_TEMPLATE_CATALOG } from '../src/services/aiTemplateCatalog.js'

test('investment PPT context carries company, team, finance, funding, valuation and deal details', () => {
  const sources: EvidenceSource[] = [
    {
      sourceType: 'file',
      sourceName: '财务模型.xlsx',
      sourceId: 'financial-model',
      chunkIndex: 12,
      content: '2025年度营业收入为3,200万元，毛利率为48%，净利润为260万元；经营现金流为负500万元。',
    },
    {
      sourceType: 'file',
      sourceName: '融资及交易方案.docx',
      sourceId: 'deal-plan',
      chunkIndex: 4,
      content: '本轮融资金额5,000万元，投前估值3亿元；拟以增资方式投资2,000万元，交割后持股比例6.25%，并设置反稀释和董事席位条款。',
    },
  ]

  const context = buildInvestmentRecommendationDetailContext({
    name: '智灵动力',
    companyName: '浙江智灵动力科技有限公司',
    industry: '具身智能',
    round: 'A轮',
    stage: '立项',
    summary: '面向工业场景提供具身智能机器人。',
    businessModel: '机器人本体销售与RaaS服务。',
    market: '工业制造与仓储物流。',
    team: '创始人负责产品与商业化，CTO负责机器人控制与算法。',
    financing: '本轮计划融资5,000万元。',
    valuation: '投前估值3亿元。',
  }, sources, {
    investmentAmount: '2,000万元',
    transactionTerms: '增资、反稀释、董事席位',
  })

  for (const heading of [
    '公司简介与主体',
    '核心团队与治理',
    '财务与经营数据',
    '融资情况',
    '估值依据',
    '交易方案与关键条款',
  ]) {
    assert.match(context, new RegExp(`### ${heading}`))
  }
  assert.match(context, /浙江智灵动力科技有限公司/)
  assert.match(context, /CTO负责机器人控制与算法/)
  assert.match(context, /2025年度营业收入为3,200万元/)
  assert.match(context, /本轮计划融资5,000万元/)
  assert.match(context, /投前估值3亿元/)
  assert.match(context, /拟投资金额：2,000万元/)
  assert.match(context, /\[S0\] 财务模型\.xlsx \/ 片段12/)
  assert.match(context, /\[S1\] 融资及交易方案\.docx \/ 片段4/)
  assert.doesNotMatch(context, /项目阶段|项目来源|项目负责人/)
})

test('investment PPT removes internal stage metadata and AI-style narration before delivery', () => {
  const template = AI_TEMPLATE_CATALOG.investment_recommendation_ppt
  const sections = template.sections.map((title, index) => ({
    title,
    summary: index === 0
      ? '项目具备继续推进价值，但仍处线索阶段，亮点成立依赖后续核验。'
      : `${title}涉及的公司、产品、客户或交易事实需要按本页职责说明。`,
    findings: [{
      text: index === 1
        ? '项目档案登记主体为“大衍科技有限公司”，项目资料多处指向“大衍科技（桐乡）有限公司”，主体名称需在正式交易文件中统一。'
        : `${title}的关键事实应以公司、客户、财务科目或交易条款为主语直接陈述。`,
      status: '资料记载' as const,
      sourceIndexes: [0],
    }],
    tables: [],
  }))
  const finalized = finalizeInvestmentRecommendationPptContent({
    title: '大衍科技投资建议书',
    executiveSummary: '综合当前项目阶段与可核验事实，建议提交投决。大衍科技项目当前处于线索阶段，项目档案登记主体为“大衍科技有限公司”，项目资料多处指向“大衍科技（桐乡）有限公司”。基于已提供材料，公司资料显示其围绕真实数据采集、合成数据生成和物理仿真形成闭环产品组合，客户合同、回款及本轮交易条款尚待核实。',
    sections,
    highlights: ['项目亮点集中在赛道窗口、产品闭环和早期商业化。'],
    risks: ['资料记载，客户合同、验收和回款需要重点核对。'],
    missing: [],
  }, template, {
    name: '大衍科技',
    companyName: '大衍科技（桐乡）有限公司',
    industry: '具身智能',
    stage: '线索',
  })
  const visibleText = [
    finalized.title,
    finalized.executiveSummary,
    ...finalized.sections.flatMap((section) => [
      section.title,
      section.summary,
      ...section.findings.map((finding) => finding.text),
    ]),
    ...finalized.highlights,
    ...finalized.risks,
  ].join(' ')
  assert.doesNotMatch(visibleText, /项目阶段|线索阶段|进入初筛|申请立项|启动尽调|提请上会|提交投决|继续跟踪|暂缓推进|归档建议/)
  assert.doesNotMatch(visibleText, /项目档案|项目资料|可核验事实|资料记载|AI\s*(?:辅助|生成|初稿)/i)
  assert.doesNotMatch(visibleText, /赛道窗口|早期窗口|形成闭环产品组合|项目具备继续推进价值|亮点成立依赖/)
  assert.deepEqual(finalized.sections.map((section) => section.title), [
    '投资摘要',
    '公司概况与发展历程',
    '股权结构与核心团队',
    '产品与核心技术',
    '商业模式与客户验证',
    '行业与市场空间',
    '竞争格局与差异化',
    '财务分析',
    '融资与估值',
    '投资方案',
    '核心投资逻辑',
    '主要风险与待落实事项',
  ])
  const qualityIssues = investmentRecommendationContentQualityIssues(
    finalized,
    template.sections.length,
  )
  assert.equal(
    qualityIssues.some((issue) => /项目阶段|资料处理|模型化套话/.test(issue)),
    false,
    qualityIssues.join('；'),
  )
  assert.ok(
    qualityIssues.some((issue) => /信息密度不足|内容过少|占位/.test(issue)),
    '样例正文只有通用句，专业性门禁应要求补充章节事实与数据',
  )
})
