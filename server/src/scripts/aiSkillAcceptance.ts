import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AI_BUSINESS_SKILLS,
  AI_DOCUMENT_PLUGIN_BINDINGS,
  AI_DUE_DILIGENCE_SKILL_NAME,
  AI_PPT_WORKFLOW_SKILLS,
  AI_QA_SKILL_NAME,
  getAiSkillDirectory,
  getAiSkillRoot,
  getAiSkillRuntimeDirectory,
  listAiBusinessSkills,
  loadAiSkill,
  loadAiSkillFromDirectory,
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

async function loadHostAdapterSkill(name: string) {
  const root = getAiSkillRoot()
  return loadAiSkillFromDirectory({
    name,
    directory: getAiSkillRuntimeDirectory(name),
    allowedRoot: root,
  })
}

async function main() {
  const root = getAiSkillRoot()
  const listed = await listAiBusinessSkills()
  assert('登记六个业务 Skill', listed.length === 6, `${listed.length} 个`)
  assert(
    'Skill 名称唯一',
    new Set(listed.map((item) => item.name)).size === listed.length,
    listed.map((item) => item.name).join(', '),
  )

  assert(
    '四项正式文档快捷入口不再绑定 Plugin',
    AI_DOCUMENT_PLUGIN_BINDINGS.length === 0,
    `${AI_DOCUMENT_PLUGIN_BINDINGS.length} 个内置文档 Plugin 绑定`,
  )
  for (const skillName of [
    'generate-investment-compliance-note',
    'draft-investment-proposal',
    'draft-investment-qa',
    'draft-due-diligence-report',
  ] as const) {
    const loadedSkill = await loadAiSkill(skillName)
    assert(
      `${skillName} 快捷入口加载同名独立 Skill`,
      loadedSkill.name === skillName
        && getAiSkillDirectory(skillName) === getAiSkillRuntimeDirectory(skillName)
        && getAiSkillDirectory(skillName).endsWith(`${path.sep}skills${path.sep}${skillName}`),
      `${loadedSkill.name} / ${getAiSkillDirectory(skillName)}`,
    )
  }

  for (const definition of AI_BUSINESS_SKILLS) {
    const definitionName = String(definition.name)
    const isProjectQa = definitionName === AI_QA_SKILL_NAME
    const loaded = await loadHostAdapterSkill(definition.name)
    const directory = getAiSkillRuntimeDirectory(definition.name)
    const skillSource = await readFile(path.join(directory, 'SKILL.md'), 'utf8')
    const uiSource = await readFile(path.join(directory, 'agents', 'openai.yaml'), 'utf8')
    const referenceName = definitionName === AI_DUE_DILIGENCE_SKILL_NAME
      ? 'quality-gates.md'
      : isProjectQa
        ? 'evidence-and-quality-rules.md'
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
      isProjectQa
        ? uiValues.every((value) => containsChinese(value))
          && containsChinese(skillSource)
          && chineseCharacterCount(skillSource) >= 100
        : containsChinese(loaded.description)
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
      definitionName === AI_DUE_DILIGENCE_SKILL_NAME
        ? /重复/.test(skillSource)
          && /多个转载同一稿件/.test(loaded.referenceInstructions)
        : isProjectQa
          ? /来源冲突必须显式记录，不得静默调和/.test(skillSource)
            && /不得平均口径冲突的数据/.test(referenceSource)
            && /两个独立高质量来源/.test(referenceSource)
        : /重复|去重/.test(skillSource)
          && /重复|去重|不得复述|只(?:能|列)/.test(referenceSource)
          && /同一(?:事实|文件|数字|来源)/.test(`${skillSource}\n${referenceSource}`),
      '证据分片去重、一个事实只出现一次',
    )
    assert(
      `${definition.label} 明确来源披露位置`,
      definitionName === AI_DUE_DILIGENCE_SKILL_NAME
        ? /内部工作文件保留/.test(`${skillSource}\n${loaded.referenceInstructions}`)
          && /证据台账、来源清单.*内部工作文件保留/.test(skillSource)
          && /不写成正文免责声明/.test(skillSource)
        : isProjectQa
          ? /标准读者版不展示来源清单/.test(skillSource)
            && /内部证据台账/.test(`${skillSource}\n${referenceSource}`)
            && /标准读者版没有来源清单、来源行、引用标签/.test(referenceSource)
        : definitionName === 'draft-investment-proposal'
          ? /任务来源表|审计元数据/.test(`${skillSource}\n${referenceSource}`)
            && /不得生成.*免责声明.*引用资料|不生成文末.*免责声明.*引用资料/.test(
              `${skillSource}\n${referenceSource}`,
            )
        : /末尾|文尾|最后一页/.test(`${skillSource}\n${referenceSource}`)
          && /来源|引用资料/.test(referenceSource),
      definitionName === AI_DUE_DILIGENCE_SKILL_NAME
        ? '尽调来源保存在系统审计记录，正式正文不显示文末来源'
        : isProjectQa
          ? 'Q&A 来源保存在系统审计记录，正式 DOCX 不显示来源编号或引用资料'
        : definitionName === 'draft-investment-proposal'
          ? '投资提案来源保存在任务来源表和审计元数据，正文不显示免责声明或引用资料'
        : '仅列实际使用来源并置于末尾',
    )
    if (isProjectQa) {
      const documentGeneratorRequirements = [
        '# 生成项目 Q&A 报告',
        '使用标准版，设置 8—12 个问题',
        'qa_cn_formal_a4',
        '标题后立即进入连续编号的 Q&A',
        '不添加独立的“结论：”段落',
        '标准读者版不展示来源清单',
        '内部证据台账',
        '外部超链接为零',
        'DOCX',
        'Markdown 底稿',
      ]
      assert(
        `${definition.label} 遵守直接式报告与版式契约`,
        documentGeneratorRequirements.every((term) => skillSource.includes(term)),
        documentGeneratorRequirements.filter((term) => !skillSource.includes(term)).join(', ') || '完整',
      )
      assert(
        `${definition.label} 资料不足时保留可核验边界且禁止编造`,
        /采用自适应研究/.test(skillSource)
          && /宁可明确保留缺口，也不得用流畅文字掩盖编造/.test(skillSource)
          && /不得编造市场规模/.test(skillSource)
          && /不得把占位内容当作证据/.test(skillSource),
        '授权资料优先；关键缺口可定向研究，无法核验时保留边界且不得用模板占位内容补写',
      )
    }
    if (definitionName === 'generate-document-from-template') {
      const leadIntelligenceRequirements = [
        '投资中台的资深投资经理',
        '当前会话绑定',
        '线索池',
        '股权与治理',
        '产品与技术',
        '推进、继续观察、暂缓或归档',
        '泛泛的行业研究报告',
        '当前项目',
        '融资与估值',
        '交易方案',
        '可核验来源',
        '本地项目资料库优先',
        '进程内公开检索',
        'LLM Gateway',
        '候选 URL',
        '页面核验',
        '检索摘要',
        '核验结果缓存复用',
        '只联网搜索',
      ]
      assert(
        `${definition.label} 固化投资中台资深投资经理角色`,
        leadIntelligenceRequirements.every((term) =>
          `${skillSource}\n${referenceSource}`.includes(term)),
        leadIntelligenceRequirements
          .filter((term) => !`${skillSource}\n${referenceSource}`.includes(term))
          .join('、') || '完整',
      )
    }
  }

  assert(
    '五类文档任务均绑定唯一 Skill',
    new Set(AI_TASK_TYPES.map((type) => AI_TEMPLATE_CATALOG[type].skillName)).size === 5,
    AI_TASK_TYPES.map((type) => `${type}:${AI_TEMPLATE_CATALOG[type].skillName}`).join(', '),
  )
  const pptWorkflowSkills = await Promise.all(
    AI_PPT_WORKFLOW_SKILLS.map((definition) => loadAiSkill(definition.name)),
  )
  assert(
    'PPT 总编排、Gorden 两阶段生成与 PDF 可编辑化能力均可审计',
    pptWorkflowSkills.length === 3
      && pptWorkflowSkills.every((skill) =>
        containsChinese(skill.instructions)
        && /^sha256-[a-f0-9]{12}$/.test(skill.version)
        && /^[a-f0-9]{64}$/.test(skill.sha256)),
    pptWorkflowSkills.map((skill) => `${skill.name}:${skill.version}`).join('、'),
  )
  assert(
    '投资建议书固定使用分阶段图片版与元素级可编辑版链路',
    !AI_TEMPLATE_CATALOG.investment_recommendation_ppt.requiredParameters.includes('customTemplateId')
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.requiredParameters.includes('structureMode')
      && !AI_TEMPLATE_CATALOG.investment_recommendation_ppt.requiredParameters.includes('pageCount')
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.sections.length === 12
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.workflowSkillNames?.join(',')
        === 'create-reference-driven-editable-ppt,GordenSuperPPTSkill,pdf-to-editable-ppt'
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.skillName
        === 'create-reference-driven-editable-ppt'
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.referencePaths?.length === 0,
    `${AI_TEMPLATE_CATALOG.investment_recommendation_ppt.requiredParameters.join('、')} / ${
      AI_TEMPLATE_CATALOG.investment_recommendation_ppt.workflowSkillNames?.join('、')}`,
  )
  const proposalTemplate = AI_TEMPLATE_CATALOG.investment_proposal
  const proposalSkill = await loadHostAdapterSkill('draft-investment-proposal')
  const proposalProfile = await readFile(
    path.join(root, 'draft-investment-proposal', 'references', 'template-profile.md'),
    'utf8',
  )
  const proposalCoreSpec = await readFile(
    path.join(root, 'draft-investment-proposal', 'references', 'core-standard.md'),
    'utf8',
  )
  assert(
    'AI-008 只登记 Skill 自带的两份当前版式权威',
    proposalTemplate.referencePaths?.length === 2
      && proposalTemplate.referencePaths.every((referencePath) =>
        referencePath.includes(`${path.sep}draft-investment-proposal${path.sep}assets${path.sep}`)
          && existsSync(referencePath)),
    `${proposalTemplate.referencePaths?.length ?? 0} 份`,
  )
  const proposalTemplateHashes = await Promise.all(
    (proposalTemplate.referencePaths ?? []).map(async (referencePath) =>
      createHash('sha256').update(await readFile(referencePath)).digest('hex')),
  )
  assert(
    'AI-008 两份版式权威指纹与 Skill 模板画像一致',
    proposalTemplateHashes.length === 2
      && proposalTemplateHashes.every((hash) => proposalProfile.includes(hash)),
    `${proposalTemplateHashes.length} 份版式权威 SHA-256`,
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
    'AI-008 Skill 当前核心规范和关键规则已固化',
    [
        '当前会话绑定',
        '用户本次明确输入',
        'Skill 自带的主要版式权威',
        '主标题 | 黑体，16 pt',
        '行距 | 固定值 24 pt',
        '不创建独立封面',
        '默认先检索本地资料，再复用网络补全缓存',
        '只联网搜索',
        '不得一开始就进行宽泛的全网搜索',
        '不恢复或依赖 SearXNG',
        '正文末尾不增加`免责声明`或`引用资料`板块',
        '受限初稿',
      ].every((term) => proposalCoreSpec.includes(term)),
    'Skill 原生版式权威、17 节结构、取证顺序与版式规则',
  )
  assert(
    'AI-008 默认本地优先、进程内发现、LLM Gateway 页面核验并缓存复用',
    [
      '本地项目资料库优先',
      '进程内公开检索',
      'LLM Gateway',
      '候选 URL',
      '页面核验',
      '只联网搜索',
      '不得一开始就',
      'Local Project Retrieval',
      'Network Cache Retrieval',
      'Evidence Gap Analysis',
      'In-process Candidate Discovery',
      'LLM Gateway Page Verification',
      'Network Cache Writeback',
      '不恢复或依赖 SearXNG',
    ].every((term) =>
      `${proposalSkill.instructions}\n${proposalSkill.referenceInstructions}`.includes(term)),
    '本地资料库 → 网络缓存 → 缺口分析 → 进程内候选发现 → LLM Gateway 页面核验 → 缓存写回',
  )
  assert(
    'AI-008 Skill 覆盖结构、文风、章节任务与视觉门禁',
    [
      '固定 17 节',
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
      'C0C0C0',
      '只交付一份 DOCX',
      'PDF 和渲染图均为内部临时产物',
      '每个 finding 是不含手动换行的完整自然段',
      '列角色不同但使用等宽列',
      'Calculation Ledger',
      'Manifest',
      '...展开',
      '原文链接',
      '完整法律主体',
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
  const diligenceSkill = await loadHostAdapterSkill(AI_DUE_DILIGENCE_SKILL_NAME)
  const diligenceCanonicalSpec = await readFile(
    path.resolve(process.cwd(), 'docs', '尽调报告', '尽调报告统一生成规范.md'),
    'utf8',
  )
  const diligenceTemplateDirectory = path.resolve(process.cwd(), 'docs', '尽调报告')
  const diligenceTemplateFileNames = (await readdir(diligenceTemplateDirectory, {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isFile() && /\.(?:docx|pdf)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
  const diligenceReferencePaths = diligenceTemplate.referencePaths ?? []
  const registeredDiligenceTemplateFileNames = diligenceReferencePaths
    .map((referencePath) => path.basename(referencePath))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
  assert(
    'AI-010 登记 docs/尽调报告 全部模板且不设置单一主模板',
    diligenceTemplateFileNames.length > 0
      && JSON.stringify(registeredDiligenceTemplateFileNames)
        === JSON.stringify(diligenceTemplateFileNames)
      && diligenceReferencePaths.every((referencePath) =>
        referencePath.includes(`${path.sep}docs${path.sep}尽调报告${path.sep}`)
          && existsSync(referencePath))
      && diligenceTemplate.referencePath.endsWith(
        `${path.sep}docs${path.sep}尽调报告${path.sep}尽调报告统一生成规范.md`,
      )
      && diligenceTemplate.templateVersion.includes('corpus'),
    `${diligenceTemplate.referencePaths?.length ?? 0} 份`,
  )
  assert(
    'AI-010 运行时加载字段、证据、文风、版式与质量门禁',
    [
      'references/evidence-policy.md',
      'references/diligence-data-schema.md',
      'references/public-research-protocol.md',
      'references/source-sufficiency-routing.md',
      'references/report-framework.md',
      'references/human-investment-writing.md',
      'references/deta-v5-template-contract.md',
      'references/layout-spec.md',
      'references/quality-gates.md',
    ].every((referenceName) => diligenceSkill.referenceNames.includes(referenceName))
      && diligenceSkill.referenceInstructions.includes('# Evidence Policy')
      && diligenceSkill.referenceInstructions.includes('# Human Investment Writing Standard')
      && diligenceSkill.referenceInstructions.includes('# Quality Gates'),
    diligenceSkill.referenceNames.join('、'),
  )
  const diligenceCoreTerms = [
    '字段完整性门禁',
    'diligence-data.json',
    'evidence.json',
    '字段级公开信息穷尽检索',
    '投资概要',
    '风险提示与对策',
    '投资结论及建议',
    '项目资料',
    'Word',
    '逐页视觉检查',
  ]
  const diligenceSkillContract = `${diligenceSkill.instructions}\n${diligenceSkill.referenceInstructions}`
  assert(
    'AI-010 新尽调 Skill 覆盖字段、证据、联网补全、固定结构和视觉验收',
    diligenceCoreTerms.every((term) => diligenceSkillContract.includes(term))
      && diligenceCanonicalSpec.includes('投资结论及建议'),
    diligenceCoreTerms.filter((term) => !diligenceSkillContract.includes(term)).join('、')
      || '字段数据层 → 证据台账 → 公开检索 → 投资判断 → DOCX 逐页验收',
  )
  assert(
    'AI-010 Skill 强制先锁定项目、建立证据与字段数据层再生成',
    [
      '锁定项目身份与尽调范围',
      '先建立证据台账',
      '建立投委会字段数据层',
      '检索公开信息并解决冲突',
      '围绕投资决策组织报告',
      '执行结构审计和逐页视觉检查',
    ].every((term) =>
      diligenceSkillContract.includes(term)),
    '项目身份 → 证据台账 → 字段数据层 → 公开补全 → 投资判断 → 逐页验收',
  )
  const aiTaskServiceSource = await readFile(
    path.resolve(process.cwd(), 'server', 'src', 'services', 'aiTaskService.ts'),
    'utf8',
  )
  const aiBusinessContentSource = await readFile(
    path.resolve(process.cwd(), 'server', 'src', 'services', 'aiBusinessContentService.ts'),
    'utf8',
  )
  const dueDiligenceResearchSource = await readFile(
    path.resolve(
      process.cwd(),
      'server',
      'src',
      'services',
      'aiDueDiligenceNetworkResearchService.ts',
    ),
    'utf8',
  )
  const dueDiligenceNativeSource = await readFile(
    path.resolve(
      process.cwd(),
      'server',
      'src',
      'services',
      'aiDueDiligenceSkillRuntimeService.ts',
    ),
    'utf8',
  )
  assert(
    'AI-010 正文按 11 个章组生成 30 个模块并仅重试受影响章组',
    aiBusinessContentSource.includes('DUE_DILIGENCE_GENERATION_GROUPS')
      && aiBusinessContentSource.includes('DUE_DILIGENCE_DEFAULT_CONCURRENCY = 3')
      && aiBusinessContentSource.includes('runDueDiligenceGroupsWithConcurrency')
      && aiBusinessContentSource.includes('章节 JSON 未完整返回')
      && aiBusinessContentSource.includes('assembleSections')
      && aiBusinessContentSource.includes('requestSummary')
      && aiBusinessContentSource.includes("if (input.type === 'due_diligence_report')")
      && aiTaskServiceSource.includes('AI_DUE_DILIGENCE_CHAPTER_CONCURRENCY')
      && diligenceTemplate.sections.length === 30
      && diligenceSkill.instructions.includes('投资概要')
      && diligenceSkill.instructions.includes('投资结论及建议'),
    '快捷任务仍按 11 个固定章组并发生成 30 个模块，新技能负责字段、证据、写作与视觉门禁',
  )
  const projectKnowledgeBriefSource = await readFile(
    path.resolve(
      process.cwd(),
      'server',
      'src',
      'services',
      'aiProjectKnowledgeBriefService.ts',
    ),
    'utf8',
  )
  assert(
    '四项文档任务在生成前建立项目研读简报',
    projectKnowledgeBriefSource.includes('PROJECT_KNOWLEDGE_TOPICS')
      && projectKnowledgeBriefSource.includes('recommendedTables')
      && projectKnowledgeBriefSource.includes('sourceFilesRepresented')
      && aiTaskServiceSource.includes('buildProjectKnowledgeBrief')
      && aiTaskServiceSource.includes('projectKnowledgeStudy')
      && aiBusinessContentSource.includes('projectKnowledgeBriefForPrompt'),
    '代表性读取每份文件，输出主题事实、时间线、冲突、缺口与表格候选，并注入四项文档生成流程',
  )
  assert(
    'AI-010 待核验项触发进程内候选发现、LLM Gateway 页面核验、缓存写回和二次生成',
    [
      'dueDiligencePendingResearchTopics',
      '联网检索 Agent 发现待核验事项来源',
      '核验待确认事项的公开资料',
      'fetchDueDiligenceNetworkEvidence',
      'fetchVerifiedProjectWebEvidence',
      'cacheProjectNetworkEvidence',
      '使用本地与联网证据重新生成尽调内容',
      'project_knowledge_primary_in_process_discovery_llm_page_verification',
    ].every((term) => aiTaskServiceSource.includes(term))
      && aiBusinessContentSource.includes('source.sourceType.startsWith(\'public_web\')')
      && aiBusinessContentSource.includes('finding.status !== \'待核验\'')
      && aiBusinessContentSource.includes('DUE_DILIGENCE_CONTENT_QUALITY_REJECTED')
      && aiBusinessContentSource.includes('DUE_DILIGENCE_MODEL_UNAVAILABLE')
      && !aiTaskServiceSource.includes('DUE_DILIGENCE_NETWORK_UNAVAILABLE')
      && aiTaskServiceSource.includes('尽调公开页面核验失败，使用现有证据继续生成')
      && dueDiligenceResearchSource.includes('collectCompanyIntel')
      && dueDiligenceResearchSource.includes("provider: 'in_process_intel_collect'")
      && dueDiligenceResearchSource.includes('public_web_agent_search'),
    '首轮生成 → 待核验问题提取 → 进程内候选发现 → LLM Gateway 页面核验 → 缓存写回 → 带补全证据二次生成；联网异常继续生成受限 DOCX',
  )
  assert(
    '投资建议书与 Q&A 绑定原生 Skill，其余业务任务绑定 docs 模板',
    AI_TASK_TYPES
      .filter((type) => !['investment_recommendation_ppt', 'project_qa'].includes(type))
      .every((type) =>
        AI_TEMPLATE_CATALOG[type].referencePath.includes(`${path.sep}docs${path.sep}`))
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.referencePath.includes(
        `${path.sep}create-reference-driven-editable-ppt${path.sep}SKILL.md`,
      )
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.referencePaths?.length === 0
      && AI_TEMPLATE_CATALOG.project_qa.referencePath.includes(
        `${path.sep}draft-investment-qa${path.sep}`,
      )
      && AI_QA_TEMPLATE.referencePaths.length >= 1
      && AI_QA_TEMPLATE.referencePaths.every((item) =>
        item.includes(`${path.sep}draft-investment-qa${path.sep}`)),
    [
      ...AI_TASK_TYPES.map((type) => AI_TEMPLATE_CATALOG[type].referencePath),
      ...AI_QA_TEMPLATE.referencePaths,
    ].join(' | '),
  )

  const complianceSkill = await loadHostAdapterSkill('generate-investment-compliance-note')
  const complianceDirectory = path.join(root, 'generate-investment-compliance-note')
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
    'AI-007 正文不使用数字小标题或冒号标签',
    /不显示数字小标题|不使用阿拉伯数字小标题/.test(complianceCorpus)
      && /学术团队：/.test(complianceCorpus)
      && /连续正文/.test(complianceCorpus),
    '仅一级、二级正式章节保留编号，其余 finding 为自然段落',
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
    'AI-010 最终 DOCX 完全经过 draft-due-diligence-report 原生硬门禁',
    aiTaskServiceSource.includes('generateDueDiligenceReportWithSkill')
      && [
        'check_runtime.py',
        'audit_evidence.py',
        'audit_ic_completeness.py',
        'audit_report_content.py',
        'audit_narrative_quality.py',
        'build_report_docx.py',
        'audit_docx_style.py',
        'deta_dd_processor.py',
        'investment_bank_styles.py',
      ].every((term) => dueDiligenceNativeSource.includes(term))
      && dueDiligenceNativeSource.includes('DUE_DILIGENCE_PUBLIC_RESEARCH_AUDIT_REQUIRED')
      && dueDiligenceNativeSource.includes('usedSourceIndexes')
      && dueDiligenceNativeSource.includes('source_index')
      && dueDiligenceNativeSource.includes("formatter: 'draft-due-diligence-report-skill-v5'")
      && dueDiligenceNativeSource.includes('deta_dd_processor.py')
      && dueDiligenceNativeSource.includes('investment_bank_styles.py'),
    '证据台账 → 字段完整性 → 内容/文风 → V5 Skill 格式化 → Skill 样式与逐页渲染',
  )
  assert(
    'AI-008 投资提案最终 Skill 校验失败时禁止登记产物',
    aiTaskServiceSource.includes(
      'proposalSkillValidation = await validateInvestmentProposalWithSkill(outputPath)',
    )
      && !aiTaskServiceSource.includes(
        '投资提案 Skill 最终校验执行失败，保留已通过内建检查的 DOCX',
      ),
    'draft-investment-proposal 成品门禁必须硬失败',
  )
  assert(
    'AI-007 强制 Word/WPS 无修复兼容验收',
    ['WORD_REPAIR_REQUIRED', 'WPS_REPAIR_REQUIRED', 'NUMBERING_INVALID', 'EMPTY_TAIL_PAGE']
      .every((term) => complianceReviewerContract.includes(term))
      && /无法读取的内容/.test(complianceReviewerContract)
      && /不得交付需要恢复/.test(complianceCorpus),
    'Word/WPS 直接打开、字体、编号、分页和 OpenXML 关系闭包',
  )
  assert(
    'AI-007 默认本地优先、网络补全并缓存复用',
    [
      '本地项目资料库优先',
      '网络补全为辅',
      '补全结果缓存复用',
      '只联网搜索',
      '不得一开始就',
      'Network Cache Retrieval',
      'Project LLM Network Supplement',
      'Network Cache Writeback',
      'NETWORK_CACHE_WRITEBACK',
      '项目统一大模型网关',
      'PROJECT_LLM_GROUNDING_UNAVAILABLE',
      'UNVERIFIABLE_MODEL_SOURCE',
      '不得仅因联网、模型或内容 Reviewer 异常终止整个任务',
      '只登记并交付一份',
      '不得生成或登记 PDF、Markdown',
    ].every((term) => complianceCorpus.includes(term)),
    '本地资料库 → 网络缓存 → 项目大模型定向网络补全 → 缓存写回；仅交付 DOCX',
  )

  const qaCoreRules = await readFile(AI_QA_TEMPLATE.coreRulesPath, 'utf8')
  const qaSkill = await loadHostAdapterSkill(AI_QA_SKILL_NAME)
  const qaRuntimeCorpus = `${qaSkill.instructions}\n${qaSkill.referenceInstructions}`
  const aiQaPipelineSource = await readFile(
    path.resolve(process.cwd(), 'server', 'src', 'services', 'aiQaPipelineService.ts'),
    'utf8',
  )
  const qaRuntimeSource = await readFile(
    path.resolve(process.cwd(), 'server', 'src', 'services', 'aiProjectQaSkillRuntimeService.ts'),
    'utf8',
  )
  assert(
    'Q&A 快捷任务统一绑定 draft-investment-qa',
    AI_QA_SKILL_NAME === 'draft-investment-qa'
      && qaSkill.name === AI_QA_SKILL_NAME
      && AI_QA_TEMPLATE.skillName === AI_QA_SKILL_NAME
      && AI_TEMPLATE_CATALOG.project_qa.skillName === AI_QA_SKILL_NAME,
    `${AI_QA_SKILL_NAME} / ${AI_TEMPLATE_CATALOG.project_qa.skillName}`,
  )
  assert(
    'Q&A 深度门禁同时检查正文密度与投资因果层级',
    aiQaPipelineSource.includes('PROJECT_QA_ANSWER_HARD_FLOOR_CHARACTERS')
      && aiQaPipelineSource.includes('projectQaAnswerCausalDepthScore')
      && aiQaPipelineSource.includes('projectQaAnswerInvestmentDimensionScore')
      && qaRuntimeSource.includes('projectQaContentDepthMetrics')
      && qaRuntimeSource.includes('causalDepthRatio >= 0.7')
      && qaRuntimeSource.includes('documentInvestmentDimensionCount >= 4')
      && qaRuntimeSource.includes("code: 'PROJECT_QA_DEPTH_GATE_FAILED'"),
    '单题硬底线 + 全文平均密度 + 专题因果层级 + 全文投资维度覆盖',
  )
  const deploySource = await readFile(path.resolve(process.cwd(), 'deploy.sh'), 'utf8')
  const serverIndexSource = await readFile(
    path.resolve(process.cwd(), 'server', 'src', 'index.ts'),
    'utf8',
  )
  assert(
    '四项文档同名 Skill 随项目安装并在服务启动时校验',
    AI_DOCUMENT_PLUGIN_BINDINGS.length === 0
      && [
        'generate-investment-compliance-note',
        'draft-investment-proposal',
        'draft-investment-qa',
        'draft-due-diligence-report',
      ].every((name) => existsSync(path.resolve(
        process.cwd(), 'server', 'workspace', '.agents', 'skills', name, 'SKILL.md',
      )))
      && deploySource.includes('systemctl stop "$SERVICE_UNIT"')
      && deploySource.includes('systemctl start "$SERVICE_UNIT"')
      && serverIndexSource.includes('qaSkillName: AI_QA_SKILL_NAME')
      && serverIndexSource.includes('AI_REQUIRED_DOCUMENT_SKILL_NAMES.map((name) => loadAiSkill(name))'),
    '合规性说明 + 投资提案 + 尽调报告 + Q&A 同名 Skill 目录 / 启动加载门禁 / health 绑定探针',
  )
  const qaRequired = [
    '# 生成项目 Q&A 报告',
    '使用标准版，设置 8—12 个问题',
    '标题后立即进入连续编号的 Q&A',
    '不添加独立的“结论：”段落',
    '标准读者版不展示来源清单',
    '内部证据台账',
    'qa_cn_formal_a4',
    'DOCX',
    '外部超链接为零',
    '投资深度门禁',
  ]
  assert(
    'Q&A 新 Skill 的直接式结构、证据边界和 DOCX 契约完整',
    qaRequired.every((term) => qaRuntimeCorpus.includes(term)),
    qaRequired.filter((term) => !qaRuntimeCorpus.includes(term)).join(', ') || '完整',
  )
  assert(
    'Q&A 核心规则直接来自 draft-investment-qa',
    AI_QA_TEMPLATE.coreRulesPath === path.resolve(
      process.cwd(),
      'server',
      'workspace',
      '.agents',
      'skills',
      'draft-investment-qa',
      'SKILL.md',
    )
      && qaCoreRules.includes('# 生成项目 Q&A 报告')
      && qaCoreRules.includes('标题后立即进入连续编号的 Q&A')
      && qaCoreRules.includes('不添加独立的“结论：”段落')
      && !/(普雷赛斯|轻蜓光电|中数睿智|德塔智能|浙江蓝成)/.test(qaCoreRules),
    AI_QA_TEMPLATE.coreRulesPath,
  )
  assert(
    'Q&A 登记新 Skill 的模板与四份核心规范',
    AI_QA_TEMPLATE.templateDirectory === path.resolve(
      process.cwd(),
      'server',
      'workspace',
      '.agents',
      'skills',
      'draft-investment-qa',
    )
      && AI_QA_TEMPLATE.referencePaths.length === 5
      && AI_QA_TEMPLATE.referencePaths.every((item) =>
        item.startsWith(`${AI_QA_TEMPLATE.templateDirectory}${path.sep}`)
        && item.toLowerCase().endsWith('.md')),
    `${AI_QA_TEMPLATE.templateDirectory} / ${AI_QA_TEMPLATE.referencePaths.length} 份`,
  )
  assert(
    'Q&A 作为正式文档任务只输出 DOCX',
    AI_QA_TEMPLATE.outputMode === 'document-task'
      && AI_QA_TEMPLATE.downloadableArtifact === true
      && AI_QA_TEMPLATE.outputFormats.join(',') === 'docx'
      && /DOCX/.test(qaSkill.instructions)
      && AI_TEMPLATE_CATALOG.project_qa.outputFormat === 'docx',
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
      && qaPipelineSource.includes('只以已激活的 Q&A Skill 及其 references 为业务权威')
      && AI_QA_TEMPLATE.referencePaths.some((item) =>
        item.endsWith(`${path.sep}assets${path.sep}qa-report-template.md`))
      && qaSkill.referenceNames.includes('references/structure-blueprint.md')
      && qaSkill.referenceNames.includes('references/section-writing-guide.md')
      && qaSkill.referenceNames.includes('references/evidence-and-quality-rules.md')
      && qaSkill.referenceNames.includes('references/format-guidelines.md')
      && qaSkill.referenceNames.includes('references/investment-manager-role.md')
      && qaSkill.referenceNames.includes('references/investment-depth-gates.md')
      && qaSkill.instructions.includes('assets/investment-question-scorecard-template.md')
      && qaSkill.referenceInstructions.includes('# Q&A 报告结构蓝图')
      && qaSkill.referenceInstructions.includes('# Q&A 报告格式规范')
      && qaSkill.referenceInstructions.includes('# 投资经理角色与资本配置视角')
      && qaSkill.referenceInstructions.includes('# 投资分析深度门禁'),
    '新 Skill + 结构蓝图 + 章节写作 + 投资经理角色 + 深度门禁 + 证据质量 + 版式规范',
  )
  assert(
    'Q&A Pipeline 包含新 Skill 画像、项目 RAG、Generator、Duplicate Checker、Reviewer 与 DOCX 生成',
    qaPipelineSource.includes('generateProjectQaQuestions')
      && qaPipelineSource.includes('checkDuplicateQuestions')
      && qaPipelineSource.includes('reviewProjectQaAnswers')
      && qaDocumentSource.includes('generateProjectQaDocx')
      && !qaDocumentSource.includes('convertProjectQaDocxToPdf')
      && qaParserSource.includes('createProjectQaSkillProfile')
      && qaParserSource.includes('draft-investment-qa-profile-v1'),
    'Skill Profile / Current Project RAG / Question Generator / Duplicate Checker / Reviewer / DOCX',
  )
  assert(
    'Q&A Formatter 落实 Deta QA 字号、固定行距、页边距与直接式结构',
    qaDocumentSource.includes("const PROJECT_QA_REPORT_BODY_FONT = 'STKaiti'")
      && qaDocumentSource.includes("const PROJECT_QA_REPORT_HEADING_FONT = 'STKaiti'")
      && qaDocumentSource.includes('const PROJECT_QA_REPORT_BODY_SIZE = 21')
      && qaDocumentSource.includes('const PROJECT_QA_REPORT_TITLE_SIZE = 40')
      && qaDocumentSource.includes('const PROJECT_QA_REPORT_QUESTION_SIZE = 28')
      && qaDocumentSource.includes('const PROJECT_QA_REPORT_BODY_SPACING = 288')
      && qaDocumentSource.includes('const PROJECT_QA_REPORT_QUESTION_SPACING = 420')
      && qaDocumentSource.includes('const PROJECT_QA_REPORT_TITLE_SPACING = 480')
      && qaDocumentSource.includes("layoutProfile: 'deta_qa_pdf'")
      && qaDocumentSource.includes('generateProjectQaReportDocx')
      && qaDocumentSource.includes('visibleAnswerLabelPresent')
      && qaDocumentSource.includes('visibleSubheadingsAbsent')
      && qaDocumentSource.includes('visibleSourceProcessAbsent')
      && qaDocumentSource.includes('visibleAuditAppendixAbsent')
      && qaDocumentSource.includes('不得包含外部超链接')
      && qaDocumentSource.includes('首段必须显示“回答：”'),
    'STKaiti / 16pt 标题 / 11pt 问答 / 14.4pt 固定行距 / Deta A4 页边距',
  )
  assert(
    'Q&A 快捷任务使用标准 8 题并只登记 DOCX',
    qaPipelineSource.includes('标准版: 8')
      && /仅在用户明确要求时生成 PDF/.test(qaSkill.instructions)
      && AI_QA_TEMPLATE.outputFormats.join(',') === 'docx',
    '标准版 8 题 / 快捷任务仅 DOCX / PDF 仅在用户明确要求时生成',
  )

  const pptContract = await readFile(
    path.join(root, 'GordenSuperPPTSkills', 'GordenSuperPPTSkill', 'SKILL.md'),
    'utf8',
  )
  const pptWorkflowSource = await readFile(
    path.resolve(
      process.cwd(),
      'server',
      'src',
      'services',
      'aiInvestmentRecommendationPptWorkflowService.ts',
    ),
    'utf8',
  )
  const pptDocumentSource = await readFile(
    path.resolve(process.cwd(), 'server', 'src', 'services', 'aiBusinessDocumentService.ts'),
    'utf8',
  )
  const pptGeneratorSource = await readFile(
    path.resolve(
      process.cwd(),
      'server',
      'src',
      'services',
      'aiGordenSuperPptService.ts',
    ),
    'utf8',
  )
  assert(
    'PPT Skill 明确图片生成与四层可编辑还原链路',
    /阶段 1：GordenImagePPTGen/.test(pptContract)
      && /阶段 2：GordenImage2PPTX/.test(pptContract)
      && /强制四层/.test(pptContract)
      && /imagegen-manifest\.json/.test(pptContract)
      && /imagegen-assets-manifest\.json/.test(pptContract),
    '网关成品图 / 背景、框架、图标、文本四层 / 生成证据',
  )
  assert(
    '投资建议书工作流禁用外部模板并通过图片 PDF 桥接生成可编辑 PPTX',
    [
      "sourceMode: 'gorden-native'",
      "templateReuse: 'none'",
      "bridgePolicy: 'image-deck-to-pdf-to-editable-pptx'",
    ].every((term) => pptWorkflowSource.includes(term)),
    'Gorden 原生出图 / 禁用外部模板 / PDF 桥接可编辑转换',
  )
  assert(
    '投资建议书按编排、Gorden 出图和 PDF 可编辑转换顺序交付',
    pptWorkflowSource.includes("loadAiSkill('create-reference-driven-editable-ppt')")
      && pptWorkflowSource.includes("loadAiSkill('GordenSuperPPTSkill')")
      && pptWorkflowSource.includes("loadAiSkill('pdf-to-editable-ppt')")
      && pptDocumentSource.includes('generateInvestmentRecommendationPptWithGorden')
      && pptGeneratorSource.includes('project-facts.json')
      && pptGeneratorSource.includes('imagegen-manifest.json')
      && pptGeneratorSource.includes('imagegen-assets-manifest.json')
      && pptGeneratorSource.includes('chromaKey')
      && pptGeneratorSource.includes('sliceGrid')
      && pptGeneratorSource.includes('layoutGuard')
      && pptGeneratorSource.includes('visualCompareQa')
      && pptGeneratorSource.includes('pipelinePaths.packageSlidesAsPdf')
      && pptGeneratorSource.includes('convertUploadedInvestmentPdfTemplate')
      && pptGeneratorSource.includes('conversionHandoffPath')
      && !pptGeneratorSource.includes('referenceImage: plan.referencePage')
      && !pptGeneratorSource.includes('referencePaths.packageSlidesAsPdf'),
    '项目事实 / 网关图片证据 / Gorden 四层语义资产 / PDF 桥接 / 可编辑 PPTX',
  )

  const quickActionsSource = await readFile(
    path.resolve(process.cwd(), 'src', 'components', 'AiQuickActions.tsx'),
    'utf8',
  )
  const aiTasksRouteSource = await readFile(
    path.resolve(process.cwd(), 'server', 'src', 'routes', 'aiTasks.ts'),
    'utf8',
  )
  const assistantPageSource = await readFile(
    path.resolve(process.cwd(), 'src', 'pages', 'AIAssistantPage.tsx'),
    'utf8',
  )
  const aiMessageSafetySource = await readFile(
    path.resolve(process.cwd(), 'src', 'lib', 'aiMessageSafety.ts'),
    'utf8',
  )
  assert(
    '四项正式文档快捷入口直接创建进度任务且不展示内部 Skill 指令',
    assistantPageSource.includes("apiPost<AiTask>('/ai/tasks'")
      && assistantPageSource.includes('parameters.attachmentFileIds = attachmentFileIds')
      && assistantPageSource.includes('parameters.userInstructions = combinedUserInstructions')
      && assistantPageSource.includes("parameters.diligenceScope = request.diligenceScope || '商业尽调'")
      && assistantPageSource.includes('setAiTasks((items) => [')
      && assistantPageSource.includes('if (isFormalDocumentTask) setUploads([])')
      && !assistantPageSource.includes('请使用 Skill「${quickSkillName}」'),
    '点击开始生成 → POST /ai/tasks → 立即显示进度卡 → 成功后显示结果与 DOCX 下载',
  )
  assert(
    '投资建议书快捷任务以高亮会话模式读取项目、附件和对话',
    quickActionsSource.includes("mode: 'chat'")
      && quickActionsSource.includes('selectedActionId')
      && quickActionsSource.includes('aria-pressed')
      && quickActionsSource.includes('已选中，请输入要求或添加文件')
      && assistantPageSource.includes("selectedQuickAction === 'investment_ppt'")
      && assistantPageSource.includes('attachmentFileIds: uploads')
      && assistantPageSource.includes('attachmentFileNames: uploads.map')
      && assistantPageSource.includes('force: forceInvestmentPpt')
      && aiTasksRouteSource.includes("['standard', 'strict-template']")
      && !AI_TEMPLATE_CATALOG.investment_recommendation_ppt.requiredParameters.includes('customTemplateId'),
    '点击高亮 → 输入文字/添加文件 → 当前项目与最近对话 → 系统标准 PPTX',
  )
  assert(
    '历史投资建议书模板准备任务仍可恢复',
    quickActionsSource.includes('onCreatePreparationTask')
      && quickActionsSource.includes('taskId: preparationTaskId')
      && !quickActionsSource.includes('const taskCreated = await submit(result)')
      && quickActionsSource.includes("stage: isInvestmentPpt")
      && quickActionsSource.includes('上传、分析并开始生成')
      && assistantPageSource.includes("'/ai/tasks/preparations/investment-ppt'")
      && assistantPageSource.includes('onCreatePreparationTask={createQuickTaskPreparation}')
      && aiTasksRouteSource.includes('startInvestmentPptTaskAfterPreparation'),
    '旧任务上传开始 → 持久任务 → 模板分析 → 同一任务启动生成；切换会话后仍可恢复',
  )
  assert(
    '会话消息、文档任务和项目 Q&A 按创建时间统一排列',
    aiMessageSafetySource.includes("safeProperty(rawMetadata, 'timestamp')")
      && assistantPageSource.includes('function buildConversationTimeline(')
      && assistantPageSource.includes('left.timestampMs - right.timestampMs')
      && assistantPageSource.includes('conversationTimeline.map((item)')
      && assistantPageSource.includes('tasks={[item.task]}')
      && assistantPageSource.includes('answers={[item.answer]}'),
    'MySQL 消息时间、任务 createdAt 和 Q&A createdAt 合并升序；最新内容位于最下方',
  )
  assert(
    'Q&A 前端创建正式项目文档任务',
    quickActionsSource.includes("id: 'qa'")
      && quickActionsSource.includes("mode: 'task'")
      && quickActionsSource.includes('项目投资问答 DOCX')
      && !quickActionsSource.includes('Q&amp;A 类型')
      && !quickActionsSource.includes('问题深度')
      && !quickActionsSource.includes('qaMode')
      && !quickActionsSource.includes('questionDepth')
      && !quickActionsSource.includes("activeAction.id === 'qa' ? 'PDF'")
      && !quickActionsSource.includes('QA_GROUPS')
      && AI_TEMPLATE_CATALOG.project_qa.skillName === 'draft-investment-qa'
      && AI_TEMPLATE_CATALOG.project_qa.templateVersion === 'draft-investment-qa-20260820-v1',
    'Q&A task / draft-investment-qa / DOCX',
  )
  const taskCardsSource = await readFile(
    path.resolve(process.cwd(), 'src', 'components', 'AiTaskCards.tsx'),
    'utf8',
  )
  assert(
    'Q&A 前端只展示 DOCX 下载',
    taskCardsSource.includes("if (task.type === 'project_qa') return format === 'docx'"),
    '历史或新任务均不展示 Q&A PDF 下载按钮',
  )
  assert(
    '投资建议书任务卡只展示 PPTX 下载、不展示封面预览',
    !taskCardsSource.includes('ProtectedImagePreview')
      && !taskCardsSource.includes('投资建议书封面预览')
      && !taskCardsSource.includes('加载 PPT 预览'),
    'PNG 预览可保留用于服务端质量检查，但不在 PPTX 下载按钮下方展示',
  )
  assert(
    '非 PPT 文档任务以主文档交付为优先并自动恢复一次',
    aiTaskServiceSource.includes('AUTO_RECOVERY_TASK_TYPES')
      && aiTaskServiceSource.includes('_systemDocumentRecoveryAttempt')
      && aiTaskServiceSource.includes("'draft-due-diligence-report 原生 DOCX Pipeline'")
      && aiTaskServiceSource.includes(": 'DOCX Formatter'")
      && aiTaskServiceSource.includes('generateCurrentDocx')
      && aiTaskServiceSource.includes("retryDocumentStep('Q&A DOCX 生成与质量检查'")
      && aiTaskServiceSource.includes('主文档已登记，任务状态恢复为已完成')
      && aiTaskServiceSource.includes('delete retryParameters._systemDocumentRecoveryAttempt')
      && aiTaskServiceSource.includes('withTaskHeartbeat')
      && aiBusinessContentSource.includes('AI_DUE_DILIGENCE_MODEL_TIMEOUT_MS')
      && aiTaskServiceSource.includes('保留已生成主文档')
      && aiTaskServiceSource.includes('保留已生成 DOCX'),
    '联网、模型、Reviewer、来源审计或伴生产物异常不推翻主 DOCX；长耗时尽调模型请求持续更新心跳，生成/质检异常自动继续一次，人工继续生成重新获得完整恢复次数',
  )
  assert(
    '文档任务卡展示安全、可行动的失败原因和错误编号',
    taskCardsSource.includes('task.errorMessage')
      && taskCardsSource.includes('错误编号：{task.errorId}')
      && taskCardsSource.includes('停止阶段：{failureStage}')
      && taskCardsSource.includes('文档尚未完成，系统已保留本次生成参数')
      && taskCardsSource.includes('继续生成'),
    '只展示服务端清洗后的业务原因、停止阶段和错误编号，不展示模型原文或堆栈',
  )

  assert(
    'Q&A 通过统一任务 API 生成可下载产物',
    assistantPageSource.includes("qa: 'project_qa'")
      && assistantPageSource.includes("apiPost<AiTask>('/ai/tasks'")
      && !assistantPageSource.includes('parameters.qaMode')
      && !assistantPageSource.includes('parameters.questionDepth')
      && AI_TEMPLATE_CATALOG.project_qa.requiredParameters.join(',') === 'projectId,sourceCutoffDate'
      && !assistantPageSource.includes('Q&A任务创建失败：${(error as Error).message}'),
    'POST /api/ai/tasks type=project_qa；类型与深度由标准 Skill 统一决定',
  )
  assert(
    'AI 助手生成界面显示安全的实时阶段和进度心跳',
    !assistantPageSource.includes('阶段：{stage}')
      && !taskCardsSource.includes('阶段：{visibleStage}')
      && taskCardsSource.includes("task.stage || '生成进度'"),
    '任务卡在进度条上显示“正在生成尽调正文/整合联网证据”和等待秒数，不展示技术堆栈',
  )
  assert(
    '任务完成进度下方不显示结果摘要提示栏',
    !taskCardsSource.includes('{task.resultSummary && (')
      && !taskCardsSource.includes('>{task.resultSummary}</p>'),
    '结果摘要保留在任务数据中，不在用户任务卡重复显示',
  )
  assert(
    'AI 助手对话框支持拖拽多文件直接上传',
    assistantPageSource.includes('onDrop={onDropFiles}')
      && assistantPageSource.includes('onDragOver={onDragOverFiles}')
      && assistantPageSource.includes('event.dataTransfer.files')
      && assistantPageSource.includes('void uploadFiles(Array.from(event.dataTransfer.files))')
      && assistantPageSource.includes('松开以上传文件')
      && assistantPageSource.includes('accept={AI_UPLOAD_ACCEPT}')
      && assistantPageSource.includes(".jpeg,.zip'"),
    '拖拽与回形针选择复用同一上传、项目入库、进度和失败隔离流程，并允许 ZIP 会话附件',
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
