import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  generateProjectQaDocx,
  inspectProjectQaDocx,
} from '../services/aiQaDocumentService.js'
import {
  PROJECT_QA_DOCUMENT_CATEGORIES,
  PROJECT_QA_QUESTION_COUNTS,
  PROJECT_QA_READING_ORDER,
  buildProjectQaDocumentContent,
  checkDuplicateQuestions,
  composeProjectQaStructuredAnswer,
  generateProjectQaAnswers,
  generateProjectQaQuestions,
  reviewProjectQaAnswers,
} from '../services/aiQaPipelineService.js'
import {
  extractProjectQaPublicPageText,
  fetchProjectQaModelEvidence,
} from '../services/aiQaModelResearchService.js'
import { loadAiSkill } from '../services/aiSkillService.js'
import { AI_QA_TEMPLATE, AI_TEMPLATE_CATALOG } from '../services/aiTemplateCatalog.js'
import { parseQaTemplateCorpus } from '../services/aiQaTemplateParser.js'
import type { EvidenceSource } from '../services/aiBusinessContentService.js'

type Check = { name: string; passed: boolean; detail: string }
const checks: Check[] = []

function assert(name: string, condition: boolean, detail: string) {
  checks.push({ name, passed: condition, detail })
  if (!condition) throw new Error(`${name}：${detail}`)
}

