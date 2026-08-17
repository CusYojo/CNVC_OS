import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import mysql from 'mysql2/promise'
import { mysqlConfig } from '../db/config.js'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const evidenceDir = path.resolve(root, '.runtime/migration-evidence/environment-baseline')
const archiveFiles = [
  'package.json',
  'package-lock.json',
  '.env.example',
  'start.sh',
  'deploy.sh',
  'docker-compose.yml',
  'vite.config.ts',
  'drizzle.config.ts',
  'tsconfig.json',
  'tsconfig.node.json',
  'server/tsconfig.json',
  'server/document-runtime-dependencies.json',
  'server/requirements-pdf-to-ppt.txt',
  'server/requirements-pdf-to-ppt.lock.txt',
  'server/scripts/setup-pdf-to-ppt-runtime.mjs',
  'server/src/scripts/verifyDocumentRuntimeDependencies.ts',
  'server/src/scripts/targetSingleServiceEvidence.ts',
  'server/src/scripts/radarLeadSourceReconciliationAcceptance.ts',
  'server/src/scripts/fileAssetInventory.ts',
  'server/src/scripts/quarantineAiTemplateAcceptanceFixtures.ts',
  'server/src/scripts/quarantineResourceAcceptanceArtifacts.ts',
  'server/src/scripts/quarantineOrphanAgentWorkspaces.ts',
  'server/src/scripts/agentWorkspaceLifecycleAcceptance.ts',
  'server/src/scripts/applyMissingProjectFileDispositions.ts',
  'server/migration/project-file-missing-dispositions-20260811.json',
  'server/src/services/agentWorkspaceLifecycleService.ts',
  'server/src/services/migrationReadinessTelemetryService.ts',
] as const

type CommandVersion = {
  command: string
  available: boolean
  version: string | null
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

function firstLine(value: string): string | null {
  return value.trim().split(/\r?\n/, 1)[0]?.trim() || null
}

async function commandVersion(command: string, args: string[]): Promise<CommandVersion> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15_000,
    })
    return { command, available: true, version: firstLine(stdout) || firstLine(stderr) }
  } catch {
    return { command, available: false, version: null }
  }
}

async function firstAvailable(candidates: Array<{ command: string; args: string[] }>): Promise<CommandVersion> {
  for (const candidate of candidates) {
    const result = await commandVersion(candidate.command, candidate.args)
    if (result.available) return result
  }
  return { command: candidates.map((candidate) => candidate.command).join(' | '), available: false, version: null }
}

async function executableOnPath(name: string): Promise<string | null> {
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

async function mysqlVersion(): Promise<string> {
  const connection = await mysql.createConnection({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    database: mysqlConfig.database,
    user: mysqlConfig.user,
    password: mysqlConfig.password,
    connectTimeout: mysqlConfig.connectTimeoutMs,
    timezone: '+08:00',
  })
  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version')
    const version = String(rows[0]?.version || '').trim()
    if (!version) throw new Error('MySQL returned an empty version')
    return version
  } finally {
    await connection.end()
  }
}

async function writePrivate(file: string, data: string | Buffer): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, data, { mode: 0o600 })
  await rename(temporary, file)
  await chmod(file, 0o600)
}

