import assert from 'node:assert/strict'
import test from 'node:test'
import type { BusinessContent } from '../src/services/aiBusinessContentService.js'
import {
  professionalizeDocumentText,
  reviewBusinessDocumentEditorialQuality,
  sanitizeBusinessContentForDelivery,
} from '../src/services/aiDocumentEditorialQualityService.js'
import {
  answerHasSufficientDepth,
  compactProjectQaQuestion,
  composeProjectQaStructuredAnswer,
  PROJECT_QA_QUESTION_MAX_CHARACTERS,
  type ProjectQaGeneratedQuestion,
} from '../src/services/aiQaPipelineService.js'
import { sanitizeInvestmentProposalClientText } from '../src/services/aiInvestmentProposalTextService.js'

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

test('正文专业化修复英文缩写、连字符技术名和 Markdown 标记', () => {
  assert.equal(
    professionalizeDocumentText('**执行摘要**：AI- Core- Tech 由负责人 C OO 推进 4 D 产品化。'),
    '执行摘要：AI-Core-Tech 由负责人 COO 推进 4D 产品化。',
  )
})

test('正文专业化清除 PDF 页眉、目录和多级章节编号残片', () => {
  assert.equal(
    professionalizeDocumentText('39 06 丨机会与风险总结 6.2.5 行业生态与标准缺失的风险。'),
    '行业生态与标准缺失的风险。',
  )
  assert.equal(
    professionalizeDocumentText('目录 AI-Core-Tech 公司介绍 市场预期 融资发展 目录 02 03 04 公司概况 核心团队'),
    '',
  )
})

test('全篇门禁识别来源版式残片、Markdown 和异常英文空格', () => {
  const issues = reviewBusinessDocumentEditorialQuality(content([{
    title: '执行摘要',
    summary: '',
    findings: [{
      text: '**39 06 丨机会与风险总结 6.2.5 AI- Core- Tech 由 C OO 负责。**',
      status: '资料记载',
      sourceIndexes: [0],
    }],
    tables: [],
  }]))
  assert.ok(issues.some((issue) => issue.code === 'MARKDOWN_LEAK'))
  assert.ok(issues.some((issue) => issue.code === 'SOURCE_LAYOUT_FRAGMENT'))
  assert.ok(issues.some((issue) => issue.code === 'BROKEN_LATIN_TOKEN'))
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

test('Q&A 将多重长问题压缩为单一投委会问题', () => {
  const compact = compactProjectQaQuestion(
    '公司当前产品已经进入哪些客户场景、每个场景的交付和回款是否完成；如果核心客户不再续约，单位经济性和现金流安全边际将如何变化，哪些指标会直接改变投资判断？',
  )
  assert.ok(compact.length <= PROJECT_QA_QUESTION_MAX_CHARACTERS)
  assert.ok(compact.endsWith('？'))
  assert.equal((compact.match(/；/g) ?? []).length, 0)
})

test('Q&A 深度门禁要求回答明显长于问题并达到模板展开度', () => {
  const question: ProjectQaGeneratedQuestion = {
    id: 'Q001',
    category: '融资与估值',
    question: '本轮估值的安全边际来自哪里？',
    rationale: '检验估值依据。',
    priority: '高',
  }
  assert.equal(answerHasSufficientDepth('估值仍需核实。', question), false)
  assert.equal(
    answerHasSufficientDepth('公司本轮估值应同时结合收入质量、客户验证、现金消耗和下一轮融资条件判断。'.repeat(12), question),
    true,
  )
})

test('投资提案清除 PPT 目录拼接并修复产品技术名异常空格', () => {
  assert.equal(
    sanitizeInvestmentProposalClientText('公司采用 AI- Core- Tech 平台开展 4 D 建模，由 C OO 负责商业化。'),
    '公司采用AI-Core-Tech平台开展4D建模，由COO负责商业化。',
  )
  assert.equal(
    sanitizeInvestmentProposalClientText(
      '目录AI-Core-Tech大衍科技公司介绍市场预期融资发展目录AI-Core-Tech 02 03 04 公司概况核心团队',
    ),
    '',
  )
})
