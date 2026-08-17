import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auditableTaskSourceIndexes,
  auditableTaskSources,
  investmentRecommendationReviewProjectName,
  screenEvidenceSources,
} from '../src/services/aiTaskService.js'

const sources = [
  { sourceType: 'project_record', sourceName: '项目档案', content: '项目名称：测试项目' },
  { sourceType: 'project_file', sourceName: '商业计划书', content: '客户与产品信息' },
]

test('AI task source audit preserves explicit used sources', () => {
  assert.deepEqual(auditableTaskSourceIndexes([1, 1], sources), [1])
})

test('AI task source audit records project master data when generated content has no citations', () => {
  assert.deepEqual(auditableTaskSourceIndexes([], sources), [0])
})

test('AI task source audit does not invent a source when no project record exists', () => {
  assert.deepEqual(auditableTaskSourceIndexes([], sources.slice(1)), [])
})

test('AI task source audit retains the raw project record when evidence screening removes it', () => {
  assert.deepEqual(auditableTaskSources([], [], sources).map((source) => source.sourceName), ['项目档案'])
})

test('due diligence evidence screening keeps a complete medium-sized primary document', () => {
  const sections = [
    '工商登记与主体沿革记录了成立日期、注册资本和历次名称变更。',
    '股权结构与实际控制人章节记录了全部股东、持股比例和表决权安排。',
    '核心团队章节记录了创始人、研发负责人和销售负责人的完整履历。',
    '产品矩阵章节记录了平台软件、行业模块和交付工具的定价及毛利。',
    '客户闭环章节记录了签约主体、合同金额、验收状态和回款进度。',
    '收入分析章节记录了软件许可、实施服务和运维订阅的年度构成。',
    '竞争格局章节记录了三家可比企业的产品边界、价格和渠道差异。',
    '合规核查章节记录了资质证照、数据安全制度和重大诉讼查询结果。',
    '投资结论章节记录了估值条件、交割前提和需要持续跟踪的风险。',
  ].map((content, chunkIndex) => ({
    sourceType: 'project_file',
    sourceId: 'primary-dd-file',
    sourceName: '尽调主资料.md',
    chunkIndex,
    content,
  }))

  assert.equal(screenEvidenceSources(sections, 'due_diligence_report').usable.length, sections.length)
  assert.equal(screenEvidenceSources(sections, 'custom_template_document').usable.length, 4)
})

test('investment recommendation reviewer uses the company subject before the project alias', () => {
  assert.equal(investmentRecommendationReviewProjectName({
    name: 'AI API 验收项目',
    companyName: '杭州脱敏验收科技有限公司',
  }), '杭州脱敏验收科技有限公司')
  assert.equal(investmentRecommendationReviewProjectName({
    name: 'AI API 验收项目',
    companyName: '  ',
  }), 'AI API 验收项目')
})
