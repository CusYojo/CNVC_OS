import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AI_BUSINESS_SKILLS,
  getAiSkillRoot,
  listAiBusinessSkills,
  loadAiSkill,
} from '../services/aiSkillService.js'
import {
  AI_QA_TEMPLATE,
  AI_TASK_TYPES,
  AI_TEMPLATE_CATALOG,
} from '../services/aiTemplateCatalog.js'

type Check = { name: string; passed: boolean; detail: string }

const checks: Check[] = []

function assert(name: string, condition: boolean, detail: string) {
  checks.push({ name, passed: condition, detail })
  if (!condition) throw new Error(`${name}：${detail}`)
}

function frontmatterKeys(source: string) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return []
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^([a-z][a-z0-9-]*):/)?.[1])
    .filter((key): key is string => Boolean(key))
}

function containsChinese(source: string) {
  return /[\u3400-\u9fff]/.test(source)
}

function chineseCharacterCount(source: string) {
  return source.match(/[\u3400-\u9fff]/g)?.length ?? 0
}

function yamlString(source: string, key: string) {
  return source.match(new RegExp(`^\\s*${key}:\\s*["'](.+)["']\\s*$`, 'm'))?.[1] ?? ''
}

async function main() {
  const root = getAiSkillRoot()
  const listed = await listAiBusinessSkills()
  assert('登记五个业务 Skill', listed.length === 5, `${listed.length} 个`)
  assert(
    'Skill 名称唯一',
    new Set(listed.map((item) => item.name)).size === listed.length,
    listed.map((item) => item.name).join(', '),
  )

  for (const definition of AI_BUSINESS_SKILLS) {
    const loaded = await loadAiSkill(definition.name)
    const directory = path.join(root, definition.name)
    const skillSource = await readFile(path.join(directory, 'SKILL.md'), 'utf8')
    const uiSource = await readFile(path.join(directory, 'agents', 'openai.yaml'), 'utf8')
    const referenceName = definition.name === 'answer-project-qa'
      ? 'qa-contract.md'
      : 'output-contract.md'
    const referenceSource = await readFile(path.join(directory, 'references', referenceName), 'utf8')

    assert(
      `${definition.label} frontmatter 仅含 name/description`,
      frontmatterKeys(skillSource).join(',') === 'name,description',
      frontmatterKeys(skillSource).join(','),
    )
    assert(
      `${definition.label} 无脚手架占位符`,
      !skillSource.includes('[TODO') && !referenceSource.includes('[TODO'),
      definition.name,
    )
    assert(
      `${definition.label} UI 默认提示显式调用 Skill`,
      uiSource.includes(`$${definition.name}`),
      definition.name,
    )
    const uiValues = [
      yamlString(uiSource, 'display_name'),
      yamlString(uiSource, 'short_description'),
      yamlString(uiSource, 'default_prompt'),
    ]
    assert(
      `${definition.label} 用户可见内容使用中文`,
      containsChinese(loaded.description)
        && containsChinese(skillSource)
        && containsChinese(referenceSource)
        && uiValues.every((value) => containsChinese(value))
        && chineseCharacterCount(skillSource) >= 100
        && chineseCharacterCount(referenceSource) >= 100,
      `description/SKILL/reference/UI 中文化；UI=${uiValues.join(' | ')}`,
    )
    assert(
      `${definition.label} 版本和摘要可审计`,
      loaded.description.length > 20
        && /^sha256-[a-f0-9]{12}$/.test(loaded.version)
        && /^[a-f0-9]{64}$/.test(loaded.sha256),
      loaded.version,
    )
    assert(
      `${definition.label} 未打包已知项目样本正文`,
      !/(德塔智能|佳量脑科学|蓝成应急|中数睿智)/.test(referenceSource),
      'SKILL 可登记已批准模板路径，但引用契约不得复制样本项目正文',
    )
    assert(
      `${definition.label} 明确证据与内容去重`,
      /重复|去重/.test(skillSource)
        && /重复|去重|不得复述|只(?:能|列)/.test(referenceSource)
        && /同一(?:事实|文件|数字|来源)/.test(`${skillSource}\n${referenceSource}`),
      '证据分片去重、一个事实只出现一次',
    )
    assert(
      `${definition.label} 明确末尾来源披露`,
      /末尾|文尾|最后一页/.test(`${skillSource}\n${referenceSource}`)
        && /来源|引用资料/.test(referenceSource),
      '仅列实际使用来源并置于末尾',
    )
    if (definition.name === 'answer-project-qa') {
      const documentGeneratorRequirements = [
        'Structured Q&A Document Generator',
        'Template Parser',
        'Question Generator',
        'Duplicate Checker',
        'Answer Generator',
        'Reviewer',
        'Formatter',
        'Word',
        'PDF',
        '暂无相关资料。',
      ]
      assert(
        `${definition.label} 遵守模板学习与内容重建契约`,
        documentGeneratorRequirements.every((term) => skillSource.includes(term)),
        documentGeneratorRequirements.filter((term) => !skillSource.includes(term)).join(', ') || '完整',
      )
      assert(
        `${definition.label} 证据不足时不使用样本补写`,
        /资料不足时必须严格输出/.test(skillSource)
          && /禁止使用.*模板项目正文/.test(skillSource),
        '资料不足时写“暂无相关资料。”且不得使用模板项目事实',
      )
    }
  }

  assert(
    '五类文档任务均绑定唯一 Skill',
    new Set(AI_TASK_TYPES.map((type) => AI_TEMPLATE_CATALOG[type].skillName)).size === 5,
    AI_TASK_TYPES.map((type) => `${type}:${AI_TEMPLATE_CATALOG[type].skillName}`).join(', '),
  )
  const proposalTemplate = AI_TEMPLATE_CATALOG.investment_proposal
  const proposalSkill = await loadAiSkill('draft-investment-proposal')
  const proposalProfile = await readFile(
    path.join(root, 'draft-investment-proposal', 'references', 'template-profile.md'),
    'utf8',
  )
  const proposalCanonicalSpec = await readFile(
    path.resolve(process.cwd(), 'docs', '投资提案模板分析', '投资提案模板核心规范.md'),
    'utf8',
  )
  const proposalCoreSpec = await readFile(
    path.join(root, 'draft-investment-proposal', 'references', 'core-standard.md'),
    'utf8',
  )
  assert(
    'AI-008 登记 docs/投资提案 全部九份模板',
    proposalTemplate.referencePaths?.length === 9
      && proposalTemplate.referencePaths.every((referencePath) =>
        referencePath.includes(`${path.sep}docs${path.sep}投资提案${path.sep}`)
          && existsSync(referencePath)),
    `${proposalTemplate.referencePaths?.length ?? 0} 份`,
  )
  const proposalTemplateHashes = await Promise.all(
    (proposalTemplate.referencePaths ?? []).map(async (referencePath) =>
      createHash('sha256').update(await readFile(referencePath)).digest('hex')),
  )
  assert(
    'AI-008 九份模板指纹与模板画像一致',
    proposalTemplateHashes.length === 9
      && proposalTemplateHashes.every((hash) => proposalProfile.includes(hash)),
    `${proposalTemplateHashes.length} 份模板 SHA-256`,
  )
  assert(
    'AI-008 运行时加载核心规范、模板画像与生成契约',
    proposalSkill.referenceNames.includes('references/core-standard.md')
      && proposalSkill.referenceNames.includes('references/document-blueprint.md')
      && proposalSkill.referenceNames.includes('references/template-profile.md')
      && proposalSkill.referenceNames.includes('references/output-contract.md')
      && proposalSkill.referenceInstructions.includes('版式令牌')
      && proposalSkill.referenceInstructions.includes('表格槽位'),
    proposalSkill.referenceNames.join('、'),
  )
  assert(
    'AI-008 核心规范来源指纹和关键规则已固化',
    createHash('sha256').update(proposalCanonicalSpec).digest('hex')
        === '18a87773e412e5bf7127914cb4469f2a64c392cae3e18c37d899730eecf31f4f'
      && proposalCoreSpec.includes('18a87773e412e5bf7127914cb4469f2a64c392cae3e18c37d899730eecf31f4f')
      && [
        '用户本次明确输入',
        '文档主标题 | 黑体 | 16pt',
        '正文行距 | 固定值 24pt',
        '不设置独立封面',
        '四、项目亮点总结',
        '五、风险提示与对策',
        '六、结论',
      ].every((term) => proposalCanonicalSpec.includes(term))
      && [
        '标准 17 节',
        '16 pt',
        '固定值 24 pt',
        '用户本次明确输入',
        '不创建独立封面或模板外目录',
      ].every((term) => proposalCoreSpec.includes(term)),
    '核心规范 SHA-256、17 节结构、16/12pt 字号、24pt 行距和输入优先级',
  )
  assert(
    'AI-008 Skill 覆盖结构、文风、章节任务与视觉门禁',
    [
      '标准 17 节目录',
      '章节任务',
      '正式、克制',
      '责任主体和时点',
      '一、基本情况简介',
      '二、交易条件',
      '三、公司业务计划',
      '六、结论',
      '16 pt',
      '12 pt',
      '固定值 24 pt',
      'D9D9D9',
    ].every((term) => proposalSkill.referenceInstructions.includes(term)),
    '结构、章节目的、文风、版式、表格与 QA',
  )
  assert(
    'AI-008 运行时目录固定为核心规范 17 节',
    proposalTemplate.sections.length === 17
      && proposalTemplate.sections.every((section) =>
        proposalSkill.referenceInstructions.includes(section)),
    `${proposalTemplate.sections.length} 个章节`,
  )
  const diligenceTemplate = AI_TEMPLATE_CATALOG.due_diligence_report
  const diligenceSkill = await loadAiSkill('write-due-diligence-report')
  const diligenceCanonicalSpec = await readFile(
    path.resolve(process.cwd(), 'docs', '尽调报告', '尽调报告统一生成规范.md'),
    'utf8',
  )
  const diligenceCoreSpec = await readFile(
    path.join(root, 'write-due-diligence-report', 'references', 'core-spec.md'),
    'utf8',
  )
  assert(
    'AI-010 登记 docs/尽调报告 全部十二份模板',
    diligenceTemplate.referencePaths?.length === 12
      && diligenceTemplate.referencePaths.every((referencePath) =>
        referencePath.includes(`${path.sep}docs${path.sep}尽调报告${path.sep}`)
          && existsSync(referencePath)),
    `${diligenceTemplate.referencePaths?.length ?? 0} 份`,
  )
  assert(
    'AI-010 运行时只加载统一核心规范与输出契约',
    diligenceSkill.referenceNames.join(',') === 'references/core-spec.md,references/output-contract.md'
      && diligenceSkill.referenceInstructions.includes('尽调报告核心规范')
      && diligenceSkill.referenceInstructions.includes('商业尽调报告输出契约')
      && !existsSync(path.join(root, 'write-due-diligence-report', 'references', 'template-profile.md'))
      && !existsSync(path.join(root, 'write-due-diligence-report', 'references', 'chapter-playbook.md')),
    diligenceSkill.referenceNames.join('、'),
  )
  const diligenceCoreTerms = [
    '项目数据',
    '用户补充',
    '资料截止日',
    '八章',
    '十六',
    '1、投资概要',
    '8、风险提示与对策',
    '结论—证据—分析—限制',
    '星实-一标',
    '星实-正文',
    '14 pt',
    '1.5 倍行距',
    '两端对齐',
    'Word / WPS',
    'TOC 域',
  ]
  assert(
    'AI-010 核心规范与项目唯一规范保持关键规则一致',
    diligenceCoreTerms.every((term) =>
      diligenceCanonicalSpec.includes(term) && diligenceCoreSpec.includes(term)),
    diligenceCoreTerms
      .filter((term) =>
        !diligenceCanonicalSpec.includes(term) || !diligenceCoreSpec.includes(term))
      .join('、') || '八章十六模块、章节内容、证据写法、精确版式与 WPS 门禁',
  )
  assert(
    'AI-007～AI-011 均绑定 docs 业务模板',
    AI_TASK_TYPES.every((type) =>
      AI_TEMPLATE_CATALOG[type].referencePath.includes(`${path.sep}docs${path.sep}`))
      && AI_QA_TEMPLATE.referencePaths.length >= 1
      && AI_QA_TEMPLATE.referencePaths.every((item) =>
        item.includes(`${path.sep}docs${path.sep}Q&A${path.sep}`)),
    [
      ...AI_TASK_TYPES.map((type) => AI_TEMPLATE_CATALOG[type].referencePath),
      ...AI_QA_TEMPLATE.referencePaths,
    ].join(' | '),
  )

  const complianceSkill = await loadAiSkill('generate-compliance-statement')
  const complianceDirectory = path.join(root, 'generate-compliance-statement')
  const complianceCoreSpec = await readFile(
    path.resolve(process.cwd(), 'docs', '合规性说明', '合规性说明模板核心规范.md'),
    'utf8',
  )
  const complianceTemplateSpec = await readFile(
    path.join(complianceDirectory, 'references', 'template-spec.md'),
    'utf8',
  )
  const complianceOutputContract = await readFile(
    path.join(complianceDirectory, 'references', 'output-contract.md'),
    'utf8',
  )
  const complianceWorkflowContract = await readFile(
    path.join(complianceDirectory, 'references', 'workflow-contract.md'),
    'utf8',
  )
  const complianceReviewerContract = await readFile(
    path.join(complianceDirectory, 'references', 'reviewer-contract.md'),
    'utf8',
  )
  const complianceCoreSha256 = createHash('sha256')
    .update(complianceCoreSpec)
    .digest('hex')
  const complianceCorpus = [
    complianceSkill.instructions,
    complianceTemplateSpec,
    complianceOutputContract,
    complianceWorkflowContract,
    complianceReviewerContract,
  ].join('\n')
  assert(
    'AI-007 以合规性说明核心规范为唯一格式权威',
    complianceTemplateSpec.includes('合规性说明模板核心规范.md')
      && complianceTemplateSpec.includes(complianceCoreSha256)
      && /唯一权威|始终优先/.test(complianceTemplateSpec),
    complianceCoreSha256,
  )
  assert(
    'AI-007 固定四章、五项投资理由和七项合规核查',
    [
      '一、公司情况介绍',
      '二、投资理由',
      '三、投资计划',
      '四、投资情形分析',
      '恰好 5',
      '恰好 7',
    ].every((term) => complianceCorpus.includes(term)),
    '四章 / 五项理由 / 七项核查',
  )
  assert(
    'AI-007 审计元数据不漂移为模板外正文板块',
    /不得渲染为正文|不渲染为正文/.test(complianceCorpus)
      && /不增加封面、执行摘要、责任声明、风险提示、资料缺口或引用资料/.test(
        complianceCorpus,
      ),
    '摘要、风险、缺口和来源仅保留为审计元数据',
  )
  assert(
    'AI-007 强制 Word/WPS 无修复兼容验收',
    ['WORD_REPAIR_REQUIRED', 'WPS_REPAIR_REQUIRED', 'NUMBERING_INVALID', 'EMPTY_TAIL_PAGE']
      .every((term) => complianceReviewerContract.includes(term))
      && /无法读取的内容/.test(complianceReviewerContract)
      && /不得交付需要恢复/.test(complianceCorpus),
    'Word/WPS 直接打开、字体、编号、分页和 OpenXML 关系闭包',
  )

  const qaContract = await readFile(
    path.join(root, 'answer-project-qa', 'references', 'qa-contract.md'),
    'utf8',
  )
  const qaTemplateStyleGuide = await readFile(
    path.join(root, 'answer-project-qa', 'references', 'qa-template-style-guide.md'),
    'utf8',
  )
  const qaCoreRules = await readFile(AI_QA_TEMPLATE.coreRulesPath, 'utf8')
  const qaCoreRulesSha256 = createHash('sha256').update(qaCoreRules).digest('hex')
  const qaSkill = await loadAiSkill('answer-project-qa')
  const qaRequired = [
    '企业介绍', '商业模式', '产品能力', '团队', '市场', '竞争', '财务', '融资',
    '风险', '合规', '知识产权', '客户', '行业', '运营', '未来规划',
    '暂无相关资料。', 'Reviewer', 'Word', 'PDF',
  ]
  assert(
    'Q&A 十五类问题、回答和双格式契约完整',
    qaRequired.every((term) => qaContract.includes(term)),
    qaRequired.filter((term) => !qaContract.includes(term)).join(', ') || '完整',
  )
  const qaStyleRequired = [
    '模板共识',
    '各内容单元的表达目的',
    '结论先行',
    '分维度论证',
    'Word',
    'PDF',
    '黑白公文',
    'A4',
    '宋体',
    'Times New Roman',
    '18 pt',
    '14 pt',
    '12 pt',
    '10.5-11 pt',
    '1.5 倍行距',
    '两端对齐',
    '首行缩进 2 个汉字',
    'Q1：',
    '（1）',
  ]
  assert(
    'Q&A 模板结构与文风规范完整',
    qaStyleRequired.every((term) => qaTemplateStyleGuide.includes(term)),
    qaStyleRequired.filter((term) => !qaTemplateStyleGuide.includes(term)).join(', ') || '完整',
  )
  assert(
    'Q&A Skill 核心规则与 docs/Q&A 统一规范一致',
    AI_QA_TEMPLATE.coreRulesPath === path.resolve(process.cwd(), 'docs', 'Q&A', 'Q&A模板核心规则.md')
      && qaCoreRules.includes('# 项目 Q&A 模板核心规则')
      && ['A4', '宋体', 'Times New Roman', '1.5 倍', '问题目录', '直接答复', '分维度论证']
        .every((term) => qaCoreRules.includes(term))
      && qaTemplateStyleGuide.includes(qaCoreRulesSha256)
      && !/(普雷赛斯|轻蜓光电|中数睿智|德塔智能|浙江蓝成)/.test(qaCoreRules),
    AI_QA_TEMPLATE.coreRulesPath,
  )
  assert(
    'Q&A 登记 docs/Q&A 全部五份业务样本',
    AI_QA_TEMPLATE.templateDirectory === path.resolve(process.cwd(), 'docs', 'Q&A')
      && AI_QA_TEMPLATE.referencePaths.length === 5
      && AI_QA_TEMPLATE.referencePaths.every((item) =>
        path.dirname(item) === AI_QA_TEMPLATE.templateDirectory
        && item.toLowerCase().endsWith('.pdf')),
    `${AI_QA_TEMPLATE.templateDirectory} / ${AI_QA_TEMPLATE.referencePaths.length} 份`,
  )
  assert(
    'Q&A 作为正式文档任务输出 Word 与 PDF',
    AI_QA_TEMPLATE.outputMode === 'document-task'
      && AI_QA_TEMPLATE.downloadableArtifact === true
      && AI_QA_TEMPLATE.outputFormats.join(',') === 'docx,pdf'
      && /Word/.test(qaSkill.instructions)
      && /PDF/.test(qaSkill.instructions)
      && /暂无相关资料。/.test(qaContract),
    `${AI_QA_TEMPLATE.outputMode} / downloadable=${AI_QA_TEMPLATE.downloadableArtifact}`,
  )
  const qaPipelineSource = await readFile(
    path.resolve(process.cwd(), 'server', 'src', 'services', 'aiQaPipelineService.ts'),
    'utf8',
  )
  const qaDocumentSource = await readFile(
    path.resolve(process.cwd(), 'server', 'src', 'services', 'aiQaDocumentService.ts'),
    'utf8',
  )
  const qaParserSource = await readFile(
    path.resolve(process.cwd(), 'server', 'src', 'services', 'aiQaTemplateParser.ts'),
    'utf8',
  )
  assert(
    'Q&A 运行时注入完整 Prompt、Workflow 与模板规范',
    qaPipelineSource.includes('skill.referenceInstructions')
      && qaSkill.referenceNames.includes('references/qa-contract.md')
      && qaSkill.referenceNames.includes('references/qa-template-style-guide.md')
      && qaSkill.referenceNames.includes('references/workflow.md')
      && qaSkill.referenceNames.includes('references/pipeline-prompts.md')
      && qaSkill.referenceInstructions.includes('# Q&A 生产契约')
      && qaSkill.referenceInstructions.includes('# Q&A Pipeline Prompts'),
    '生产契约 + 模板画像 + Workflow + Pipeline Prompts',
  )
  assert(
    'Q&A Pipeline 包含 Parser、Generator、Duplicate Checker、Reviewer 与双格式导出',
    qaPipelineSource.includes('generateProjectQaQuestions')
      && qaPipelineSource.includes('checkDuplicateQuestions')
      && qaPipelineSource.includes('reviewProjectQaAnswers')
      && qaDocumentSource.includes('generateProjectQaDocx')
      && qaDocumentSource.includes('convertProjectQaDocxToPdf')
      && qaParserSource.includes('parseQaTemplateCorpus'),
    'Template Parser / Question Generator / Duplicate Checker / Reviewer / Word / PDF',
  )
  assert(
    'Q&A Formatter 落实统一字号、行距、页边距与问题一级结构',
    qaDocumentSource.includes("'Songti SC'")
      && qaDocumentSource.includes("const LATIN_FONT = 'Times New Roman'")
      && qaDocumentSource.includes('size: 36')
      && qaDocumentSource.includes('size: 28')
      && qaDocumentSource.includes('size: 24')
      && qaDocumentSource.includes('line: 360')
      && qaDocumentSource.includes('margin: { top: 1440, right: 1800, bottom: 1440, left: 1800 }')
      && qaDocumentSource.includes('input.content.questions.forEach((question, globalIndex)')
      && !qaDocumentSource.includes('function categoryHeading')
      && !qaDocumentSource.includes('function metadataTable')
      && !qaDocumentSource.includes('`${question.question}（${question.category}）`')
      && qaPipelineSource.includes('function cleanAnswerText')
      && qaPipelineSource.includes('二至五个换行分隔'),
    '宋体 / 18pt 标题 / 14pt 问题 / 12pt 分维度 / 1.5 倍行距 / 25.4×31.7mm 页边距',
  )
  assert(
    'Q&A 双模式边界明确且不生成 PPT',
    /正式文档模式/.test(qaSkill.instructions)
      && /单题会话模式/.test(qaSkill.instructions)
      && /DOCX/.test(qaSkill.instructions)
      && /PDF/.test(qaSkill.instructions)
      && /永不生成 PPT\/PPTX/.test(qaSkill.instructions)
      && /不创建文档任务或下载产物/.test(qaSkill.instructions),
    '正式任务 DOCX+PDF / 单题结构化回答 / 禁止 PPT',
  )

  const pptContract = await readFile(
    path.join(root, 'build-investment-recommendation-ppt', 'references', 'output-contract.md'),
    'utf8',
  )
  assert(
    'PPT Skill 明确单一可编辑 PPTX 链路',
    /原生可编辑对象/.test(pptContract)
      && /不得再生成第二份纯图片 PPTX/.test(pptContract),
    '核心内容原生可编辑 / 仅一份正式 PPTX',
  )

  const quickActionsSource = await readFile(
    path.resolve(process.cwd(), 'src', 'components', 'AiQuickActions.tsx'),
    'utf8',
  )
  assert(
    'Q&A 前端创建正式项目文档任务',
    quickActionsSource.includes("id: 'qa'")
      && quickActionsSource.includes("mode: 'task'")
      && quickActionsSource.includes('投资委员会 Q&A')
      && quickActionsSource.includes('DOCX+PDF')
      && !quickActionsSource.includes('QA_GROUPS'),
    'Q&A task / 投资委员会或尽调 / DOCX+PDF',
  )

  const assistantPageSource = await readFile(
    path.resolve(process.cwd(), 'src', 'pages', 'AIAssistantPage.tsx'),
    'utf8',
  )
  assert(
    'Q&A 通过统一任务 API 生成可下载产物',
    assistantPageSource.includes("qa: 'project_qa'")
      && assistantPageSource.includes("apiPost<AiTask>('/ai/tasks'")
      && assistantPageSource.includes('parameters.qaMode')
      && assistantPageSource.includes('parameters.questionDepth'),
    'POST /api/ai/tasks type=project_qa',
  )

  const report = {
    generatedAt: new Date().toISOString(),
    skillRoot: root,
    passed: checks.every((check) => check.passed),
    checks,
  }
  const reportPath = process.env.AI_SKILL_ACCEPTANCE_REPORT
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
