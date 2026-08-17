import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const approve = args.includes('--approve')

function values(name: string): string[] {
  return args.flatMap((arg, index) => arg === name && args[index + 1] ? [args[index + 1]] : [])
}

function value(name: string): string | null {
  return values(name)[0] ?? null
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function looksLikePostgresDump(file: string): Promise<boolean> {
  if (!/\.(?:sql|dump|backup|pgdump)$/i.test(path.basename(file))) return false
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const prefix = buffer.subarray(0, bytesRead)
    if (prefix.subarray(0, 5).toString('ascii') === 'PGDMP') return true
    const text = prefix.toString('utf8')
    return /PostgreSQL database dump|COPY\s+(?:public\.)?[a-z_][a-z0-9_]*\s*\(/i.test(text)
  } finally {
    await handle.close()
  }
}

function isWithin(file: string, root: string): boolean {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function main(): Promise<void> {
  const environment = value('--environment') ?? process.env.NODE_ENV ?? 'development'
  const approvedBy = value('--approved-by')?.trim() ?? ''
  if (approve && (environment !== 'production' || !approvedBy)) {
    throw new Error('--approve requires --environment production and a non-empty --approved-by identity')
  }
  const rootInputs = values('--scan-root')
  const dumpInputs = values('--postgres-dump')
  const flueInputs = values('--flue-source')
  if (!rootInputs.length || dumpInputs.length !== 1) {
    throw new Error('provide at least one --scan-root and exactly one --postgres-dump')
  }
  async function resolveInput(input: string, kind: 'directory' | 'file'): Promise<string> {
    const absolute = path.resolve(input)
    const metadata = await lstat(absolute)
    if (metadata.isSymbolicLink()) throw new Error(`declared ${kind} must not be a symbolic link`)
    if (kind === 'directory' ? !metadata.isDirectory() : !metadata.isFile()) {
      throw new Error(`declared ${kind} is not a regular ${kind}`)
    }
    return realpath(absolute)
  }
  const scannedRoots = [...new Set(await Promise.all(rootInputs.map((root) => resolveInput(root, 'directory'))))]
  const postgresDump = await resolveInput(dumpInputs[0], 'file')
  const flueSources = [...new Set(await Promise.all(flueInputs.map((file) => resolveInput(file, 'file'))))]
  for (const declared of [postgresDump, ...flueSources]) {
    if (!scannedRoots.some((root) => isWithin(declared, root))) {
      throw new Error(`declared source is outside all scanned roots: ${declared}`)
    }
  }

  const maxFiles = Number(process.env.MIGRATION_SOURCE_SCAN_MAX_FILES ?? 200_000)
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error('MIGRATION_SOURCE_SCAN_MAX_FILES must be a positive integer')
  const discovered = new Set<string>()
  const skippedSymlinks: string[] = []
  const visitedDirectories = new Set<string>()
  const visitedFiles = new Set<string>()
  let scannedFiles = 0
  async function walk(directory: string): Promise<void> {
    const canonicalDirectory = await realpath(directory)
    if (visitedDirectories.has(canonicalDirectory)) return
    visitedDirectories.add(canonicalDirectory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.resolve(directory, entry.name)
      if (entry.isSymbolicLink()) {
        skippedSymlinks.push(target)
        continue
      }
      if (entry.isDirectory()) {
        await walk(target)
        continue
      }
      if (!entry.isFile()) continue
      const canonicalFile = await realpath(target)
      if (visitedFiles.has(canonicalFile)) continue
      visitedFiles.add(canonicalFile)
      scannedFiles += 1
      if (scannedFiles > maxFiles) throw new Error(`source inventory exceeded ${maxFiles} files`)
      if (entry.name === 'flue.db' || await looksLikePostgresDump(canonicalFile)) discovered.add(canonicalFile)
    }
  }
  for (const root of scannedRoots) await walk(root)

  const declared = new Set([postgresDump, ...flueSources])
  const unexpectedFiles = [...discovered].filter((file) => !declared.has(file)).sort()
  const unexpectedSources = await Promise.all(unexpectedFiles.map(async (file) => ({
    file, fileName: path.basename(file), sha256: await sha256(file),
  })))
  const postgresDumpSha256 = await sha256(postgresDump)
  const flueSourceEvidence = await Promise.all(flueSources.map(async (file) => ({ file, sha256: await sha256(file) })))
  const report = {
    schemaVersion: '1.0', generatedAt: new Date().toISOString(), environment,
    hostIdentity: os.hostname(), scannedRoots, scannedFiles,
    skippedSymlinks,
    postgresDump: { file: postgresDump, sha256: postgresDumpSha256 },
    postgresDumpSha256,
    flueSources: flueSourceEvidence,
    flueSourceSha256: flueSourceEvidence.map((item) => item.sha256).sort(),
    unexpectedSources,
    approved: approve && unexpectedSources.length === 0 && skippedSymlinks.length === 0,
    approvedBy: approve ? approvedBy : null,
  }
  const redirectedOutput = process.env.MIGRATION_SOURCE_INVENTORY_OUTPUT_DIR?.trim()
  if (redirectedOutput && (process.env.NODE_ENV !== 'test' || approve)) {
    throw new Error('MIGRATION_SOURCE_INVENTORY_OUTPUT_DIR is allowed only for non-approval test runs')
  }
  const outputDirectory = redirectedOutput
    ? await resolveInput(redirectedOutput, 'directory')
    : path.resolve(process.cwd(), '.runtime/migration-evidence/production-source-inventory')
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  const target = path.resolve(outputDirectory, approve ? 'report.json' : 'candidate.json')
  const temporary = `${target}.${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, target)
  console.log(JSON.stringify({
    ok: unexpectedSources.length === 0 && skippedSymlinks.length === 0,
    approved: report.approved, output: target,
    scannedRoots: scannedRoots.length, scannedFiles, declaredSources: declared.size,
    unexpectedSources: unexpectedSources.length, skippedSymlinks: skippedSymlinks.length,
  }))
  if (unexpectedSources.length || skippedSymlinks.length) process.exitCode = 2
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, message: (error as Error).message }))
  process.exitCode = 1
})
