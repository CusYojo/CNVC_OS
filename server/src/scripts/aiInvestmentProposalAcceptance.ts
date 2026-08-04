import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import type {
  BusinessContent,
  BusinessSection,
  BusinessTable,
  EvidenceSource,
} from '../services/aiBusinessContentService.js'
import {
  CURRENT_PROJECT_NO_DATA,
  loadInvestmentProposalBlueprint,
  proposalLeafSections,
  proposalSectionsForChapter,
} from '../services/aiInvestmentProposalBlueprintService.js'
import {
  buildInvestmentProposalEvidencePlan,
} from '../services/aiInvestmentProposalEvidenceService.js'
import {
  containsInvestmentProposalAbnormalSpacing,
  containsInvestmentProposalAiStyleBoilerplate,
  containsInvestmentProposalColonLabel,
  containsInvestmentProposalConversationalWording,
  containsInvestmentProposalFormulaicAnalysisWrapper,
  containsInvestmentProposalGenericNoDataPreface,
  containsInvestmentProposalInlineSubheading,
  containsInvestmentProposalLongQuotedExcerpt,
  containsInvestmentProposalSourceProcessWording,
  sanitizeInvestmentProposalClientText,
  sanitizeInvestmentProposalEvidenceContent,
  summarizeInvestmentProposalProductEvidence,
} from '../services/aiInvestmentProposalTextService.js'
import {
  compactInvestmentProposalSkillPrompt,
  composeInvestmentProposalContent,
  requestInvestmentProposalChapterJson,
  type InvestmentProposalChapterCheckpoint,
  type InvestmentProposalChapterProgress,
} from '../services/aiInvestmentProposalContentService.js'
import {
  generateInvestmentProposalDocx,
  reviewInvestmentProposalDocx,
} from '../services/aiInvestmentProposalDocumentService.js'
import {
  exportAndReviewInvestmentProposalPdf,
} from '../services/aiInvestmentProposalPdfService.js'
import {
  isInvestmentProposalDeliveryLimitation,
  reviewInvestmentProposalContent,
} from '../services/aiInvestmentProposalReviewerService.js'
import { curateEvidenceSources } from '../services/aiEvidenceQualityService.js'
import { loadAiSkill } from '../services/aiSkillService.js'
import { AI_TEMPLATE_CATALOG } from '../services/aiTemplateCatalog.js'
import { safeAiTaskFailureMessage } from '../services/aiTaskErrorService.js'
import { extractProjectQaPublicPageText } from '../services/aiQaModelResearchService.js'

const template = AI_TEMPLATE_CATALOG.investment_proposal
const blueprint = await loadInvestmentProposalBlueprint(template)
const skill = await loadAiSkill('draft-investment-proposal')
const publicCompanyPage = curateEvidenceSources([{
  sourceType: 'public_web_cache',
  sourceId: 'public-company-profile',
  sourceName: '企业公开信息',
  content: '公司全称：星河机器人有限公司。成立时间：2025年1月。主营机器人产品。联系我们 北京 中国北京朝阳区。英诺嘿呀邮箱：test@example.com。',
}])
assert.equal(publicCompanyPage.usable.length, 1)
assert.equal(publicCompanyPage.usable[0].content.includes('主营机器人产品'), true)
assert.equal(publicCompanyPage.usable[0].content.includes('联系我们'), false)
assert.equal(publicCompanyPage.usable[0].content.includes('英诺嘿呀邮箱'), false)
const extractedCompanyPage = extractProjectQaPublicPageText(`
  <main>
    <p>简介：星河机器人有限公司成立于2025年1月，注册地址为北京市海淀区测试路1号4FL3A-2... 展开</p>
    <p>公司全称：星河机器人有限公司</p>
    <p>注册时间：2025-01-01</p>
    <p>注册地址：北京市海淀区测试路1号4FL3A-2</p>
    <p>一般项目：机器人技术服务；人工智能软件开发；智能机器人销售；依法自主开展经营活动。</p>
    <p>原文链接：https://example.com/source</p>
  </main>
`)
assert.match(extractedCompanyPage, /注册地址：北京市海淀区测试路1号4FL3A-2/)
assert.match(extractedCompanyPage, /智能机器人销售/)
assert.doesNotMatch(extractedCompanyPage, /(?:\.{3}|…)\s*展开|原文链接/)
const sanitizedCompanyEvidence = sanitizeInvestmentProposalEvidenceContent([
  '证据属性：系统联网发现并直接读取页面。',
  '页面标题：星河机器人有限公司工商信息',
  '页面正文摘录：公司全称：星河机器人有限公司',
  '简介：星河机器人有限公司注册地址为北京市海淀区测试路1号4FL3A-2... 展开',
  '注册时间：2025-01-01',
  '注册地址：北京市海淀区测试路1号4FL3A-2',
  '一般项目：机器人技术服务；人工智能软件开发；智能机器人销售；依法自主开展经营活动。',
  '原文链接：https://example.com/source',
  '来源网址：https://example.com/cache',
].join('\n'))
assert.match(sanitizedCompanyEvidence, /公司全称：星河机器人有限公司/)
assert.match(sanitizedCompanyEvidence, /注册地址：北京市海淀区测试路1号4FL3A-2/)
assert.match(sanitizedCompanyEvidence, /智能机器人销售/)
assert.doesNotMatch(
  sanitizedCompanyEvidence,
  /证据属性|页面标题|(?:\.{3}|…)\s*展开|原文链接|来源网址/,
)
const innoHereProductEvidence = [
  '证据属性：系统联网发现并直接读取页面。',
  '页面标题：智灵动力 - 公司详情 - 产品介绍 - innoHere英诺嘿呀',
  '页面正文摘录：智灵动力 - 公司详情 - 产品介绍 - innoHere英诺嘿呀 首页 权威榜 价值榜 行业数据 产业图谱 行业研究 查询 企业入驻 小程序 登入 智灵动力 天使轮 大模型技术研发商 关注 已关注 融资历史 公司简介 产品介绍 业务介绍 人机共生智能引擎 作为公司的核心产品，该引擎集成先进的语言模型、视觉识别和智慧推理技术，提供强大的多模态理解与交互能力。智灵虚拟人生成平台 该平台基于多模态大模型技术，支持面部表情捕捉、动作模拟、语音合成与识别。',
  '来源网址：https://example.com/product',
].join('\n')
const sanitizedInnoHereProductEvidence =
  sanitizeInvestmentProposalEvidenceContent(innoHereProductEvidence)
