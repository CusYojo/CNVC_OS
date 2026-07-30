import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AI_BUSINESS_SKILLS,
  AI_PPT_WORKFLOW_SKILLS,
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
  assert('登记六个业务 Skill', listed.length === 6, `${listed.length} 个`)
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
      `${definition.label} 明确来源披露位置`,
      definition.name === 'write-due-diligence-report'
        ? /系统审计记录/.test(`${skillSource}\n${referenceSource}`)
          && /不增加文末|不包含免责声明/.test(`${skillSource}\n${referenceSource}`)
        : definition.name === 'answer-project-qa'
          ? /系统审计/.test(`${skillSource}\n${referenceSource}`)
            && /不显示|不得显示/.test(`${skillSource}\n${referenceSource}`)
            && /引用资料/.test(referenceSource)
        : definition.name === 'draft-investment-proposal'
          ? /任务来源表|审计元数据/.test(`${skillSource}\n${referenceSource}`)
            && /不得生成.*免责声明.*引用资料|不生成文末.*免责声明.*引用资料/.test(
              `${skillSource}\n${referenceSource}`,
            )
        : /末尾|文尾|最后一页/.test(`${skillSource}\n${referenceSource}`)
          && /来源|引用资料/.test(referenceSource),
      definition.name === 'write-due-diligence-report'
        ? '尽调来源保存在系统审计记录，正式正文不显示文末来源'
        : definition.name === 'answer-project-qa'
          ? 'Q&A 来源保存在系统审计记录，正式 DOCX 不显示来源编号或引用资料'
        : definition.name === 'draft-investment-proposal'
          ? '投资提案来源保存在任务来源表和审计元数据，正文不显示免责声明或引用资料'
        : '仅列实际使用来源并置于末尾',
    )
    if (definition.name === 'answer-project-qa') {
      const documentGeneratorRequirements = [
        '投资中台资深投资经理',
        '当前会话绑定',
        '线索池',
        '项目主体',
        '股权与治理',
        '产品与技术',
        '进入初筛',
        '继续跟踪',
        '申请立项',
        '启动尽调',
        '提请上会',
        '提交投决',
        '暂缓推进',
        '归档',
        '泛泛的行业研究报告',
        'Structured Q&A DOCX Generator',
        'Template Parser',
        'Current Project RAG',
        'Flue Intel Discovery',
        'Controlled Search Fallback',
        'Page Verification',
        'Question Generator',
        'Duplicate Checker',
        'Answer Generator',
        'Reviewer',
        'Formatter',
        'DOCX',
        '项目资料库',
        '项目大模型',
      ]
      assert(
        `${definition.label} 遵守模板学习与内容重建契约`,
        documentGeneratorRequirements.every((term) => skillSource.includes(term)),
        documentGeneratorRequirements.filter((term) => !skillSource.includes(term)).join(', ') || '完整',
      )
      assert(
        `${definition.label} 资料不足时形成核验边界且不使用样本补写`,
        /资料不能完整回答时.*核验边界/.test(`${skillSource}\n${referenceSource}`)
          && /Flue `intel-collect`/.test(`${skillSource}\n${referenceSource}`)
          && /受控公开搜索兜底/.test(`${skillSource}\n${referenceSource}`)
          && /范例正文永远不是当前项目证据/.test(`${skillSource}\n${referenceSource}`)
          && /不得输出“暂无相关资料”/.test(`${skillSource}\n${referenceSource}`),
        '项目资料库优先；关键缺口先由 Flue 发现候选来源，再受控搜索兜底、页面核验并由项目大模型总结，且不得使用模板项目事实',
      )
    }
    if (definition.name === 'generate-document-from-template') {
      const leadIntelligenceRequirements = [
        '投资中台的资深投资经理',
        '当前会话绑定',
        '线索池',
        '股权与治理',
        '产品与技术',
        '进入初筛',
        '继续跟踪',
        '申请立项',
        '启动尽调',
        '提请上会',
        '提交投决',
        '暂缓推进',
        '归档',
        '泛泛的行业研究报告',
        '当前项目',
        '融资与估值',
        '交易方案',
        '可核验来源',
        '本地项目资料库优先',
        'Flue',
        'LLM Gateway',
        '候选 URL',
        '页面核验',
        '搜索摘要',
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
    'PPT 模板准备与内容替换基础能力均可审计',
    pptWorkflowSkills.length === 2
      && pptWorkflowSkills.every((skill) =>
        containsChinese(skill.instructions)
        && /^sha256-[a-f0-9]{12}$/.test(skill.version)
        && /^[a-f0-9]{64}$/.test(skill.sha256)),
    pptWorkflowSkills.map((skill) => `${skill.name}:${skill.version}`).join('、'),
  )
  assert(
    '投资建议书要求上传模板且工作流只绑定两个顺序 Skill',
    AI_TEMPLATE_CATALOG.investment_recommendation_ppt.requiredParameters.includes('customTemplateId')
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.requiredParameters.includes('structureMode')
      && !AI_TEMPLATE_CATALOG.investment_recommendation_ppt.requiredParameters.includes('pageCount')
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.workflowSkillNames?.join(',')
        === 'pdf-to-editable-ppt,editable-ppt-content-replacer'
      && AI_TEMPLATE_CATALOG.investment_recommendation_ppt.skillName
        === 'editable-ppt-content-replacer',
    `${AI_TEMPLATE_CATALOG.investment_recommendation_ppt.requiredParameters.join('、')} / ${
      AI_TEMPLATE_CATALOG.investment_recommendation_ppt.workflowSkillNames?.join('、')}`,
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
        === 'fed1147e287ef8242bf4b6e50ab298f6e5f8f4ba2fbea40e2372de1c2f5e5621'
      && proposalCoreSpec.includes('fed1147e287ef8242bf4b6e50ab298f6e5f8f4ba2fbea40e2372de1c2f5e5621')
      && [
        '你是投资中台的资深投资经理',
        '当前会话绑定',
        '线索池',
        '进入初筛',
        '继续跟踪',
        '申请立项',
        '启动尽调',
        '提请上会',
        '提交投决',
        '暂缓推进',
        '归档',
        '用户本次明确输入',
        '文档主标题 | 黑体 | 16pt',
        '正文行距 | 固定值 24pt',
        '不设置独立封面',
        '四、项目亮点总结',
        '五、风险提示与对策',
        '六、结论',
        '本地项目资料库优先，网络补全为辅，补全结果缓存复用',
        '只联网搜索',
        '不得一开始就发起宽泛的全网搜索',
        '不恢复或依赖 SearXNG',
        '正文末尾不增加“免责声明”或“引用资料”板块',
        '受限初稿',
      ].every((term) => proposalCanonicalSpec.includes(term))
      && [
        '标准 17 节',
        '16 pt',
        '固定值 24 pt',
        '用户本次明确输入',
        '不创建独立封面或模板外目录',
      ].every((term) => proposalCoreSpec.includes(term)),
    '核心规范 SHA-256、资深投资经理角色、阶段建议、17 节结构与版式规则',
  )
  assert(
    'AI-008 默认本地优先、Flue 发现、LLM Gateway 页面核验并缓存复用',
    [
      '本地项目资料库优先',
      'Flue',
      'LLM Gateway',
      '候选 URL',
      '页面核验',
      '只联网搜索',
      '不得一开始就',
      'Local Project Retrieval',
      'Network Cache Retrieval',
      'Evidence Gap Analysis',
      'Flue Candidate Discovery',
      'LLM Gateway Page Verification',
      'Network Cache Writeback',
      '不恢复或依赖 SearXNG',
    ].every((term) =>
      `${proposalSkill.instructions}\n${proposalSkill.referenceInstructions}`.includes(term)),
    '本地资料库 → 网络缓存 → 缺口分析 → Flue 候选发现 → LLM Gateway 页面核验 → 缓存写回',
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
      '只生成、登记并交付一份 DOCX',
      '不生成或登记 PDF',
      '不得逐段套用',
      '订单节奏：',
      '数字小标题',
      '连续的正文段落',
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
    '用户补充',
    '资料截止日',
    '八章',
    '十六',
    '1、投资概要',
    '8、风险与核验',
    '结论—证据—分析—限制',
    '星实-一标',
    '星实-正文',
    '14 pt',
    '1.5 倍行距',
    '两端对齐',
    'Word / WPS',
    'TOC 域',
    '当前项目资料库',
    '后续核验事项',
    '系统审计记录',
    '投资中台的资深投资经理',
    '当前会话绑定',
    '线索池',
    '进入初筛',
    '继续跟踪',
    '申请立项',
    '启动尽调',
    '提请上会',
    '提交投决',
    '暂缓推进',
    '归档',
    '股权与治理',
    '产品与技术',
    '融资与估值',
    '交易方案',
    '可核验来源',
    '不要写泛泛的行业研究报告',
    '本地项目资料库优先',
    '只联网搜索',
    '不得一开始就',
    'Project Knowledge Retrieval',
    'Network Cache Retrieval',
    'Evidence Gap Analysis',
    'Network Cache Writeback',
    '规范化 URL',
    '内容指纹',
    '待核验`是检索触发器',
    '未执行补全不得直接',
    '单次模型响应',
    '最多三个',
    '受影响章组',
  ]
  assert(
    'AI-010 核心规范与项目唯一规范保持关键规则一致',
    diligenceCoreTerms.every((term) =>
      diligenceCanonicalSpec.includes(term) && diligenceCoreSpec.includes(term)),
    diligenceCoreTerms
      .filter((term) =>
        !diligenceCanonicalSpec.includes(term) || !diligenceCoreSpec.includes(term))
      .join('、') || '本地资料库 → 网络缓存 → 定向网络补全 → 缓存写回；八章十六模块、证据写法、精确版式与 WPS 门禁',
  )
  assert(
    'AI-010 Skill 使用 Flue 候选发现和 LLM Gateway 页面核验',
    [
      'Flue Candidate Discovery',
      'LLM Gateway Page Verification',
      'Flue 搜索摘要',
      '不得因此把主任务标记为失败',
    ].every((term) =>
      `${diligenceSkill.instructions}\n${diligenceSkill.referenceInstructions}`.includes(term)),
    '只将页面核验通过的当前项目来源写入证据；联网异常继续生成受限 DOCX',
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
  assert(
    'AI-010 正文按八章分组生成并仅重试受影响章组',
    aiBusinessContentSource.includes('DUE_DILIGENCE_GENERATION_GROUPS')
      && aiBusinessContentSource.includes('DUE_DILIGENCE_DEFAULT_CONCURRENCY = 3')
      && aiBusinessContentSource.includes('runDueDiligenceGroupsWithConcurrency')
      && aiBusinessContentSource.includes('章节 JSON 未完整返回')
      && aiBusinessContentSource.includes('assembleSections')
      && aiBusinessContentSource.includes('requestSummary')
      && aiBusinessContentSource.includes("if (input.type === 'due_diligence_report')")
      && aiTaskServiceSource.includes('AI_DUE_DILIGENCE_CHAPTER_CONCURRENCY')
      && diligenceSkill.instructions.includes('严禁要求模型在一次响应中返回全部十六个模块')
      && diligenceSkill.referenceInstructions.includes('已通过章组不得重新生成'),
    '八个固定章组，最多三个并行；单章独立 JSON、独立重试，合并后生成执行摘要和执行全篇 Reviewer',
  )
  assert(
    'AI-010 待核验项触发 Flue 候选发现、LLM Gateway 页面核验、缓存写回和二次生成',
    [
      'dueDiligencePendingResearchTopics',
      '联网检索 Agent 发现待核验事项来源',
      'LLM Gateway 核验待核验事项公开页面',
      'fetchDueDiligenceNetworkEvidence',
      'fetchVerifiedProjectWebEvidence',
      'cacheProjectNetworkEvidence',
      '使用本地与联网证据重新生成尽调内容',
      'project_knowledge_primary_flue_discovery_llm_page_verification',
    ].every((term) => aiTaskServiceSource.includes(term))
      && aiBusinessContentSource.includes('source.sourceType.startsWith(\'public_web\')')
      && aiBusinessContentSource.includes('finding.status !== \'待核验\'')
      && aiBusinessContentSource.includes('DUE_DILIGENCE_CONTENT_QUALITY_REJECTED')
      && aiBusinessContentSource.includes('DUE_DILIGENCE_MODEL_UNAVAILABLE')
      && aiBusinessContentSource.includes('现有资料')
      && !aiTaskServiceSource.includes('DUE_DILIGENCE_NETWORK_UNAVAILABLE')
      && aiTaskServiceSource.includes('尽调公开页面核验失败，使用现有证据继续生成')
      && dueDiligenceResearchSource.includes('/workflows/${WORKFLOW}?wait=result')
      && dueDiligenceResearchSource.includes('public_web_agent_search'),
    '首轮生成 → 待核验问题提取 → Flue 候选发现 → LLM Gateway 页面核验 → 缓存写回 → 带补全证据二次生成；联网异常继续生成受限 DOCX',
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
  const qaRuntimeCorpus = `${qaSkill.instructions}\n${qaSkill.referenceInstructions}`
  const qaRequired = [
    '阶段与推进建议', '项目主体', '股权与治理', '创始人与团队', '产品与技术',
    '知识产权', '商业模式', '客户与商业化', '市场与应用场景', '竞争格局',
    '财务与现金流', '融资与估值', '交易方案', '合规与权属', '风险与核验',
    '投资中台资深投资经理', '进入初筛', '继续跟踪', '申请立项', '启动尽调',
    '提请上会', '提交投决', '暂缓推进', '归档',
    '泛行业研究',
    '项目资料库', 'Reviewer', 'DOCX', '系统审计记录', '不生成或登记 PDF',
  ]
  assert(
    'Q&A 动态选题、项目资料库证据、内部审阅与 DOCX 契约完整',
    qaRequired.every((term) => qaRuntimeCorpus.includes(term)),
    qaRequired.filter((term) => !qaRuntimeCorpus.includes(term)).join(', ') || '完整',
  )
  const qaStyleRequired = [
    '模板共识',
    '各内容单元的表达目的',
    '分维度论证',
    'DOCX',
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
    '项目资料库与证据',
    '可见正文排除项',
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
      && [
        '投资中台资深投资经理',
        '当前会话绑定',
        '线索池',
        '进入初筛',
        '继续跟踪',
        '申请立项',
        '启动尽调',
        '提请上会',
        '提交投决',
        '暂缓推进',
        '归档',
        '股权与治理',
        '产品与技术',
        '融资与估值',
        '交易方案',
        'A4',
        '宋体',
        'Times New Roman',
        '1.5 倍',
        '问题目录',
        '直接答复',
        '分维度论证',
      ]
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
    'Q&A 作为正式文档任务只输出 DOCX',
    AI_QA_TEMPLATE.outputMode === 'document-task'
      && AI_QA_TEMPLATE.downloadableArtifact === true
      && AI_QA_TEMPLATE.outputFormats.join(',') === 'docx'
      && /DOCX/.test(qaSkill.instructions)
      && /只提供一份.*正式 DOCX/.test(qaSkill.instructions)
      && /项目资料库/.test(qaContract),
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
      && qaRuntimeCorpus.includes('投资中台资深投资经理')
      && !qaPipelineSource.includes('你是早期投资项目线索分析师')
      && !qaRuntimeCorpus.includes('早期投资项目线索分析师')
      && qaRuntimeCorpus.includes('泛行业研究')
      && ['进入初筛', '继续跟踪', '申请立项', '启动尽调', '提请上会', '提交投决', '暂缓推进', '归档']
        .every((term) => qaRuntimeCorpus.includes(term))
      && qaSkill.referenceNames.includes('references/qa-contract.md')
      && qaSkill.referenceNames.includes('references/qa-template-style-guide.md')
      && qaSkill.referenceNames.includes('references/workflow.md')
      && qaSkill.referenceNames.includes('references/pipeline-prompts.md')
      && qaSkill.referenceInstructions.includes('# Q&A 生产契约')
      && qaSkill.referenceInstructions.includes('# Q&A Pipeline Prompts'),
    '生产契约 + 模板画像 + Workflow + Pipeline Prompts',
  )
  assert(
    'Q&A Pipeline 包含 Parser、项目 RAG、Generator、Duplicate Checker、Reviewer 与 DOCX 生成',
    qaPipelineSource.includes('generateProjectQaQuestions')
      && qaPipelineSource.includes('checkDuplicateQuestions')
      && qaPipelineSource.includes('reviewProjectQaAnswers')
      && qaDocumentSource.includes('generateProjectQaDocx')
      && !qaDocumentSource.includes('convertProjectQaDocxToPdf')
      && qaParserSource.includes('parseQaTemplateCorpus'),
    'Template Parser / Current Project RAG / Question Generator / Duplicate Checker / Reviewer / DOCX',
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
      && !qaDocumentSource.includes("mixedTextRuns('引用资料'")
      && !qaDocumentSource.includes("mixedTextRuns('Reviewer 审阅结果'")
      && qaPipelineSource.includes('function cleanAnswerText')
      && qaPipelineSource.includes('五个连续自然段')
      && qaDocumentSource.includes('answerParagraphFormValid')
      && qaDocumentSource.includes('visibleAnswerLabelsAbsent')
      && qaDocumentSource.includes('visibleSubheadingsAbsent')
      && !qaDocumentSource.includes('function dimensionParagraph')
      && !qaDocumentSource.includes('bodyParagraph(`答复：${line}`')
      && !qaDocumentSource.includes('index === 6')
      && qaDocumentSource.includes('globalIndex === 0'),
    '宋体 / 18pt 标题 / 14pt 问题 / 无小标题自然段 / 1.5 倍行距 / 25.4×31.7mm 页边距',
  )
  assert(
    'Q&A 双模式边界明确且正式任务只交付 DOCX',
    /正式文档模式/.test(qaSkill.instructions)
      && /单题会话模式/.test(qaSkill.instructions)
      && /DOCX/.test(qaSkill.instructions)
      && /不生成或登记 PDF、PPT 或 PPTX/.test(qaSkill.instructions)
      && /不创建文档任务或下载产物/.test(qaSkill.instructions),
    '正式任务 DOCX / 单题结构化回答 / 禁止 PDF、PPT、PPTX',
  )

  const pptContract = await readFile(
    path.join(root, 'editable-ppt-content-replacer', 'SKILL.md'),
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
  const pptReplacerSource = await readFile(
    path.resolve(
      process.cwd(),
      'server',
      'src',
      'services',
      'aiEditablePptContentReplacerService.ts',
    ),
    'utf8',
  )
  assert(
    'PPT Skill 明确单一可编辑 PPTX 链路',
    /原生可编辑对象/.test(pptContract)
      && /不得再生成第二份\s*纯图片 PPTX/.test(pptContract)
      && /pdf-to-editable-ppt/.test(pptContract)
      && /editable-ppt-content-replacer/.test(pptContract)
      && /sourceMode:\s*"native-pptx"/.test(pptContract),
    '核心内容原生可编辑 / 仅一份正式 PPTX',
  )
  assert(
    'PDF 转换交接门槛和原生 PPTX 跳过逻辑已接入',
    [
      'watermarkQaPassed',
      'editabilityReviewPassed',
      'readyForContentReplacement',
      'pdf-converted',
      'native-pptx',
      '用户上传模板为原生可编辑 PPTX，无需执行 PDF 转换',
    ].every((term) => pptWorkflowSource.includes(term)),
    'PDF 模板必须通过交接证书；上传的原生 PPTX 记录 converter not-required',
  )
  assert(
    '可编辑内容替换使用语义键、证据备注和生成后 Reviewer',
    pptWorkflowSource.includes("schemaVersion: '1.3'")
      && pptWorkflowSource.includes("defaultOperation: 'KEEP'")
      && pptWorkflowSource.includes('semanticKey')
      && pptWorkflowSource.includes('evidenceIds')
      && pptWorkflowSource.includes('sourceNotesPresent')
      && pptDocumentSource.includes('generateInvestmentRecommendationPptFromTemplate')
      && pptReplacerSource.includes('replacement-manifest.json')
      && pptReplacerSource.includes('apply_template_plan_openxml.py')
      && pptReplacerSource.includes('validate_template_result_openxml.py')
      && pptReplacerSource.includes('final-watermark-qa.json'),
    'KEEP / semanticKey / evidenceIds / [Sources] / OpenXML 原位替换与水印检查',
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
    '投资建议书前端和任务 API 强制使用上传模板',
    quickActionsSource.includes("accept={isInvestmentTemplateAction ? '.pdf,.pptx'")
      && quickActionsSource.includes("purpose: isInvestmentPpt")
      && quickActionsSource.includes("'investment_recommendation_ppt'")
      && quickActionsSource.includes('严格沿用上传模板')
      && assistantPageSource.includes('parameters.customTemplateId = request.customTemplateId')
      && assistantPageSource.includes("parameters.structureMode = request.structureMode || 'strict-template'")
      && aiTasksRouteSource.includes("path: ['parameters', 'customTemplateId']")
      && aiTasksRouteSource.includes("requireAllowed('structureMode', ['strict-template']")
      && !aiTasksRouteSource.includes("requireAllowed('template', ['公司标准模板']"),
    'PDF/PPTX 上传 → 模板分析 → customTemplateId → strict-template 任务',
  )
  assert(
    '投资建议书模板分析完成后自动创建任务并切换到统一进度条',
    quickActionsSource.includes('const taskCreated = await submit(result)')
      && quickActionsSource.includes("stage: isInvestmentPpt")
      && quickActionsSource.includes('模板分析完成，正在创建生成任务')
      && quickActionsSource.includes("if (ok) setActiveAction(null)")
      && quickActionsSource.includes('上传、分析并开始生成')
      && assistantPageSource.includes('setAiTasks((items) => [task, ...items.filter')
      && assistantPageSource.includes('scrollRef.current?.scrollTo'),
    '分析成功 → 自动创建任务 → 关闭上传弹窗 → 滚动到任务卡进度条',
  )
  assert(
    '会话消息、文档任务和项目 Q&A 按创建时间统一排列',
    aiMessageSafetySource.includes("safeProperty(rawMetadata, 'timestamp')")
      && assistantPageSource.includes('function buildConversationTimeline(')
      && assistantPageSource.includes('left.timestampMs - right.timestampMs')
      && assistantPageSource.includes('conversationTimeline.map((item)')
      && assistantPageSource.includes('tasks={[item.task]}')
      && assistantPageSource.includes('answers={[item.answer]}'),
    'Flue 消息时间、任务 createdAt 和 Q&A createdAt 合并升序；最新内容位于最下方',
  )
  assert(
    'Q&A 前端创建正式项目文档任务',
    quickActionsSource.includes("id: 'qa'")
      && quickActionsSource.includes("mode: 'task'")
      && quickActionsSource.includes('投资委员会 Q&A')
      && quickActionsSource.includes('项目投资问答 DOCX')
      && !quickActionsSource.includes("activeAction.id === 'qa' ? 'PDF'")
      && !quickActionsSource.includes('QA_GROUPS'),
    'Q&A task / 投资委员会或尽调 / DOCX',
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
      && aiTaskServiceSource.includes("retryDocumentStep('DOCX Formatter'")
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
      && assistantPageSource.includes('parameters.qaMode')
      && assistantPageSource.includes('parameters.questionDepth')
      && !assistantPageSource.includes('任务创建失败：${(error as Error).message}'),
    'POST /api/ai/tasks type=project_qa',
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
      && assistantPageSource.includes('accept={AI_UPLOAD_ACCEPT}'),
    '拖拽与回形针选择复用同一上传、项目入库、进度和失败隔离流程',
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
