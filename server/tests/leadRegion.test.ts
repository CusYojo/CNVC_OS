import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeBusinessRegion,
  resolveLeadBusinessRegion,
} from '../src/services/leadRegion.js'

test('normalizes city-level addresses to province-level business regions', () => {
  assert.equal(normalizeBusinessRegion('深圳市南山区科技园'), '广东')
  assert.equal(normalizeBusinessRegion('南京市江北新区研创园'), '江苏')
  assert.equal(normalizeBusinessRegion('厦门市思明区宜兰路7号'), '福建')
  assert.equal(normalizeBusinessRegion('合肥市高新区创新大道'), '安徽')
})

test('prefers verified registry location over weaker project context', () => {
  assert.deepEqual(resolveLeadBusinessRegion({
    registry: { registeredAddress: '深圳市南山区科技园' },
    profile: { affiliatedInstitutions: '浙江大学' },
    sourceGroup: '高校公众号',
  }), {
    region: '广东',
    source: '工商注册地',
    confidence: '高',
  })
})

test('derives academic project region from its institution', () => {
  assert.deepEqual(resolveLeadBusinessRegion({
    subjectName: '清华大学智能机器人实验室',
    profile: { affiliatedInstitutions: '清华大学' },
    sourceGroup: '高校公众号',
  }), {
    region: '北京',
    source: '所属高校/研究机构',
    confidence: '中',
  })
})

test('prefers the subject administrative prefix over collaborator institutions', () => {
  assert.deepEqual(resolveLeadBusinessRegion({
    subjectName: '武汉中科牛津波谱技术有限公司',
    profile: {
      region: '陕西',
      regionSource: '所属高校/研究机构',
      regionConfidence: '中',
      affiliatedInstitutions: '西安交通大学',
    },
    sourceGroup: '高校公众号',
  }), {
    region: '湖北',
    source: '主体名称行政区划',
    confidence: '中',
  })
})

test('allows concrete subject evidence to correct a medium-confidence stored region', () => {
  assert.deepEqual(resolveLeadBusinessRegion({
    businessRegion: '陕西',
    businessRegionSource: '所属高校/研究机构',
    businessRegionConfidence: '中',
    subjectName: '武汉中科牛津波谱技术有限公司',
  }), {
    region: '湖北',
    source: '主体名称行政区划',
    confidence: '中',
  })
})

test('uses only explicit location sentences and ignores casual city mentions', () => {
  assert.equal(resolveLeadBusinessRegion({
    subjectName: '某智能项目',
    summary: '团队受邀前往上海参加行业会议，并与北京投资机构交流。',
  }), undefined)
  assert.deepEqual(resolveLeadBusinessRegion({
    subjectName: '某智能项目',
    summary: '某智能项目公司总部位于深圳市南山区，主要从事工业软件研发。',
  }), {
    region: '广东',
    source: '来源原文明确地点',
    confidence: '中',
  })
})

test('does not infer Ningxia from a founder name or a team label containing Yinchuan', () => {
  assert.equal(resolveLeadBusinessRegion({ subjectName: '银川团队' }), undefined)
  assert.equal(resolveLeadBusinessRegion({ subjectName: '创始人李银川' }), undefined)
})

test('explicit company location can correct a polluted medium-confidence profile region', () => {
  assert.deepEqual(resolveLeadBusinessRegion({
    subjectName: '诺因智能',
    profile: { region: '宁夏', regionSource: '所属高校/研究机构', regionConfidence: '中' },
    articleText: '诺因智能公司总部位于深圳市南山区，团队专注家庭具身智能产品。',
  }), {
    region: '广东',
    source: '来源原文明确地点',
    confidence: '中',
  })
})
