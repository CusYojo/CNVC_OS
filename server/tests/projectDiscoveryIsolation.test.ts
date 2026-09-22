import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  canAssignProjectDiscoveryOwner,
  isProjectDiscoveryLead,
  isProjectDiscoverySourceKey,
  normalizeProjectDiscoveryKeywords,
} from '../src/services/projectDiscoveryScope.js'

test('project discovery accepts only migrated VC Hunter and future page uploads', () => {
  assert.equal(isProjectDiscoverySourceKey('vc-hunter:candidate-screenshot-123'), true)
  assert.equal(isProjectDiscoverySourceKey('bp-upload:123'), true)
  assert.equal(isProjectDiscoverySourceKey('batch-import:123'), false)
  assert.equal(isProjectDiscoverySourceKey('investment:123'), false)
  assert.equal(isProjectDiscoverySourceKey('radar:123'), false)
})

test('discovery mutations stay isolated to imported and manually uploaded records', () => {
  assert.equal(isProjectDiscoveryLead(['radar:old', 'vc-hunter:42']), true)
  assert.equal(isProjectDiscoveryLead(['radar:old', 'investment:42']), false)
  assert.equal(isProjectDiscoveryLead(undefined), false)
})

test('editable discovery keywords are normalized and bounded at the API boundary', () => {
  assert.deepEqual(normalizeProjectDiscoveryKeywords([
    { kind: 'institution', label: ' 机构 ', value: '  星河创投  ' },
    { kind: 'technology', label: '技术', value: '端侧 AI' },
  ]), [
    { kind: 'institution', label: '机构', value: '星河创投' },
    { kind: 'technology', label: '技术', value: '端侧 AI' },
  ])
  assert.throws(() => normalizeProjectDiscoveryKeywords([
    { kind: 'other', label: '其他', value: '越权分类' },
  ]), /关键词类型/)
  assert.throws(() => normalizeProjectDiscoveryKeywords(Array.from({ length: 9 }, (_, index) => ({
    kind: 'industry', label: '产业', value: `关键词${index}`,
  }))), /最多保留/)
})

test('owner delegation requires project classification or system management permission', () => {
  assert.equal(canAssignProjectDiscoveryOwner('actor', 'actor', []), true)
  assert.equal(canAssignProjectDiscoveryOwner('actor', 'owner', []), false)
  assert.equal(canAssignProjectDiscoveryOwner('actor', 'owner', ['project.classify']), true)
  assert.equal(canAssignProjectDiscoveryOwner('actor', 'owner', ['system.manage']), true)
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
  assert.match(routes, /get\('\/project-discovery\/assignment-options'/)
  assert.match(routes, /patch\('\/project-discovery\/leads\/:id\/keywords'/)
  assert.match(routes, /post\('\/project-discovery\/leads\/:id\/defer'/)
  assert.match(routes, /projectDiscoveryOnly:\s*true/)
  assert.match(leadService, /JSON_SEARCH\(/, '生产 MySQL 应直接匹配 radar_source_keys JSON 数组')
  assert.doesNotMatch(leadService, /JSON_TABLE\([\s\S]{0,300}project_discovery_source/, '发现池筛选不得使用当前生产库不兼容的 JSON_TABLE 路径')
  assert.match(leadService, /projectDiscoveryOnly \? visibleProjectDiscoveryLeadExpr : visiblePublicLeadExpr/, 'VC Hunter 迁移项目不得再次被共享池噪音规则排除')
  assert.match(leadService, /Boolean\(options\.projectDiscoveryOnly\) \|\| leadPoolCandidateDataEnabled\(\)/, '发现页必须直接返回已迁移候选字段，不受共享线索池展示开关影响')
})
