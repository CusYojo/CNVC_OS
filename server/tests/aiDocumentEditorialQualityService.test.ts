import assert from 'node:assert/strict'
import test from 'node:test'
import type { BusinessContent } from '../src/services/aiBusinessContentService.js'
import {
  professionalizeDocumentText,
  reviewBusinessDocumentEditorialQuality,
  sanitizeBusinessContentForDelivery,
} from '../src/services/aiDocumentEditorialQualityService.js'
import { composeProjectQaStructuredAnswer } from '../src/services/aiQaPipelineService.js'

function content(sections: BusinessContent['sections']): BusinessContent {
  return {
    title: '测试项目投资提案',
    executiveSummary: '',
    sections,
    highlights: [],
    risks: [],
    missing: [],
  }
}

test('交付前清洗删除跨章节近重复和残缺编号', () => {
  const result = sanitizeBusinessContentForDelivery(content([
    {
      title: '产品',
      summary: '',
      findings: [{
        text: '公司已完成样机开发，并在真实客户环境开展产品验证。',
        status: '资料记载',
        sourceIndexes: [0],
      }],
      tables: [],
    },
    {
      title: '客户',
      summary: '',
      findings: [
        {
          text: '公司已经完成样机开发，并在真实客户环境开展产品验证。',
          status: '资料记载',
          sourceIndexes: [0],
        },
        {
          text: '现金流与估值规划 1、；',
          status: 'AI推断',
          sourceIndexes: [0],
        },
      ],
      tables: [],
    },
  ]))

  assert.equal(result.sections[0].findings.length, 1)
  assert.equal(result.sections[1].findings.length, 0)
})

test('交付前清洗修复紧贴标题和全角括号的空编号且保留有效正文', () => {
  assert.equal(
    professionalizeDocumentText(
      '现金流与估值规划1、；老股东拟提供1000万元借款，可保障半年内无融资情况下的现金流安全。1、；',
    ),
    '现金流与估值规划：老股东拟提供1000万元借款，可保障半年内无融资情况下的现金流安全。',
  )
  assert.equal(
    professionalizeDocumentText(
      '投后与风控场景（1）；该风控功能自动抓取全网公开数据，覆盖舆情、经营、法律、财务四大风险维度，（1）；',
    ),
    '投后与风控场景：该风控功能自动抓取全网公开数据，覆盖舆情、经营、法律、财务四大风险维度。',
  )
})

test('全篇门禁识别未解释的估值冲突和内部流程词', () => {
  const issues = reviewBusinessDocumentEditorialQuality(content([
    {
      title: '融资与估值',
      summary: '',
      findings: [
        { text: '公司本轮投前估值为1亿元。', status: '资料记载', sourceIndexes: [0] },
        { text: '项目计划按10亿元估值推进，并通过OA流程提交。', status: '资料记载', sourceIndexes: [1] },
      ],
      tables: [],
    },
  ]))

  assert.ok(issues.some((issue) => issue.code === 'FINANCIAL_FACT_CONFLICT'))
  assert.ok(issues.some((issue) => issue.code === 'INTERNAL_WORKFLOW_LEAK'))
})

test('正文专业化删除 AI 式开场并隐藏 OA 术语', () => {
  assert.equal(
    professionalizeDocumentText('综合来看，公司完成产品验证，后续通过OA审批。'),
    '公司完成产品验证，后续提交审批。',
  )
})

test('Q&A 优先使用模型直接写成的 answer，不再拼接固定字段', () => {
  const answer = composeProjectQaStructuredAnswer({
    answer: '公司已完成首轮客户验证，但尚未形成可重复交付。\n下一步应核对验收和回款记录。',
    directAnswer: '不应使用这段旧字段。',
  }, {
    id: 'Q001',
    category: '客户与商业化',
    question: '商业化进展如何？',
    priority: '高',
    intent: '判断商业化进展',
  })

  assert.match(answer, /首轮客户验证/)
  assert.doesNotMatch(answer, /旧字段/)
})
