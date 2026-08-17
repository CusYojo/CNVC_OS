import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

type RunResult = { code: number; stdout: string; stderr: string }

const root = process.cwd()
const script = path.resolve(root, 'server/src/scripts/productionSourceInventory.ts')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[production source inventory acceptance] ${message}`)
}

function run(args: string[], outputDirectory: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        MIGRATION_SOURCE_INVENTORY_OUTPUT_DIR: outputDirectory,
      },
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException & { code?: number } | null)?.code === 'number'
        ? Number((error as NodeJS.ErrnoException & { code?: number }).code)
        : error ? 1 : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

async function report(outputDirectory: string) {
  return JSON.parse(await readFile(path.join(outputDirectory, 'candidate.json'), 'utf8')) as {
    scannedFiles: number
    unexpectedSources: unknown[]
    skippedSymlinks: unknown[]
    approved: boolean
  }
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'production-source-inventory-acceptance-'))
  const sourceRoot = path.join(temporaryRoot, 'sources')
  const nestedRoot = path.join(sourceRoot, 'nested')
  const outputDirectory = path.join(temporaryRoot, 'evidence')
  const dump = path.join(nestedRoot, 'primary.sql')
  const rootLink = path.join(temporaryRoot, 'sources-link')
  const dumpLink = path.join(nestedRoot, 'primary-link.sql')
  try {
    await mkdir(nestedRoot, { recursive: true, mode: 0o700 })
    await mkdir(outputDirectory, { mode: 0o700 })
    await writeFile(dump, '-- PostgreSQL database dump\nCOPY public.users (id) FROM stdin;\n', { mode: 0o600 })
    await writeFile(path.join(nestedRoot, 'notes.txt'), 'not a database source\n', { mode: 0o600 })

    const clean = await run([
      '--scan-root', sourceRoot,
      '--scan-root', nestedRoot,
      '--postgres-dump', dump,
      '--environment', 'production',
    ], outputDirectory)
    assert(clean.code === 0, 'clean declared source inventory failed')
    const cleanReport = await report(outputDirectory)
    assert(cleanReport.scannedFiles === 2 && cleanReport.unexpectedSources.length === 0,
      'overlapping roots were double-counted or produced an unexpected source')

    const surprise = path.join(sourceRoot, 'renamed.backup')
    await writeFile(surprise, Buffer.from('PGDMP\u0001\u0000unexpected'), { mode: 0o600 })
    const unexpected = await run([
      '--scan-root', sourceRoot,
      '--postgres-dump', dump,
      '--environment', 'production',
    ], outputDirectory)
    assert(unexpected.code === 2, 'renamed PostgreSQL dump was not rejected as unexpected')
    const unexpectedReport = await report(outputDirectory)
    assert(unexpectedReport.unexpectedSources.length === 1 && unexpectedReport.approved === false,
      'unexpected renamed PostgreSQL dump was not reported exactly once')
    await rm(surprise)

    await symlink(sourceRoot, rootLink)
    const linkedRoot = await run([
      '--scan-root', rootLink,
      '--postgres-dump', dump,
      '--environment', 'production',
    ], outputDirectory)
    assert(linkedRoot.code === 1, 'symbolic-link scan root was followed')

    await symlink(dump, dumpLink)
    const linkedDump = await run([
      '--scan-root', sourceRoot,
      '--postgres-dump', dumpLink,
      '--environment', 'production',
    ], outputDirectory)
    assert(linkedDump.code === 1, 'symbolic-link declared dump was followed')

    const duplicateDump = await run([
      '--scan-root', sourceRoot,
      '--postgres-dump', dump,
      '--postgres-dump', dump,
      '--environment', 'production',
    ], outputDirectory)
    assert(duplicateDump.code === 1, 'duplicate --postgres-dump was not rejected')

    const redirectedApproval = await run([
      '--scan-root', sourceRoot,
      '--postgres-dump', dump,
      '--environment', 'production',
      '--approve',
      '--approved-by', 'acceptance-data-owner',
    ], outputDirectory)
    assert(redirectedApproval.code === 1, 'approval evidence was allowed to use the test output redirect')

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'clean-overlapping-roots-scan-counts-files-once',
        'renamed-postgres-dump-is-detected-and-rejected',
        'symbolic-link-scan-root-is-rejected',
        'symbolic-link-declared-dump-is-rejected',
        'exactly-one-postgres-dump-argument-is-enforced',
        'approval-report-cannot-use-test-output-redirection',
        'temporary-fixture-cleanup-verified',
      ],
      databaseWrites: 0,
    }))
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main()