async function main() {
  const fileManifest = await Promise.all(archiveFiles.map(async (relativePath) => {
    const absolute = path.resolve(root, relativePath)
    const metadata = await lstat(absolute)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`[environment-baseline] archive input is not a regular file: ${relativePath}`)
    }
    return {
      path: relativePath,
      bytes: metadata.size,
      mode: (metadata.mode & 0o777).toString(8).padStart(3, '0'),
      sha256: await sha256(absolute),
    }
  }))
  const sofficeOnPath = await executableOnPath('soffice')
  const bundledPdftotext = sofficeOnPath
    ? path.resolve(path.dirname(sofficeOnPath), '..', '..', 'native', 'poppler', 'poppler', 'bin', 'pdftotext')
    : null
  const [node, npm, python, libreOffice, poppler, tesseract, fontconfig, databaseVersion] = await Promise.all([
    commandVersion(process.execPath, ['--version']),
    commandVersion('npm', ['--version']),
    firstAvailable([
      { command: path.resolve(root, 'server/.venv/bin/python'), args: ['--version'] },
      { command: 'python3', args: ['--version'] },
    ]),
    firstAvailable([
      { command: process.env.AI_SOFFICE_PATH || '', args: ['--version'] },
      { command: '/Applications/LibreOffice.app/Contents/MacOS/soffice', args: ['--version'] },
      { command: 'soffice', args: ['--version'] },
      { command: 'libreoffice', args: ['--version'] },
    ].filter((candidate) => candidate.command)),
    firstAvailable([
      { command: process.env.AI_PDFTOTEXT_PATH || '', args: ['-v'] },
      { command: bundledPdftotext || '', args: ['-v'] },
      { command: 'pdftotext', args: ['-v'] },
    ].filter((candidate) => candidate.command)),
    firstAvailable([
      { command: process.env.AI_PDF_TO_PPT_TESSERACT || '', args: ['--version'] },
      { command: 'tesseract', args: ['--version'] },
    ].filter((candidate) => candidate.command)),
    commandVersion('fc-list', ['--version']),
    mysqlVersion(),
  ])

  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const archivePath = path.join(evidenceDir, 'configuration-baseline.tar')
  const temporaryArchive = `${archivePath}.${process.pid}.tmp`
  await execFileAsync('tar', ['-cf', temporaryArchive, '--', ...archiveFiles], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  })
  await rename(temporaryArchive, archivePath)
  await chmod(archivePath, 0o600)
  await rm(path.join(evidenceDir, 'configuration-baseline.tar.gz'), { force: true })
  const archiveMetadata = await stat(archivePath)

  const nativeDependencies = { node, npm, python, libreOffice, poppler, tesseract, fontconfig }
  const versionStateCaptured = Object.values(nativeDependencies).every((item) => (
    typeof item.available === 'boolean' && (item.available ? Boolean(item.version) : item.version === null)
  ))
  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ok: versionStateCaptured && Boolean(databaseVersion),
    operatingSystem: {
      platform: process.platform,
      architecture: process.arch,
      release: os.release(),
      type: os.type(),
    },
    mysql: { version: databaseVersion },
    nativeDependencies,
    archive: {
      path: path.basename(archivePath),
      bytes: archiveMetadata.size,
      sha256: await sha256(archivePath),
      excludesRuntimeEnvironment: true,
      files: fileManifest,
    },
    checks: {
      runtimeVersionAndMissingDependencyStateCaptured: versionStateCaptured,
      mysqlVersionCapturedWithoutConnectionDetails: Boolean(databaseVersion),
      archiveContainsOnlyApprovedFiles: fileManifest.length === archiveFiles.length,
      runtimeEnvExcluded: !archiveFiles.some((file) => file === ('.env' as string)),
      archiveChecksummed: true,
    },
  }
  await writePrivate(path.join(evidenceDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const dependencyLines = Object.values(nativeDependencies).map((item) => (
    `- ${item.command}: ${item.available ? `\`${item.version || 'available'}\`` : '不可用'}`
  ))
  const summary = [
    '# 迁移环境与配置归档基线',
    '',
    `生成时间：${report.generatedAt}`,
    '',
    `- 操作系统：${report.operatingSystem.type} ${report.operatingSystem.release} (${report.operatingSystem.architecture})`,
    `- MySQL：${databaseVersion}`,
    `- 配置归档：\`${report.archive.path}\`，${report.archive.bytes} bytes，SHA-256 \`${report.archive.sha256}\``,
    '- 真实 `.env`：明确排除',
    '',
    '## 运行依赖',
    '',
    ...dependencyLines,
    '',
    '## 归档文件',
    '',
    ...fileManifest.map((file) => `- \`${file.path}\`：${file.bytes} bytes，mode ${file.mode}，SHA-256 \`${file.sha256}\``),
    '',
  ].join('\n')
  await writePrivate(path.join(evidenceDir, 'summary.md'), summary)
  console.log(JSON.stringify({
    ok: report.ok,
    evidenceDir,
    operatingSystem: report.operatingSystem,
    mysqlVersion: databaseVersion,
    nativeDependencies,
    archive: {
      files: fileManifest.length,
      bytes: archiveMetadata.size,
      sha256: report.archive.sha256,
      runtimeEnvExcluded: report.archive.excludesRuntimeEnvironment,
    },
  }))
  if (!report.ok) process.exitCode = 2
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
