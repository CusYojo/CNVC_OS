import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  inspectProjectQaDocx,
} from '../services/aiQaDocumentService.js'
import { generateProjectQaWithSkill } from '../services/aiProjectQaSkillRuntimeService.js'
import {
  PROJECT_QA_DOCUMENT_CATEGORIES,
  PROJECT_QA_QUESTION_COUNTS,
  PROJECT_QA_READING_ORDER,
  buildProjectQaDocumentContent,
  checkDuplicateQuestions,
  composeProjectQaStructuredAnswer,
  generateProjectQaAnswers,
  generateProjectQaQuestions,
  isHighValueProjectQaQuestion,
  projectQaQuestionDepthScore,
  reviewProjectQaAnswers,
} from '../services/aiQaPipelineService.js'
import {
  extractProjectQaPublicPageText,
  fetchProjectQaModelEvidence,
} from '../services/aiQaModelResearchService.js'
import { AI_QA_SKILL_NAME, loadAiSkill } from '../services/aiSkillService.js'
import { createProjectQaSkillProfile } from '../services/aiQaTemplateParser.js'
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

  const skill = await loadAiSkill(AI_QA_SKILL_NAME)
  const profile = createProjectQaSkillProfile(skill)
  assert(
    '阶段1 Skill Profile：统一加载 generate-project-qa-report',
    skill.name === 'generate-project-qa-report'
      && profile.parserVersion === 'generate-project-qa-report-profile-v1',
    `${skill.name} / ${profile.parserVersion}`,
  )
  assert(
    '阶段1 Skill Profile：A4 直接式 Q&A 契约通过',
    profile.files.length === 1
      && profile.files.every((file) =>
        Math.abs(file.pageWidth - 595.3) < 2
        && Math.abs(file.pageHeight - 841.9) < 2
        && file.questionCount >= 8
        && !file.hasQuestionIndex
        && file.answerLabels.length === 0)
      && profile.consensus.openingPattern.includes('直接进入 Q1'),
    profile.corpusSha256,
  )

  assert(
    '阶段2 Skill：结构、写作、证据和版式规则已加载',
    [
      'references/structure-blueprint.md',
      'references/section-writing-guide.md',
      'references/evidence-and-quality-rules.md',
      'references/format-guidelines.md',
    ].every((name) => skill.referenceNames.includes(name)),
    skill.referenceNames.join('、'),
  )
  assert(
    '阶段2 Skill：直接式 Q&A 与无来源正文规则已加载',
    skill.instructions.includes('标题后立即进入 Q1')
      && skill.instructions.includes('不添加独立的“结论：”段落')
      && skill.instructions.includes('标准读者版不展示来源清单'),
    '直接进入 Q1、自然分析、正文不显示来源',
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
    '阶段2 Current Project RAG：授权资料优先并按缺口定向补充',
    sources.length === 2
      && sources.every((source) => !source.sourceType.startsWith('public_web'))
      && skill.instructions.includes('采用自适应研究')
      && skill.instructions.includes('当前对话中输入或粘贴的信息')
      && skill.instructions.includes('用户上传、附加或明确引用的文件与链接')
      && skill.instructions.includes('对其余可研究缺口使用合法网络来源'),
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
  assert(
    '阶段3 Question Generator：拦截信息盘点题并保留投资决策型问题',
    !isHighValueProjectQaQuestion('公司目前有哪些客户？')
      && !isHighValueProjectQaQuestion('项目面临哪些风险？')
      && isHighValueProjectQaQuestion(
        '客户验证能否支撑可复制需求和现金流安全边际？',
      ),
    '问题应以短句检验一个决策假设，分析关系在回答中展开，而非仅盘点信息',
  )

  const duplicateCheck = await generateProjectQaQuestions({
    project,
    mode: '投资委员会 Q&A',
    depth: '标准版',
    sources: enrichedSources,
    skill,
  })
  assert(
    '阶段3 Question Generator：标准版动态选取八个高价值问题',
    duplicateCheck.questions.length === PROJECT_QA_QUESTION_COUNTS.标准版
      && new Set(duplicateCheck.questions.map((question) => question.category)).size
        === duplicateCheck.questions.length
      && duplicateCheck.questions.every((question) => isHighValueProjectQaQuestion(question.question)),
    duplicateCheck.questions
      .map((question) =>
        `${question.category}[depth=${projectQaQuestionDepthScore(question.question)}]:${question.question}`)
      .join('\n'),
  )
  assert(
    '阶段3 Question Generator：默认不生成内部阶段问题或状态词',
    duplicateCheck.questions.every((question) =>
      question.category !== '阶段与推进建议'
      && !/线索|进入初筛|申请立项|提请上会|提交投决|继续跟踪|暂缓推进|归档/.test(
        question.question,
      )),
    duplicateCheck.questions.map((question) => question.question).join('\n'),
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
      && checkDuplicateQuestions(deepDuplicateCheck.questions).removed.length === 0
      && deepDuplicateCheck.questions.every((question) =>
        isHighValueProjectQaQuestion(question.question)),
    `${deepDuplicateCheck.questions.length} 题`,
  )
  const explicitStageCheck = await generateProjectQaQuestions({
    project,
    mode: '投资委员会 Q&A',
    depth: '标准版',
    sources: enrichedSources,
    skill,
    userIntent: '请判断该项目是否已经具备启动尽调条件，并说明下一步如何推进',
  })
  const explicitStageQuestion = explicitStageCheck.questions.find((question) =>
    question.category === '阶段与推进建议')
  assert(
    '阶段3 Question Generator：仅在用户明确要求时生成自然的阶段判断问题',
    Boolean(
      explicitStageQuestion
      && !/线索|进入初筛|申请立项|提请上会|提交投决|继续跟踪|暂缓推进|归档/.test(
        explicitStageQuestion.question,
      )
    ),
    explicitStageQuestion?.question ?? '未生成阶段判断问题',
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
        && !/已经形成可识别的.{0,16}方向|收费方式只是商业模式的起点|商业模式是否成立最终取决于|需要从.{0,24}综合判断|不能混为一谈|当前需要优先处理的是/.test(
          answer.answer,
        )
        && (answer.sourceIndexes.length > 0 || answer.confidenceStatus === '证据不足')),
    `${reviewed.answers.length} 个回答 / ${reviewed.review.dataGapCount} 个资料缺口`,
  )
  const dispositionAnswer = reviewed.answers.find((answer) => answer.category === '阶段与推进建议')
  assert(
    '阶段4 Answer Generator：默认回答不包含内部阶段建议',
    !dispositionAnswer,
    dispositionAnswer?.answer ?? '默认未选择阶段问题',
  )
  const explicitStageAnswers = await generateProjectQaAnswers({
    project,
    mode: '投资委员会 Q&A',
    questions: explicitStageQuestion ? [explicitStageQuestion] : [],
    sources: enrichedSources,
    skill,
    userIntent: '请判断该项目是否已经具备启动尽调条件，并说明下一步如何推进',
  })
  const explicitStageAnswer = explicitStageAnswers[0]
  assert(
    '阶段4 Answer Generator：明确要求阶段判断时使用客户语言',
    Boolean(
      explicitStageAnswer
      && /可以继续评估|具备启动尽调的基础|提交内部投资决策审议|暂不建议继续推进|建议停止评估/.test(
        explicitStageAnswer.answer,
      )
      && !/线索|进入初筛|申请立项|提请上会|提交投决|继续跟踪|暂缓推进|归档/.test(
        explicitStageAnswer.answer,
      )
    ),
    explicitStageAnswer?.answer ?? '未生成阶段判断回答',
  )
  const productAnswer = reviewed.answers.find((answer) => answer.category === '产品与技术')
  assert(
    '阶段4 Answer Generator：引用与问题分类直接相关',
    Boolean(
      productAnswer
      && /产品|技术|原型|样机|成熟度/.test(productAnswer.answer)
      && !productAnswer.answer.includes('计划融资'),
    ),
    productAnswer?.answer ?? '未生成产品与技术回答',
  )
  assert(
    '阶段4 Answer Generator：普通问题按内容形成自然段',
    reviewed.answers
      .filter((answer) => answer.category !== '阶段与推进建议' && answer.confidenceStatus !== '证据不足')
      .every((answer) => {
        const paragraphCount = answer.answer.split(/\n+/).length
        return paragraphCount >= 1
          && paragraphCount <= 6
          && !/（[1-4]）(?:已确认事实|分析判断|证据边界|下一步核验)：/.test(answer.answer)
          && !/项目资料|项目材料|资料库|资料截止日|经系统核验|公开页面/.test(answer.answer)
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
    '阶段4 Answer Generator：清除 Markdown、小标题与网页导航拼接',
    markdownAndChromeFixture.includes('核心产品为人机共生智能引擎')
      && markdownAndChromeFixture.includes('核验产品版本、测试报告和客户验收材料')
      && !/OA|内部审批程序/.test(markdownAndChromeFixture)
      && markdownAndChromeFixture.split(/\n+/).length >= 1
      && markdownAndChromeFixture.split(/\n+/).length <= 6
      && !/\*\*|(?:^|\n)(?:[（(]?[1-4][）)]?)?(?:判断依据|升级与失效条件|下一步动作|OA 流转边界)[：:]|权威榜|产业图谱|企业入驻|小程序|项目资料|项目材料|资料库|经系统核验|公开页面/.test(
        markdownAndChromeFixture,
      ),
    markdownAndChromeFixture,
  )

  const meetingMinutesAnswer = (await generateProjectQaAnswers({
    project,
    mode: '投资委员会 Q&A',
    questions: [{
      id: 'Q-MEETING',
      category: '商业模式',
      question: '公司的收入模式和项目实施方式是什么？',
      rationale: '验证会议纪要只作为内部证据，不显示纪要元数据。',
      priority: '高',
    }],
    sources: [{
      sourceType: 'material',
      sourceId: 'meeting-minutes-regression',
      sourceName: 'FDE 交流纪要',
      chunkIndex: 0,
      versionOrDate: '2026-06-30',
      content: [
        '1 沈阳与智灵 FDE 团队交流纪要交流时间：2026 年 6 月 30 日 10:00-13:30 交流地点：赛智伯乐大会议室交流人员：黄昕、任丽平、沈阳、朱旭琪 收费模式 模式一：按投入人力与规模的传统软件项目制收费。',
        '项目实施流程：需求调研后梳理客户业务流程，再按业务节点配置人员并推进交付。',
      ].join('\n'),
    }],
    skill,
  }))[0]
  assert(
    '阶段4 Answer Generator：会议纪要只提炼业务事实，不复制纪要元数据',
    Boolean(
      meetingMinutesAnswer
      && meetingMinutesAnswer.answer.includes('公司按投入人力与规模')
      && meetingMinutesAnswer.answer.includes('项目实施通常先梳理客户业务流程')
      && meetingMinutesAnswer.answer.split(/\n+/)[0]?.startsWith('公司按投入人力与规模')
      && !/已经提出相应的收费与交付方式|最终取决于|只是商业模式的起点/.test(
        meetingMinutesAnswer.answer,
      )
      && !/会议纪要|交流纪要|访谈纪要|交流时间|交流地点|交流人员|大会议室|黄昕|任丽平/.test(
        meetingMinutesAnswer.answer,
      )
    ),
    meetingMinutesAnswer?.answer ?? '未生成会议纪要回归回答',
  )
  const fragmentAnswer = (await generateProjectQaAnswers({
    project,
    mode: '投资委员会 Q&A',
    questions: [{
      id: 'Q-FRAGMENT',
      category: '客户与商业化',
      question: '现有客户订单能否证明需求可复制；若不能，最关键的反证是什么？',
      rationale: '验证章节标题、孤立短语和重复事实清理。',
      priority: '高',
    }],
    sources: [{
      sourceType: 'material',
      sourceId: 'fragment-regression',
      sourceName: '客户进展说明',
      chunkIndex: 0,
      versionOrDate: '2026-07-25',
      content: [
        '三、核心产品与技术体系。',
        '客户合同、回款、验收与复购。',
        '公司已与甲客户签订 100 万元正式合同。',
        '公司与甲客户签订的正式合同金额为 100 万元。',
      ].join('\n'),
    }],
    skill,
  }))[0]
  assert(
    '阶段4 Answer Generator：清除章节残片、孤立短语和重复事实',
    Boolean(
      fragmentAnswer
      && !/核心产品与技术体系|客户合同、回款、验收与复购/.test(fragmentAnswer.answer)
      && (fragmentAnswer.answer.match(/100\s*万元/g) ?? []).length <= 1
    ),
    fragmentAnswer?.answer ?? '未生成片段清理回归回答',
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
      && financeRegression.answer.includes('完整经营判断')
      && financingRegression?.answer.includes('老股东借款')
      && financingRegression.answer.includes('不应计入已完成股权融资')
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
      && answer.answer.split(/\n+/).length >= 2
      && answer.answer.split(/\n+/).length <= 6
      && !/暂无相关资料|暂无资料|无相关资料/.test(answer.answer)
      && !/项目资料|项目材料|资料库|当前资料|现有证据|资料截止日|经系统核验|公开页面|公司材料称|资料显示|材料显示|会议纪要|交流纪要|访谈纪要|交流时间|交流地点|交流人员|更新本题|本回答|结论置信度/.test(answer.answer)
      && !/线索|进入初筛|申请立项|提请上会|提交投决|继续跟踪|暂缓推进|归档/.test(answer.answer)
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
  const docxPath = path.join(outputDir, 'qa-acceptance.docx')
  const skillNativeContent = {
    ...content,
    answers: content.answers.map((answer) => ({
      ...answer,
      answer: [
        answer.answer
          .replace(/\*\*/g, '')
          .replace(/^（\d+）[^：\n]{2,16}[：:]\s*/gm, ''),
        `对“${answer.category}”的判断不能停留在单一标签或一次性事件。需要把形成收入或投资价值的关键环节按时间顺序还原，区分公司陈述、已经发生的经营事实和仍待实现的目标，并判断这些环节之间是否存在可重复的因果关系。只有同一套产品能力、交付方式和客户价值能够在不同场景中复现，相关优势才可能转化为持续回报。`,
        `进一步分析时，应把业务规模、单位经济性、现金回收和组织投入放在同一口径下观察。规模增长如果依赖同比增加的人力、定制开发或渠道费用，收入扩张未必改善毛利和现金流；反之，如果交付周期缩短、复购提高且回款稳定，才说明产品化和商业模式正在形成。`,
        `风险边界在于，现阶段的局部验证不能自动外推为规模化结果。管理层目标、合作意向、试点、合同、验收、收入确认和实际回款应分别核对，任何一环缺失都会降低预测可靠性；关键人员、知识产权或客户集中度发生变化，也可能使原有判断失效。`,
        `下一步应围绕本题取得能够改变判断的原件和连续数据，并通过客户、核心成员或交易对手访谈交叉确认。完成核实后再更新收入、成本、现金和估值假设；如果关键事实无法闭环，投资方案应收紧安全边际、补充保护条件，或停止继续投入。`,
      ].join('\n'),
    })),
  }
  const skillGeneration = await generateProjectQaWithSkill({
    outputPath: docxPath,
    markdownPath: path.join(outputDir, 'qa-acceptance.md'),
    visualDirectory: path.join(outputDir, 'visual-qa'),
    projectName: project.companyName || project.name,
    content: skillNativeContent,
    skill,
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
      && Number(docxReview.metadata.averageQuestionLength ?? Infinity) <= 32
      && Number(docxReview.metadata.maximumQuestionLength ?? Infinity) <= 88
      && Number(docxReview.metadata.averageAnswerLength ?? 0) >= 420
      && docxReview.metadata.layoutProfile === 'qa_cn_formal_a4'
      && docxReview.metadata.pageGeometryValidated
      && docxReview.metadata.cjkFontValidated
      && docxReview.metadata.lineSpacingValidated
      && docxReview.metadata.frontDirectoryAbsent
      && !docxReview.metadata.directoryCompleteBeforeBody
      && docxReview.metadata.answerParagraphFormValid
      && docxReview.metadata.narrativeParagraphRangeValid
      && docxReview.metadata.visibleAnswerLabelsAbsent
      && docxReview.metadata.visibleSubheadingsAbsent
      && docxReview.metadata.sourceOutlineNumberingAbsent
      && docxReview.metadata.visibleSourceProcessAbsent
      && docxReview.metadata.visibleAuditAppendixAbsent
      && docxReview.metadata.markdownDecorationAbsent
      && docxReview.metadata.webPageChromeAbsent,
    JSON.stringify(docxReview.metadata),
  )
  assert(
    '阶段5 Skill Native Runtime：Markdown 校验、Skill DOCX 渲染与逐页检查通过',
    skillGeneration.skillExecutionMode === 'native-markdown-validated-docx-rendered'
      && skillGeneration.markdownValidation.errors === 0
      && skillGeneration.visualQa.renderedEveryPage
      && skillGeneration.visualQa.pageCount >= PROJECT_QA_QUESTION_COUNTS.标准版,
    JSON.stringify(skillGeneration),
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
