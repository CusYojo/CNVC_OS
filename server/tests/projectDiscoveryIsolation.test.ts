import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isProjectDiscoverySourceKey } from '../src/services/projectDiscoveryScope.js'

test('project discovery accepts only migrated VC Hunter and future page uploads', () => {
  assert.equal(isProjectDiscoverySourceKey('vc-hunter:candidate-screenshot-123'), true)
  assert.equal(isProjectDiscoverySourceKey('bp-upload:123'), true)
  assert.equal(isProjectDiscoverySourceKey('batch-import:123'), false)
  assert.equal(isProjectDiscoverySourceKey('investment:123'), false)
  assert.equal(isProjectDiscoverySourceKey('radar:123'), false)
})

test('project discovery uses an isolated endpoint instead of the shared lead pool endpoint', async () => {
  const [page, routes, leadService] = await Promise.all([
    readFile(new URL('../../src/pages/ProjectDiscoveryPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/meta.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/aiSummaryService.ts', import.meta.url), 'utf8'),
  ])
  assert.match(page, /\/project-discovery\/leads/)
  assert.doesNotMatch(page, /fetchLeads\(/)
  assert.match(routes, /get\('\/project-discovery\/leads'/)
  assert.match(routes, /projectDiscoveryOnly:\s*true/)
  assert.match(leadService, /JSON_SEARCH\(/, '生产 MySQL 应直接匹配 radar_source_keys JSON 数组')
  assert.doesNotMatch(leadService, /JSON_TABLE\([\s\S]{0,300}project_discovery_source/, '发现池筛选不得使用当前生产库不兼容的 JSON_TABLE 路径')
  assert.match(leadService, /projectDiscoveryOnly \? visibleProjectDiscoveryLeadExpr : visiblePublicLeadExpr/, 'VC Hunter 迁移项目不得再次被共享池噪音规则排除')
  assert.match(leadService, /Boolean\(options\.projectDiscoveryOnly\) \|\| leadPoolCandidateDataEnabled\(\)/, '发现页必须直接返回已迁移候选字段，不受共享线索池展示开关影响')
})