async function main() {
  process.env.AI_QA_DISABLE_LLM = '1'
  const outputDir = process.env.AI_QA_ACCEPTANCE_OUTPUT
    ? path.resolve(process.env.AI_QA_ACCEPTANCE_OUTPUT)
    : await mkdtemp(path.join(os.tmpdir(), 'qa-pipeline-acceptance-'))
  await mkdir(outputDir, { recursive: true })

  const template = AI_TEMPLATE_CATALOG.project_qa
  const profile = await parseQaTemplateCorpus(AI_QA_TEMPLATE.referencePaths)
  assert(
    '阶段1 Template Parser：五份模板全部解析',
    profile.files.length === 5 && profile.files.every((file) => file.pageCount > 0),
    `${profile.files.length} 份 / ${profile.files.map((file) => file.pageCount).join('、')} 页`,
  )
  assert(
    '阶段1 Template Parser：A4、问题目录、回答结构与分维度结构通过',
    profile.files.every((file) =>
      Math.abs(file.pageWidth - 595.3) < 2
      && Math.abs(file.pageHeight - 841.9) < 2
      && file.questionCount > 0)
      && profile.files.some((file) => file.answerLabels.length > 0)
      && profile.files.some((file) => file.usesDimensionBreakdown),
    profile.corpusSha256,
  )

  const skill = await loadAiSkill('answer-project-qa')
  assert(
    '阶段2 Skill：契约、Workflow 与 Pipeline Prompts 已加载',
    [
      'references/qa-contract.md',
      'references/qa-template-style-guide.md',
      'references/workflow.md',
      'references/pipeline-prompts.md',
    ].every((name) => skill.referenceNames.includes(name)),
    skill.referenceNames.join('、'),
  )

  const project = {
    name: '工业巡检机器人 Q&A 自动验收项目',
    companyName: '自动验收机器人科技有限公司',
    industry: '机器人',
    stage: '初筛',
    financing: '计划融资 3000 万元，用于中试验证与客户试点',
    valuation: '估值资料待补充',
    summary: '项目拟将机器人控制技术工程化为工业巡检产品。',
    businessModel: '拟通过设备销售与运维服务取得收入。',
    market: '目标应用场景为工业园区巡检，客户预算和采购周期待核验。',
    team: '核心团队包括技术负责人和工程化人员，全职状态待核验。',
  }
  const sources: EvidenceSource[] = [
    {
      sourceType: 'project_record',
      sourceId: 'acceptance-project',
      sourceName: '项目档案',
      chunkIndex: 0,
      versionOrDate: '2026-07-25',
      content: [
        '公司主体：自动验收机器人科技有限公司。',
        '所属行业：机器人。',
        '发展阶段：初筛。',
        '项目概述：项目拟将机器人控制技术工程化为工业巡检产品。',
        '股权结构：创始团队拟控股，工商股东和持股比例待原件核验。',
        '商业模式：拟通过设备销售与运维服务取得收入。',
        '融资计划：计划融资 3000 万元，用于中试验证与客户试点。',
      ].join('\n'),
    },
    {
      sourceType: 'material',
      sourceId: 'material-1',
      sourceName: '产品与研发说明',
      chunkIndex: 3,
      versionOrDate: '2026-07-20',
      content: [
        '核心产品为工业巡检机器人样机，已完成测试环境下的基本功能验证。',
        '核心技术由技术负责人牵头，创始团队全职状态和知识产权权属文件尚待核验。',
        '项目已与一家工业园区开展客户试点沟通，尚未形成正式合同、验收或回款。',
        '当前知识产权清单、成果权属证明和历史融资文件尚未提供。',
      ].join('\n'),
    },
  ]
  const modelResearch = await fetchProjectQaModelEvidence({
    project,
    currentSources: sources,
    sourceCutoffDate: '2026-07-25',
    parameters: { nativeModelSearch: true },
    requestedTopics: ['产品、技术指标与工程化里程碑'],
    fetchImpl: (async (url) => {
      if (String(url).includes('/chat/completions')) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                results: [{
                  topic: '产品、技术指标与工程化里程碑',
                  title: '自动验收机器人项目工程化进展',
                  url: 'https://example.com/qa-project',
                  publisher: '示例机器人研发中心',
                  publishedAt: '2026-07-18',
                }],
              }),
            },
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(
        '<html><head><title>自动验收机器人项目工程化进展 - 示例平台首页</title></head><body>'
        + '<header>首页 权威榜 价值榜 行业数据 产业图谱 行业研究 查询企业 企业入驻 登录 小程序</header>'
        + '<main><article><p>自动验收机器人科技有限公司公开展示工业巡检机器人样机。</p>'
        + '<p>样机完成测试环境连续运行验证，项目团队正在推进中试环境部署。</p>'
        + `<p>${'机器人研发中心披露，本次展示对应具体机器人控制技术和工程化项目。'.repeat(10)}</p>`
        + '</article></main>'
        + '<footer>联系我们 微信号：example 京ICP备123456号 Copyright © 2026 All Rights Reserved.</footer>'
        + '</body></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      )
    }) as typeof fetch,
    resolveHost: async () => ['93.184.216.34'],
    now: new Date('2026-07-25T08:00:00Z'),
  })
  assert(
    '阶段2 Model Network Research：项目大模型发现并核验公开页面',
    modelResearch.sources.length === 1
      && modelResearch.sources[0]?.sourceType === 'public_web_llm'
      && modelResearch.sources[0]?.locator === 'https://example.com/qa-project'
      && !modelResearch.sources[0]?.content.includes('示例平台首页')
      && modelResearch.audit.verifiedSourceCount === 1,
    JSON.stringify(modelResearch.audit),
  )
  const noisyPublicPageText = extractProjectQaPublicPageText(
    '<html><body>'
    + '<nav>首页 权威榜 价值榜 行业数据 产业图谱 行业研究 查询企业 企业入驻 登录 小程序</nav>'
    + '<main><p>智灵动力围绕多模态理解与交互开发人机共生智能引擎。</p>'
    + '<p>该页面称公司正在迭代自适应参数与蒸馏能力，产品成熟度仍需项目原件核验。</p></main>'
    + '<footer>联系我们 邮箱：test@example.com 京ICP备123456号 Copyright © 2026 All Rights Reserved.</footer>'
    + '</body></html>',
  )
  assert(
    '阶段2 Page Verification：网页正文去除导航、联系方式、备案与版权页脚',
    noisyPublicPageText.includes('人机共生智能引擎')
      && !/权威榜|产业图谱|联系我们|test@example|京ICP备|Copyright|All Rights Reserved/.test(
        noisyPublicPageText,
      ),
    noisyPublicPageText,
  )
  const nearNameEntityResearch = await fetchProjectQaModelEvidence({
    project: {
      name: '智灵动力有限公司',
      companyName: '智灵动力有限公司',
    },
    currentSources: [{
      sourceType: 'project_record',
      sourceId: 'near-name-project',
      sourceName: '项目档案',
      chunkIndex: 0,
      versionOrDate: '2026-07-25',
      content: '公司主体：智灵动力有限公司。',
    }],
    sourceCutoffDate: '2026-07-25',
    requestedTopics: ['项目主体与工商'],
    fetchImpl: (async (url) => {
      if (String(url).includes('search.brave.com/search')) {
        return new Response(
          '<html><body><a href="https://example.com/near-name-company">智灵动力公司详情</a></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        )
      }
      return new Response(
        '<html><head><title>智灵动力公司详情</title></head><body><main>'
        + '<p>智灵动力（北京）科技有限公司成立于2024年，注册资本100万元。</p>'
        + `<p>${'该公司披露人机共生智能引擎及多模态交互产品。'.repeat(15)}</p>`
        + '</main></body></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      )
    }) as typeof fetch,
    resolveHost: async () => ['93.184.216.34'],
    now: new Date('2026-07-25T08:00:00Z'),
  })
  assert(
    '阶段2 Entity Match：近名公司页面不得确认当前项目工商事实',
    nearNameEntityResearch.sources.length === 0
      && nearNameEntityResearch.audit.proposedSourceCount === 1
      && nearNameEntityResearch.audit.rejectedSourceCount === 1,
    JSON.stringify(nearNameEntityResearch.audit),
  )
  const directSearchResearch = await fetchProjectQaModelEvidence({
    project,
    currentSources: sources,
    sourceCutoffDate: '2026-07-25',
    requestedTopics: ['客户、订单与商业化信号'],
    fetchImpl: (async (url) => {
      if (String(url).includes('search.brave.com/search')) {
        return new Response(
          '<html><body><a href="https://example.com/qa-commercial">'
          + '自动验收机器人客户试点进展</a></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        )
      }
      return new Response(
        '<html><head><title>自动验收机器人客户试点进展</title></head><body>'
        + '自动验收机器人科技有限公司与工业园区开展工业巡检机器人客户试点，'
        + '双方完成现场测试，但尚未披露正式采购合同、验收单或回款凭证。'.repeat(12)
        + '</body></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      )
    }) as typeof fetch,
    resolveHost: async () => ['93.184.216.34'],
    now: new Date('2026-07-25T08:00:00Z'),
  })
  assert(
    '阶段2 Direct Search：原生模型无搜索能力时仍可联网发现并核验页面',
    directSearchResearch.sources.length === 1
      && directSearchResearch.audit.discovery === 'direct_search'
      && directSearchResearch.sources[0]?.locator === 'https://example.com/qa-commercial',
    JSON.stringify(directSearchResearch.audit),
  )
  const agentCandidateResearch = await fetchProjectQaModelEvidence({
    project,
    currentSources: sources,
    candidateSources: [{
      sourceType: 'public_web_agent_search',
      sourceId: 'agent-candidate',
      sourceName: 'Flue 情报发现·产品与技术·自动验收机器人项目进展',
      chunkIndex: 0,
      versionOrDate: '2026-07-18',
      locator: 'https://example.com/qa-agent-candidate',
      content: [
        '检索方式：联网检索 Agent 调用 intel-collect 工作流。',
        '页面标题：自动验收机器人项目进展',
        '来源网址：https://example.com/qa-agent-candidate',
      ].join('\n'),
    }],
    sourceCutoffDate: '2026-07-25',
    requestedTopics: ['产品、技术指标与工程化里程碑'],
    fetchImpl: (async (url) => {
      if (String(url).includes('search.brave.com/search')
        || String(url).includes('duckduckgo.com/html')) {
        return new Response('<html><body></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      }
      return new Response(
        '<html><head><title>自动验收机器人项目进展</title></head><body>'
        + '自动验收机器人科技有限公司公开展示工业巡检机器人样机，'
        + '项目完成测试环境连续运行验证，正在推进中试环境部署。'.repeat(12)
        + '</body></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      )
    }) as typeof fetch,
    resolveHost: async () => ['93.184.216.34'],
    now: new Date('2026-07-25T08:00:00Z'),
  })
  assert(
    '阶段2 Flue Intel Discovery：普通会话同源候选经过页面核验后进入证据',
    agentCandidateResearch.sources.length === 1
      && agentCandidateResearch.audit.discovery === 'agent_search'
      && agentCandidateResearch.audit.agentCandidateCount === 1
      && agentCandidateResearch.sources[0]?.locator === 'https://example.com/qa-agent-candidate',
    JSON.stringify(agentCandidateResearch.audit),
  )
  const enrichedSources = [...sources, ...modelResearch.sources]
  assert(
    '阶段2 Current Project RAG：本地资料优先并使用 Flue 同源联网发现',
    sources.length === 2
      && sources.every((source) => !source.sourceType.startsWith('public_web'))
      && skill.instructions.includes('Flue `intel-collect`')
      && !/早期投资项目线索分析师|值得接触|作为对标|清华系/.test(
        `${skill.instructions}\n${skill.referenceInstructions}`,
      ),
    sources.map((source) => `${source.sourceType}:${source.sourceName}`).join('、'),
  )

  const duplicateFixture = [
    {
      id: 'Q001',
      category: '风险与核验' as const,
      question: '项目成果权属、团队投入和商业化风险如何？',
      rationale: '影响投资判断。',
      priority: '高' as const,
    },
    {
      id: 'Q002',
      category: '风险与核验' as const,
      question: '项目成果权属、团队投入和商业化风险究竟如何？',
      rationale: '影响投资判断。',
      priority: '中' as const,
    },
  ]
  const duplicateFixtureResult = checkDuplicateQuestions(duplicateFixture)
  assert(
    '阶段3 Duplicate Checker：近重复问题可识别并删除',
    duplicateFixtureResult.removed.length === 1 && duplicateFixtureResult.questions.length === 1,
    JSON.stringify(duplicateFixtureResult.removed),
  )

  const duplicateCheck = await generateProjectQaQuestions({
    project,
    mode: '投资委员会 Q&A',
    depth: '标准版',
    sources: enrichedSources,
    skill,
  })
  assert(
    '阶段3 Question Generator：标准版动态选取七个高价值问题',
    duplicateCheck.questions.length === PROJECT_QA_QUESTION_COUNTS.标准版
      && new Set(duplicateCheck.questions.map((question) => question.category)).size
        === duplicateCheck.questions.length,
    `${duplicateCheck.questions.length} 题`,
  )
  assert(
    '阶段3 Duplicate Checker：最终问题无重复且编号连续',
    checkDuplicateQuestions(duplicateCheck.questions).removed.length === 0
      && duplicateCheck.questions.every((question, index) =>
        question.id === `Q${String(index + 1).padStart(3, '0')}`)
      && duplicateCheck.questions.every((question, index, questions) =>
        index === 0
        || PROJECT_QA_READING_ORDER.indexOf(questions[index - 1].category)
          < PROJECT_QA_READING_ORDER.indexOf(question.category)),
    duplicateCheck.questions.map((question) => question.id).join('、'),
  )
  const deepDuplicateCheck = await generateProjectQaQuestions({
    project,
    mode: '尽调 Q&A',
    depth: '深度版',
    sources: enrichedSources,
    skill,
  })
  assert(
    '阶段3 Question Generator：深度版动态选取十题且无重复',
    deepDuplicateCheck.questions.length === PROJECT_QA_QUESTION_COUNTS.深度版
      && checkDuplicateQuestions(deepDuplicateCheck.questions).removed.length === 0,
    `${deepDuplicateCheck.questions.length} 题`,
  )

  const draftAnswers = await generateProjectQaAnswers({
    project,
    mode: '投资委员会 Q&A',
    questions: duplicateCheck.questions,
    sources: enrichedSources,
    skill,
  })
  const reviewed = await reviewProjectQaAnswers({
    project,
    questions: duplicateCheck.questions,
    answers: draftAnswers,
    sources: enrichedSources,
    duplicateCheck,
    skill,
  })
  assert(
    '阶段4 Answer Generator：每题均有回答且不使用占位式无资料短语',
    reviewed.answers.length === duplicateCheck.questions.length
      && reviewed.answers.every((answer) =>
        answer.answer.length > 20
        && !/暂无相关资料|暂无资料|无相关资料/.test(answer.answer)
        && !/检索式|Q&A 分类|公开检索记录/.test(answer.answer)
        && (answer.sourceIndexes.length > 0 || answer.confidenceStatus === '证据不足')),
    `${reviewed.answers.length} 个回答 / ${reviewed.review.dataGapCount} 个资料缺口`,
  )
  const dispositionAnswer = reviewed.answers.find((answer) => answer.category === '阶段与推进建议')
  assert(
    '阶段4 Answer Generator：如选择阶段问题则形成与当前阶段匹配的推进建议',
    !dispositionAnswer || Boolean(
      dispositionAnswer.answer.includes('主建议为“继续跟踪”')
      && dispositionAnswer.answer.includes('（1）判断依据：')
      && dispositionAnswer.answer.includes('（2）升级与失效条件：')
      && dispositionAnswer.answer.includes('（3）下一步动作：')
      && dispositionAnswer.answer.includes('（4）OA 流转边界：')
    ),
    dispositionAnswer?.answer ?? '本次按证据价值未选择阶段问题',
  )
  const productAnswer = reviewed.answers.find((answer) => answer.category === '产品与技术')
  assert(
    '阶段4 Answer Generator：引用与问题分类直接相关',
    Boolean(
      productAnswer
      && productAnswer.answer.includes('核心产品')
      && !productAnswer.answer.includes('计划融资'),
    ),
    productAnswer?.answer ?? '未生成产品与技术回答',
  )
  assert(
    '阶段4 Answer Generator：普通问题使用固定逻辑小标题顺序',
    reviewed.answers
      .filter((answer) => answer.category !== '阶段与推进建议' && answer.confidenceStatus !== '证据不足')
      .every((answer) => {
        const facts = answer.answer.indexOf('（1）已确认事实：')
        const analysis = answer.answer.indexOf('（2）分析判断：')
        const boundary = answer.answer.indexOf('（3）证据边界：')
        const verification = answer.answer.indexOf('（4）下一步核验：')
        return facts >= 0 && facts < analysis && analysis < boundary && boundary < verification
      }),
    reviewed.answers.map((answer) => answer.category).join('、'),
  )
  const markdownAndChromeFixture = composeProjectQaStructuredAnswer({
    directAnswer: '**1）判断依据：**综合项目材料与经系统核验的公开页面，智灵动力 - 公司详情 - 产品介绍 - innoHere英诺嘿呀首页权威榜价值榜行业数据产业图谱行业研究查询企业入驻小程序登入公司简介产品介绍业务介绍人机共生智能引擎为核心产品。',
    decisionBasis: [
      '**（1）判断依据：**项目材料显示，核心产品为人机共生智能引擎。',
      '公司正在迭代自适应参数与模型蒸馏能力。',
    ],
    upgradeOrInvalidationConditions: '**（2）升级与失效条件：**取得产品测试与客户验证原件后重新评估。',
    nextAction: '**（3）下一步动作：**核验产品版本、测试报告和客户验收材料。',
    oaBoundary: '**（4）OA 流转边界：**阶段调整以 OA 审批结果为准。',
  }, {
    id: 'Q-FORMAT',
    category: '阶段与推进建议',
    question: '项目下一步如何推进？',
    rationale: '验证格式标准化。',
    priority: '高',
  })
  assert(
    '阶段4 Answer Generator：清除 Markdown、重复标题与网页导航拼接',
    markdownAndChromeFixture.includes('（1）判断依据：项目材料显示')
      && markdownAndChromeFixture.includes('（4）OA 流转边界：阶段调整以 OA 审批结果为准')
      && !/\*\*|(?:^|\n)1）判断依据|权威榜|产业图谱|企业入驻|小程序/.test(
        markdownAndChromeFixture,
      ),
    markdownAndChromeFixture,
  )

  const mismatchRegressionAnswers = await generateProjectQaAnswers({
    project,
    mode: '投资委员会 Q&A',
    questions: [
      {
        id: 'Q001',
        category: '股权与治理',
        question: '项目公司的股权结构、实际控制人和关键股东是否清晰？',
        rationale: '防止产品功能描述被误识别为本项目股权证据。',
        priority: '高',
      },
      {
        id: 'Q002',
        category: '财务与现金流',
        question: '项目最近三年及最新一期的收入、成本、毛利和现金流表现如何？',
        rationale: '区分单位经济性线索与完整财务报表。',
        priority: '高',
      },
      {
        id: 'Q003',
        category: '融资与估值',
        question: '项目发生过哪些融资事件，金额、投资方和估值口径是否清晰？',
        rationale: '区分借款、资产出售和正式股权融资。',
        priority: '高',
      },
      {
        id: 'Q004',
        category: '阶段与推进建议',
        question: '根据当前证据，项目下一步应如何推进？',
        rationale: '防止把平台功能和项目库描述误当成项目推进证据。',
        priority: '高',
      },
    ],
    sources: [{
      sourceType: 'material',
      sourceId: 'mismatch-regression',
      sourceName: '错配回归材料',
      chunkIndex: 0,
      versionOrDate: '2026-07-25',
      content: [
        '产品功能：系统可自动解析被投企业新融资协议和工商变更，并生成股东权益影响分析。',
        '投前研投场景：搭建多维度项目库，覆盖项目线索来源和前沿论文专利。',
        '股东线索：学术志为项目公司第三大股东，完整持股比例和实际控制人仍需工商原件核验。',
        '单位经济性线索：视频生成报价为每分钟 1000-1200 元，公司材料称该业务毛利率低于另一项业务。',
        '融资线索：项目曾取得老股东借款，借款金额、期限及是否转股尚需协议原件核验。',
      ].join('\n'),
    }],
    skill,
  })
  const equityRegression = mismatchRegressionAnswers.find((answer) => answer.category === '股权与治理')
  const financeRegression = mismatchRegressionAnswers.find((answer) => answer.category === '财务与现金流')
  const financingRegression = mismatchRegressionAnswers.find((answer) => answer.category === '融资与估值')
  const dispositionRegression = mismatchRegressionAnswers.find((answer) => answer.category === '阶段与推进建议')
  assert(
    '阶段4 Answer Generator：关键词错配回归通过',
    Boolean(
      equityRegression?.answer.includes('第三大股东')
      && !equityRegression.answer.includes('自动解析被投企业')
      && financeRegression?.answer.includes('毛利率')
      && financeRegression.answer.includes('不能替代连续财务报表')
      && financingRegression?.answer.includes('老股东借款')
      && financingRegression.answer.includes('应严格区分已完成融资')
      && dispositionRegression?.confidenceStatus === '证据不足'
      && !/搭建多维度项目库|自动解析被投企业|股东权益影响分析/.test(
        dispositionRegression.answer,
      ),
    ),
    [
      equityRegression?.answer,
      financeRegression?.answer,
      financingRegression?.answer,
      dispositionRegression?.answer,
    ].filter(Boolean).join('\n---\n'),
  )
  assert(
    '阶段4 Reviewer：重复、完整性、幻觉和引用检查全部通过',
    Object.values(reviewed.review.checks).every(Boolean),
    JSON.stringify(reviewed.review.checks),
  )
  const noEvidenceAnswers = await generateProjectQaAnswers({
    project,
    mode: '尽调 Q&A',
    questions: duplicateCheck.questions,
    sources: [],
    skill,
  })
  assert(
    '阶段4 Answer Generator：无证据时形成具体核验结论',
    noEvidenceAnswers.every((answer) =>
      answer.confidenceStatus === '证据不足'
      && answer.answer.includes('现阶段')
      && !/暂无相关资料|暂无资料|无相关资料/.test(answer.answer)
      && (answer.category !== '阶段与推进建议'
        || /进入初筛|继续跟踪|申请立项|启动尽调|提请上会|提交投决|暂缓推进|归档/.test(answer.answer))
      && answer.sourceIndexes.length === 0
      && answer.supportingQuotes.length === 0),
    `${noEvidenceAnswers.filter((answer) => answer.confidenceStatus === '证据不足').length}/${noEvidenceAnswers.length}`,
  )

  const content = buildProjectQaDocumentContent({
    project,
    mode: '投资委员会 Q&A',
    depth: '标准版',
    questions: duplicateCheck.questions,
    answers: reviewed.answers,
    review: reviewed.review,
  })
  const contentWithMarkdownFixture = {
    ...content,
    answers: content.answers.map((answer, index) => {
      if (index === content.answers.length - 1) {
        return {
          ...answer,
          confidenceStatus: '证据不足' as const,
          answer: [
            '截至资料截止日，当前证据尚不足以形成确定结论，只能先明确核验边界。',
            '（4）下一步核验：取得原件或责任人访谈后更新本题。',
            '（3）已确认事实：现有证据未形成能够相互印证的完整证据链。',
            '（2）分析判断：证据不足不代表相关事项不存在。',
            '（3）证据边界：需要补充对应原件、量化数据和管理层说明。',
          ].join('\n'),
        }
      }
      if (index !== 0) return answer
      const [lead, ...dimensions] = answer.answer.split('\n')
      return {
        ...answer,
        answer: [
          `**${lead}**`,
          ...dimensions.map((dimension) => `**${dimension.match(/^[^：:]+[：:]/)?.[0] ?? ''}**${
            dimension.replace(/^[^：:]+[：:]/, '')
          }`),
        ].join('\n'),
      }
    }),
  }
  const docxPath = path.join(outputDir, 'qa-acceptance.docx')
  await generateProjectQaDocx({
    outputPath: docxPath,
    project,
    content: contentWithMarkdownFixture,
    sources: enrichedSources,
    sourceCutoffDate: '2026-07-25',
    templateProfile: profile,
    disclaimer: template.disclaimer,
  })
  const docxReview = await inspectProjectQaDocx(docxPath, {
    questionCount: content.questions.length,
    categoryCount: PROJECT_QA_DOCUMENT_CATEGORIES.length,
  })
  assert(
    '阶段5 DOCX Formatter：正式文档结构与 OpenXML 通过',
    docxReview.qualityStatus === 'passed'
      && docxReview.metadata.questionCount === PROJECT_QA_QUESTION_COUNTS.标准版
      && docxReview.metadata.categoryCount === 15
      && docxReview.metadata.directoryCompleteBeforeBody
      && docxReview.metadata.subheadingOrderValid
      && docxReview.metadata.sourceOutlineNumberingAbsent
      && docxReview.metadata.markdownDecorationAbsent
      && docxReview.metadata.webPageChromeAbsent,
    JSON.stringify(docxReview.metadata),
  )
  assert(
    '阶段6 Word/WPS Review：正式 DOCX 可编辑且中文编码正常',
    docxReview.metadata.editableText
      && docxReview.metadata.encodingClean
      && docxReview.metadata.bytes > 2000,
    JSON.stringify(docxReview.metadata),
  )

  const report = {
    generatedAt: new Date().toISOString(),
    passed: checks.every((check) => check.passed),
    checks,
    outputDir,
    docxPath,
    templateCorpusSha256: profile.corpusSha256,
    skillVersion: skill.version,
  }
  const reportPath = path.join(outputDir, 'qa-acceptance-report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
