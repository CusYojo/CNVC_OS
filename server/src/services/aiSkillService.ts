import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

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
    mode: 'question-library',
    taskType: null,
  },
] as const

export type AiBusinessSkillName = typeof AI_BUSINESS_SKILLS[number]['name']

export type LoadedAiSkill = {
  name: AiBusinessSkillName
  description: string
  instructions: string
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
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^([a-z][a-z0-9-]*):\s*(.+)$/)
    if (match) fields.set(match[1], parseScalar(match[2]))
  }
  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  const instructions = source.slice(frontmatter[0].length).trim()
  if (!name || !description) throw new Error('SKILL.md 必须声明 name 和 description')
  if (!instructions || instructions.includes('[TODO')) throw new Error('SKILL.md 指令尚未完成')
  return { name, description, instructions }
}

export function getAiSkillRoot() {
  return skillRoot
}

export async function loadAiSkill(name: AiBusinessSkillName): Promise<LoadedAiSkill> {
  if (!AI_BUSINESS_SKILLS.some((item) => item.name === name)) {
    throw new Error(`未注册的 AI Skill：${name}`)
  }
  const skillDir = path.resolve(skillRoot, name)
  const skillPath = path.resolve(skillDir, 'SKILL.md')
  if (
    !skillDir.startsWith(`${skillRoot}${path.sep}`)
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
  if (parsed.name !== name) {
    throw new Error(`AI Skill 名称与目录不一致：${parsed.name} / ${name}`)
  }
  const sha256 = createHash('sha256').update(source).digest('hex')
  return {
    name,
    description: parsed.description,
    instructions: parsed.instructions,
    sha256,
    version: `sha256-${sha256.slice(0, 12)}`,
  }
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
