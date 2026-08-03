#!/usr/bin/env node
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(process.argv[2] || '')
if (!process.argv[2]) {
  console.error('Usage: node validate-agent-skills.mjs <skills-root>')
  process.exit(2)
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const REQUIRED_SKILLS = new Set([
  'answer-project-qa',
  'build-investment-recommendation-ppt',
  'draft-investment-proposal',
  'editable-ppt-content-replacer',
  'generate-compliance-statement',
  'generate-document-from-template',
  'pdf-to-editable-ppt',
  'write-due-diligence-report',
])

function parseFrontmatter(source, skillName) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) throw new Error(`${skillName}: SKILL.md 缺少 YAML frontmatter`)
  const fields = new Map()
  const lines = match[1].split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(/^([a-z][a-z0-9-]*):\s*(.*)$/)
    if (!field) continue
    const [, key, raw] = field
    if (/^[>|][+-]?$/.test(raw.trim())) {
      const block = []
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        block.push(lines[index + 1].trim())
        index += 1
      }
      fields.set(key, raw.trim().startsWith('>')
        ? block.join(' ').trim()
        : block.join('\n').trim())
    } else {
      fields.set(key, raw.trim().replace(/^(['"])(.*)\1$/, '$2'))
    }
  }
  return {
    name: fields.get('name') || '',
    description: fields.get('description') || '',
    instructions: source.slice(match[0].length).trim(),
  }
}

function localMarkdownLinks(source) {
  return [...source.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1].split('#', 1)[0])
    .filter((value) => value && !/^(?:https?:|mailto:|data:)/i.test(value))
}

async function assertRegularFile(filePath, label) {
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label}: 必须是普通文件且不能是符号链接`)
  }
}

async function assertNoSymlinks(directory, skillName) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    const stat = await lstat(entryPath)
    if (stat.isSymbolicLink()) throw new Error(`${skillName}: 不允许符号链接 ${entry.name}`)
    if (stat.isDirectory()) await assertNoSymlinks(entryPath, skillName)
  }
}

async function main() {
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Skills 根目录无效：${root}`)
  }
  const canonicalRoot = await realpath(root)
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith('.'))
  const names = new Set()

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Skills 根目录只允许直接 Skill 目录：${entry.name}`)
    }
    const skillName = entry.name
    if (!NAME_PATTERN.test(skillName)) {
      throw new Error(`${skillName}: 目录名必须为 lowercase kebab-case`)
    }
    if (names.has(skillName)) throw new Error(`${skillName}: Skill 名称重复`)
    names.add(skillName)

    const skillDir = path.join(root, skillName)
    const skillPath = path.join(skillDir, 'SKILL.md')
    await assertRegularFile(skillPath, `${skillName}/SKILL.md`)
    await assertNoSymlinks(skillDir, skillName)
    const source = await readFile(skillPath, 'utf8')
    const parsed = parseFrontmatter(source, skillName)
    if (parsed.name !== skillName) {
      throw new Error(`${skillName}: frontmatter name 必须与目录名一致（当前 ${parsed.name || '空'}）`)
    }
    if (!NAME_PATTERN.test(parsed.name)) {
      throw new Error(`${skillName}: frontmatter name 必须为 lowercase kebab-case`)
    }
    if (!parsed.description || parsed.description.length > 1024) {
      throw new Error(`${skillName}: description 必须为 1-1024 个字符`)
    }
    if (!parsed.instructions) throw new Error(`${skillName}: SKILL.md 缺少正文指令`)

    for (const reference of localMarkdownLinks(source)) {
      const referencePath = path.resolve(skillDir, reference)
      if (
        referencePath !== canonicalRoot
        && !referencePath.startsWith(`${canonicalRoot}${path.sep}`)
      ) {
        throw new Error(`${skillName}: 引用路径越界 ${reference}`)
      }
      await assertRegularFile(referencePath, `${skillName}: 引用 ${reference}`)
    }
  }

  const missing = [...REQUIRED_SKILLS].filter((name) => !names.has(name)).sort()
  if (missing.length) throw new Error(`缺少核心 Skills：${missing.join('、')}`)
  console.log(`Validated ${names.size} agent skills in ${root}`)
}

main().catch((error) => {
  console.error(`Agent Skill validation failed: ${error.message}`)
  process.exit(1)
})
