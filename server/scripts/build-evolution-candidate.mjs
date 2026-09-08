import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const assert = (condition, message) => { if (!condition) throw new Error(`[evolution-build] ${message}`) }

export function parseCandidateArguments(args) {
  const names = new Map([
    ['--source-root', 'sourceRoot'], ['--output-root', 'outputRoot'],
    ['--base-commit', 'baseCommit'], ['--patch-hash', 'patchHash'],
  ])
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const name = names.get(args[i])
    assert(name, 'unsupported argument')
    assert(!(name in options), 'duplicate argument')
    assert(args[i + 1] && !args[i + 1].startsWith('--'), 'argument value required')
    options[name] = args[i + 1]
  }
  for (const name of names.values()) assert(options[name], `${name} required`)
  return options
}

function inside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function candidateBuildEnvironment() {
  const env = { NODE_ENV: 'production', TZ: 'UTC', LANG: 'C.UTF-8', NODE_OPTIONS: '--max-old-space-size=3072' }
  // No inherited NODE_OPTIONS, DB_*, model keys, VITE_* or npm configuration.
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`candidate command failed: ${code ?? signal}`)))
  })
}

async function artifactFiles(root, relative = '') {
  const records = []
  const directory = path.join(root, relative)
  assert(!(await lstat(directory)).isSymbolicLink(), 'symbolic link in output')
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name)
    assert(!entry.isSymbolicLink(), 'symbolic link in output')
    assert(!/(^|\/)(\.env(?:\..*)?|\.git|\.npmrc)$|\.(pem|key|p12)$/i.test(name), 'forbidden file in output')
    if (entry.isDirectory()) records.push(...await artifactFiles(root, name))
    else {
      assert(entry.isFile(), 'unsupported output entry')
      const bytes = await readFile(path.join(root, name))
      records.push({ path: name, bytes: bytes.length, sha256: hash(bytes) })
    }
  }
  return records.sort((a, b) => a.path.localeCompare(b.path))
}

// Call only in the task execution environment: compilers and dependencies are executable code.
// Provenance is supplied by the trusted orchestrator; this builder never grants publication rights.
export async function buildEvolutionCandidate({ sourceRoot, outputRoot, baseCommit, patchHash, runCommand = run }) {
  assert(typeof sourceRoot === 'string' && path.isAbsolute(sourceRoot), 'absolute sourceRoot required')
  assert(typeof outputRoot === 'string' && path.isAbsolute(outputRoot), 'absolute outputRoot required')
  assert(/^[a-f0-9]{40,64}$/.test(baseCommit ?? ''), 'immutable baseCommit required')
  assert(/^[a-f0-9]{64}$/.test(patchHash ?? ''), 'patchHash required')
  const source = await realpath(sourceRoot)
  const output = path.join(await realpath(path.dirname(outputRoot)), path.basename(outputRoot))
  assert(!inside(source, output) && !inside(output, source), 'source and output overlap')
  const lockHash = hash(await readFile(path.join(source, 'package-lock.json')))
  await mkdir(output) // Exclusive: never overwrite, activate, prune, or delete another candidate.
  const serverDist = path.join(output, 'server-dist')
  const dist = path.join(output, 'dist')
  const tsc = path.join(source, 'node_modules', 'typescript', 'bin', 'tsc')
  const options = { cwd: source, env: candidateBuildEnvironment() }
  await runCommand(process.execPath, [tsc, '-p', 'tsconfig.app.json', '--noEmit', '--incremental', 'false'], options)
  await runCommand(process.execPath, [tsc, '-p', 'server/tsconfig.build.json', '--outDir', serverDist, '--incremental', 'false'], options)
  await runCommand(process.execPath, [path.join(scriptsRoot, 'build-evolution-web.mjs'), source, output], options)
  await runCommand(process.execPath, ['--check', path.join(serverDist, 'index.js')], options)
  await writeFile(path.join(serverDist, 'evolution-build.json'), JSON.stringify({ schemaVersion: 1, baseCommit, patchHash, lockHash }), { flag: 'wx', mode: 0o644 })
  const artifacts = [
    ...(await artifactFiles(dist)).map((file) => ({ ...file, path: `dist/${file.path}` })),
    ...(await artifactFiles(serverDist)).map((file) => ({ ...file, path: `server-dist/${file.path}` })),
  ]
  assert(artifacts.some((file) => file.path === 'dist/index.html'), 'missing Web entry')
  assert(artifacts.some((file) => file.path.startsWith('dist/assets/')), 'missing Web assets')
  assert(artifacts.some((file) => file.path === 'server-dist/index.js'), 'missing server entry')
  assert(hash(await readFile(path.join(source, 'package-lock.json'))) === lockHash, 'dependency lock changed during build')
  const manifest = {
    schemaVersion: 1, baseCommit, patchHash, lockHash, activated: false,
    createdAt: new Date().toISOString(), nodeVersion: process.version,
    buildParameters: { mode: 'production', sourceEnvLoaded: false, sourceViteConfigLoaded: false },
    artifacts,
  }
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildEvolutionCandidate(parseCandidateArguments(process.argv.slice(2)))
    .then((manifest) => process.stdout.write(`${JSON.stringify(manifest)}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
