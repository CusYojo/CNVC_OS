import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

type RootKey =
  | 'project-files'
  | 'ai-artifacts'
  | 'ai-template-data'
  | 'legacy-template-skills'
  | 'generated'
  | 'workspace'
  | 'jw-agent-workspace'
  | 'radar-data'
  | 'skills'

type AssetRoot = {
  key: RootKey
  absolutePath: string
  requiredWhenReferenced: boolean
}

type AssetReference = {
  kind: 'project_file' | 'ai_artifact' | 'ai_custom_template'
  id: string
  absolutePath: string
  userId: string | null
  projectId: string | null
  conversationId: string | null
  expectedSha256: string | null
}

type AssetRecord = {
  root: RootKey
  relativePath: string
  size: number
  modifiedAt: string
  sha256: string | null
  ownership: 'verified' | 'derived' | 'system' | 'unresolved'
  userId: string | null
  projectId: string | null
  conversationId: string | null
  references: Array<{ kind: string; id: string }>
}

type ManifestIssue = {
  severity: 'blocking' | 'review' | 'info'
  code: string
  root: RootKey | null
  path: string
  detail: string
}

type ConversationOwner = { userId: string; projectId: string | null }
type TaskOwner = { userId: string; projectId: string }
type TemplateOwner = TaskOwner & { conversationId: string | null }

const outputDir = path.resolve(process.env.FILE_MANIFEST_OUTPUT_DIR || '.runtime/migration-evidence/file-assets')
const args = process.argv.slice(2)
const expectedEmptyRadarJsonl = new Set([
  'arxiv_candidates.jsonl',
  'wechat_985_candidates.jsonl',
  'wechat_api_candidates.jsonl',
  'wechat_chat_candidates.jsonl',
  'investment_candidates.jsonl',
])
const strict = args.includes('--strict')
const approve = args.includes('--approve')
function argumentValue(name: string): string {
  const index = args.indexOf(name)
  return index >= 0 ? String(args[index + 1] ?? '').trim() : ''
}
const environment = argumentValue('--environment') || process.env.NODE_ENV || 'development'
const approvedBy = argumentValue('--approved-by')
if (approve && (!strict || environment !== 'production' || !approvedBy)) {
  throw new Error('--approve requires --strict, --environment production and a non-empty --approved-by identity')
}
const maxFiles = (() => {
  const value = Number(process.env.FILE_MANIFEST_MAX_FILES || 250_000)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('FILE_MANIFEST_MAX_FILES must be a positive integer')
  return value
})()

