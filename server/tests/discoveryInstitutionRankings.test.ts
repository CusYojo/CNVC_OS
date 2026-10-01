import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DISCOVERY_INSTITUTION_RANKINGS,
  lookupDiscoveryInstitutionRanking,
  normalizeDiscoveryInstitutionName,
} from '../src/data/discoveryInstitutionRankings.js'

test('published 2025 VC ranking boundaries use the stated score bands', () => {
  const cases = [
    ['IDG资本', 1, 90],
    ['国中资本', 30, 90],
    ['黑蚁资本', 31, 80],
    ['创东方投资', 50, 80],
    ['国科嘉和', 51, 70],
    ['天鹰资本', 100, 70],
  ] as const
  for (const [name, rank, score] of cases) {
    assert.deepEqual(lookupDiscoveryInstitutionRanking(name), {
      rank, category: 'VC', year: 2025,
      sourceUrl: 'https://www.chinaventure.com.cn/rank/210/3182.html', score,
    })
  }
})

test('published 2025 PE ranking boundaries use the stated score bands', () => {
  const cases = [
    ['红杉中国', 1, 90],
    ['云晖资本', 30, 90],
    ['元禾璞华', 31, 80],
    ['盛世投资', 50, 80],
    ['广州产投资本', 51, 70],
    ['国金鼎兴', 100, 70],
  ] as const
  for (const [name, rank, score] of cases) {
    assert.deepEqual(lookupDiscoveryInstitutionRanking(name), {
      rank, category: 'PE', year: 2025,
      sourceUrl: 'https://www.chinaventure.com.cn/rank/210/3183.html', score,
    })
  }
})

test('normalization is narrow and never fuzzy-guesses an institution', () => {
  assert.equal(lookupDiscoveryInstitutionRanking('  IDG 资本  ')?.rank, 1)
  assert.equal(lookupDiscoveryInstitutionRanking('浦东科创／海望资本')?.rank, 25)
  assert.equal(lookupDiscoveryInstitutionRanking('建信(北京)投资')?.rank, 56)
  assert.equal(lookupDiscoveryInstitutionRanking('LCatterton路威凯腾')?.rank, 97)
  assert.equal(normalizeDiscoveryInstitutionName('L Catterton路威凯腾'), 'LCatterton路威凯腾')
  assert.equal(lookupDiscoveryInstitutionRanking('IDG') , null)
  assert.equal(lookupDiscoveryInstitutionRanking('深创投'), null)
  assert.equal(lookupDiscoveryInstitutionRanking(''), null)
  assert.equal(lookupDiscoveryInstitutionRanking('不在榜机构'), null)
})

test('catalog contains a complete, uniquely numbered 100-name list per category', () => {
  assert.equal(DISCOVERY_INSTITUTION_RANKINGS.length, 200)
  for (const category of ['VC', 'PE']) {
    const rows = DISCOVERY_INSTITUTION_RANKINGS.filter((item) => item.category === category)
    assert.deepEqual(rows.map((item) => item.rank), Array.from({ length: 100 }, (_, index) => index + 1))
    assert.equal(new Set(rows.map((item) => item.name)).size, 100)
    assert.ok(rows.every((item) => item.year === 2025 && item.sourceUrl.startsWith('https://')))
  }
})
