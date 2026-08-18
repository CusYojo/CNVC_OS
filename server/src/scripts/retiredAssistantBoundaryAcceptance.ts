import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const legacyRoot = path.resolve(root, 'cybernaut-assistant')
const retiredRuntime = path.resolve(legacyRoot, 'scripts/retired-runtime.mjs')
const legacyDatabase = path.resolve(root, '.runtime/cybernaut-assistant/flue.db')
const forbiddenRuntimeNames = [
  'FLUE_BASE_URL', 'FLUE_DB_PATH', 'FLUE_AGENT_NAME', 'RADAR_BASE_URL', 'INTERNAL_SECRET',
]
const checks: string[] = []

async function fileIdentity(file: string) {
  try {
    const metadata = await stat(file)
    const bytes = await readFile(file)
    return {
      exists: true,
      size: metadata.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, size: 0, sha256: null }
    throw error
  }
}

async function runRetiredRuntime() {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [retiredRuntime], {
      cwd: legacyRoot,
      env: {
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        PORT: '3584',
        FLUE_DB_PATH: legacyDatabase,
        INTERNAL_SECRET: 'retired-assistant-acceptance-secret',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

const legacySourcePresent = (await fileIdentity(legacyRoot)).exists
if (legacySourcePresent) {
  const sourceFiles = [
    '.env.example',
    'src/db.ts',
    'src/tools/investment-tools.ts',
    'src/tools/advisor-tools.ts',
  ]
  const sources = await Promise.all(sourceFiles.map(async (file) => ({
    file,
    text: await readFile(path.resolve(legacyRoot, file), 'utf8'),
  })))
  for (const name of forbiddenRuntimeNames) {
    assert(!sources.some((source) => source.text.includes(name)), `${name} remains in retired runtime source`)
  }
  assert(!sources.some((source) => /x-internal-secret|cybernaut-internal-2026/.test(source.text)))
  checks.push('retired-assistant-source-has-no-old-runtime-variable-or-shared-secret')
} else {
  checks.push('retired-assistant-source-directory-absent')
}

const envNames = new Set((await readFile(path.resolve(root, '.env'), 'utf8'))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && line.includes('='))
  .map((line) => line.slice(0, line.indexOf('=')).trim()))
assert(forbiddenRuntimeNames.every((name) => !envNames.has(name)))
checks.push('active-root-environment-has-no-retired-runtime-variable-name')

const before = await fileIdentity(legacyDatabase)
const result = legacySourcePresent
  ? await runRetiredRuntime()
  : { code: null, stdout: '', stderr: '' }
const after = await fileIdentity(legacyDatabase)
if (legacySourcePresent) {
  assert.equal(result.code, 78)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /standalone Flue runtime has retired/)
  assert(!result.stderr.includes('retired-assistant-acceptance-secret'))
  checks.push('retired-start-with-stale-environment-fails-closed-without-touching-legacy-database')
}
assert.deepEqual(after, before)
checks.push('retired-assistant-absence-does-not-touch-legacy-database')

console.log(JSON.stringify({
  ok: true,
  checks,
  legacySourcePresent,
  retiredRuntimeExitCode: result.code,
  legacyDatabasePresent: before.exists,
  legacyDatabaseUnchanged: true,
  configuredValuesExcluded: true,
  databaseWrites: 0,
  serviceStarted: false,
}))
