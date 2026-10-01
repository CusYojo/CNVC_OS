import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { projectDiscoveryLeadsQuery } from '../src/contracts/leadPoolQueryContract.js'

test('discovery query validates period, industry, region, type, keyword and sort before database access', () => {
  assert.deepEqual(projectDiscoveryLeadsQuery.parse({}), { page: 1, pageSize: 50 })
  assert.deepEqual(projectDiscoveryLeadsQuery.parse({
    period: 'week', industry: '航空航天', region: '上海', sort: 'score', leadType: 'company', keyword: '火箭',
  }), {
    page: 1, pageSize: 50, period: 'week', industry: '航空航天', region: '上海', sort: 'score', leadType: 'company', keyword: '火箭',
  })
  for (const invalid of [
    { period: 'future' }, { sort: 'valuation' }, { industry: '%' }, { region: '火星' },
    { keyword: 'x'.repeat(101) }, { leadType: 'other' }, { unexpected: 'value' },
  ]) assert.equal(projectDiscoveryLeadsQuery.safeParse(invalid).success, false, JSON.stringify(invalid))
})

test('discovery list retains bounded news source URLs and filters before server pagination', async () => {
  const source = await readFile(new URL('../src/services/aiSummaryService.ts', import.meta.url), 'utf8')
  assert.equal(/sourceUrl:\s*item\.sourceUrl/.test(source), true)
  assert.equal(/options\.projectDiscoveryOnly\s*&&\s*options\.period/.test(source), true)
  assert.equal(/options\.projectDiscoveryOnly\s*&&\s*options\.sort === 'score'/.test(source), true)
})
