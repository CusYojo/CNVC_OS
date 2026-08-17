import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

const root = path.resolve(process.env.AI_CUSTOM_TEMPLATE_DATA_ROOT || process.env.AI_CUSTOM_TEMPLATE_ROOT || 'server/ai-template-data')
const quarantineRoot = path.resolve('.runtime/migration-evidence/quarantine/ai-template-acceptance-fixtures')
const apply = process.argv.slice(2).includes('--apply')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fixtureFile = /^AI-009-上传模板-[0-9a-f]{8}\.pptx$/
const expectedSlideText = [
  '投资建议书模板',
  '项目概览',
  '投资判断',
  '风险与核验',
  '封面：项目名称、截止日期和内部使用说明',
  '公司定位、发展阶段和融资安排',
  '投资逻辑、亮点和推进建议',
  '风险触发条件、资料缺口和后续动作',
] as const

type Candidate = {
  source: string
  relativePath: string
  userId: string
  projectId: string
  conversationId: string
  templateId: string
  pptxName: string
  pptxSha256: string
  analysisSha256: string
  identitySha256: string
}

function table(name: string) {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function isInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function existingIds(name: string): Promise<Set<string>> {
  const [rows] = await pool.query<Array<RowDataPacket & { id: string }>>(`SELECT id FROM ${table(name)}`)
  return new Set(rows.map((row) => String(row.id)))
}

async function candidateDirectories(): Promise<string[]> {
  const rootInfo = await lstat(root).catch(() => null)
  if (!rootInfo) return []
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('AI template data root must be a regular directory')
  let directories = [root]
  for (let depth = 0; depth < 4; depth += 1) {
    const next: string[] = []
    for (const directory of directories) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!uuid.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue
        next.push(path.join(directory, entry.name))
      }
    }
    directories = next
  }
  return directories
}

async function inspectCandidate(directory: string): Promise<Candidate | null> {
  if (!isInside(root, directory)) throw new Error('candidate escaped AI template root')
  const relativePath = path.relative(root, directory)
  const segments = relativePath.split(path.sep)
  if (segments.length !== 4 || !segments.every((segment) => uuid.test(segment))) return null
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.length !== 2 || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) return null
  const pptxEntry = entries.find((entry) => fixtureFile.test(entry.name))
  const analysisEntry = entries.find((entry) => entry.name === 'template-analysis.json')
  if (!pptxEntry || !analysisEntry) return null
  const pptxPath = path.join(directory, pptxEntry.name)
  const analysisPath = path.join(directory, analysisEntry.name)
  const [pptxInfo, analysisInfo] = await Promise.all([lstat(pptxPath), lstat(analysisPath)])
  if (pptxInfo.size <= 0 || pptxInfo.size > 25 * 1024 * 1024 || analysisInfo.size <= 0 || analysisInfo.size > 2 * 1024 * 1024) return null
  const analysis = JSON.parse(await readFile(analysisPath, 'utf8')) as Record<string, unknown>
  if (analysis.fileName !== pptxEntry.name || analysis.schemaVersion !== '1.0' || analysis.format !== 'pptx') return null
  const zip = await JSZip.loadAsync(await readFile(pptxPath), { checkCRC32: true })
  const slides = Object.entries(zip.files).filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
  if (slides.length !== 4) return null
  const slideXml = (await Promise.all(slides.map(([, entry]) => entry.async('string')))).join('\n')
  if (!expectedSlideText.every((text) => slideXml.includes(text))) return null
  const [pptxSha256, analysisSha256] = await Promise.all([sha256File(pptxPath), sha256File(analysisPath)])
  return {
    source: directory,
    relativePath: relativePath.split(path.sep).join('/'),
    userId: segments[0],
    projectId: segments[1],
    conversationId: segments[2],
    templateId: segments[3],
    pptxName: pptxEntry.name,
    pptxSha256,
    analysisSha256,
    identitySha256: createHash('sha256').update(`${relativePath}\0${pptxSha256}\0${analysisSha256}`).digest('hex'),
  }
}

async function chmodTree(directory: string): Promise<void> {
  await chmod(directory, 0o700)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) await chmodTree(target)
    else if (entry.isFile()) await chmod(target, 0o600)
    else throw new Error('quarantine target contains a non-regular entry')
  }
}

async function removeEmptyParents(directory: string): Promise<void> {
  let current = path.dirname(directory)
  while (current !== root && isInside(root, current)) {
    try {
      await rmdir(current)
      current = path.dirname(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return
      throw error
    }
  }
}

async function main() {
  const [users, projects, chatConversations, agentConversations, templates] = await Promise.all([
    existingIds('users'),
    existingIds('projects'),
    existingIds('chat_conversations'),
    existingIds('agent_conversations'),
    existingIds('ai_custom_templates'),
  ])
  const inspected = await Promise.all((await candidateDirectories()).map(inspectCandidate))
  const candidates = inspected.filter((candidate): candidate is Candidate => Boolean(candidate)).filter((candidate) => (
    !users.has(candidate.userId)
    && !projects.has(candidate.projectId)
    && !chatConversations.has(candidate.conversationId)
    && !agentConversations.has(candidate.conversationId)
    && !templates.has(candidate.templateId)
  ))
  const moved: Candidate[] = []
  if (apply) {
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 })
    await chmod(quarantineRoot, 0o700)
    for (const candidate of candidates) {
      const target = path.resolve(quarantineRoot, candidate.relativePath)
      if (!isInside(quarantineRoot, target)) throw new Error('quarantine target escaped root')
      if (await lstat(target).catch(() => null)) throw new Error(`quarantine target already exists for ${candidate.identitySha256}`)
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await rename(candidate.source, target)
      await chmodTree(target)
      await removeEmptyParents(candidate.source)
      moved.push(candidate)
    }
  }
  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    apply,
    matchedDirectories: candidates.length,
    matchedFiles: candidates.length * 2,
    movedDirectories: moved.length,
    movedFiles: moved.length * 2,
    checks: {
      exactAcceptanceFileName: true,
      exactFourSlideAcceptanceContent: true,
      pairedAnalysisMetadata: true,
      sourceIdsAbsentFromTargetMysql: true,
      noSymlinksFollowed: true,
      originalBytesRetainedInPrivateQuarantine: apply,
    },
    items: candidates.map((candidate) => ({
      identitySha256: candidate.identitySha256,
      pptxSha256: candidate.pptxSha256,
      analysisSha256: candidate.analysisSha256,
      moved: moved.includes(candidate),
    })),
    pathsExcluded: true,
    identitiesExcluded: true,
    businessContentExcluded: true,
    secretsExcluded: true,
  }
  if (apply) {
    const reportPath = path.join(quarantineRoot, 'report.json')
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    await chmod(reportPath, 0o600)
  }
  console.log(JSON.stringify({
    ok: true,
    apply,
    matchedDirectories: report.matchedDirectories,
    matchedFiles: report.matchedFiles,
    movedDirectories: report.movedDirectories,
    movedFiles: report.movedFiles,
    evidence: apply,
  }))
}

await main().finally(async () => pool.end())