function table(name: string) {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function normalizeRelative(root: string, candidate: string) {
  return path.relative(root, candidate).split(path.sep).join('/')
}

function resolveStoredPath(root: string, storedPath: string) {
  return path.resolve(path.isAbsolute(storedPath) ? storedPath : path.join(root, storedPath))
}

function uniqueRoots(candidates: AssetRoot[]): AssetRoot[] {
  const exact = new Map<string, AssetRoot>()
  for (const candidate of candidates) {
    const existing = exact.get(candidate.absolutePath)
    if (!existing) exact.set(candidate.absolutePath, candidate)
    else if (candidate.requiredWhenReferenced) existing.requiredWhenReferenced = true
  }
  const roots = [...exact.values()]
  return roots.filter((candidate) => !roots.some((parent) => (
    parent !== candidate && isInside(parent.absolutePath, candidate.absolutePath)
  )))
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function queryRows<T extends RowDataPacket>(sql: string): Promise<T[]> {
  const [rows] = await pool.query<T[]>(sql)
  return rows
}

async function loadDatabaseContext() {
  const [users, chatRows, agentRows, tasks, projectFileRows, artifactRows, templateRows] = await Promise.all([
    queryRows<RowDataPacket & { id: string }>(`SELECT id FROM ${table('users')}`),
    queryRows<RowDataPacket & { id: string; userId: string; projectId: string | null }>(
      `SELECT id, user_id AS userId, project_id AS projectId FROM ${table('chat_conversations')}`,
    ),
    queryRows<RowDataPacket & { id: string; userId: string; projectId: string | null }>(
      `SELECT id, user_id AS userId, project_id AS projectId FROM ${table('agent_conversations')}`,
    ),
    queryRows<RowDataPacket & { id: string; userId: string; projectId: string }>(
      `SELECT id, user_id AS userId, project_id AS projectId FROM ${table('ai_tasks')}`,
    ),
    queryRows<RowDataPacket & { id: string; projectId: string; storagePath: string }>(
      `SELECT id, project_id AS projectId, storage_path AS storagePath FROM ${table('project_files')} WHERE storage_path IS NOT NULL AND storage_path <> ''`,
    ),
    queryRows<RowDataPacket & { id: string; userId: string; projectId: string; conversationId: string | null; storagePath: string }>(
      `SELECT id, user_id AS userId, project_id AS projectId, conversation_id AS conversationId, storage_path AS storagePath FROM ${table('ai_artifacts')}`,
    ),
    queryRows<RowDataPacket & { id: string; userId: string; projectId: string; conversationId: string | null; storagePath: string; sha256: string }>(
      `SELECT id, user_id AS userId, project_id AS projectId, conversation_id AS conversationId, storage_path AS storagePath, sha256 FROM ${table('ai_custom_templates')}`,
    ),
  ])
  const conversations = new Map<string, ConversationOwner>()
  for (const row of [...chatRows, ...agentRows]) {
    const current = conversations.get(row.id)
    if (current && (current.userId !== row.userId || current.projectId !== row.projectId)) {
      throw new Error(`conversation id ${row.id} has conflicting ownership across chat/agent tables`)
    }
    conversations.set(row.id, { userId: row.userId, projectId: row.projectId })
  }
  return {
    users: new Set(users.map((row) => row.id)),
    conversations,
    tasks: new Map(tasks.map((row) => [row.id, { userId: row.userId, projectId: row.projectId }] as const)),
    templates: new Map(templateRows.map((row) => [row.id, {
      userId: row.userId,
      projectId: row.projectId,
      conversationId: row.conversationId,
    }] as const)),
    projectFileRows,
    artifactRows,
    templateRows,
  }
}

function classifyUnregistered(
  root: AssetRoot,
  relativePath: string,
  context: Awaited<ReturnType<typeof loadDatabaseContext>>,
): Omit<AssetRecord, 'root' | 'relativePath' | 'size' | 'modifiedAt' | 'sha256' | 'references'> {
  const segments = relativePath.split('/').filter(Boolean)
  if (root.key === 'radar-data' || root.key === 'legacy-template-skills' || root.key === 'skills') {
    return { ownership: 'system', userId: null, projectId: null, conversationId: null }
  }
  if (root.key === 'generated') {
    const userId = segments[0] || ''
    return context.users.has(userId)
      ? { ownership: 'derived', userId, projectId: null, conversationId: null }
      : { ownership: 'unresolved', userId: null, projectId: null, conversationId: null }
  }
  if (root.key === 'workspace' || root.key === 'jw-agent-workspace') {
    if (segments[0] === '.agents') {
      return { ownership: 'system', userId: null, projectId: null, conversationId: null }
    }
    if (segments[0] === '_users' && context.users.has(segments[1] || '')) {
      return { ownership: 'derived', userId: segments[1], projectId: null, conversationId: null }
    }
    const owner = context.conversations.get(segments[0] || '')
    return owner
      ? { ownership: 'derived', ...owner, conversationId: segments[0] }
      : { ownership: 'unresolved', userId: null, projectId: null, conversationId: null }
  }
  if (root.key === 'ai-artifacts') {
    const [userId, projectId, taskId] = segments
    const owner = context.tasks.get(taskId || '')
    return owner && owner.userId === userId && owner.projectId === projectId
      ? { ownership: 'derived', userId, projectId, conversationId: null }
      : { ownership: 'unresolved', userId: null, projectId: null, conversationId: null }
  }
  if (root.key === 'ai-template-data') {
    const [userId, projectId, conversationSegment, templateId] = segments
    const owner = context.templates.get(templateId || '')
    const expectedConversation = owner?.conversationId || 'project'
    return owner && owner.userId === userId && owner.projectId === projectId && expectedConversation === conversationSegment
      ? { ownership: 'derived', userId, projectId, conversationId: owner.conversationId }
      : { ownership: 'unresolved', userId: null, projectId: null, conversationId: null }
  }
  return { ownership: 'unresolved', userId: null, projectId: null, conversationId: null }
}

async function main() {
  const projectFileRoot = path.resolve(process.env.PROJECT_FILE_ROOT || 'server/project-files')
  const artifactRoot = path.resolve(process.env.AI_ARTIFACT_ROOT || 'server/ai-artifacts')
  const templateRoot = path.resolve(process.env.AI_CUSTOM_TEMPLATE_DATA_ROOT || process.env.AI_CUSTOM_TEMPLATE_ROOT || 'server/ai-template-data')
  const configuredWorkspace = process.env.AGENT_WORKSPACE?.trim()
  const workspaceRoot = path.resolve(configuredWorkspace || 'server/workspace')
  const jwWorkspaceRoot = path.resolve(configuredWorkspace || 'server/agent-workspace')
  const candidates: AssetRoot[] = [
    { key: 'project-files', absolutePath: projectFileRoot, requiredWhenReferenced: true },
    { key: 'ai-artifacts', absolutePath: artifactRoot, requiredWhenReferenced: true },
    { key: 'ai-template-data', absolutePath: templateRoot, requiredWhenReferenced: true },
    { key: 'legacy-template-skills', absolutePath: path.resolve('server/ai-template-skills'), requiredWhenReferenced: false },
    { key: 'generated', absolutePath: path.resolve('server/generated'), requiredWhenReferenced: false },
    { key: 'workspace', absolutePath: workspaceRoot, requiredWhenReferenced: false },
    { key: 'jw-agent-workspace', absolutePath: jwWorkspaceRoot, requiredWhenReferenced: false },
    { key: 'radar-data', absolutePath: path.resolve(process.env.RADAR_DATA_DIR?.trim() || 'project-discovery/data'), requiredWhenReferenced: false },
    { key: 'skills', absolutePath: path.resolve(process.env.AI_SKILL_ROOT?.trim() || path.join(workspaceRoot, '.agents/skills')), requiredWhenReferenced: false },
  ]
  const roots = uniqueRoots(candidates)
  const configuredRoot = (key: RootKey) => {
    const root = candidates.find((candidate) => candidate.key === key)
    if (!root) throw new Error(`file inventory root is not configured: ${key}`)
    return root
  }
  const context = await loadDatabaseContext()
  const issues: ManifestIssue[] = []
  const references: AssetReference[] = []

  const registerReference = (
    root: AssetRoot,
    row: { id: string; storagePath: string; userId?: string; projectId?: string; conversationId?: string | null; sha256?: string },
    kind: AssetReference['kind'],
  ) => {
    const absolutePath = resolveStoredPath(root.absolutePath, row.storagePath)
    if (!isInside(root.absolutePath, absolutePath)) {
      issues.push({
        severity: 'blocking', code: 'REGISTERED_PATH_OUTSIDE_ROOT', root: root.key,
        path: row.storagePath, detail: `${kind}:${row.id} points outside configured root`,
      })
      return
    }
    references.push({
      kind,
      id: row.id,
      absolutePath,
      userId: row.userId || null,
      projectId: row.projectId || null,
      conversationId: row.conversationId || null,
      expectedSha256: row.sha256?.toLowerCase() || null,
    })
  }
  context.projectFileRows.forEach((row) => registerReference(
    configuredRoot('project-files'), row, 'project_file',
  ))
  context.artifactRows.forEach((row) => registerReference(
    configuredRoot('ai-artifacts'), row, 'ai_artifact',
  ))
  context.templateRows.forEach((row) => registerReference(
    configuredRoot('ai-template-data'), row, 'ai_custom_template',
  ))

  const referencesByPath = new Map<string, AssetReference[]>()
  for (const reference of references) {
    const list = referencesByPath.get(reference.absolutePath) || []
    list.push(reference)
    referencesByPath.set(reference.absolutePath, list)
  }
  for (const [absolutePath, list] of referencesByPath) {
    if (list.length > 1) issues.push({
      severity: 'blocking', code: 'MULTIPLE_DB_REFERENCES', root: null, path: absolutePath,
      detail: list.map((item) => `${item.kind}:${item.id}`).join(', '),
    })
  }

  const assets: AssetRecord[] = []
  const seen = new Set<string>()
  let scanned = 0
  async function scanDirectory(root: AssetRoot, directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++scanned > maxFiles) throw new Error(`file inventory exceeded FILE_MANIFEST_MAX_FILES=${maxFiles}`)
      const absolutePath = path.join(directory, entry.name)
      const info = await lstat(absolutePath)
      const relativePath = normalizeRelative(root.absolutePath, absolutePath)
      if (info.isSymbolicLink()) {
        issues.push({ severity: 'blocking', code: 'SYMLINK_REQUIRES_ISOLATION', root: root.key, path: relativePath, detail: 'symlink is never followed or assigned automatically' })
        continue
      }
      if (info.isDirectory()) {
        await scanDirectory(root, absolutePath)
        continue
      }
      if (!info.isFile()) {
        issues.push({ severity: 'review', code: 'UNSUPPORTED_FILESYSTEM_ENTRY', root: root.key, path: relativePath, detail: 'entry is not a regular file' })
        continue
      }
      const digest = await sha256File(absolutePath)
      const refs = referencesByPath.get(absolutePath) || []
      const assignment = refs.length
        ? {
            ownership: 'verified' as const,
            userId: refs[0].userId,
            projectId: refs[0].projectId,
            conversationId: refs[0].conversationId,
          }
        : classifyUnregistered(root, relativePath, context)
      assets.push({
        root: root.key,
        relativePath,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
        sha256: digest,
        ...assignment,
        references: refs.map((reference) => ({ kind: reference.kind, id: reference.id })),
      })
      seen.add(absolutePath)
      if (info.size === 0) {
        const expectedEmpty = root.key === 'radar-data' && expectedEmptyRadarJsonl.has(relativePath)
        issues.push(expectedEmpty
          ? { severity: 'info', code: 'EXPECTED_EMPTY_RADAR_DATASET', root: root.key, path: relativePath, detail: 'approved empty JSONL collection; Radar read_candidates and append_jsonl treat zero lines as a valid empty dataset' }
          : { severity: 'blocking', code: 'ZERO_BYTE_FILE', root: root.key, path: relativePath, detail: 'zero-byte file requires an explicit keep/remove decision' })
      }
      if (assignment.ownership === 'unresolved') issues.push({ severity: 'blocking', code: 'UNRESOLVED_OWNERSHIP', root: root.key, path: relativePath, detail: 'no exact DB reference or validated path ownership was found' })
      for (const reference of refs) {
        if (reference.expectedSha256 && reference.expectedSha256 !== digest) issues.push({
          severity: 'blocking', code: 'REGISTERED_HASH_MISMATCH', root: root.key, path: relativePath,
          detail: `${reference.kind}:${reference.id} expected ${reference.expectedSha256}, found ${digest}`,
        })
      }
    }
  }

  const rootResults: Array<{ key: RootKey; absolutePath: string; present: boolean }> = []
  for (const root of roots) {
    const rootStat = await stat(root.absolutePath).catch(() => null)
    const present = Boolean(rootStat?.isDirectory())
    rootResults.push({ key: root.key, absolutePath: root.absolutePath, present })
    if (present) await scanDirectory(root, root.absolutePath)
  }
  for (const reference of references) {
    if (!seen.has(reference.absolutePath)) issues.push({
      severity: 'blocking', code: 'REGISTERED_FILE_MISSING', root: null, path: reference.absolutePath,
      detail: `${reference.kind}:${reference.id} has no regular file at its registered path`,
    })
  }

  const byHash = new Map<string, AssetRecord[]>()
  for (const asset of assets) {
    if (!asset.sha256 || asset.size === 0) continue
    const list = byHash.get(asset.sha256) || []
    list.push(asset)
    byHash.set(asset.sha256, list)
  }
  for (const [digest, matches] of byHash) {
    if (matches.length < 2) continue
    issues.push({
      severity: 'review', code: 'DUPLICATE_CONTENT', root: null, path: digest,
      detail: matches.map((asset) => `${asset.root}:${asset.relativePath}`).join(', '),
    })
  }

  assets.sort((left, right) => left.root.localeCompare(right.root) || left.relativePath.localeCompare(right.relativePath))
  issues.sort((left, right) => left.severity.localeCompare(right.severity) || left.code.localeCompare(right.code) || left.path.localeCompare(right.path))
  const blockingIssues = issues.filter((issue) => issue.severity === 'blocking').length
  const summary = {
    roots: rootResults.length,
    rootsPresent: rootResults.filter((root) => root.present).length,
    files: assets.length,
    bytes: assets.reduce((total, asset) => total + asset.size, 0),
    verified: assets.filter((asset) => asset.ownership === 'verified').length,
    derived: assets.filter((asset) => asset.ownership === 'derived').length,
    system: assets.filter((asset) => asset.ownership === 'system').length,
    unresolved: assets.filter((asset) => asset.ownership === 'unresolved').length,
    issues: issues.length,
    blockingIssues,
  }
  const manifest = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    database: { prefix: process.env.DB_FREFIX },
    environment,
    strict,
    technicalReady: strict && blockingIssues === 0,
    approval: {
      approved: approve && strict && blockingIssues === 0,
      approvedBy: approve ? approvedBy : null,
    },
    summary,
    roots: rootResults,
    assets,
    issues,
  }
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  const manifestPath = path.join(outputDir, 'manifest.json')
  const summaryPath = path.join(outputDir, 'summary.md')
  const statusPath = path.join(outputDir, 'status.json')
  const suffix = `.tmp-${process.pid}`
  await writeFile(`${manifestPath}${suffix}`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  const issueRows = issues.slice(0, 200).map((issue) => {
    const safe = (value: string) => value.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ')
    return `| ${issue.severity} | ${safe(issue.code)} | ${safe(issue.root || '-')} | ${safe(issue.path)} | ${safe(issue.detail)} |`
  })
  const markdown = [
    '# 文件资产迁移清单',
    '',
    `生成时间：${manifest.generatedAt}`,
    '',
    `- 文件：${summary.files}`,
    `- 总容量：${summary.bytes} bytes`,
    `- 数据库精确登记：${summary.verified}`,
    `- 由稳定目录键推导归属：${summary.derived}`,
    `- 系统资产：${summary.system}`,
    `- 未决归属：${summary.unresolved}`,
    `- 阻断问题：${summary.blockingIssues}`,
    '',
    '完整逐文件路径、SHA-256、归属和引用见 `manifest.json`。本工具不跟随符号链接、不猜测未决归属，也不删除或移动任何文件。',
    '',
    '## 问题（最多展示 200 条）',
    '',
    '| 级别 | 代码 | 根 | 路径/摘要 | 说明 |',
    '| --- | --- | --- | --- | --- |',
    ...issueRows,
    '',
  ].join('\n')
  await writeFile(`${summaryPath}${suffix}`, markdown, { mode: 0o600 })
  await writeFile(`${statusPath}${suffix}`, `${JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    generatedAt: manifest.generatedAt,
    strict: manifest.strict,
    technicalReady: manifest.technicalReady,
    approval: { approved: manifest.approval.approved },
    summary,
    pathsExcluded: true,
    fileNamesExcluded: true,
    identitiesExcluded: true,
    businessContentExcluded: true,
    secretsExcluded: true,
  }, null, 2)}\n`, { mode: 0o600 })
  await rename(`${manifestPath}${suffix}`, manifestPath)
  await rename(`${summaryPath}${suffix}`, summaryPath)
  await rename(`${statusPath}${suffix}`, statusPath)
  console.log(JSON.stringify({
    ok: blockingIssues === 0,
    strict,
    technicalReady: manifest.technicalReady,
    approved: manifest.approval.approved,
    summary,
    outputDir,
  }))
  if (strict && blockingIssues > 0) process.exitCode = 2
}

await main().finally(async () => pool.end())
