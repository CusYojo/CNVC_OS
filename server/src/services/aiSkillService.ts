import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

export const AI_TEMPLATE_DRIVEN_SKILL_NAME = 'generate-document-from-template'
export const AI_DUE_DILIGENCE_SKILL_NAME = 'draft-due-diligence-report'

// 正式文档任务只加载同名独立 Skill。旧 Plugin 包保留为历史资产，
// 不再参与能力目录、运行时路由或文档生成核心。
export const AI_DOCUMENT_PLUGIN_BINDINGS = [] as const

export const AI_QA_SKILL_NAMES = [
  'draft-investment-qa',
] as const

export type AiQaSkillName = typeof AI_QA_SKILL_NAMES[number]

// 快捷任务的 Q&A 只绑定公司当前标准技能；历史任务中的旧名称仅作为审计数据保留。
export const AI_QA_SKILL_NAME: AiQaSkillName = 'draft-investment-qa'

export const AI_REQUIRED_DOCUMENT_SKILL_NAMES = [
  'generate-investment-compliance-note',
  AI_QA_SKILL_NAME,
  'draft-investment-proposal',
  'investment-committee-ppt',
  AI_DUE_DILIGENCE_SKILL_NAME,
] as const

export const AI_BUSINESS_SKILLS = [
  {
    name: 'generate-investment-compliance-note',
    label: '合规性说明',
    mode: 'document-task',
    taskType: 'compliance_statement',
  },
  {
    name: 'draft-investment-proposal',
    label: '投资提案',
    mode: 'document-task',
    taskType: 'investment_proposal',
  },
  {
    name: 'investment-committee-ppt',
    label: '投资建议书（PPT）',
    mode: 'document-task',
    taskType: 'investment_recommendation_ppt',
  },
  {
    name: AI_DUE_DILIGENCE_SKILL_NAME,
    label: '尽调报告',
    mode: 'document-task',
    taskType: 'due_diligence_report',
  },
  {
    name: AI_QA_SKILL_NAME,
    label: 'Q&A',
    mode: 'document-task',
    taskType: 'project_qa',
  },
  {
    name: AI_TEMPLATE_DRIVEN_SKILL_NAME,
    label: '上传模板',
    mode: 'document-task',
    taskType: 'custom_template_document',
  },
] as const

export type AiBusinessSkillName = typeof AI_BUSINESS_SKILLS[number]['name']

export const AI_PPT_WORKFLOW_SKILLS = [
  {
    name: 'create-reference-driven-editable-ppt',
    label: '参考模板可编辑 PPT 总编排',
    role: 'ppt-orchestration-and-handoff',
  },
  {
    name: 'GordenSuperPPTSkill',
    label: 'Gorden 图片生成与可编辑 PPTX 还原',
    role: 'ppt-generation-and-editable-reconstruction',
  },
  {
    name: 'pdf-to-editable-ppt',
    label: 'PDF 桥接稿转元素级可编辑 PPT',
    role: 'final-editable-conversion-and-qa',
  },
] as const

export type AiPptWorkflowSkillName = typeof AI_PPT_WORKFLOW_SKILLS[number]['name']

export type LoadedAiSkill = {
  name: string
  description: string
  instructions: string
  referenceInstructions: string
  referenceNames: string[]
  sha256: string
  version: string
}

const configuredWorkspace = path.resolve(
  process.env.AGENT_WORKSPACE ?? '/data/cybernaut-assistant/workspace',
)
const workspaceRoot = process.env.NODE_ENV !== 'production' && !existsSync(configuredWorkspace)
  ? path.resolve(process.cwd(), 'server', 'workspace')
  : configuredWorkspace
const workspaceSkillRoot = path.join(workspaceRoot, '.agents', 'skills')
const bundledSkillRoot = path.resolve(
  process.cwd(),
  'server',
  'workspace',
  '.agents',
  'skills',
)
const skillRoot = path.resolve(
  process.env.AI_SKILL_ROOT
    ?? (
      process.env.NODE_ENV !== 'production' && !existsSync(workspaceSkillRoot)
        ? bundledSkillRoot
        : workspaceSkillRoot
    ),
)
const AI_SKILL_DIRECTORY_CANDIDATES_BY_NAME: Readonly<Record<string, string[]>> = {
  GordenSuperPPTSkill: [
    path.join('GordenSuperPPTSkills', 'GordenSuperPPTSkill'),
    'GordenSuperPPTSkill',
  ],
}

export function resolveAiSkillDirectory(name: string, root: string) {
  const candidates = AI_SKILL_DIRECTORY_CANDIDATES_BY_NAME[name] ?? [name]
  const resolved = candidates.map((candidate) => path.resolve(root, candidate))
  return resolved.find((candidate) => existsSync(path.join(candidate, 'SKILL.md')))
    ?? resolved[0]
}

export function getAiSkillRuntimeDirectory(name: string) {
  return resolveAiSkillDirectory(name, skillRoot)
}

export function getAiSkillDirectory(name: string) {
  return getAiSkillRuntimeDirectory(name)
}

