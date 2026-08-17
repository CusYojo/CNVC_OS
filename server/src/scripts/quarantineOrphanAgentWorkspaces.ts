import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

const workspaceRoot = path.resolve(process.env.AGENT_WORKSPACE?.trim() || 'server/workspace')
const quarantineRoot = path.resolve('.runtime/migration-evidence/quarantine/orphan-agent-workspaces')
const apply = process.argv.slice(2).includes('--apply')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const maximumFiles = 10_000
const maximumBytes = 1024 * 1024 * 1024

type FileIdentity = { relativePath: string; bytes: number; sha256: string }
type Candidate = {
  conversationId: string
  directory: string
  files: FileIdentity[]
  bytes: number
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

async function inspectDirectory(conversationId: string): Promise<Candidate> {
  const directory = path.resolve(workspaceRoot, conversationId)
  if (!isInside(workspaceRoot, directory)) throw new Error('orphan workspace escaped configured root')
  const files: FileIdentity[] = []
  let bytes = 0
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      const metadata = await lstat(target)
      if (metadata.isSymbolicLink()) throw new Error('orphan workspace contains a symlink and requires manual review')
      if (metadata.isDirectory()) {
        await walk(target)
        continue
      }
      if (!metadata.isFile()) throw new Error('orphan workspace contains a non-regular entry')
      bytes += metadata.size
      if (files.length + 1 > maximumFiles || bytes > maximumBytes) throw new Error('orphan workspace exceeds quarantine safety budget')
      files.push({
        relativePath: path.relative(directory, target).split(path.sep).join('/'),
        bytes: metadata.size,
        sha256: await sha256File(target),
      })
    }
  }
  await walk(directory)
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  const identitySha256 = createHash('sha256').update(files.map((file) => (
    `${file.relativePath}\0${file.bytes}\0${file.sha256}`
  )).join('\n')).digest('hex')
  return { conversationId, directory, files, bytes, identitySha256 }
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

async function main() {
  const rootMetadata = await lstat(workspaceRoot).catch(() => null)
  if (!rootMetadata) {
    console.log(JSON.stringify({ ok: true, apply, matchedDirectories: 0, matchedFiles: 0, movedDirectories: 0, movedFiles: 0 }))
    return
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('Agent workspace root must be a regular directory')
  const [chatRows, agentRows] = await Promise.all([
    pool.query<Array<RowDataPacket & { id: string }>>(`SELECT id FROM ${table('chat_conversations')}`).then(([rows]) => rows),
    pool.query<Array<RowDataPacket & { id: string }>>(`SELECT id FROM ${table('agent_conversations')}`).then(([rows]) => rows),
  ])
  const activeConversations = new Set([...chatRows, ...agentRows].map((row) => String(row.id)))
  const candidates: Candidate[] = []
  for (const entry of await readdir(workspaceRoot, { withFileTypes: true })) {
    if (!uuid.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink() || activeConversations.has(entry.name)) continue
    candidates.push(await inspectDirectory(entry.name))
  }
  const moved: Candidate[] = []
  if (apply) {
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 })
    await chmod(quarantineRoot, 0o700)
    for (const candidate of candidates) {
      const target = path.resolve(quarantineRoot, candidate.conversationId)
      if (!isInside(quarantineRoot, target)) throw new Error('orphan workspace quarantine target escaped root')
      if (await lstat(target).catch(() => null)) throw new Error(`quarantine target already exists for ${candidate.identitySha256}`)
      await rename(candidate.directory, target)
      await chmodTree(target)
      moved.push(candidate)
    }
  }
  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    apply,
    matchedDirectories: candidates.length,
    matchedFiles: candidates.reduce((total, candidate) => total + candidate.files.length, 0),
    matchedBytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0),
    movedDirectories: moved.length,
    movedFiles: moved.reduce((total, candidate) => total + candidate.files.length, 0),
    checks: {
      conversationAbsentFromChatAndAgentMysql: true,
      exactUuidDirectoryBoundary: true,
      noSymlinksFollowed: true,
      sizeAndFileCountBounded: true,
      originalBytesRetainedInPrivateQuarantine: apply,
    },
    items: candidates.map((candidate) => ({
      identitySha256: candidate.identitySha256,
      files: candidate.files.length,
      bytes: candidate.bytes,
      moved: moved.includes(candidate),
    })),
    pathsExcluded: true,
    fileNamesExcluded: true,
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
    matchedBytes: report.matchedBytes,
    movedDirectories: report.movedDirectories,
    movedFiles: report.movedFiles,
    evidence: apply,
  }))
}

await main().finally(async () => pool.end())
