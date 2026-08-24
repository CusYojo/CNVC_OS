import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AI_BUSINESS_SKILLS,
  AI_DOCUMENT_PLUGIN_BINDINGS,
  AI_DUE_DILIGENCE_SKILL_NAME,
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
    'investment-committee-ppt',
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
    const isInvestmentCommitteePpt = definitionName === 'investment-committee-ppt'
    const loaded = await loadHostAdapterSkill(definition.name)
    const directory = getAiSkillRuntimeDirectory(definition.name)
    const skillSource = await readFile(path.join(directory, 'SKILL.md'), 'utf8')
    const uiSource = await readFile(path.join(directory, 'agents', 'openai.yaml'), 'utf8')
    const referenceName = definitionName === AI_DUE_DILIGENCE_SKILL_NAME
      ? 'quality-gates.md'
      : isProjectQa
        ? 'evidence-and-quality-rules.md'
        : isInvestmentCommitteePpt
          ? 'qa-and-delivery.md'
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
        : isInvestmentCommitteePpt
          ? /合并重复内容/.test(skillSource)
            && /事实表、数字表、来源表、缺口表/.test(loaded.referenceInstructions)
            && /冲突数据保留各自版本、日期和口径/.test(loaded.referenceInstructions)
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
  const investmentCommitteePptSkill = await loadAiSkill('investment-committee-ppt')
  assert(
    '投资建议书直接绑定单一 investment-committee-ppt Skill',
    investmentCommitteePptSkill.name === 'investment-committee-ppt'
      && containsChinese(investmentCommitteePptSkill.instructions)
      && /^sha256-[a-f0-9]{12}$/.test(investmentCommitteePptSkill.version)
      && /^[a-f0-9]{64}$/.test(investmentCommitteePptSkill.sha256),
    `${investmentCommitteePptSkill.name}:${investmentCommitteePptSkill.version}`,
  )
  assert(
    '投资建议书快捷任务不再绑定旧模板与多技能编排链',
    !AI_TEMPLATE_CATALOG.investment_recommendation_ppt.requiredParameters.includes('customTemplateId')
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.requiredParameters.includes('structureMode')
      && !AI_TEMPLATE_CATALOG.investment_recommendation_ppt.requiredParameters.includes('pageCount')
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.sections.length === 12
      && !AI_TEMPLATE_CATALOG.investment_recommendation_ppt.workflowSkillNames?.length
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.skillName
        === 'investment-committee-ppt'
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.referencePaths?.length === 0,
    `${AI_TEMPLATE_CATALOG.investment_recommendation_ppt.requiredParameters.join('、')} / ${
      AI_TEMPLATE_CATALOG.investment_recommendation_ppt.skillName}`,
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
  assert(
    'AI-010 尽调快捷入口只绑定当前 draft-due-diligence-report Skill',
    diligenceTemplate.skillName === AI_DUE_DILIGENCE_SKILL_NAME
      && diligenceTemplate.referencePath.endsWith(
        `${path.sep}${AI_DUE_DILIGENCE_SKILL_NAME}${path.sep}SKILL.md`,
      )
      && diligenceTemplate.referencePaths?.length === 0
      && diligenceTemplate.templateVersion.includes('skill-native'),
    `${diligenceTemplate.skillName} / ${diligenceTemplate.templateVersion}`,
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
      && diligenceSkill.instructions.includes('投资结论及建议'),
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
  const directDocumentAgentSource = await readFile(
    path.resolve(process.cwd(), 'server', 'src', 'services', 'aiDirectInvestmentProposalAgentService.ts'),
    'utf8',
  )
  assert(
    'AI-010 Q&A 与尽调由隔离 Agent 原生调用 Skill，宿主不编排正文',
    aiTaskServiceSource.includes('runDirectBusinessDocumentAgent({')
      && aiTaskServiceSource.includes('usesDirectQaOrDueDiligenceAgent(task.type)')
      && directDocumentAgentSource.includes("skillName: 'draft-investment-qa'")
      && directDocumentAgentSource.includes("skillName: 'draft-due-diligence-report'")
      && directDocumentAgentSource.includes('全部来源文件和全部片段')
      && directDocumentAgentSource.includes('宿主不会生成问题、答案、章节、底稿或兜底正文')
      && directDocumentAgentSource.includes('hostContentOrchestration: false')
      && directDocumentAgentSource.includes('hostEvidenceFallback: false'),
    '完整资料 → 隔离 Agent → 原生 Skill → Skill 自审 → 单一 DOCX 下载',
  )
  assert(
    'Q&A 与尽调完整保留项目全部可研读片段并拒绝静默降级',
    aiTaskServiceSource.includes("'project_qa',\n    'due_diligence_report',")
      && aiTaskServiceSource.includes('retainEveryReadableChunk: true')
      && aiTaskServiceSource.includes('assertCompleteProjectFileCoverage(requiredProjectFiles, sources)')
      && directDocumentAgentSource.includes('completeSourceChunkCoverage: true'),
    '不抽样、不截断、不遗漏项目文件；不能完整覆盖时停止生成',
  )
  assert(
    '投资提案、投资建议书、Q&A 与尽调均绑定各自原生 Skill',
    AI_TEMPLATE_CATALOG.investment_proposal.referencePath.includes(
      `${path.sep}draft-investment-proposal${path.sep}`,
    )
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.referencePath.includes(
        `${path.sep}investment-committee-ppt${path.sep}SKILL.md`,
      )
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.referencePaths?.length === 0
      && AI_TEMPLATE_CATALOG.project_qa.referencePath.includes(
        `${path.sep}draft-investment-qa${path.sep}`,
      )
      && AI_QA_TEMPLATE.referencePaths.length >= 1
      && AI_QA_TEMPLATE.referencePaths.every((item) =>
        item.includes(`${path.sep}draft-investment-qa${path.sep}`))
      && AI_TEMPLATE_CATALOG.due_diligence_report.referencePath.includes(
        `${path.sep}draft-due-diligence-report${path.sep}SKILL.md`,
      )
      && AI_TEMPLATE_CATALOG.due_diligence_report.referencePaths?.length === 0,
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
    'AI-010 最终 DOCX 由直接 Skill Agent 生成验收且宿主不二次判卷',
    directDocumentAgentSource.includes('runDirectBusinessDocumentAgent')
      && directDocumentAgentSource.includes("taskType: 'due_diligence_report'")
      && directDocumentAgentSource.includes('由当前 Agent 按 Skill 自主')
      && aiTaskServiceSource.includes("acceptanceAuthority: 'direct-skill-agent-and-current-skill'")
      && aiTaskServiceSource.includes('programmaticBusinessAcceptance: false')
      && aiTaskServiceSource.includes("deliveryValidation: 'file-integrity-and-authorization-only'"),
    '当前 Skill 规则 → 隔离 Agent 原生执行 → Skill 验收 → 文件完整性与下载',
  )
  assert(
    '全部快捷入口业务验收权归 Agent 与当前 Skill',
    !aiTaskServiceSource.includes('reviewGeneratedComplianceDocx({')
      && !aiTaskServiceSource.includes('reviewInvestmentProposalDocx({')
      && !aiTaskServiceSource.includes('validateInvestmentProposalWithSkill(outputPath)')
      && !aiTaskServiceSource.includes('reviewInvestmentRecommendationPpt({')
      && !aiTaskServiceSource.includes('assessQaTemplateFidelity({')
      && !aiTaskServiceSource.includes('assessDueDiligenceTemplateFidelity({')
      && aiTaskServiceSource.includes('{ deliveryIntegrityOnly: true }')
      && aiTaskServiceSource.includes("acceptanceAuthority: 'direct-skill-agent-and-current-skill'")
      && aiTaskServiceSource.includes('programmaticBusinessAcceptance: false')
      && aiTaskServiceSource.includes("deliveryValidation: 'file-integrity-and-authorization-only'"),
    '宿主只做文件完整性、归属、存储与鉴权下载，不重复判定内容和版式',
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

  const pptContract = await readFile(path.join(root, 'investment-committee-ppt', 'SKILL.md'), 'utf8')
  const directPptAgentSource = await readFile(
    path.resolve(
      process.cwd(),
      'server',
      'src',
      'services',
      'aiDirectInvestmentCommitteePptAgentService.ts',
    ),
    'utf8',
  )
  assert(
    'investment-committee-ppt Skill 明确研究型可编辑 PPT 与逐页 QA',
    /研究型建议书/.test(pptContract)
      && /所有重要文字、图表、流程、时间轴和表格保持可编辑/.test(pptContract)
      && /逐页 100% 视觉检查/.test(pptContract)
      && /Investment Editorial Research v001/.test(pptContract),
    '研究叙事 / 原生可编辑 / Design DNA / 逐页视觉复核',
  )
  assert(
    '投资建议书由隔离 Agent 原生调用单一 Skill，宿主只登记成品',
    directPptAgentSource.includes("skills: ['investment-committee-ppt']")
      && directPptAgentSource.includes("tools: ['Skill', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']")
      && directPptAgentSource.includes('全部来源文件和全部片段')
      && directPptAgentSource.includes('宿主不会生成页面、编排内容或提供兜底稿')
      && directPptAgentSource.includes('hostContentOrchestration: false')
      && directPptAgentSource.includes('hostEvidenceFallback: false')
      && directPptAgentSource.includes('failIfUnavailable: true')
      && !directPptAgentSource.includes('GordenSuperPPTSkill')
      && !directPptAgentSource.includes('pdf-to-editable-ppt'),
    'Skill tool / 全部资料 / Agent 自主生成与验收 / 宿主无内容编排或兜底',
  )

  const quickActionsSource = await readFile(
    path.resolve(process.cwd(), 'src', 'components', 'AiQuickActions.tsx'),
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
  const jwAgentRuntimeSource = await readFile(
    path.resolve(process.cwd(), 'server', 'src', 'runtime', 'jwAgentRuntime.ts'),
    'utf8',
  )
  const taskConversationSource = await readFile(
    path.resolve(process.cwd(), 'src', 'components', 'AiTaskConversationMessage.tsx'),
    'utf8',
  )
  assert(
    '六项文档快捷入口只预选 Skill 并复用普通 Agent 发送',
    quickActionsSource.includes('onSelectSkill')
      && quickActionsSource.includes("skillName: 'draft-investment-proposal'")
      && quickActionsSource.includes("skillName: 'investment-committee-ppt'")
      && quickActionsSource.includes("skillName: 'generate-document-from-template'")
      && assistantPageSource.includes('selectedQuickSkill')
      && assistantPageSource.includes('await agent.sendMessage(ctx, {')
      && assistantPageSource.includes('skillName: quickSkill?.skillName')
      && !assistantPageSource.includes("apiPost<AiTask>('/ai/tasks'"),
    '点击入口 → 普通输入框补充要求 → 发送 → Agent 调用绑定 Skill',
  )
  assert(
    '投资建议书快捷入口与投资提案使用同一普通 Agent 发送流程',
    quickActionsSource.includes("id: 'investment_ppt'")
      && quickActionsSource.includes("mode: 'task'")
      && quickActionsSource.includes("skillName: 'investment-committee-ppt'")
      && quickActionsSource.includes('selectedActionId')
      && assistantPageSource.includes('attachmentFileIds: uploads')
      && assistantPageSource.includes('customTemplateId: quickSkill?.customTemplateId')
      && jwAgentRuntimeSource.includes("taskType: 'investment_recommendation_ppt'")
      && !assistantPageSource.includes("'/ai/tasks/preparations/investment-ppt'")
      && !AI_TEMPLATE_CATALOG.investment_recommendation_ppt.requiredParameters.includes('customTemplateId'),
    '点击入口 → 输入要求 → 普通 Agent 消息 → investment-committee-ppt → PPTX',
  )
  assert(
    '投资建议书快捷入口不再创建模板准备任务',
    !quickActionsSource.includes('onCreatePreparationTask')
      && !quickActionsSource.includes('preparationTaskId')
      && !quickActionsSource.includes('上传、分析并开始生成')
      && !assistantPageSource.includes('createQuickTaskPreparation')
      && !assistantPageSource.includes('onPreparationProgress'),
    '旧模板准备接口仅保留服务端历史兼容，不再参与快捷入口',
  )
  assert(
    '会话消息、文档任务和项目 Q&A 按创建时间统一排列',
    aiMessageSafetySource.includes("safeProperty(rawMetadata, 'timestamp')")
      && assistantPageSource.includes('function buildConversationTimeline(')
      && assistantPageSource.includes('left.timestampMs - right.timestampMs')
      && assistantPageSource.includes('conversationTimeline.map((item)')
      && assistantPageSource.includes('task={item.task}')
      && assistantPageSource.includes('answers={[item.answer]}'),
    'MySQL 消息时间、任务 createdAt 和 Q&A createdAt 合并升序；最新内容位于最下方',
  )
  assert(
    'Q&A 前端创建正式项目文档任务',
    quickActionsSource.includes("id: 'qa'")
      && quickActionsSource.includes("mode: 'task'")
      && quickActionsSource.includes("skillName: 'draft-investment-qa'")
      && quickActionsSource.includes("outputFormat: 'DOCX'")
      && !quickActionsSource.includes('Q&amp;A 类型')
      && !quickActionsSource.includes('问题深度')
      && !quickActionsSource.includes('qaMode')
      && !quickActionsSource.includes('questionDepth')
      && !quickActionsSource.includes("activeAction.id === 'qa' ? 'PDF'")
      && !quickActionsSource.includes('QA_GROUPS')
      && AI_TEMPLATE_CATALOG.project_qa.skillName === 'draft-investment-qa'
      && AI_TEMPLATE_CATALOG.project_qa.templateVersion === 'draft-investment-qa-20260821-v2-skill-native',
    'Q&A task / draft-investment-qa / DOCX',
  )
  const taskCardsSource = await readFile(
    path.resolve(process.cwd(), 'src', 'components', 'AiTaskCards.tsx'),
    'utf8',
  )
  assert(
    '聊天原生文档消息只展示通过 Skill 验收的正式产物',
    taskConversationSource.includes("artifact.qualityStatus === 'passed'")
      && taskConversationSource.includes("['docx', 'pptx', 'pdf'].includes")
      && taskConversationSource.includes('/api/ai/artifacts/${artifact.id}/download'),
    '对话下载与右侧产物中心共用 ai_artifacts ID 和受保护下载接口',
  )
  assert(
    '投资建议书直接 Skill 任务以普通 assistant 消息展示实际阶段和下载',
    taskConversationSource.includes("investment_recommendation_ppt: '投资建议书（PPT）'")
      && taskConversationSource.includes("investment_recommendation_ppt: 'investment-committee-ppt'")
      && taskConversationSource.includes('文档 Agent 实际执行阶段')
      && taskConversationSource.includes('下载 {artifact.format.toUpperCase()} · V{artifact.version}')
      && !taskConversationSource.includes('ProgressBar'),
    '普通对话头像 / 实际阶段 / 无固定百分比 / 正式 PPTX 下载',
  )
  assert(
    'Q&A 与尽调不回退旧宿主编排或旧 Formatter',
    aiTaskServiceSource.indexOf('if (usesDirectQaOrDueDiligenceAgent(task.type))')
      < aiTaskServiceSource.indexOf('let complianceModelResearch:')
      && directDocumentAgentSource.includes('code: \'DIRECT_SKILL_OUTPUT_CONTRACT_FAILED\'')
      && directDocumentAgentSource.includes('最终只在 ./output 中保留一份 DOCX')
      && directDocumentAgentSource.includes('无法完成时明确失败，不得生成占位文件'),
    '直接 Skill Agent 成功即登记单一 DOCX；失败即明确失败，不再降级到旧正文拼装链路',
  )
  assert(
    '聊天原生文档消息展示安全、可行动的失败原因和错误编号',
    taskConversationSource.includes('task.errorMessage')
      && taskConversationSource.includes('错误编号：{task.errorId}')
      && taskConversationSource.includes('继续执行')
      && !taskConversationSource.includes('error.stack'),
    '只展示服务端清洗后的业务原因和错误编号，不展示模型原文或堆栈',
  )

  assert(
    'Q&A 通过普通 Agent 与绑定 Skill 生成可下载产物',
    quickActionsSource.includes("skillName: 'draft-investment-qa'")
      && assistantPageSource.includes('await agent.sendMessage(ctx, {')
      && jwAgentRuntimeSource.includes("taskType: 'project_qa'")
      && !assistantPageSource.includes('parameters.qaMode')
      && !assistantPageSource.includes('parameters.questionDepth')
      && AI_TEMPLATE_CATALOG.project_qa.requiredParameters.join(',') === 'projectId,sourceCutoffDate'
      && !assistantPageSource.includes('Q&A任务创建失败：${(error as Error).message}'),
    '普通消息 → draft-investment-qa → 受控持久任务；类型与深度由标准 Skill 决定',
  )
  assert(
    'AI 助手以普通消息显示持久化的真实阶段且不展示伪百分比',
    taskConversationSource.includes('task.events ?? []')
      && taskConversationSource.includes('event.stage')
      && !taskConversationSource.includes('task.progress}%')
      && !taskConversationSource.includes('ProgressBar'),
    '任务实际阶段跨刷新恢复；固定 82%/98% 和进度条不进入聊天原生展示',
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
