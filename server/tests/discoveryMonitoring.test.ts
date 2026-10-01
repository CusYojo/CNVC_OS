import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDiscoveryMonitoringPlans, redactDiscoveryMonitoringPlans } from '../src/contracts/discoveryMonitoringContract.js'

test('monitoring plans distinguish runnable public sources from unavailable connectors', () => {
  const plans = buildDiscoveryMonitoringPlans([
    { id: 'news', kind: 'public-source', group: '创投新闻', name: '融资快报', enabled: true, config: { type: 'rss', url: 'https://example.com/feed' } },
    { id: 'manual', kind: 'public-source', group: '创投新闻', name: '人工参考', enabled: false, config: { type: 'manual', url: 'https://example.com' } },
    { id: 'licensed', kind: 'public-source', group: '创投新闻', name: '授权接口', enabled: false, config: { type: 'licensed_api', url: 'https://example.com/api' } },
  ])
  assert.equal(plans.length, 4)
  assert.equal(plans[0]?.key, 'venture-tech')
  assert.equal(plans[0]?.enabled, true)
  assert.deepEqual(plans[0]?.sourceIds, ['news'])
  assert.equal(plans[1]?.ready, false)
  assert.equal(plans[2]?.ready, false)
  assert.equal(plans[3]?.ready, false)
})

test('a paused Radar scheduler cannot be represented as an active monitor', () => {
  const [plan] = buildDiscoveryMonitoringPlans([
    { id: 'news', kind: 'public-source', group: '创投新闻', name: '融资快报', enabled: true, config: { type: 'rss', url: 'https://example.com/feed' } },
  ], false)
  assert.equal(plan?.schedulerEnabled, false)
  assert.equal(plan?.ready, false)
  assert.equal(plan?.enabled, false)
  assert.equal(plan?.activeSourceCount, 1)
})

test('monitoring responses do not leak source credentials or operational errors', () => {
  const plans = buildDiscoveryMonitoringPlans([
    { id: 'news', kind: 'public-source', group: '创投新闻', name: '融资快报', enabled: true,
      config: { type: 'rss', url: 'https://example.com/feed?token=secret', note: 'private' }, lastError: 'token=secret failed' },
  ])
  const serialized = JSON.stringify(redactDiscoveryMonitoringPlans(plans))
  assert.doesNotMatch(serialized, /secret|example\.com|lastError/)
  assert.match(serialized, /融资快报/)
})
