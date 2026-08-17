import assert from 'node:assert/strict'
import test from 'node:test'
import { INVESTMENT_PROPOSAL_TABLE_COLUMNS } from '../src/services/aiInvestmentProposalBlueprintService.js'
import { investmentProposalSectionEvidenceContract } from '../src/services/aiInvestmentProposalEvidenceService.js'
import { hasInvestmentProposalNamedProductOrTechnology } from '../src/services/aiInvestmentProposalReviewerService.js'
import {
  sanitizeInvestmentProposalEvidenceContent,
  summarizeInvestmentProposalProductEvidence,
} from '../src/services/aiInvestmentProposalTextService.js'

test('investment proposal gives every leaf section an exact source-index contract', () => {
  const contract = investmentProposalSectionEvidenceContract({
    evidenceScope: 'project_knowledge_primary',
    sections: [
      {
        sectionId: 'company.product',
        sectionTitle: '（四）产品及技术',
        evidence: [],
        sourceIndexes: [2, 4],
        coverage: 'available',
      },
      {
        sectionId: 'company.financials',
        sectionTitle: '（六）财务摘要',
        evidence: [],
        sourceIndexes: [7],
        coverage: 'available',
      },
    ],
    usedSourceIndexes: [2, 4, 7],
    coverage: { totalLeafSections: 2, coveredLeafSections: 2, missingLeafSections: 0 },
  }, new Set(['company.product', 'company.financials']))

  assert.match(contract, /company\.product.+仅可引用：S2、S4/u)
  assert.match(contract, /company\.financials.+仅可引用：S7/u)
})

test('investment proposal table schemas expose the minimum reviewer-compatible columns', () => {
  assert.deepEqual(INVESTMENT_PROPOSAL_TABLE_COLUMNS.financial_summary, ['期间', '营业收入'])
  assert.deepEqual(INVESTMENT_PROPOSAL_TABLE_COLUMNS.equity_structure, ['股东名称', '持股比例'])
  assert.deepEqual(INVESTMENT_PROPOSAL_TABLE_COLUMNS.transaction_plan, ['投资方式', '投资金额'])
})

test('investment proposal recognizes named SaaS and module products', () => {
  const evidence = [
    'product：知行业务协同SaaS；delivery：专有云部署；maturity：正式商用V3.2。',
    'product：知行智能分析模块；delivery：作为SaaS插件在线开通；maturity：正式商用V2.1。',
  ].join('\n')
  const summary = summarizeInvestmentProposalProductEvidence(evidence).join('')
  assert.equal(hasInvestmentProposalNamedProductOrTechnology('知行业务协同SaaS已完成专有云部署。'), true)
  assert.equal(hasInvestmentProposalNamedProductOrTechnology('知行智能分析模块已正式商用。'), true)
  assert.match(summary, /知行业务协同SaaS/u)
  assert.match(summary, /知行智能分析模块/u)
})

test('investment proposal evidence removes fixture and source-process preambles', () => {
  const sanitized = sanitizeInvestmentProposalEvidenceContent([
    '使用边界：本资料仅用于隔离验收环境。',
    '本主档由营业执照、合同和回单逐项转录。',
    '相应原始凭证在本测试场景中视为已核对一致。',
    'product：知行业务协同SaaS；maturity：正式商用V3.2。',
  ].join('\n'), 8000)
  assert.doesNotMatch(sanitized, /隔离验收|本主档|原始凭证/u)
  assert.match(sanitized, /知行业务协同SaaS/u)
})
