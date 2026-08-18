import { spawn } from 'node:child_process'
import { access, cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const sourceRoot = process.cwd()
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cybernaut-clean-build-'))
const excluded = [
  '.git', '.env', 'node_modules', 'dist', 'server-dist', '.runtime', 'logs',
  'server/generated', 'server/ai-artifacts', 'server/project-files', 'server/ai-template-data',
  'server/workspace', 'server/agent-workspace', 'cybernaut_mvp_dump.sql',
]

function included(source) {
  const relative = path.relative(sourceRoot, source).split(path.sep).join('/')
  if (!relative) return true
  const basename = path.posix.basename(relative)
  if (basename.startsWith('.env') && basename !== '.env.example') return false
  return !excluded.some((entry) => relative === entry || relative.startsWith(`${entry}/`))
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: temporaryRoot, stdio: 'inherit', env: process.env })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} failed with code=${String(code)} signal=${String(signal)}`))
    })
  })
}

let completed = false
let artifactPairValidated = false
try {
  await cp(sourceRoot, temporaryRoot, { recursive: true, filter: included })
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  await run(npm, ['ci', '--no-audit', '--no-fund'])
  await run(npm, ['run', 'build'])
  let distRoot = path.join(temporaryRoot, 'dist')
  let serverDistRoot = path.join(temporaryRoot, 'server-dist')
  try {
    await access(path.join(distRoot, 'index.html'))
    await access(path.join(serverDistRoot, 'index.js'))
  } catch {
    const pointer = JSON.parse(await readFile(path.join(temporaryRoot, '.runtime/build-candidate.json'), 'utf8'))
    if (!/^build-[0-9]{8}T[0-9]{9}Z-[0-9]+-[a-f0-9]{8}$/.test(pointer.releaseId)) {
      throw new Error('clean build candidate has an invalid release identifier')
    }
    const candidate = path.join(temporaryRoot, '.runtime/build-candidates', pointer.releaseId)
    distRoot = path.join(candidate, 'dist')
    serverDistRoot = path.join(candidate, 'server-dist')
  }
  const [webIndex, serverEntry] = await Promise.all([
    readFile(path.join(distRoot, 'index.html'), 'utf8'),
    readFile(path.join(serverDistRoot, 'index.js'), 'utf8'),
  ])
  if (!webIndex.includes('<div id="root">') || !serverEntry.includes('cybernaut-app')) {
    throw new Error('clean build did not produce the unified Web/server artifact pair')
  }
  artifactPairValidated = true
  completed = true
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

console.log(JSON.stringify({
  ok: completed,
  checks: ['no-env-copied', 'fresh-npm-ci', 'production-build', 'web-server-artifact-pair-validated'],
  artifactPairValidated,
  excludedRuntimeState: excluded,
  temporaryDirectoryRemoved: true,
}))
