import assert from 'node:assert/strict'
import test from 'node:test'
import { buildComplianceSkillContent } from '../src/services/aiDocumentSkillRenderService.js'

const findings = Array.from({ length: 7 }, (_, index) => ({
  text: `第${index + 1}项资料尚未确定，仍需核对相关证据和计算口径。`,
  status: '待核验' as const,
  sourceIndexes: [],
}))

test('authorized limited compliance draft has seven role-bound pending checks and conditional conclusion', () => {
  const payload = buildComplianceSkillContent({
    projectName: '大衍科技（新）', targetCompanyLegalName: '大衍科技（新）', company: '测试管理人', generatedAt: new Date('2026-09-08'),
    sources: [{ sourceType: 'project', sourceId: 'source-1', sourceName: '项目资料', content: '大衍科技（新）项目资料' }],
    deliveryReadiness: {
      status: 'proceed_with_available_materials', as_of_date: '2026-09-08',
      missing_decisive_inputs: ['基金协议'], blocking_issues: [],
      supplement_request: { requested: true, outcome: 'not_provided', requested_items: ['基金协议'] },
      continuation_authorization: { authorized: true, basis: 'explicit_user_instruction', instruction: '继续' },
      fund_agreement: { status: 'pending', source_ids: [] }, transaction_terms: { status: 'pending', source_ids: [] },
      return_investment: { status: 'pending', source_ids: [] }, concentration: { status: 'pending', source_ids: [] },
      related_party: { status: 'pending', source_ids: [] },
    } as any,
    content: {
      title: '合规说明', executiveSummary: '', highlights: [], risks: [], missing: ['基金协议'],
      sections: [
        { title: '公司简介', summary: '', findings: [] },
        { title: '核心团队', summary: '', findings: [{ text: '多人名单但无可靠相邻身份关系', status: '资料记载', sourceIndexes: [] }] },
        { title: '产品及技术', summary: '', findings: [] },
        { title: '投资理由', summary: '', findings: [] },
        { title: '投资计划', summary: '', findings: [] },
        { title: '投资情形分析', summary: '', findings },
        { title: '结论', summary: '', findings: [{ text: '无法形成结论', status: '待核验', sourceIndexes: [] }] },
      ],
    },
  }) as any
  const analysis = payload.sections.find((section: any) => section.heading === '投资情形分析')
  const numbered = analysis.blocks.filter((block: any) => block.type === 'numbered')
  assert.equal(numbered.length, 7)
  for (const block of numbered) assert.equal(block.status, 'pending')
  assert.match(numbered[0].text, /投资限制事项尚待确认/)
  assert.match(numbered[5].text, /投资集中度尚待确认/)
  assert.match(numbered[6].text, /其他法律监管事项尚待确认/)
  assert.doesNotMatch(numbered[6].text, /知识产权|数据合规|审批/)
  assert.match(analysis.blocks.at(-1).text, /条件下.*原则上符合.*仍需核验/)
  const company = payload.sections.find((section: any) => section.heading === '公司情况介绍')
  const intro = company.blocks.find((block: any) => block.type === 'paragraph')
  assert.match(intro.text, /^大衍科技（新），/)
  assert.doesNotMatch(intro.text, /实际控制人|股权架构/)
})
