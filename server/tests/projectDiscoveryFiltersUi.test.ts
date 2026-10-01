import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('discovery requests server-side period, type, industry, region, search and sort before pagination', async () => {
  const page = await read('src/pages/ProjectDiscoveryPage.tsx')

  for (const parameter of ['period', 'leadType', 'industry', 'region', 'keyword', 'sort']) {
    assert.match(page, new RegExp(`params\\.set\\('${parameter}'`), `${parameter} must be sent to the API`)
  }
  assert.match(page, /sort: 'latest' \| 'funding' \| 'score'/)
  assert.doesNotMatch(page, /filterProjectDiscoveryCandidates\(candidates/, 'browser filtering would reorder or hide server-ranked pages')
  assert.match(page, /pagination\.page < pagination\.totalPages/, 'additional pages should remain available')
})

test('every discovery card shows sourced reporting or an explicit missing-evidence state', async () => {
  const page = await read('src/pages/ProjectDiscoveryPage.tsx')

  assert.match(page, /latestUpdates\?\.\[0\]\?\.sourceUrl/)
  assert.match(page, /radarProfile\?\.link/)
  assert.match(page, /暂无可核验报道/)
  assert.match(page, /target="_blank" rel="noopener noreferrer"/)
  assert.match(page, /url\.protocol === 'https:' \|\| url\.protocol === 'http:'/)
})

test('discovery rating stays adjacent to financing date and exposes evidence-backed dimensions', async () => {
  const [page, css, types] = await Promise.all([
    read('src/pages/ProjectDiscoveryPage.tsx'),
    read('src/pages/ProjectDiscoveryPage.css'),
    read('src/types/index.ts'),
  ])

  assert.match(page, /project-discovery-card-header[\s\S]*project-discovery-card-date[\s\S]*project-discovery-card-score[\s\S]*<\/header>/)
  assert.match(page, /discoveryScore\?\.dimensions/)
  assert.match(page, /综合评分/)
  assert.match(page, /信息不足|待评分/)
  assert.match(css, /\.project-discovery-card-score/)
  assert.match(types, /discoveryScore\?:/)
})
