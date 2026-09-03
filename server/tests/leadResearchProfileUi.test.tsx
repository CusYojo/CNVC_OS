import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

test('lead pool uses adaptive neutral columns and a dedicated research row', async () => {
  const source = await readFile(new URL('../../src/pages/SourcingPage.tsx', import.meta.url), 'utf8')
  for (const heading of ['方向 / 产品', '团队 / 机构', '进展 / 阶段', '价值 / 转化']) assert.ok(source.includes(heading), heading)
  assert.match(source, /function ResearchLeadRow/)
  const researchRow = source.slice(source.indexOf('function ResearchLeadRow'))
  assert.doesNotMatch(researchRow, /financing|valuation|customer/i)
  assert.doesNotMatch(researchRow, /待核验|联网候选|已有资料/)
})
