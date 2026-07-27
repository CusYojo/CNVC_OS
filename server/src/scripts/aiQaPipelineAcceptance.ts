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
  QA_NO_DATA,
  buildProjectQaDocumentContent,
  checkDuplicateQuestions,
  generateProjectQaAnswers,
  generateProjectQaQuestions,
  reviewProjectQaAnswers,
} from '../services/aiQaPipelineService.js'
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
    '阶段3 Question Generator：十五分类完整',
    duplicateCheck.questions.length === 15
      && PROJECT_QA_DOCUMENT_CATEGORIES.every((category) =>
        duplicateCheck.questions.some((question) => question.category === category)),
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
    '阶段3 Question Generator：深度版每类两题且无重复',
    deepDuplicateCheck.questions.length === 30
      && PROJECT_QA_DOCUMENT_CATEGORIES.every((category) =>
        deepDuplicateCheck.questions.filter((question) => question.category === category).length === 2)
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
    '阶段4 Answer Generator：每题均有回答，缺资料使用标准短语',
    reviewed.answers.length === duplicateCheck.questions.length
      && reviewed.answers.every((answer) =>
        answer.answer === QA_NO_DATA || answer.sourceIndexes.length > 0),
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
    '阶段4 Answer Generator：无证据时全部 Fail Closed',
    noEvidenceAnswers.every((answer) =>
      answer.answer === QA_NO_DATA
      && answer.sourceIndexes.length === 0
      && answer.supportingQuotes.length === 0),
    `${noEvidenceAnswers.filter((answer) => answer.answer === QA_NO_DATA).length}/${noEvidenceAnswers.length}`,
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
    '阶段5 Document Generator：Word 结构与 OpenXML 通过',
    docxReview.qualityStatus === 'passed'
      && docxReview.metadata.questionCount === 15
      && docxReview.metadata.categoryCount === 15,
    JSON.stringify(docxReview.metadata),
  )
  assert(
    '阶段5 PDF Export：PDF 有效且来自同一 Word',
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
    docxPath,
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
