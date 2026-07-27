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
} from '../services/aiInvestmentProposalBlueprintService.js'
import {
  buildInvestmentProposalEvidencePlan,
} from '../services/aiInvestmentProposalEvidenceService.js'
import {
  requestInvestmentProposalChapterJson,
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
import {
  collectDueDiligencePublicEvidence,
} from '../services/aiDueDiligenceResearchService.js'
import { loadAiSkill } from '../services/aiSkillService.js'
import { AI_TEMPLATE_CATALOG } from '../services/aiTemplateCatalog.js'
import { safeAiTaskFailureMessage } from '../services/aiTaskErrorService.js'

const template = AI_TEMPLATE_CATALOG.investment_proposal
const blueprint = await loadInvestmentProposalBlueprint(template)
const skill = await loadAiSkill('draft-investment-proposal')
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
assert.match(
  safeAiTaskFailureMessage(Object.assign(
    new Error('包含内部模型原文的错误'),
    { code: 'INVESTMENT_PROPOSAL_CHAPTER_GENERATION_FAILED' },
  )),
  /模型请求中断或返回格式异常/,
)
const outputDirectory = path.resolve(
  process.env.AI_PROPOSAL_ACCEPTANCE_OUTPUT
    || path.join(process.cwd(), 'server', 'ai-artifacts', 'acceptance', 'investment-proposal'),
)
await mkdir(outputDirectory, { recursive: true })

const leafDefinitions = proposalLeafSections(blueprint)
function claimFor(definition: typeof leafDefinitions[number]) {
  const topic = definition.title.replace(/^[一二三四五六七八九十0-9.、（）()\s]+/, '')
  if (definition.analysisKind === 'risk_summary') {
    return '若公司未能在投决前完成风险事项核验，可能影响交易判断；项目组应在投决前完成原始文件审查并持续跟踪，责任主体为项目组。'
  }
  if (definition.analysisKind === 'conclusion') {
    return '建议在项目组完成关键资料核验并落实交易条件后推进下一阶段；如重大风险未消除，应暂停并重新评估。'
  }
  return `当前项目资料记载，星河机器人有限公司已就${topic}形成项目记录，相关结论仍以原始文件复核结果为准。`
}

const sources: EvidenceSource[] = leafDefinitions.map((definition, index) => {
  const topic = definition.title.replace(/^[一二三四五六七八九十0-9.、（）()\s]+/, '')
  const claim = claimFor(definition)
  const tableEvidence = definition.tableKind === 'equity_structure'
    ? '股东：创始人；持股比例：60%。'
    : definition.tableKind
      ? '报告期：2025年；资料值：100万元。'
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
      tableEvidence,
    ].filter(Boolean).join('\n'),
  }
})
const evidencePlan = buildInvestmentProposalEvidencePlan(sources, blueprint)
const publicResearch = await collectDueDiligencePublicEvidence({
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
  industry: '具身智能机器人',
  sourceCutoffDate: '2026-07-20',
  purpose: 'investment_proposal',
  maxSources: 60,
}, async (input) => {
  const requestUrl = new URL(String(input))
  const query = requestUrl.searchParams.get('q') || '投资提案公开检索'
  const slug = encodeURIComponent(query.slice(0, 48))
  return new Response(JSON.stringify({
    results: [{
      title: `${query.slice(0, 20)}公开信息`,
      content: `公开页面记载与“${query}”有关的基础信息；该摘要仅用于验收联网证据进入章节生成，并须回到原网页交叉核验。`,
      url: `https://example.com/research/${slug}`,
      publishedDate: '2026-07-19',
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
})
assert.equal(publicResearch.attemptedQueries, 10)
assert.equal(publicResearch.successfulQueries, 10)
assert.equal(publicResearch.failedQueries, 0)
assert.equal(
  publicResearch.sources.filter((source) => source.sourceName.startsWith('公开检索记录｜')).length,
  10,
)
assert.ok(publicResearch.sources.some((source) => source.sourceType === 'public_web'
  && source.sourceId?.startsWith('https://example.com/research/')))
const priorityPlan = buildInvestmentProposalEvidencePlan([
  {
    sourceType: 'project_record',
    sourceId: 'priority-project',
    sourceName: '项目档案',
    content: '公司简介：项目档案记录公司主营机器人产品。',
  },
  {
    sourceType: 'user_input',
    sourceId: 'priority-user',
    sourceName: '用户补充输入',
    content: '公司简介：用户本次明确补充公司主营具身智能机器人产品。',
  },
], blueprint)
assert.equal(
  priorityPlan.sections.find((section) => section.sectionId === 'company.profile')
    ?.evidence[0]?.sourceType,
  'user_input',
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
  const tableTitles: Record<Exclude<NonNullable<typeof tableKind>, 'equity_structure'>, string> = {
    financial_summary: '历史财务摘要',
    financing_history: '历史融资情况',
    transaction_plan: '本轮投资方案',
    forecast_return: '经营预测与回报测算',
    comparable_valuation: '可比公司估值比较',
  }
  return {
    title: tableTitles[tableKind],
    unit: '人民币万元',
    columns: ['报告期', '资料值'],
    rows: [['2025年', '100']],
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
    '现就星河机器人有限公司项目提交投资提案，供投资决策委员会审议。本提案仅依据当前项目资料形成，所有结论仍以完成尽调及正式投决为准。',
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

const webOnlySources = structuredClone(sources)
webOnlySources[0] = {
  ...webOnlySources[0],
  sourceType: 'public_web',
  sourceId: 'https://example.com/company-profile',
  sourceName: '公开信息｜星河机器人公司简介',
}
const webOnlyPlan = buildInvestmentProposalEvidencePlan(webOnlySources, blueprint)
const publicWebAsFactReview = reviewInvestmentProposalContent({
  content,
  blueprint,
  evidencePlan: webOnlyPlan,
  sources: webOnlySources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(publicWebAsFactReview.passed, false)
assert.ok(publicWebAsFactReview.issues.some((issue) =>
  issue.code === 'PUBLIC_WEB_REQUIRES_VERIFICATION'))
const pendingPublicWebContent = structuredClone(content)
pendingPublicWebContent.sections.find((section) => section.title === '（一）公司简介')!
  .findings[0].status = '待核验'
const pendingPublicWebReview = reviewInvestmentProposalContent({
  content: pendingPublicWebContent,
  blueprint,
  evidencePlan: webOnlyPlan,
  sources: webOnlySources,
  projectName: '星河机器人项目',
  companyName: '星河机器人有限公司',
})
assert.equal(pendingPublicWebReview.passed, true, JSON.stringify(pendingPublicWebReview.issues, null, 2))

const evidenceAvailableButMissingContent = structuredClone(content)
const companyProfileSection = evidenceAvailableButMissingContent.sections
  .find((section) => section.title === '（一）公司简介')!
companyProfileSection.summary = CURRENT_PROJECT_NO_DATA
companyProfileSection.findings = [{
  text: `${CURRENT_PROJECT_NO_DATA}需补充公司主体相关原始文件或经确认的项目记录后再行分析。`,
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
          text: `${CURRENT_PROJECT_NO_DATA}需补充该主题相关原始文件或经确认的项目记录后再行分析。`,
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
assert.ok(missingSection.findings[0].text.startsWith(CURRENT_PROJECT_NO_DATA))
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
    templateEvidenceRejected: true,
    publicResearchRequired: true,
    publicWebForcedToPendingVerification: true,
    limitedNoDataDraftAccepted: true,
    evidenceGapRetriedThenDowngraded: true,
    malformedChapterJsonRetried: true,
    safeFailureReasonExposed: true,
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