assert.match(sanitizedInnoHereProductEvidence, /人机共生智能引擎/)
assert.match(sanitizedInnoHereProductEvidence, /智灵虚拟人生成平台/)
assert.doesNotMatch(
  sanitizedInnoHereProductEvidence,
  /innoHere|英诺嘿呀|首页|权威榜|产业图谱|企业入驻|小程序|登入/,
)
const detailedProductParagraphs = summarizeInvestmentProposalProductEvidence(
  '（四）技术体系与产品矩阵 1、三层自进化技术架构'
  + '（1）顶层：自进化大模型，正在迭代自适应参数、自我蒸馏、离线/在线蒸馏等核心能力。'
  + '（2）中层：自进化 AI 框架，可统一调度多模型、多智能体、多 Skill。'
  + '（3）底层：自进化算法优化，已实现商业化落地验证。'
  + '2、其他成熟产品（1）AI 科学家平台：累计20万用户。'
  + '（2）世界自进化系统：3.0版本正式上线。'
  + '（3）事件推演系统：支持社会事件、企业发展和舆情趋势推演。',
)
assert.ok(detailedProductParagraphs.length >= 2)
assert.match(detailedProductParagraphs.join('\n'), /三层技术架构/)
assert.match(detailedProductParagraphs.join('\n'), /自进化大模型/)
assert.match(detailedProductParagraphs.join('\n'), /AI科学家平台/)
assert.match(detailedProductParagraphs.join('\n'), /事件推演系统/)
assert.doesNotMatch(detailedProductParagraphs.join('\n'), /[（(]\s*\d+\s*[）)]|顶层\s*[:：]|中层\s*[:：]|底层\s*[:：]/)
const clientFinding = sanitizeInvestmentProposalClientText(
  '判断：公司具备机器人业务基础。 依据：项目资料记载公司已形成产品。 影响/约束：仍需核验客户。 待办：取得合同。项目资料显示：原文链接：https://example.com/source',
)
assert.equal(
  clientFinding,
  '公司具备机器人业务基础。公司已形成产品。仍需核验客户。取得合同。',
)
assert.doesNotMatch(
  clientFinding,
  /判断：|依据：|影响\/约束：|待办：|项目资料|原文链接/,
)
const summarizedSourceProse = sanitizeInvestmentProposalClientText(
  '会议纪要记载公司已完成首批产品交付；现有资料未提供完整客户名单，项目组应回到原始文件核验。',
)
assert.equal(
  summarizedSourceProse,
  '公司已完成首批产品交付；尚未明确完整客户名单，项目组应完成专项核验。',
)
assert.equal(containsInvestmentProposalSourceProcessWording(summarizedSourceProse), false)
assert.equal(containsInvestmentProposalAiStyleBoilerplate('总体来看，公司发展情况较好。'), true)
assert.equal(
  containsInvestmentProposalConversationalWording(
    '但是其实各种初期的尝试验证已经差不多结束了，接下来是人效提升时期。',
  ),
  true,
)
assert.equal(
  containsInvestmentProposalLongQuotedExcerpt(
    '若“公司将在后续阶段继续推进多项业务验证，并结合客户反馈调整产品方向与交付计划”未完成核验。',
  ),
  true,
)
assert.equal(
  containsInvestmentProposalFormulaicAnalysisWrapper(
    '建议继续跟踪，并在接触或立项前完成专项核验。',
  ),
  true,
)
const normalizedTypography = sanitizeInvestmentProposalClientText(
  '宁波政府项目： 在宁波注册主体，申报 800 万元政府补贴，申报方向为一人公司智 能体服务矩阵 。',
)
assert.equal(
  normalizedTypography,
  '宁波政府项目方面，在宁波注册主体，申报800万元政府补贴，申报方向为一人公司智能体服务矩阵。',
)
const normalizedMixedTypography = sanitizeInvestmentProposalClientText(
  '公司采用 Open AI Skill 框架，基础制作费 500 元 / 分钟，后台 AI 自动处理。',
)
assert.equal(
  normalizedMixedTypography,
  '公司采用Open AI Skill框架，基础制作费500元/分钟，后台AI自动处理。',
)
assert.equal(containsInvestmentProposalAbnormalSpacing(normalizedTypography), false)
assert.equal(containsInvestmentProposalAbnormalSpacing(normalizedMixedTypography), false)
const orderParagraph = sanitizeInvestmentProposalClientText(
  '订单节奏：2026年5月正式启动新合作，当前每20天交付5000分钟内容。',
)
assert.equal(
  orderParagraph,
  '公司订单交付方面，2026年5月正式启动新合作，当前每20天交付5000分钟内容。',
)
assert.equal(containsInvestmentProposalColonLabel(orderParagraph), false)
const genericColonParagraph = sanitizeInvestmentProposalClientText(
  '快速输出：当天完成场景选型、技术难度评估和落地排期。',
)
assert.equal(
  genericColonParagraph,
  '快速输出方面，当天完成场景选型、技术难度评估和落地排期。',
)
assert.equal(containsInvestmentProposalColonLabel(genericColonParagraph), false)
const continuousParagraph = sanitizeInvestmentProposalClientText(
  '三）现金流与估值规划 1、现金流保障：老股东拟提供1000万元借款，可保障半年现金流安全。',
)
assert.equal(
  continuousParagraph,
  '老股东拟提供1000万元借款，可保障半年现金流安全。',
)
assert.equal(containsInvestmentProposalInlineSubheading(continuousParagraph), false)
const nestedContinuousParagraph = sanitizeInvestmentProposalClientText(
  '四、融资进展相关 （一）存量资产处置 1、传统业务板块计划整体出售，已对接4家公司。',
)
assert.equal(
  nestedContinuousParagraph,
  '传统业务板块计划整体出售，已对接4家公司。',
)
assert.equal(containsInvestmentProposalInlineSubheading(nestedContinuousParagraph), false)
const multiFactParagraph = sanitizeInvestmentProposalClientText(
  '公司地址：北京市海淀区测试路1号。成立时间：2025-01-01。企业发展阶段：已获天使轮。创始人：测试创始人。管理团队：测试创始人、测试经理。',
)
assert.equal(
  multiFactParagraph,
  '公司注册地址为北京市海淀区测试路1号。公司成立于2025-01-01。公司目前已获天使轮。公司创始人为测试创始人。公司管理团队包括测试创始人、测试经理。',
)
assert.equal(containsInvestmentProposalColonLabel(multiFactParagraph), false)
const headlineOnlyEvidence = buildInvestmentProposalEvidencePlan([{
  sourceType: 'public_web_cache',
  sourceId: 'headline-only',
  sourceName: '星河机器人产品新闻',
  content: '星河机器人全线产品升级大模型基座，AI能力提升，对标行业先进产品。',
}], blueprint)
assert.equal(
  headlineOnlyEvidence.sections.find((section) =>
    section.sectionId === 'business-plan.comparables')?.coverage,
  'missing',
)
let chapterRequestAttempts = 0
const retriedChapterJson = await requestInvestmentProposalChapterJson({
  systemPrompt: '只返回 JSON。',
  userPrompt: '生成测试章节。',
  maxTokens: 100,
}, {
  fetchImpl: async () => {
    chapterRequestAttempts += 1
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: chapterRequestAttempts === 1
            ? '{"sections":['
            : '{"sections":[]}',
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  },
})
assert.deepEqual(retriedChapterJson, { sections: [] })
assert.equal(chapterRequestAttempts, 2)
const repairedTrailingCommaJson = await requestInvestmentProposalChapterJson({
  systemPrompt: '只返回 JSON。',
  userPrompt: '生成尾逗号修复测试章节。',
  maxTokens: 100,
}, {
  maxAttempts: 1,
  fetchImpl: async () => new Response(JSON.stringify({
    choices: [{
      finish_reason: 'stop',
      message: { content: '{"sections":[],}' },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
})
assert.deepEqual(repairedTrailingCommaJson, { sections: [] })
const repairedMissingCloserJson = await requestInvestmentProposalChapterJson({
  systemPrompt: '只返回 JSON。',
  userPrompt: '生成缺失闭合符修复测试章节。',
  maxTokens: 100,
}, {
  maxAttempts: 1,
  fetchImpl: async () => new Response(JSON.stringify({
    choices: [{
      finish_reason: 'stop',
      message: { content: '{"sections":[]' },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
})
assert.deepEqual(repairedMissingCloserJson, { sections: [] })
const streamedRequestBodies: Array<Record<string, unknown>> = []
let streamedRequestAttempts = 0
const streamedChapterJson = await requestInvestmentProposalChapterJson({
  systemPrompt: '只返回 JSON。',
  userPrompt: '生成流式章节。',
  maxTokens: 100,
}, {
  fetchImpl: async (_url, init) => {
    streamedRequestAttempts += 1
    streamedRequestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const content = streamedRequestAttempts === 1
      ? '{"sections":['
      : '{"sections":[]}'
    const finishReason = streamedRequestAttempts === 1 ? 'length' : 'stop'
    return new Response([
      `data: ${JSON.stringify({
        choices: [{
          delta: { content },
          finish_reason: finishReason,
        }],
      })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'x-request-id': `stream-attempt-${streamedRequestAttempts}`,
      },
    })
  },
})
assert.deepEqual(streamedChapterJson, { sections: [] })
assert.equal(streamedRequestAttempts, 2)
assert.deepEqual(streamedRequestBodies.map((body) => body.stream), [true, true])
assert.deepEqual(streamedRequestBodies.map((body) => body.max_tokens), [100, 100])
assert.deepEqual(streamedRequestBodies.map((body) => body.temperature), [undefined, undefined])
assert.match(
  String((streamedRequestBodies[1]?.messages as Array<{ content?: unknown }> | undefined)?.[1]?.content),
  /上一次输出被截断.*显著压缩/,
)
let timeoutRequestAttempts = 0
const timeoutRetriedChapterJson = await requestInvestmentProposalChapterJson({
  systemPrompt: '只返回 JSON。',
  userPrompt: '生成超时重试测试章节。',
  maxTokens: 100,
}, {
  fetchImpl: async () => {
    timeoutRequestAttempts += 1
    if (timeoutRequestAttempts === 1) {
      throw new DOMException('request timed out', 'TimeoutError')
    }
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: '{"sections":[]}' },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  },
})
assert.deepEqual(timeoutRetriedChapterJson, { sections: [] })
assert.equal(timeoutRequestAttempts, 2)
let unauthorizedRequestAttempts = 0
await assert.rejects(
  requestInvestmentProposalChapterJson({
    systemPrompt: '只返回 JSON。',
    userPrompt: '生成鉴权失败测试章节。',
    maxTokens: 100,
  }, {
    fetchImpl: async () => {
      unauthorizedRequestAttempts += 1
      return new Response('unauthorized', { status: 401 })
    },
  }),
  /HTTP 401/,
)
assert.equal(unauthorizedRequestAttempts, 1)
const compactSkillPrompt = compactInvestmentProposalSkillPrompt(skill)
assert.ok(compactSkillPrompt.length < skill.instructions.length + skill.referenceInstructions.length)
assert.ok(compactSkillPrompt.length <= 7000)
assert.equal(compactSkillPrompt.includes('## references/formatter-contract.md'), false)
assert.equal(compactSkillPrompt.includes('## references/template-profile.md'), false)
assert.match(compactSkillPrompt, /访谈、聊天记录和会议转录必须先提炼为正式事实/)
assert.match(compactSkillPrompt, /不使用任何`短标签：正文`式引导语/)
assert.match(
  safeAiTaskFailureMessage(Object.assign(
    new Error('包含内部模型原文的错误'),
    { code: 'INVESTMENT_PROPOSAL_CHAPTER_GENERATION_FAILED' },
  )),
  /文档尚未完成，系统已保留本次生成参数/,
)
assert.doesNotMatch(
  safeAiTaskFailureMessage(Object.assign(
    new Error('不应暴露的上游错误正文'),
    {
      code: 'INVESTMENT_PROPOSAL_CHAPTER_GENERATION_FAILED',
      upstreamCode: 'INVESTMENT_PROPOSAL_LLM_HTTP_ERROR',
      status: 504,
    },
  )),
  /HTTP 504|上游|模型网关|错误/,
)
assert.doesNotMatch(
  safeAiTaskFailureMessage(Object.assign(
    new Error('不应暴露的截断原文'),
    {
      code: 'INVESTMENT_PROPOSAL_CHAPTER_GENERATION_FAILED',
      upstreamCode: 'INVESTMENT_PROPOSAL_LLM_TRUNCATED',
    },
  )),
  /截断|模型输出不完整|错误/,
)
const outputDirectory = path.resolve(
  process.env.AI_PROPOSAL_ACCEPTANCE_OUTPUT
    || path.join(process.cwd(), 'server', 'ai-artifacts', 'acceptance', 'investment-proposal'),
)
await mkdir(outputDirectory, { recursive: true })

const leafDefinitions = proposalLeafSections(blueprint)
function claimFor(definition: typeof leafDefinitions[number]) {
  const topic = definition.title.replace(/^[一二三四五六七八九十0-9.、（）()\s]+/, '')
  if (definition.analysisKind === 'product_technology') {
    return '星河机器人平台采用视觉模型与运动控制算法，已完成原型测试，产品化状态仍以测试报告复核结果为准。'
  }
  if (definition.analysisKind === 'risk_summary') {
    return '若公司未能在投决前完成风险事项核验，可能影响交易判断；项目组应在投决前完成专项审查并持续跟踪，责任主体为项目组。'
  }
  if (definition.analysisKind === 'conclusion') {
    return '阶段与推进建议为申请立项；建议在项目组完成关键事实核验并落实立项前提后，通过OA发起立项申请；如重大风险未消除，应暂缓推进并重新评估。'
  }
  return `星河机器人有限公司已确认${topic}相关安排，具体执行情况仍需在下一阶段核验。`
}

const sources: EvidenceSource[] = leafDefinitions.map((definition, index) => {
  const topic = definition.title.replace(/^[一二三四五六七八九十0-9.、（）()\s]+/, '')
  const claim = claimFor(definition)
  const tableEvidence = definition.tableKind === 'equity_structure'
    ? '股东：创始人；持股比例：60%。'
    : definition.tableKind === 'financial_summary'
      ? '报告期：2025年；收入：100万元。'
      : definition.tableKind === 'financing_history'
        ? '融资时间：2025年；轮次：天使轮；融资金额：100万元；投资方：测试资本。'
        : definition.tableKind === 'transaction_plan'
          ? '投资形式：增资；投资金额：100万元；投前估值：1000万元；投后估值：1100万元；资金用途：研发。'
          : definition.tableKind === 'forecast_return'
            ? '年度：2025E；收入：100万元；利润：10万元；退出估值：1000万元；回报倍数：2倍。'
            : definition.tableKind === 'comparable_valuation'
              ? '可比公司：测试科技；数据时点：2025年；估值：1000万元；PS：2倍。'
              : ''
  const completeCompanyProfileEvidence = definition.analysisKind === 'company_profile'
    ? [
        '公司全称：星河机器人有限公司。',
        '简介：星河机器人有限公司注册地址为北京市海淀区测试路1号4FL3A-2... 展开',
        '注册时间：2025-01-01。',
        '注册资本：2000万元。',
        '注册地址：北京市海淀区测试路1号4FL3A-2。',
        '一般项目：机器人技术服务；人工智能软件开发；智能机器人销售；依法自主开展经营活动。',
        '原文链接：https://example.com/source',
      ].join('\n')
    : ''
  return {
    sourceType: 'project_document',
    sourceId: `acceptance-${definition.id}`,
    sourceName: `${topic}项目资料`,
    chunkIndex: index,
    versionOrDate: '2026-07-20',
    content: [
      `当前项目：星河机器人项目。公司主体：星河机器人有限公司。`,
      `章节关键词：${definition.evidenceKeywords.join('、')}。`,
      claim,
      completeCompanyProfileEvidence,
      tableEvidence,
    ].filter(Boolean).join('\n'),
  }
})
const evidencePlan = buildInvestmentProposalEvidencePlan(sources, blueprint)
assert.equal(evidencePlan.evidenceScope, 'project_knowledge_primary')
const priorityPlan = buildInvestmentProposalEvidencePlan([
  {
    sourceType: 'project_record',
    sourceId: 'priority-project',
    sourceName: '项目档案',
    content: '公司简介：项目档案记录公司主营机器人产品。',
  },
  {
    sourceType: 'project_document',
    sourceId: 'priority-knowledge',
    sourceName: '公司介绍及产品资料.docx',
    content: '公司简介：项目资料库原始文件记载公司主营具身智能机器人产品。',
  },
], blueprint)
assert.equal(
  priorityPlan.sections.find((section) => section.sectionId === 'company.profile')
    ?.evidence[0]?.sourceType,
  'project_document',
)
const productLocalFirstPlan = buildInvestmentProposalEvidencePlan([
  {
    sourceType: 'project_document',
    sourceId: 'product-local',
    sourceName: '项目交流纪要.pdf',
    content: '三层自进化技术架构包括自进化大模型、自进化 AI 框架和自进化算法优化；AI 科学家平台与事件推演系统已经形成产品记录。',
  },
  {
    sourceType: 'public_web_llm',
    sourceId: 'product-public',
    sourceName: '智灵动力产品介绍',
    content: innoHereProductEvidence,
  },
], blueprint)
assert.equal(
  productLocalFirstPlan.sections.find((section) => section.sectionId === 'company.product')
    ?.evidence[0]?.sourceType,
  'project_document',
)

function tableFor(
  tableKind: typeof leafDefinitions[number]['tableKind'],
  sourceIndex: number,
): BusinessTable | undefined {
  if (!tableKind) return undefined
  if (tableKind === 'equity_structure') {
    return {
      title: '公司股权结构',
      unit: '无',
      columns: ['股东', '持股比例'],
      rows: [['创始人', '60%']],
      status: '资料记载',
      sourceIndexes: [sourceIndex],
    }
  }
  const tableDefinitions: Record<
    Exclude<NonNullable<typeof tableKind>, 'equity_structure'>,
    { title: string; columns: string[]; row: string[]; unit: string }
  > = {
    financial_summary: {
      title: '历史财务摘要',
      columns: ['报告期', '收入'],
      row: ['2025年', '100万元'],
      unit: '人民币万元',
    },
    financing_history: {
      title: '历史融资情况',
      columns: ['融资时间', '轮次', '融资金额', '投资方'],
      row: ['2025年', '天使轮', '100万元', '测试资本'],
      unit: '人民币万元',
    },
    transaction_plan: {
      title: '本轮投资方案',
      columns: ['投资形式', '投资金额', '投前估值', '投后估值', '资金用途'],
      row: ['增资', '100万元', '1000万元', '1100万元', '研发'],
      unit: '人民币万元',
    },
    forecast_return: {
      title: '经营预测与回报测算',
      columns: ['年度', '收入', '利润', '退出估值', '回报倍数'],
      row: ['2025E', '100万元', '10万元', '1000万元', '2倍'],
      unit: '人民币万元',
    },
    comparable_valuation: {
      title: '可比公司估值比较',
      columns: ['可比公司', '数据时点', '估值', 'PS'],
      row: ['测试科技', '2025年', '1000万元', '2倍'],
      unit: '人民币万元',
    },
  }
  const definition = tableDefinitions[tableKind]
  return {
    title: definition.title,
    unit: definition.unit,
    columns: definition.columns,
    rows: [definition.row],
    status: '资料记载',
    sourceIndexes: [sourceIndex],
  }
}

const leafIndex = new Map(leafDefinitions.map((definition, index) => [definition.id, index]))
const sections: BusinessSection[] = blueprint.sections.map((definition) => {
  if (definition.container) {
    return { title: definition.title, summary: '', findings: [], tables: [] }
  }
  const sourceIndex = leafIndex.get(definition.id)!
  const claim = claimFor(definition)
  const table = tableFor(definition.tableKind, sourceIndex)
  return {
    title: definition.title,
    summary: '',
    summarySourceIndexes: [],
    findings: [{
      text: claim,
      status: '资料记载',
      sourceIndexes: [sourceIndex],
    }],
    tables: table ? [table] : [],
  }
})

const content: BusinessContent = {
  title: '关于对星河机器人有限公司实施股权投资的提案',
  executiveSummary:
    '现就星河机器人有限公司股权投资事项提交本提案，提请各位投资决策委员会成员审议。',
  executiveSummarySourceIndexes: [0],
  sections,
  highlights: sections
    .find((section) => section.title === '四、项目亮点总结')!
    .findings.map((finding) => finding.text),
  risks: sections
    .find((section) => section.title === '五、风险提示与对策')!
    .findings.map((finding) => finding.text),
  missing: [],
}

const contentReview = reviewInvestmentProposalContent({
  content,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(contentReview.passed, true, JSON.stringify(contentReview.issues, null, 2))
assert.equal(contentReview.checked.sectionCount, 17)
assert.equal(contentReview.checked.leafSectionCount, 14)
assert.equal(contentReview.checked.leafSectionCount, leafDefinitions.length)
assert.equal(evidencePlan.coverage.missingLeafSections, 0)
const internalErrorLeakContent = structuredClone(content)
internalErrorLeakContent.sections.find((section) => section.title === '（一）公司简介')!
  .findings[0].text = '模型请求失败（HTTP 400），请联系管理员。'
const internalErrorLeakReview = reviewInvestmentProposalContent({
  content: internalErrorLeakContent,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(internalErrorLeakReview.passed, false)
assert.ok(internalErrorLeakReview.issues.some((issue) =>
  issue.code === 'INTERNAL_ERROR_TEXT_LEAK'))
const boilerplateLeakContent = structuredClone(content)
boilerplateLeakContent.sections.find((section) => section.title === '（三）公司股权结构')!
  .findings[0].text = '页面正文摘录：财经 焦点 股票 新股 期指 期权 行情中心 股权质押。'
const boilerplateLeakReview = reviewInvestmentProposalContent({
  content: boilerplateLeakContent,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(boilerplateLeakReview.passed, false)
assert.ok(boilerplateLeakReview.issues.some((issue) =>
  issue.code === 'EVIDENCE_PROCESS_TEXT_LEAK'))
const productNavigationLeakContent = structuredClone(content)
productNavigationLeakContent.sections.find((section) => section.title === '（四）产品及技术')!
  .findings[0].text = '智灵动力 - 公司详情 - 产品介绍 - innoHere英诺嘿呀 首页 权威榜 价值榜 行业数据 产业图谱 行业研究 企业入驻 小程序 登入 人机共生智能引擎采用多模态模型。'
const productNavigationLeakReview = reviewInvestmentProposalContent({
  content: productNavigationLeakContent,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(productNavigationLeakReview.passed, false)
assert.ok(productNavigationLeakReview.issues.some((issue) =>
  issue.code === 'EVIDENCE_PROCESS_TEXT_LEAK' || issue.code === 'WEB_ARTIFACT_TEXT_LEAK'))
const proseLabelLeakContent = structuredClone(content)
proseLabelLeakContent.sections.find((section) => section.title === '（一）公司简介')!
  .findings[0].text = '判断：星河机器人有限公司主营机器人产品。依据：当前项目资料已形成产品记录。'
const proseLabelLeakReview = reviewInvestmentProposalContent({
  content: proseLabelLeakContent,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(proseLabelLeakReview.passed, false)
assert.ok(proseLabelLeakReview.issues.some((issue) =>
  issue.code === 'CLIENT_PROSE_LABEL_LEAK'))
assert.ok(proseLabelLeakReview.issues.some((issue) =>
  issue.code === 'SOURCE_PROCESS_WORDING_LEAK'))
const aiStyleLeakContent = structuredClone(content)
aiStyleLeakContent.sections.find((section) => section.title === '（一）公司简介')!
  .findings[0].text = '总体来看，星河机器人有限公司通过多维度赋能构建了业务生态闭环。'
const aiStyleLeakReview = reviewInvestmentProposalContent({
  content: aiStyleLeakContent,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(aiStyleLeakReview.passed, false)
assert.ok(aiStyleLeakReview.issues.some((issue) =>
  issue.code === 'AI_STYLE_BOILERPLATE'))
const conversationalLeakContent = structuredClone(content)
conversationalLeakContent.sections.find((section) => section.title === '四、项目亮点总结')!
  .findings[0].text = '但是其实各种初期的尝试验证已经差不多结束了，接下来是人效提升时期。'
const conversationalLeakReview = reviewInvestmentProposalContent({
  content: conversationalLeakContent,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(conversationalLeakReview.passed, false)
assert.ok(conversationalLeakReview.issues.some((issue) =>
  issue.code === 'CONVERSATIONAL_TRANSCRIPT_LEAK'))
const formulaicLeakContent = structuredClone(content)
formulaicLeakContent.sections.find((section) => section.title === '四、项目亮点总结')!
  .findings[0].text = '建议继续跟踪，并在接触或立项前完成专项核验。'
const formulaicLeakReview = reviewInvestmentProposalContent({
  content: formulaicLeakContent,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(formulaicLeakReview.passed, false)
assert.ok(formulaicLeakReview.issues.some((issue) =>
  issue.code === 'FORMULAIC_ANALYSIS_WRAPPER'))
const abnormalSpacingContent = structuredClone(content)
abnormalSpacingContent.sections.find((section) => section.title === '（一）公司简介')!
  .findings[0].text = '星河机器人有限公司已形成智 能体产品，2026 年启动商业化交付 。'
const abnormalSpacingReview = reviewInvestmentProposalContent({
  content: abnormalSpacingContent,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(abnormalSpacingReview.passed, false)
assert.ok(abnormalSpacingReview.issues.some((issue) =>
  issue.code === 'ABNORMAL_TYPOGRAPHY_SPACING'))
const colonLabelLeakContent = structuredClone(content)
colonLabelLeakContent.sections.find((section) => section.title === '（五）运营摘要')!
  .findings[0].text = '订单节奏：2026年5月正式启动新合作，当前每20天交付5000分钟内容。'
const colonLabelLeakReview = reviewInvestmentProposalContent({
  content: colonLabelLeakContent,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(colonLabelLeakReview.passed, false)
assert.ok(colonLabelLeakReview.issues.some((issue) =>
  issue.code === 'CLIENT_COLON_LABEL_LEAK'))
const inlineSubheadingLeakContent = structuredClone(content)
inlineSubheadingLeakContent.sections.find((section) => section.title === '（五）运营摘要')!
  .findings[0].text = '1、公司于2026年5月正式启动新合作，当前每20天交付5000分钟内容。'
const inlineSubheadingLeakReview = reviewInvestmentProposalContent({
  content: inlineSubheadingLeakContent,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(inlineSubheadingLeakReview.passed, false)
assert.ok(inlineSubheadingLeakReview.issues.some((issue) =>
  issue.code === 'INLINE_NUMBERED_SUBHEADING_LEAK'))
const webArtifactLeakContent = structuredClone(content)
webArtifactLeakContent.sections.find((section) => section.title === '（一）公司简介')!
  .findings[0].text = '简介：星河机器人有限公司注册地址为测试路1号4FL3A-2... 展开'
const webArtifactLeakReview = reviewInvestmentProposalContent({
  content: webArtifactLeakContent,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(webArtifactLeakReview.passed, false)
assert.ok(webArtifactLeakReview.issues.some((issue) =>
  issue.code === 'WEB_ARTIFACT_TEXT_LEAK'))
const wrongEquityTableContent = structuredClone(content)
wrongEquityTableContent.sections.find((section) => section.title === '（三）公司股权结构')!
  .tables = [{
    title: '网页线索汇总',
    unit: '无',
    columns: ['日期', '轮次', '金额', '备注'],
    rows: [['2025年', '天使轮', '100万元', '待核验']],
    status: '资料记载',
    sourceIndexes: [leafIndex.get('company.equity')!],
  }]
const wrongEquityTableReview = reviewInvestmentProposalContent({
  content: wrongEquityTableContent,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(wrongEquityTableReview.passed, false)
assert.ok(wrongEquityTableReview.issues.some((issue) =>
  issue.code === 'TABLE_SCHEMA_MISMATCH'))

const rootDefinitions = blueprint.sections.filter((definition) => definition.level === 1)
let incompatibleParameterCalls = 0
const incompatibleParameterFallback = await composeInvestmentProposalContent({
    template,
    skill,
    project: {
      name: '模型参数错误测试项目',
      companyName: '模型参数错误测试公司',
    },
    sources,
    sourceCutoffDate: '2026-07-28',
    parameters: {
      length: '标准版',
      audience: '内部立项',
    },
    runtime: {
      fetchImpl: async () => {
        incompatibleParameterCalls += 1
        return new Response(JSON.stringify({
          error: {
            message: 'Unsupported value: temperature',
            type: 'invalid_request_error',
          },
        }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      },
      concurrency: 1,
      maxRequestAttempts: 1,
      maxGenerationAttempts: 1,
    },
  })
assert.equal(incompatibleParameterCalls, rootDefinitions.length + 1)
const incompatibleParameterFallbackReview = reviewInvestmentProposalContent({
  content: incompatibleParameterFallback,
  blueprint,
  evidencePlan,
  sources,
  projectName: '模型参数错误测试项目',
  companyName: '模型参数错误测试公司',
})
assert.equal(
  incompatibleParameterFallbackReview.passed,
  true,
  JSON.stringify({
    issues: incompatibleParameterFallbackReview.issues,
    conclusion: incompatibleParameterFallback.sections.find((section) => section.title === '六、结论'),
  }, null, 2),
)
const incompatibleParameterFallbackText = [
  incompatibleParameterFallback.executiveSummary,
  ...incompatibleParameterFallback.sections.flatMap((section) => [
    section.summary,
    ...section.findings.map((finding) => finding.text),
  ]),
].join('\n')
assert.doesNotMatch(
  incompatibleParameterFallbackText,
  /(?:HTTP\s*\d{3}|LLM\s*(?:请求|响应|返回|错误|异常|失败|超时|中断)|网关(?:错误|异常|失败)|错误编号|错误码|invalid_request_error|unsupported_value|模型请求(?:失败|中断|异常))/i,
)
assert.equal(
  containsInvestmentProposalConversationalWording(incompatibleParameterFallbackText),
  false,
)
assert.equal(
  containsInvestmentProposalLongQuotedExcerpt(incompatibleParameterFallbackText),
  false,
)
assert.equal(
  containsInvestmentProposalFormulaicAnalysisWrapper(incompatibleParameterFallbackText),
  false,
)
const humanNoDataText = sanitizeInvestmentProposalClientText(
  '现阶段尚不能形成结论。公司完整股东名单、持股比例及实际控制人尚未明确，申请立项前应取得最新公司章程、股东名册和工商档案并完成核对。',
)
assert.equal(
  humanNoDataText,
  '公司完整股东名单、持股比例及实际控制人尚未明确，申请立项前应取得最新公司章程、股东名册和工商档案并完成核对。',
)
assert.equal(containsInvestmentProposalGenericNoDataPreface(humanNoDataText), false)
assert.equal(
  incompatibleParameterFallback.sections
    .flatMap((section) => section.findings)
    .some((finding) => finding.status === '资料缺口'),
  false,
)
const deterministicCompanyProfile = incompatibleParameterFallback.sections
  .find((section) => section.title === '（一）公司简介')
  ?.findings.map((finding) => finding.text).join('\n') ?? ''
assert.match(deterministicCompanyProfile, /公司注册地址为北京市海淀区测试路1号4FL3A-2/)
assert.match(deterministicCompanyProfile, /智能机器人销售/)
assert.doesNotMatch(deterministicCompanyProfile, /[\r\n]/)
assert.doesNotMatch(
  deterministicCompanyProfile,
  /(?:\.{3}|…)\s*展开|原文链接|来源网址|项目资料|判断：|一般项目：/,
)

let noEvidenceFetchCalled = false
const noEvidenceContent = await composeInvestmentProposalContent({
  template,
  skill,
  project: {
    name: '待补资料项目',
    companyName: '待补资料公司',
  },
  sources: [],
  sourceCutoffDate: '2026-07-28',
  parameters: {
    length: '标准版',
    audience: '内部立项',
  },
  runtime: {
    fetchImpl: async () => {
      noEvidenceFetchCalled = true
      throw new Error('无证据章节不应调用模型')
    },
  },
})
assert.equal(noEvidenceFetchCalled, false)
assert.equal(noEvidenceContent.generationAudit?.limitedDraft, true)
assert.equal(noEvidenceContent.generationAudit?.evidenceCoverage.missingLeafSections, leafDefinitions.length)
const noEvidenceText = noEvidenceContent.sections
  .flatMap((section) => section.findings.map((finding) => finding.text))
  .join('\n')
assert.equal(containsInvestmentProposalGenericNoDataPreface(noEvidenceText), false)
assert.doesNotMatch(noEvidenceText, /(?:资料不足|暂无相关资料|需核验该主题|相关关键事实后再行分析)/)
assert.match(noEvidenceText, /核心团队成员、任职履历、职责分工和全职状态尚未明确/)
assert.match(noEvidenceText, /本轮融资金额、估值、投资工具、拟出让股比和资金用途尚未明确/)
assert.match(noEvidenceText, /项目在经营、技术、合规和交易层面的关键风险及触发条件尚未明确/)

let activeChapterRequests = 0
let maxActiveChapterRequests = 0
let generatedChapterRequests = 0
const progressEvents: InvestmentProposalChapterProgress[] = []
const savedCheckpoints: InvestmentProposalChapterCheckpoint[] = []
function mockedEditorResponse() {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: 'stop',
      message: {
        content: JSON.stringify({
          executiveSummary: content.executiveSummary,
          sections: blueprint.sections.map((definition) => {
            const section = sections.find((item) => item.title === definition.title)!
            return {
              id: definition.id,
              title: definition.title,
              findings: section.findings.map((finding) => ({
                ...finding,
                text: finding.text
                  .replace('具体执行情况仍需在下一阶段核验。', '该项安排构成当前分析基础。')
                  .replace(
                    '阶段与推进建议为申请立项；建议在项目组完成关键事实核验并落实立项前提后，通过OA发起立项申请；如重大风险未消除，应暂缓推进并重新评估。',
                    '建议申请立项；项目组应先完成关键事实核验并落实立项条件，再提交内部审批；如重大风险未消除，则暂缓推进并重新评估。',
                  ),
              })),
              tables: section.tables ?? [],
            }
          }),
        }),
      },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
const mockedChapterFetch: typeof fetch = async (_input, init) => {
  activeChapterRequests += 1
  generatedChapterRequests += 1
  maxActiveChapterRequests = Math.max(maxActiveChapterRequests, activeChapterRequests)
  try {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const request = JSON.parse(String(init?.body || '{}')) as {
      messages?: Array<{ role?: string; content?: string }>
    }
    const userPrompt = request.messages?.find((message) => message.role === 'user')?.content ?? ''
    if (userPrompt.includes('当前提案：')) {
      return mockedEditorResponse()
    }
    const root = rootDefinitions.find((definition) =>
      userPrompt.includes(`生成章节：${definition.title}`))
    assert.ok(root, `无法从测试请求识别章节：${userPrompt.slice(0, 120)}`)
    const responseSections = proposalSectionsForChapter(blueprint, root.id).map((definition) => {
      const section = sections.find((item) => item.title === definition.title)!
      return {
        id: definition.id,
        title: definition.title,
        findings: section.findings,
        tables: section.tables ?? [],
      }
    })
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: JSON.stringify({ sections: responseSections }) },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } finally {
    activeChapterRequests -= 1
  }
}
const optimizedContent = await composeInvestmentProposalContent({
  template,
  skill,
  project: {
    name: '星河机器人项目',
    companyName: '星河机器人有限公司',
    industry: '具身智能机器人',
  },
  sources,
  sourceCutoffDate: '2026-07-20',
  parameters: {
    length: '标准版',
    audience: '内部立项',
  },
  runtime: {
    fetchImpl: mockedChapterFetch,
    timeoutMs: 60_000,
    maxRequestAttempts: 2,
    concurrency: 2,
    onProgress: (event) => {
      progressEvents.push(event)
    },
    saveCheckpoint: async (checkpoint) => {
      savedCheckpoints.push(structuredClone(checkpoint))
    },
  },
})
assert.equal(optimizedContent.generationAudit?.reviewerPassed, true)
assert.equal(generatedChapterRequests, rootDefinitions.length + 1)
assert.equal(maxActiveChapterRequests, 2)
assert.equal(savedCheckpoints.length, rootDefinitions.length)
assert.equal(savedCheckpoints.at(-1)?.version, 'investment-proposal-chapters-v1')
assert.equal(Object.keys(savedCheckpoints.at(-1)?.chapters ?? {}).length, rootDefinitions.length)
assert.ok(progressEvents.some((event) => event.phase === 'reviewing'))
assert.ok(progressEvents.some((event) => event.phase === 'completed'))
for (let index = 1; index < progressEvents.length; index += 1) {
  assert.ok(
    progressEvents[index].completedChapters >= progressEvents[index - 1].completedChapters,
    '章节完成进度必须单调递增',
  )
}

let splitRootAttempts = 0
let leafFallbackRequests = 0
const splitRoot = rootDefinitions.find((definition) => definition.title === '二、交易条件')!
const splitRootLeafDefinitions = proposalSectionsForChapter(blueprint, splitRoot.id)
  .filter((definition) => !definition.container)
const splitFallbackContent = await composeInvestmentProposalContent({
  template,
  skill,
  project: {
    name: '星河机器人项目',
    companyName: '星河机器人有限公司',
    industry: '具身智能机器人',
  },
  sources,
  sourceCutoffDate: '2026-07-20',
  parameters: {
    length: '标准版',
    audience: '内部立项',
  },
  runtime: {
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init?.body || '{}')) as {
        messages?: Array<{ role?: string; content?: string }>
      }
      const userPrompt = request.messages?.find((message) => message.role === 'user')?.content ?? ''
      if (userPrompt.includes('当前提案：')) {
        return mockedEditorResponse()
      }
      const leaf = splitRootLeafDefinitions.find((definition) =>
        userPrompt.includes(`id 为“${definition.id}”`))
      if (leaf) {
        leafFallbackRequests += 1
        const section = sections.find((item) => item.title === leaf.title)!
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                sections: [{
                  id: leaf.id,
                  title: leaf.title,
                  findings: section.findings,
                  tables: section.tables ?? [],
                }],
              }),
            },
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      const root = rootDefinitions.find((definition) =>
        userPrompt.includes(`生成章节：${definition.title}`))
      assert.ok(root, `无法从拆章测试请求识别章节：${userPrompt.slice(0, 120)}`)
      if (root.id === splitRoot.id) {
        splitRootAttempts += 1
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: 'stop',
            message: { content: '{"sections":[' },
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      const responseSections = proposalSectionsForChapter(blueprint, root.id).map((definition) => {
        const section = sections.find((item) => item.title === definition.title)!
        return {
          id: definition.id,
          title: definition.title,
          findings: section.findings,
          tables: section.tables ?? [],
        }
      })
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({ sections: responseSections }) },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
    maxRequestAttempts: 2,
    concurrency: 2,
  },
})
assert.equal(splitFallbackContent.generationAudit?.reviewerPassed, true)
assert.equal(splitRootAttempts, 2)
assert.equal(leafFallbackRequests, splitRootLeafDefinitions.length)

let resumedEditorCalls = 0
const resumedProgressEvents: InvestmentProposalChapterProgress[] = []
const resumedContent = await composeInvestmentProposalContent({
  template,
  skill,
  project: {
    name: '星河机器人项目',
    companyName: '星河机器人有限公司',
    industry: '具身智能机器人',
  },
  sources,
  sourceCutoffDate: '2026-07-20',
  parameters: {
    length: '标准版',
    audience: '内部立项',
  },
  runtime: {
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init?.body || '{}')) as {
        messages?: Array<{ role?: string; content?: string }>
      }
      const userPrompt = request.messages?.find((message) => message.role === 'user')?.content ?? ''
      assert.ok(userPrompt.includes('当前提案：'), '断点恢复只能调用全篇总编辑，不应重新生成章节')
      resumedEditorCalls += 1
      return mockedEditorResponse()
    },
    loadCheckpoint: async () => savedCheckpoints.at(-1),
    onProgress: (event) => {
      resumedProgressEvents.push(event)
    },
  },
})
assert.equal(resumedEditorCalls, 1)
assert.equal(resumedContent.generationAudit?.resumedChapters?.length, rootDefinitions.length)
assert.equal(
  resumedProgressEvents.filter((event) => event.phase === 'resumed').length,
  rootDefinitions.length,
)

const webOnlySources = structuredClone(sources)
webOnlySources[0] = {
  ...webOnlySources[0],
  sourceType: 'public_web',
  sourceId: 'https://example.com/company-profile',
  sourceName: '公开信息｜星河机器人公司简介',
}
const webOnlySourceSet = [webOnlySources[0]]
const webOnlyPlan = buildInvestmentProposalEvidencePlan(webOnlySourceSet, blueprint)
const webOnlyProfileContent: BusinessContent = {
  ...structuredClone(content),
  sections: [
    structuredClone(content.sections.find((section) =>
      section.title === '（一）公司简介')!),
  ],
}
const publicWebAsFactReview = reviewInvestmentProposalContent({
  content: webOnlyProfileContent,
  blueprint,
  evidencePlan: webOnlyPlan,
  sources: webOnlySourceSet,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
  sectionIds: new Set(['company.profile']),
})
assert.equal(publicWebAsFactReview.passed, false)
assert.ok(publicWebAsFactReview.issues.some((issue) =>
  issue.code === 'PUBLIC_WEB_REQUIRES_VERIFICATION'))
const pendingPublicWebContent = structuredClone(webOnlyProfileContent)
pendingPublicWebContent.sections[0].findings[0].status = '待核验'
const pendingPublicWebReview = reviewInvestmentProposalContent({
  content: pendingPublicWebContent,
  blueprint,
  evidencePlan: webOnlyPlan,
  sources: webOnlySourceSet,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
  sectionIds: new Set(['company.profile']),
})
assert.equal(pendingPublicWebReview.passed, true, JSON.stringify(pendingPublicWebReview.issues, null, 2))

const evidenceAvailableButMissingContent = structuredClone(content)
const companyProfileSection = evidenceAvailableButMissingContent.sections
  .find((section) => section.title === '（一）公司简介')!
companyProfileSection.summary = CURRENT_PROJECT_NO_DATA
companyProfileSection.findings = [{
  text: '公司的法律主体、成立时间、注册地和主营业务尚未明确，申请立项前应取得工商档案、公司章程和业务说明并完成核对。',
  status: '资料缺口',
  sourceIndexes: [],
}]
companyProfileSection.tables = []
const limitedFullReview = reviewInvestmentProposalContent({
  content: evidenceAvailableButMissingContent,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(limitedFullReview.passed, true, JSON.stringify(limitedFullReview.issues, null, 2))
assert.ok(limitedFullReview.issues.some((reviewIssue) =>
  reviewIssue.code === 'EVIDENCE_AVAILABLE_BUT_MISSING'
  && reviewIssue.severity === 'warning'))
const companyRootSectionIds = new Set(blueprint.sections
  .filter((definition) => definition.id === 'company' || definition.parentId === 'company')
  .map((definition) => definition.id))
const chapterRetryReview = reviewInvestmentProposalContent({
  content: evidenceAvailableButMissingContent.sections
    .filter((section) => {
      const definition = blueprint.sections.find((item) => item.title === section.title)
      return definition ? companyRootSectionIds.has(definition.id) : false
    })
    .reduce<BusinessContent>((partial, section) => ({
      ...partial,
      sections: [...partial.sections, section],
    }), {
      ...evidenceAvailableButMissingContent,
      sections: [],
    }),
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
  sectionIds: companyRootSectionIds,
})
assert.equal(chapterRetryReview.passed, false)
assert.ok(chapterRetryReview.issues.some((reviewIssue) =>
  reviewIssue.code === 'EVIDENCE_AVAILABLE_BUT_MISSING'
  && reviewIssue.severity === 'error'))

const malicious = structuredClone(content)
const firstLeaf = malicious.sections.find((section) => section.findings.length)!
firstLeaf.findings[0].text += '未经证据支持的金额为9999万元。'
const maliciousReview = reviewInvestmentProposalContent({
  content: malicious,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(maliciousReview.passed, false)
assert.ok(maliciousReview.issues.some((issue) => issue.code === 'UNSUPPORTED_NUMBER'))

const incompleteRisk = structuredClone(content)
incompleteRisk.sections.find((section) => section.title === '五、风险提示与对策')!
  .findings[0].text = '公司存在经营风险。'
const incompleteRiskReview = reviewInvestmentProposalContent({
  content: incompleteRisk,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(incompleteRiskReview.passed, false)
assert.ok(incompleteRiskReview.issues.some((issue) => issue.code === 'RISK_ACTION_CHAIN_INCOMPLETE'))

const unconditionalConclusion = structuredClone(content)
unconditionalConclusion.sections.find((section) => section.title === '六、结论')!
  .findings[0].text = '建议推进项目。'
const unconditionalConclusionReview = reviewInvestmentProposalContent({
  content: unconditionalConclusion,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(unconditionalConclusionReview.passed, false)
assert.ok(unconditionalConclusionReview.issues.some((issue) => issue.code === 'CONDITIONAL_CONCLUSION_REQUIRED'))

const missingDispositionConclusion = structuredClone(content)
missingDispositionConclusion.sections.find((section) => section.title === '六、结论')!
  .findings[0].text = '建议在完成关键资料核验并落实交易条件后推进下一阶段。'
const missingDispositionConclusionReview = reviewInvestmentProposalContent({
  content: missingDispositionConclusion,
  blueprint,
  evidencePlan,
  sources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(missingDispositionConclusionReview.passed, false)
assert.ok(missingDispositionConclusionReview.issues.some((issue) =>
  issue.code === 'CONDITIONAL_CONCLUSION_REQUIRED'))

assert.throws(
  () => buildInvestmentProposalEvidencePlan([
    ...sources,
    {
      sourceType: 'project_document',
      sourceName: '投资提案模板.docx',
      content: '该内容不得作为当前项目证据。',
    },
  ], blueprint),
  /模板文件不得进入当前项目证据集合/,
)

const missingEvidenceSources: EvidenceSource[] = []
const missingPlan = buildInvestmentProposalEvidencePlan(missingEvidenceSources, blueprint)
const missingSections: BusinessSection[] = blueprint.sections.map((definition) =>
  definition.container
    ? { title: definition.title, summary: '', findings: [], tables: [] }
    : {
        title: definition.title,
        summary: CURRENT_PROJECT_NO_DATA,
        findings: [{
          text: '该事项涉及的关键事实尚未明确，进入下一阶段前应补充相关文件并完成核对。',
          status: '资料缺口',
          sourceIndexes: [],
        }],
        tables: [],
      })
const missingSection = missingSections.find((section) => section.findings.length)!
const noDataContent: BusinessContent = {
  ...content,
  sections: missingSections,
}
const missingReview = reviewInvestmentProposalContent({
  content: noDataContent,
  blueprint,
  evidencePlan: missingPlan,
  sources: missingEvidenceSources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(containsInvestmentProposalGenericNoDataPreface(missingSection.findings[0].text), false)
assert.equal(missingReview.passed, true)
assert.ok(missingReview.issues.some((issue) =>
  issue.code === 'MISSING_EVIDENCE_RESEARCH_REQUIRED'
  && issue.severity === 'warning'
  && isInvestmentProposalDeliveryLimitation(issue.code)))

const docxPath = path.join(outputDirectory, '星河机器人项目投资提案-验收.docx')
const pdfPath = path.join(outputDirectory, '星河机器人项目投资提案-验收.pdf')
const generation = await generateInvestmentProposalDocx({
  outputPath: docxPath,
  template,
  project: {
    name: '星河机器人项目',
    companyName: '星河机器人有限公司',
  },
  content,
  sources,
  sourceCutoffDate: '2026-07-20',
  generatedAt: new Date('2026-07-25T00:00:00+08:00'),
  blueprint,
})
const wordReview = await reviewInvestmentProposalDocx({
  filePath: docxPath,
  template,
  blueprint,
  content,
  projectName: '星河机器人项目',
})
assert.equal(wordReview.passed, true, JSON.stringify(wordReview.issues, null, 2))
const docxZip = await JSZip.loadAsync(await readFile(docxPath))
const documentXml = await docxZip.file('word/document.xml')!.async('string')
assert.equal(documentXml.includes('免责声明'), false)
assert.equal(documentXml.includes('引用资料'), false)
assert.equal(documentXml.includes(template.disclaimer), false)
assert.equal(documentXml.includes('资料来源：S'), false)
assert.equal(documentXml.includes('〔资料记载〕'), false)
assert.equal(documentXml.includes('〔分析判断〕'), false)
assert.equal(documentXml.includes('〔待核验〕'), false)
assert.equal(documentXml.includes('〔资料缺口〕'), false)
assert.equal(documentXml.includes('待核验'), false)
assert.equal(documentXml.includes('现阶段尚不能形成结论'), false)
assert.doesNotMatch(
  documentXml,
  /判断：|依据：|影响\/约束：|待办：|订单节奏：|客户结构：|财务情况：|项目资料|资料库|会议纪要|原始文件|原始资料|现有资料|当前资料|(?:\.{3}|…)\s*展开|原文链接|来源网址|总体来看|值得注意的是|由此可见/,
)

const pdfReview = await exportAndReviewInvestmentProposalPdf({
  docxPath,
  pdfPath,
  template,
  blueprint,
  content,
})
assert.equal(pdfReview.passed, true, JSON.stringify(pdfReview.issues, null, 2))

const limitedDocxPath = path.join(outputDirectory, '星河机器人项目投资提案-受限初稿-验收.docx')
const limitedPdfPath = path.join(outputDirectory, '星河机器人项目投资提案-受限初稿-验收.pdf')
await generateInvestmentProposalDocx({
  outputPath: limitedDocxPath,
  template,
  project: {
    name: '星河机器人项目',
    companyName: '星河机器人有限公司',
  },
  content: evidenceAvailableButMissingContent,
  sources,
  sourceCutoffDate: '2026-07-20',
  generatedAt: new Date('2026-07-25T00:00:00+08:00'),
  blueprint,
})
const limitedWordReview = await reviewInvestmentProposalDocx({
  filePath: limitedDocxPath,
  template,
  blueprint,
  content: evidenceAvailableButMissingContent,
  projectName: '星河机器人项目',
})
assert.equal(limitedWordReview.passed, true, JSON.stringify(limitedWordReview.issues, null, 2))
const limitedPdfReview = await exportAndReviewInvestmentProposalPdf({
  docxPath: limitedDocxPath,
  pdfPath: limitedPdfPath,
  template,
  blueprint,
  content: evidenceAvailableButMissingContent,
})
assert.equal(limitedPdfReview.passed, true, JSON.stringify(limitedPdfReview.issues, null, 2))

console.log(JSON.stringify({
  passed: true,
  skill: {
    name: skill.name,
    version: skill.version,
    references: skill.referenceNames,
  },
  blueprint: {
    version: blueprint.version,
    templateVersion: blueprint.templateVersion,
    corpusSha256: blueprint.corpusSha256,
    parsedTemplates: blueprint.templates.length,
    sections: blueprint.sections.length,
    leafSections: leafDefinitions.length,
    requiredAnalyses: blueprint.requiredAnalysisKinds,
  },
  evidence: evidencePlan.coverage,
  contentReview,
  negativeChecks: {
    userInputPriorityPassed: true,
    unsupportedNumberRejected: true,
    incompleteRiskRejected: true,
    unconditionalConclusionRejected: true,
    missingDispositionConclusionRejected: true,
    templateEvidenceRejected: true,
    projectKnowledgePrimary: true,
    publicWebForcedToPendingVerification: true,
    limitedNoDataDraftAccepted: true,
    evidenceGapRetriedThenDowngraded: true,
    malformedChapterJsonRetried: true,
    incompatibleTemperatureOmitted: true,
    httpParameterFailureDeliveredEvidenceFallback: true,
    internalErrorTextExcludedFromDelivery: true,
    webNavigationAndFooterTextRejected: true,
    wrongEquityTableSchemaRejected: true,
    timeoutWithDomCodeRetried: true,
    authorizationFailureNotRetried: true,
    promptCompacted: true,
    chapterProgressMonotonic: true,
    checkpointResumePassed: true,
    boundedParallelismPassed: true,
    technicalFailureHiddenFromUser: true,
    limitedDraftWordAndPdfPassed: true,
    disclaimerAndReferencesOmitted: true,
  },
  word: {
    path: docxPath,
    generation,
    review: wordReview,
  },
  pdf: {
    path: pdfPath,
    review: pdfReview,
  },
  limitedDraft: {
    wordPath: limitedDocxPath,
    wordReview: limitedWordReview,
    pdfPath: limitedPdfPath,
    pdfReview: limitedPdfReview,
  },
}, null, 2))
