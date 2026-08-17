import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

const artifactRoot = path.resolve(process.env.AI_ARTIFACT_ROOT || 'server/ai-artifacts')
const quarantineRoot = path.resolve('.runtime/migration-evidence/quarantine/resource-acceptance-ai-artifacts')
const apply = process.argv.slice(2).includes('--apply')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Candidate = {
  directory: string
  relativePath: string
  userId: string
  marker: string
  sha256: string
  identitySha256: string
}

function table(name: string) {
  return quoteMysqlIdentifier(mysqlTableName(name))
}

function isInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function main() {
  const [userRows] = await pool.query<Array<RowDataPacket & { id: string }>>(`SELECT id FROM ${table('users')}`)
  const users = new Set(userRows.map((row) => String(row.id)))
  const candidates: Candidate[] = []
  const rootInfo = await lstat(artifactRoot).catch(() => null)
  if (rootInfo && (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())) {
    throw new Error('AI artifact root must be a regular directory')
  }
  if (rootInfo) {
    for (const userEntry of await readdir(artifactRoot, { withFileTypes: true })) {
      if (!uuid.test(userEntry.name) || !userEntry.isDirectory() || userEntry.isSymbolicLink() || users.has(userEntry.name)) continue
      const directory = path.join(artifactRoot, userEntry.name)
      const entries = await readdir(directory, { withFileTypes: true })
      if (entries.length !== 1 || !entries[0].isFile() || entries[0].isSymbolicLink()) continue
      const marker = path.basename(entries[0].name, '.md')
      if (!uuid.test(marker) || entries[0].name !== `${marker}.md`) continue
      const file = path.join(directory, entries[0].name)
      const payload = await readFile(file)
      if (!payload.equals(Buffer.from(`ai-artifact-secret-${marker}`))) continue
      const sha256 = createHash('sha256').update(payload).digest('hex')
      const relativePath = path.relative(artifactRoot, directory).split(path.sep).join('/')
      candidates.push({
        directory,
        relativePath,
        userId: userEntry.name,
        marker,
        sha256,
        identitySha256: createHash('sha256').update(`${relativePath}\0${sha256}`).digest('hex'),
      })
    }
  }
  const moved: Candidate[] = []
  if (apply) {
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 })
    await chmod(quarantineRoot, 0o700)
    for (const candidate of candidates) {
      const target = path.resolve(quarantineRoot, candidate.relativePath)
      if (!isInside(quarantineRoot, target)) throw new Error('quarantine target escaped root')
      if (await lstat(target).catch(() => null)) throw new Error(`quarantine target already exists for ${candidate.identitySha256}`)
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await rename(candidate.directory, target)
      await chmod(target, 0o700)
      const files = await readdir(target, { withFileTypes: true })
      for (const file of files) {
        if (!file.isFile() || file.isSymbolicLink()) throw new Error('quarantine target contains a non-regular entry')
        await chmod(path.join(target, file.name), 0o600)
      }
      moved.push(candidate)
    }
  }
  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    apply,
    matchedDirectories: candidates.length,
    matchedFiles: candidates.length,
    movedDirectories: moved.length,
    movedFiles: moved.length,
    checks: {
      exactResourceAcceptancePayload: true,
      ownerAbsentFromTargetMysql: true,
      noSymlinksFollowed: true,
      originalBytesRetainedInPrivateQuarantine: apply,
    },
    items: candidates.map((candidate) => ({
      identitySha256: candidate.identitySha256,
      contentSha256: candidate.sha256,
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
    matchedDirectories: candidates.length,
    matchedFiles: candidates.length,
    movedDirectories: moved.length,
    movedFiles: moved.length,
    evidence: apply,
  }))
}

await main().finally(async () => pool.end())
