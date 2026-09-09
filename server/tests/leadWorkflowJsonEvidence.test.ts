import test from 'node:test'
import assert from 'node:assert/strict'
import { validateLeadWorkflowAgentOutput } from '../src/services/leadWorkflowAgentService.js'

const quote = '企业完成融资。\n资金用于“扩产”。'
const output = (sourceId: string, evidence = quote) => ({ summary: '融资情况', facts: [{
  claim: '资金用于扩产', quote: evidence, sourceId, sourceUrl: '', reliability: 'unknown', verificationStatus: 'unverified',
}], conflicts: [], gaps: [] })
const prompt = '唯一输入：\n' + JSON.stringify({ sources: [{ sourceId: 'source-a', articleText: quote }, { sourceId: 'source-b', articleText: '其他公司的报道。' }] })
test('exact quotes in JSON source content survive JSON newline escaping', () => {
  assert.doesNotThrow(() => validateLeadWorkflowAgentOutput('lead-research-agent', output('source-a'), prompt))
})
test('decoded JSON quotes must still belong to declared source and cannot be invented', () => {
  assert.throws(() => validateLeadWorkflowAgentOutput('lead-research-agent', output('source-b'), prompt))
  assert.throws(() => validateLeadWorkflowAgentOutput('lead-research-agent', output('source-a', '企业融资一百亿元'), prompt))
})