function parseScalar(value: string) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseAiSkillFile(source: string) {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!frontmatter) throw new Error('SKILL.md 缺少 YAML frontmatter')
  const fields = new Map<string, string>()
  const lines = frontmatter[1].split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([a-z][a-z0-9-]*):\s*(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (/^[>|][+-]?$/.test(rawValue.trim())) {
      const block: string[] = []
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        block.push(lines[index + 1].trim())
        index += 1
      }
      fields.set(key, rawValue.trim().startsWith('>')
        ? block.join(' ').trim()
        : block.join('\n').trim())
      continue
    }
    if (rawValue.trim()) fields.set(key, parseScalar(rawValue))
  }
  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  const instructions = source.slice(frontmatter[0].length).trim()
  if (!name || !description) throw new Error('SKILL.md 必须声明 name 和 description')
  if (!instructions || instructions.includes('[TODO')) throw new Error('SKILL.md 指令尚未完成')
  return { name, description, instructions }
}

export function referencedAiSkillMarkdownFiles(instructions: string) {
  return [...new Set(
    [...instructions.matchAll(/\]\((references\/[^)\s]+\.md)\)/g)]
      .map((match) => match[1]),
  )]
}

export function getAiSkillRoot() {
  return skillRoot
}

export async function loadAiSkillFromDirectory(input: {
  name: string
  directory: string
  allowedRoot: string
  expectedName?: string
  identitySource?: string
}): Promise<LoadedAiSkill> {
  const allowedRoot = path.resolve(input.allowedRoot)
  const skillDir = path.resolve(input.directory)
  const skillPath = path.resolve(skillDir, 'SKILL.md')
  if (
    !skillDir.startsWith(`${allowedRoot}${path.sep}`)
    || !skillPath.startsWith(`${skillDir}${path.sep}`)
  ) {
    throw new Error('AI Skill 路径越界')
  }
  let directoryStat: Awaited<ReturnType<typeof lstat>>
  let fileStat: Awaited<ReturnType<typeof lstat>>
  try {
    [directoryStat, fileStat] = await Promise.all([
      lstat(skillDir),
      lstat(skillPath),
    ])
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw Object.assign(new Error(`AI Skill 不可用：${input.name}`), {
        status: 503,
        code: 'AI_SKILL_NOT_AVAILABLE',
      })
    }
    throw error
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`AI Skill 目录无效：${input.name}`)
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`AI Skill 文件无效：${input.name}`)
  }
  const source = await readFile(skillPath, 'utf8')
  const parsed = parseAiSkillFile(source)
  const expectedName = input.expectedName ?? input.name
  if (parsed.name !== expectedName) {
    throw new Error(`AI Skill 名称与目录不一致：${parsed.name} / ${expectedName}`)
  }
  const referenceNames = referencedAiSkillMarkdownFiles(parsed.instructions)
  const referenceSources: string[] = []
  for (const referenceName of referenceNames) {
    const referencePath = path.resolve(skillDir, referenceName)
    if (!referencePath.startsWith(`${skillDir}${path.sep}`)) {
      throw new Error(`AI Skill 引用路径越界：${referenceName}`)
    }
    const referenceStat = await lstat(referencePath)
    if (!referenceStat.isFile() || referenceStat.isSymbolicLink()) {
      throw new Error(`AI Skill 引用文件无效：${referenceName}`)
    }
    referenceSources.push(await readFile(referencePath, 'utf8'))
  }
  const referenceInstructions = referenceSources
    .map((reference, index) => `## ${referenceNames[index]}\n\n${reference.trim()}`)
    .join('\n\n')
  const sha256 = createHash('sha256')
    .update(source)
    .update('\n\n')
    .update(referenceInstructions)
    .update('\n\n')
    .update(input.identitySource ?? '')
    .digest('hex')
  return {
    name: input.name,
    description: parsed.description,
    instructions: parsed.instructions,
    referenceInstructions,
    referenceNames,
    sha256,
    version: `sha256-${sha256.slice(0, 12)}`,
  }
}

export async function loadAiSkill(name: string): Promise<LoadedAiSkill> {
  const isBusinessSkill = AI_BUSINESS_SKILLS.some((item) => item.name === name)
  const isPptWorkflowSkill = AI_PPT_WORKFLOW_SKILLS.some((item) => item.name === name)
  if (!isBusinessSkill && !isPptWorkflowSkill) {
    throw new Error(`未注册的 AI Skill：${name}`)
  }
  return loadAiSkillFromDirectory({
    name,
    directory: getAiSkillDirectory(name),
    allowedRoot: skillRoot,
  })
}

export async function loadAiPptWorkflowSkills() {
  return Promise.all(AI_PPT_WORKFLOW_SKILLS.map(async (item) => ({
    ...item,
    skill: await loadAiSkill(item.name),
  })))
}

export async function listAiBusinessSkills() {
  return Promise.all(AI_BUSINESS_SKILLS.map(async (item) => {
    const loaded = await loadAiSkill(item.name)
    return {
      ...item,
      description: loaded.description,
      version: loaded.version,
      sha256: loaded.sha256,
    }
  }))
}
