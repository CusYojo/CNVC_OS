import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildInvestmentRecommendationDetailContext,
  type EvidenceSource,
} from '../src/services/aiBusinessContentService.js'

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
})
