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
