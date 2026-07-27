import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  COMPLIANCE_MISSING_DATA_SENTENCE,
  parseComplianceDocumentBlueprint,
} from '../services/aiComplianceBlueprintService.js'
import {
  buildComplianceEvidencePackets,
  composeComplianceStatement,
  reviewComplianceContent,
} from '../services/aiComplianceWorkflowService.js'
import {
  convertComplianceDocxToPdf,
  reviewCompliancePdfAgainstDocx,
  reviewGeneratedComplianceDocx,
} from '../services/aiComplianceOutputService.js'
import {
  buildComplianceWebSearchQueries,
  fetchComplianceWebEvidence,
} from '../services/aiComplianceWebResearchService.js'
import { generateBusinessDocx } from '../services/aiBusinessDocumentService.js'
import { loadAiSkill } from '../services/aiSkillService.js'
import { AI_TEMPLATE_CATALOG } from '../services/aiTemplateCatalog.js'

type Check = {
  name: string
  passed: boolean
  detail: string
}

const checks: Check[] = []

function check(name: string, condition: unknown, detail: string) {
  assert.ok(condition, `${name}：${detail}`)
  checks.push({ name, passed: true, detail })
}

function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function main() {
  const outputDirectory = path.resolve(
    process.env.AI_COMPLIANCE_ACCEPTANCE_DIR
      ?? '/private/tmp/codex-compliance-skill-acceptance',
  )
  await mkdir(outputDirectory, { recursive: true })

  const template = AI_TEMPLATE_CATALOG.compliance_statement
  const [skill, blueprint] = await Promise.all([
    loadAiSkill(template.skillName),
    parseComplianceDocumentBlueprint(template),
  ])

  check(
    '模板语料库完整',
    blueprint.templates.length === 2,
    `${blueprint.templates.length}份DOCX模板`,
  )
  check(
    '模板摘要固定',
    blueprint.templates.map((item) => item.sha256).join(',') === [
      '5b51cda592736fc3b2bfc69bcc75875f5588496d47f7a6b6691b21daae8b115e',
      'ce793bf645a35ffa81d76665f1acaad4d3f2d46d3a47f824f1be6c258cb84e1e',
    ].join(','),
    blueprint.templates.map((item) => `${item.fileName}:${item.sha256.slice(0, 12)}`).join('；'),
  )
  check(
    'Document Blueprint章节树固定',
    blueprint.sectionTree.map((item) => item.title).join('、')
      === '公司情况介绍、投资理由、投资计划、投资情形分析'
      && blueprint.sectionTree[0].children.join('、') === '公司简介、核心团队、产品及技术',
    JSON.stringify(blueprint.sectionTree),
  )
  check(
    '模板页面系统一致',
    blueprint.templates.every((item) =>
      item.page.widthDxa === 11906
      && item.page.heightDxa === 16838
      && item.page.marginTopDxa === 1440
      && item.page.marginRightDxa === 1800
      && item.page.marginBottomDxa === 1440
      && item.page.marginLeftDxa === 1800),
    'A4纵向，上下1440/左右1800 DXA',
  )
  check(
    'Skill加载四份约束',
    [
      'references/template-spec.md',
      'references/workflow-contract.md',
      'references/reviewer-contract.md',
      'references/output-contract.md',
    ].every((name) => skill.referenceNames.includes(name)),
    skill.referenceNames.join('、'),
  )
  check(
    'Prompt禁止整篇一次生成',
    /不得一次性生成整篇|禁止一次性生成整篇|不要一次生成整份文档|不得生成整份文档/.test(
      `${skill.instructions}\n${skill.referenceInstructions}`,
    ),
    'Skill与reference要求逐章节生成',
  )
  check(
    'Skill不提及样本文件',
    !/样本|sample/i.test(`${skill.description}\n${skill.instructions}\n${skill.referenceInstructions}`),
    'Skill仅引用核心规范，不登记样本DOCX',
  )
  check(
    'Skill要求项目资料不足时受控联网',
    /受控.*公开网络|公开网络.*受控/.test(`${skill.instructions}\n${skill.referenceInstructions}`)
      && /URL/.test(skill.referenceInstructions)
      && /基金合伙协议/.test(`${skill.instructions}\n${skill.referenceInstructions}`),
    '公开证据可补充、内部基金文件不可由网络替代',
  )
  check(
    '缺失资料固定句唯一',
    blueprint.fixedContent.missingDataSentence === COMPLIANCE_MISSING_DATA_SENTENCE
      && skill.referenceInstructions.includes(COMPLIANCE_MISSING_DATA_SENTENCE),
    COMPLIANCE_MISSING_DATA_SENTENCE,
  )

  const webPlans = buildComplianceWebSearchQueries({
    name: '联网核验项目',
    companyName: '联网核验企业有限公司',
    industry: '人工智能',
  })
  check(
    '公开检索覆盖项目与监管维度',
    webPlans.length === 7
      && webPlans.some((plan) => plan.topic === '核心团队')
      && webPlans.some((plan) => plan.topic === '处罚、诉讼与失信')
      && webPlans.some((plan) => plan.topic === '投资方式及投资限制'),
    webPlans.map((plan) => plan.topic).join('、'),
  )
  let mockSearchIndex = 0
  const mockWebFetch = (async () => {
    mockSearchIndex += 1
    return new Response(JSON.stringify({
      results: [
        {
          title: `联网核验企业公开资料${mockSearchIndex}`,
          content: '该页面披露联网核验企业有限公司在人工智能领域的公司、核心团队、产品技术、融资、政策监管及投资限制等公开信息。',
          url: `https://www.csrc.gov.cn/public-evidence/${mockSearchIndex}`,
          publishedDate: '2026-07-20',
        },
        {
          title: '截止日后资料',
          content: '该资料晚于本次资料截止日，不应进入证据。',
          url: `https://www.csrc.gov.cn/future/${mockSearchIndex}`,
          publishedDate: '2026-08-01',
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  const webResearch = await fetchComplianceWebEvidence({
    project: {
      name: '联网核验项目',
      companyName: '联网核验企业有限公司',
      industry: '人工智能',
    },
    sourceCutoffDate: '2026-07-25',
    fetchImpl: mockWebFetch,
    baseUrl: 'https://search.example.test',
    now: new Date('2026-07-25T08:00:00Z'),
  })
  check(
    '公开检索结果形成可审计证据',
    webResearch.audit.status === 'succeeded'
      && webResearch.audit.succeededQueryCount === 7
      && webResearch.sources.length === 7
      && webResearch.sources.every((source) =>
        source.sourceType === 'public_web_official'
        && source.sourceId?.length === 64
        && source.locator?.startsWith('https://www.csrc.gov.cn/')
        && source.versionOrDate === '2026-07-20'),
    `${webResearch.sources.length}条官方公开证据，状态${webResearch.audit.status}`,
  )
  const webPackets = buildComplianceEvidencePackets(webResearch.sources)
  check(
    '公开证据进入章节级Evidence Packet',
    webPackets.find((packet) => packet.sectionTitle === '核心团队')!.items.length > 0
      && webPackets.find((packet) => packet.sectionTitle === '投资情形分析')!.items
        .some((item) => item.sourceType === 'public_web_official'),
    '公开证据保留sourceType并参与相关章节检索',
  )
  const officialFallbackFetch = (async (target: string | URL | Request) => {
    const url = String(target)
    if (url.includes('/search?')) {
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(
      '<html><body><h1>私募投资基金监督管理条例</h1><p>2023年7月3日公布。'
      + '本条例用于规范私募投资基金业务活动和投资运作，保护投资者合法权益。'.repeat(12)
      + '</p></body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    )
  }) as typeof fetch
  const fallbackResearch = await fetchComplianceWebEvidence({
    project: { name: '官方规则兜底验收项目' },
    sourceCutoffDate: '2026-07-25',
    fetchImpl: officialFallbackFetch,
    baseUrl: 'https://search.example.test',
    now: new Date('2026-07-25T08:00:00Z'),
  })
  check(
    '搜索引擎无结果时直取官方监管页面',
    fallbackResearch.audit.officialFallbackAttempted
      && fallbackResearch.audit.officialFallbackSourceCount === 2
      && fallbackResearch.sources.every((source) =>
        source.sourceType === 'public_web_official'
        && source.locator?.startsWith('https://www.csrc.gov.cn/')),
    `${fallbackResearch.audit.officialFallbackSourceCount}条官方监管来源`,
  )
  const fallbackPackets = buildComplianceEvidencePackets(fallbackResearch.sources)
  check(
    '通用监管资料不污染公司与投资价值章节',
    fallbackPackets
      .filter((packet) => packet.items.length > 0)
      .every((packet) => packet.sectionTitle === '投资情形分析'),
    fallbackPackets
      .filter((packet) => packet.items.length > 0)
      .map((packet) => packet.sectionTitle)
      .join('、'),
  )
  const unavailableResearch = await fetchComplianceWebEvidence({
    project: { name: '联网不可用项目' },
    sourceCutoffDate: '2026-07-25',
    fetchImpl: (async () => { throw new Error('offline') }) as typeof fetch,
    baseUrl: 'https://search.example.test',
  })
  check(
    '公开检索不可用时不阻断生成',
    unavailableResearch.audit.status === 'unavailable'
      && unavailableResearch.sources.length === 0
      && unavailableResearch.audit.failedQueryCount === 7,
    `状态${unavailableResearch.audit.status}，失败查询${unavailableResearch.audit.failedQueryCount}`,
  )

  const project = {
    name: '生产验收企业项目',
    companyName: '生产验收企业有限公司',
  }
  const evidencePackets = buildComplianceEvidencePackets([])
  check(
    '零证据章节包为空',
    evidencePackets.length === 6
      && evidencePackets.every((packet) => packet.items.length === 0),
    '6个叶子章节均无伪造证据',
  )
  const workflow = await composeComplianceStatement({
    template,
    skill,
    blueprint,
    project,
    sources: [],
    sourceCutoffDate: '2026-07-25',
    parameters: {},
  })
  const finalContentReview = workflow.reviewReports.at(-1)
  check(
    '零证据工作流通过Reviewer',
    finalContentReview?.passed,
    `报告${workflow.reviewReports.length}轮，问题${finalContentReview?.issueCount ?? -1}项`,
  )
  const missingFindings = workflow.content.sections.flatMap((section) =>
    section.findings.filter((finding) => finding.status === '资料缺口'))
  check(
    '零证据不调用模型且逐项明确缺口',
    workflow.reviewerRegenerationRounds === 0
      && missingFindings.length >= 16
      && missingFindings.every((finding) =>
        finding.text.includes(COMPLIANCE_MISSING_DATA_SENTENCE)
        && finding.sourceIndexes.length === 0),
    `${missingFindings.length}项资料缺口均使用固定句`,
  )
  check(
    '投资理由固定五项',
    workflow.content.sections.find((section) =>
      section.title === '投资理由')?.findings.length === 5,
    '五项编号条目由核心规范约束',
  )
  check(
    '投资情形分析固定七项',
    workflow.content.sections.find((section) =>
      section.title === '投资情形分析')?.findings.length === 7,
    '七项顺序由Blueprint约束',
  )

  const leakedContent = structuredClone(workflow.content)
  leakedContent.sections.find((section) => section.title === '公司简介')!.findings[0].text
    += ' 模板项目德塔智能可直接视为本项目事实。'
  const leakageReview = reviewComplianceContent({
    content: leakedContent,
    template,
    blueprint,
    project,
    sources: [],
  })
  check(
    'Reviewer拦截模板主体泄漏',
    leakageReview.issues.some((issue) => issue.code === 'TEMPLATE_FACT_LEAK'),
    leakageReview.issues.map((issue) => issue.code).join('、'),
  )

  const invalidCitationContent = structuredClone(workflow.content)
  const invalidFinding = invalidCitationContent.sections
    .find((section) => section.title === '公司简介')!.findings[0]
  invalidFinding.text = '生产验收企业有限公司已完成工商登记。'
  invalidFinding.status = '资料记载'
  invalidFinding.sourceIndexes = [99]
  const invalidCitationReview = reviewComplianceContent({
    content: invalidCitationContent,
    template,
    blueprint,
    project,
    sources: [],
  })
  check(
    'Reviewer拦截无效引用',
    invalidCitationReview.issues.some((issue) => issue.code === 'SOURCE_INDEX_INVALID')
      && invalidCitationReview.issues.some((issue) => issue.code === 'CITATION_IRRELEVANT'),
    invalidCitationReview.issues.map((issue) => issue.code).join('、'),
  )

  const unsupportedPendingContent = structuredClone(workflow.content)
  const unsupportedPendingFinding = unsupportedPendingContent.sections
    .find((section) => section.title === '核心团队')!.findings[0]
  unsupportedPendingFinding.text = '核心团队已经形成完整的复合背景。'
  unsupportedPendingFinding.status = '待核验'
  unsupportedPendingFinding.sourceIndexes = []
  const unsupportedPendingReview = reviewComplianceContent({
    content: unsupportedPendingContent,
    template,
    blueprint,
    project,
    sources: [],
  })
  check(
    'Reviewer拦截无依据的待核验事实',
    unsupportedPendingReview.issues.some((issue) => issue.code === 'CITATION_MISSING'),
    unsupportedPendingReview.issues.map((issue) => issue.code).join('、'),
  )

  const missingSectionContent = structuredClone(workflow.content)
  missingSectionContent.sections = missingSectionContent.sections.filter((section) =>
    section.title !== '投资计划')
  const missingSectionReview = reviewComplianceContent({
    content: missingSectionContent,
    template,
    blueprint,
    project,
    sources: [],
  })
  check(
    'Reviewer拦截章节遗漏',
    missingSectionReview.issues.some((issue) => issue.code === 'SECTION_MISSING')
      && missingSectionReview.issues.some((issue) => issue.code === 'SECTION_ORDER'),
    missingSectionReview.issues.map((issue) => issue.code).join('、'),
  )

  const docxPath = path.join(outputDirectory, '合规性说明_零证据自测.docx')
  const pdfPath = path.join(outputDirectory, '合规性说明_零证据自测.pdf')
  const generation = await generateBusinessDocx({
    outputPath: docxPath,
    template,
    project,
    content: workflow.content,
    sources: [],
    sourceCutoffDate: '2026-07-25',
    generatedAt: new Date('2026-07-25T00:00:00+08:00'),
    blueprint,
  })
  const wordReview = await reviewGeneratedComplianceDocx({
    filePath: docxPath,
    template,
    blueprint,
    content: workflow.content,
    projectName: project.name,
  })
  check(
    'Word Reviewer通过',
    wordReview.passed,
    wordReview.issues.length
      ? wordReview.issues.map((issue) => `${issue.code}:${issue.message}`).join('；')
      : 'OpenXML、章节、固定内容、页面、模板部件及编号全部通过',
  )
  check(
    'Word OpenXML 内部关系闭包完整',
    wordReview.metadata.relationshipClosureValidated === true
      && wordReview.metadata.fontEmbedRelationshipsValidated === true,
    '字体、主题、样式及其他内部关系不得指向缺失部件',
  )
  check(
    'Word正文隔离审计元数据',
    wordReview.metadata.forbiddenContentValidated === true,
    '状态标签、责任声明、风险、缺口汇总、引用清单和免责声明不进入正文',
  )
  check(
    'Word中文字体和标题字形符合核心规范',
    wordReview.metadata.typographyValidated === true
      && wordReview.metadata.fontFallbackAliasesValidated === true,
    '标题黑体14pt常规，二级标题宋体12pt常规，中英文与数字随段落使用中文字体',
  )

  const conversion = await convertComplianceDocxToPdf({ docxPath, pdfPath })
  const pdfReview = await reviewCompliancePdfAgainstDocx({
    docxPath,
    pdfPath,
    template,
    blueprint,
    content: workflow.content,
  })
  check(
    'PDF Reviewer通过',
    pdfReview.passed,
    pdfReview.issues.length
      ? pdfReview.issues.map((issue) => `${issue.code}:${issue.message}`).join('；')
      : `页面${pdfReview.metadata.pageCount}，中文覆盖率${pdfReview.metadata.docxTextCoverage}`,
  )
  check(
    'Word/PDF 按内容自然分页',
    Number.isInteger(pdfReview.metadata.pageCount)
      && Number(pdfReview.metadata.pageCount) >= 1,
    `不强制固定页数；实际${pdfReview.metadata.pageCount}页`,
  )
  check(
    'PDF正文隔离审计元数据',
    pdfReview.metadata.forbiddenContentValidated === true,
    'PDF与Word正文采用同一禁入规则',
  )
  check(
    'PDF中文字体实际可用',
    pdfReview.metadata.cjkFontValidated === true
      && Array.isArray(pdfReview.metadata.pdfFontNames)
      && pdfReview.metadata.pdfFontNames.some((name) =>
        /Songti|Heiti|Hiragino|CJK|SourceHan/i.test(String(name))),
    JSON.stringify(pdfReview.metadata.pdfFontNames),
  )
  check(
    'PDF使用可审计CJK字体映射',
    conversion.fontFallbackApplied
      && conversion.fontFallbacks['宋体'] === 'Songti SC'
      && conversion.fontFallbacks['黑体'] === 'STHeiti',
    JSON.stringify(conversion.fontFallbacks),
  )
  check(
    'PDF与Word同源',
    pdfReview.metadata.derivedFrom === path.basename(docxPath),
    String(pdfReview.metadata.derivedFrom),
  )

  const [docxBuffer, pdfBuffer] = await Promise.all([
    readFile(docxPath),
    readFile(pdfPath),
  ])
  const report = {
    generatedAt: new Date().toISOString(),
    passed: checks.every((item) => item.passed),
    checks,
    blueprint: {
      version: blueprint.version,
      sha256: blueprint.blueprintSha256,
      templates: blueprint.templates.map((item) => ({
        fileName: item.fileName,
        sha256: item.sha256,
      })),
    },
    workflow: {
      generationMode: workflow.generationMode,
      evidencePackets: workflow.evidencePackets.map((packet) => ({
        sectionTitle: packet.sectionTitle,
        itemCount: packet.items.length,
      })),
      reviewerRegenerationRounds: workflow.reviewerRegenerationRounds,
    },
    artifacts: {
      docx: { path: docxPath, bytes: docxBuffer.length, sha256: sha256(docxBuffer) },
      pdf: { path: pdfPath, bytes: pdfBuffer.length, sha256: sha256(pdfBuffer) },
    },
    generation,
    reviews: {
      content: finalContentReview,
      word: wordReview,
      pdf: pdfReview,
    },
  }
  const reportPath = path.join(outputDirectory, 'acceptance-report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
