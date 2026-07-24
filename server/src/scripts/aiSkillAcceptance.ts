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
  }

  assert(
    '四类文档任务均绑定唯一 Skill',
    new Set(AI_TASK_TYPES.map((type) => AI_TEMPLATE_CATALOG[type].skillName)).size === 4,
    AI_TASK_TYPES.map((type) => `${type}:${AI_TEMPLATE_CATALOG[type].skillName}`).join(', '),
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

  const qaContract = await readFile(
    path.join(root, 'answer-project-qa', 'references', 'qa-contract.md'),
    'utf8',
  )
  const qaRequired = [
    '投资亮点',
    '核心风险',
    '财务',
    '客户',
    '竞争',
    '合规',
    '资料缺口',
    'evidence_count',
    'confidence_status',
    'disclaimer',
  ]
  assert(
    'Q&A 七类问题与回答契约完整',
    qaRequired.every((term) => qaContract.includes(term)),
    qaRequired.filter((term) => !qaContract.includes(term)).join(', ') || '完整',
  )
  assert(
    'Q&A 问题选择后不自动发送',
    /不得自动发送|绝不自动发送/.test(qaContract)
      && /等待用户明确确认发送/.test(qaContract),
    '问题库模式必须等待用户明确确认',
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
  const qaCategories = ['投资亮点', '核心风险', '财务', '客户', '竞争', '合规', '资料缺口']
  assert(
    'Q&A 前端提供七类问题库',
    qaCategories.every((category) => quickActionsSource.includes(`label: '${category}'`)),
    qaCategories.filter((category) => !quickActionsSource.includes(`label: '${category}'`)).join(', ') || '完整',
  )

  const assistantPageSource = await readFile(
    path.resolve(process.cwd(), 'src', 'pages', 'AIAssistantPage.tsx'),
    'utf8',
  )
  assert(
    'Q&A 用户确认后直接调用持久化 Skill API',
    assistantPageSource.includes("apiPost<ProjectQaAnswer>('/ai/qa'")
      && assistantPageSource.includes('setQaAnswers'),
    'POST /api/ai/qa',
  )
  assert(
    'Q&A 按会话恢复持久化回答',
    assistantPageSource.includes('/ai/qa?conversationId=')
      && assistantPageSource.includes('qaAnswersLoading'),
    'GET /api/ai/qa?conversationId=...',
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
