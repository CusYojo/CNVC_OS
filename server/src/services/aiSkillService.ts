import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

export const AI_TEMPLATE_DRIVEN_SKILL_NAME = 'generate-document-from-template'

export const AI_BUSINESS_SKILLS = [
  {
    name: 'generate-compliance-statement',
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
    name: 'build-investment-recommendation-ppt',
    label: '投资建议书（PPT）',
    mode: 'document-task',
    taskType: 'investment_recommendation_ppt',
  },
  {
    name: 'write-due-diligence-report',
    label: '尽调报告',
    mode: 'document-task',
    taskType: 'due_diligence_report',
  },
  {
    name: 'answer-project-qa',
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
    name: 'pdf-to-editable-ppt',
    label: 'PDF 模板转元素级可编辑 PPT',
    role: 'pdf-template-conversion-and-handoff',
  },
  {
    name: 'editable-ppt-content-replacer',
    label: '可编辑 PPT 模板内容原位替换',
    role: 'openxml-content-replacement-and-qa',
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

export function getAiSkillDirectory(name: string) {
  return path.resolve(skillRoot, name)
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

function parseSkillFile(source: string) {
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

function referencedMarkdownFiles(instructions: string) {
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
  const [directoryStat, fileStat] = await Promise.all([
    lstat(skillDir),
    lstat(skillPath),
  ])
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`AI Skill 目录无效：${name}`)
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`AI Skill 文件无效：${name}`)
  }
  const source = await readFile(skillPath, 'utf8')
  const parsed = parseSkillFile(source)
  if (parsed.name !== input.name) {
    throw new Error(`AI Skill 名称与目录不一致：${parsed.name} / ${input.name}`)
  }
  const referenceNames = referencedMarkdownFiles(parsed.instructions)
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
