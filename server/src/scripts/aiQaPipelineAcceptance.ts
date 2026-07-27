import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  convertProjectQaDocxToPdf,
  generateProjectQaDocx,
  inspectProjectQaDocx,
  inspectProjectQaPdf,
} from '../services/aiQaDocumentService.js'
import {
  PROJECT_QA_DOCUMENT_CATEGORIES,
  PROJECT_QA_QUESTION_COUNTS,
  buildProjectQaDocumentContent,
  checkDuplicateQuestions,
  generateProjectQaAnswers,
  generateProjectQaQuestions,
  reviewProjectQaAnswers,
} from '../services/aiQaPipelineService.js'
import { loadAiSkill } from '../services/aiSkillService.js'
import { AI_QA_TEMPLATE, AI_TEMPLATE_CATALOG } from '../services/aiTemplateCatalog.js'
import { parseQaTemplateCorpus } from '../services/aiQaTemplateParser.js'
import {
  buildQaWebSearchQueries,
  collectQaPublicEvidence,
} from '../services/aiQaWebResearchService.js'
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
    name: 'Q&A 自动验收项目',
    companyName: '自动验收科技有限公司',
    industry: '企业软件',
    stage: '成长期',
    financing: '计划融资 5000 万元，用于产品研发与市场拓展',
    valuation: '估值资料待补充',
    summary: '公司提供面向企业客户的流程自动化软件产品。',
    businessModel: '采用软件订阅与实施服务相结合的收费模式。',
    market: '目标客户为中大型企业，市场规模测算资料待补充。',
    team: '核心团队由产品、研发和行业销售人员组成，详细履历待补充。',
  }
  const webQueries = buildQaWebSearchQueries(project)
  assert(
    '阶段3 Public Web Research：覆盖十个公开信息主题',
    webQueries.length === 10
      && ['企业介绍', '产品能力', '团队', '市场', '竞争', '客户', '商业模式', '融资', '合规', '未来规划']
        .every((category) => webQueries.some((query) => query.category === category)),
    webQueries.map((query) => query.topic).join('、'),
  )
  const mockWebResearch = await collectQaPublicEvidence({
    project,
    sourceCutoffDate: '2026-07-25',
    now: new Date('2026-07-25T08:00:00Z'),
  }, async (request) => {
    const requestUrl = new URL(String(request))
    const query = requestUrl.searchParams.get('q') ?? ''
    return new Response(JSON.stringify({
      results: [{
        title: `自动验收公开资料｜${query.slice(0, 20)}`,
        content: '公开页面披露了与本次检索主题直接相关的公司、产品或行业信息，具体事实需回到原页面交叉核验。',
        url: `https://example.com/research/${createHash('sha256').update(query).digest('hex').slice(0, 12)}`,
        publishedDate: '2026-07-20',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  assert(
    '阶段3 Public Web Research：公开结果与检索审计均进入内部证据',
    mockWebResearch.successfulQueries === 10
      && mockWebResearch.failedQueries === 0
      && mockWebResearch.sources.some((source) => source.sourceType === 'public_web')
      && mockWebResearch.sources.some((source) => source.sourceType === 'public_web_search_audit'),
    `${mockWebResearch.successfulQueries}/${mockWebResearch.attemptedQueries}，${mockWebResearch.sources.length} 条`,
  )
  const sources: EvidenceSource[] = [
    {
      sourceType: 'project_record',
      sourceId: 'acceptance-project',
      sourceName: '项目档案',
      chunkIndex: 0,
      versionOrDate: '2026-07-25',
      content: [
        '公司主体：自动验收科技有限公司。',
        '所属行业：企业软件。',
        '发展阶段：成长期。',
        '项目概述：公司提供面向企业客户的流程自动化软件产品。',
        '商业模式：采用软件订阅与实施服务相结合的收费模式。',
        '融资计划：计划融资 5000 万元，用于产品研发与市场拓展。',
      ].join('\n'),
    },
    {
      sourceType: 'material',
      sourceId: 'material-1',
      sourceName: '项目运营说明',
      chunkIndex: 3,
      versionOrDate: '2026-07-20',
      content: [
        '公司的核心产品为企业流程自动化平台，现阶段以标准软件订阅和客户实施服务取得收入。',
        '核心团队由产品、研发和行业销售人员组成，详细履历尚待背调材料核验。',
        '当前客户合同、收入明细、回款记录和知识产权清单尚未提供。',
      ].join('\n'),
    },
  ]

  const duplicateFixture = [
    {
      id: 'Q001',
      category: '财务' as const,
      question: '公司的收入、利润和现金流质量如何？',
      rationale: '影响投资判断。',
      priority: '高' as const,
    },
    {
      id: 'Q002',
      category: '财务' as const,
      question: '公司的收入、利润和现金流质量究竟如何？',
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
    sources,
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
        question.id === `Q${String(index + 1).padStart(3, '0')}`),
    duplicateCheck.questions.map((question) => question.id).join('、'),
  )
  const deepDuplicateCheck = await generateProjectQaQuestions({
    project,
    mode: '尽调 Q&A',
    depth: '深度版',
    sources,
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
    sources,
    skill,
  })
  const reviewed = await reviewProjectQaAnswers({
    questions: duplicateCheck.questions,
    answers: draftAnswers,
    sources,
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
  const productAnswer = reviewed.answers.find((answer) => answer.category === '产品能力')
  assert(
    '阶段4 Answer Generator：引用与问题分类直接相关',
    Boolean(
      productAnswer
      && productAnswer.answer.includes('核心产品')
      && !productAnswer.answer.includes('融资计划'),
    ),
    productAnswer?.answer ?? '未生成产品能力回答',
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
      && answer.answer.includes('现阶段无法形成确定结论')
      && !/暂无相关资料|暂无资料|无相关资料/.test(answer.answer)
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
  const pdfPath = path.join(outputDir, 'qa-acceptance.pdf')
  await generateProjectQaDocx({
    outputPath: docxPath,
    project,
    content,
    sources,
    sourceCutoffDate: '2026-07-25',
    templateProfile: profile,
    disclaimer: template.disclaimer,
  })
  const docxReview = await inspectProjectQaDocx(docxPath, {
    questionCount: content.questions.length,
    categoryCount: PROJECT_QA_DOCUMENT_CATEGORIES.length,
  })
  await convertProjectQaDocxToPdf({ docxPath, pdfPath })
  const pdfReview = await inspectProjectQaPdf(pdfPath)
  assert(
    '阶段5 Formatter：内部排版中间件结构与 OpenXML 通过',
    docxReview.qualityStatus === 'passed'
      && docxReview.metadata.questionCount === PROJECT_QA_QUESTION_COUNTS.标准版
      && docxReview.metadata.categoryCount === 15,
    JSON.stringify(docxReview.metadata),
  )
  assert(
    '阶段5 PDF Export：正式 PDF 有效且来自同源排版中间件',
    pdfReview.qualityStatus === 'passed'
      && pdfReview.metadata.bytes > 2000
      && pdfReview.metadata.cjkFontEmbedded,
    JSON.stringify(pdfReview.metadata),
  )

  const report = {
    generatedAt: new Date().toISOString(),
    passed: checks.every((check) => check.passed),
    checks,
    outputDir,
    pdfPath,
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
