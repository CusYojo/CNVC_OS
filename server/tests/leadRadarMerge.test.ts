import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRadarLeadMergePatch } from '../src/services/leadRadarMerge.js'

test('merges stable Radar source keys without losing earlier articles', () => {
  const patch = buildRadarLeadMergePatch({
    name: '测试项目',
    source: '项目发现雷达 · 36氪',
    radarSourceKeys: ['investment:article-1'],
  }, {
    name: '测试项目',
    source: '项目发现雷达 · 36氪',
    radarSourceKeys: ['investment:article-2'],
  })

  assert.deepEqual(patch.radarSourceKeys, [
    'investment:article-1',
    'investment:article-2',
  ])
})

test('does not write a patch for an already linked Radar source key', () => {
  const patch = buildRadarLeadMergePatch({
    name: '测试项目',
    source: '项目发现雷达 · 36氪',
    radarSourceKeys: ['investment:article-1'],
  }, {
    name: '测试项目',
    source: '项目发现雷达 · 36氪',
    radarSourceKeys: ['investment:article-1'],
  })

  assert.equal('radarSourceKeys' in patch, false)
})

test('upgrades business region only when incoming confidence is not lower', () => {
  const protectedPatch = buildRadarLeadMergePatch({
    name: '测试项目',
    source: '项目发现雷达 · 高校公众号',
    businessRegion: '广东',
    businessRegionSource: '工商注册地',
    businessRegionConfidence: '高',
  }, {
    name: '测试项目',
    source: '项目发现雷达 · 高校公众号',
    businessRegion: '浙江',
    businessRegionSource: '所属高校/研究机构',
    businessRegionConfidence: '中',
  })
  assert.equal('businessRegion' in protectedPatch, false)

  const upgradePatch = buildRadarLeadMergePatch({
    name: '测试项目',
    source: '项目发现雷达 · 高校公众号',
    businessRegion: '浙江',
    businessRegionSource: '所属高校/研究机构',
    businessRegionConfidence: '中',
  }, {
    name: '测试项目',
    source: '项目发现雷达 · 高校公众号',
    businessRegion: '广东',
    businessRegionSource: '工商注册地',
    businessRegionConfidence: '高',
  })
  assert.equal(upgradePatch.businessRegion, '广东')
  assert.equal(upgradePatch.businessRegionConfidence, '高')
})
