import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

const root = path.resolve(process.cwd())
const runtimeRoot = path.join(root, '.runtime')
const candidatesRoot = path.join(runtimeRoot, 'build-candidates')
const rollbacksRoot = path.join(runtimeRoot, 'build-rollbacks')
const failedRoot = path.join(runtimeRoot, 'build-failed')
const candidatePointer = path.join(runtimeRoot, 'build-candidate.json')
const rollbackPointer = path.join(runtimeRoot, 'build-rollback.json')
const lockPath = path.join(runtimeRoot, 'build-platform.lock')
const liveDist = path.join(root, 'dist')
const liveServerDist = path.join(root, 'server-dist')
const idPattern = /^build-[0-9]{8}T[0-9]{9}Z-[0-9]+-[a-f0-9]{8}$/
const activationPort = process.env.NODE_ENV === 'test' && process.env.CYBERNAUT_BUILD_ACTIVATION_PORT
  ? Number(process.env.CYBERNAUT_BUILD_ACTIVATION_PORT)
  : 3100

function assert(condition, message) {
  if (!condition) throw new Error(`[build-platform] ${message}`)
}

function safeChild(base, id) {
  assert(idPattern.test(id), 'invalid release identifier')
  const target = path.resolve(base, id)
  assert(path.dirname(target) === path.resolve(base), 'release path escaped its managed root')
  return target
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function atomicJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o755 })
  const temporary = `${target}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, target)
}

async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'))
}

async function sha256(target) {
  return createHash('sha256').update(await readFile(target)).digest('hex')
}

async function collectFiles(directory) {
  const files = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      assert(!entry.isSymbolicLink(), `build output contains a symbolic link: ${entry.name}`)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) files.push(path.relative(directory, absolute).split(path.sep).join('/'))
      else throw new Error(`[build-platform] unsupported build output entry: ${entry.name}`)
    }
  }
  await walk(directory)
  return files.sort()
}

async function pruneManagedDirectories(base, keepIds, maxEntries = 3) {
  if (!await exists(base)) return
  const managed = []
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !idPattern.test(entry.name)) continue
    const target = safeChild(base, entry.name)
    managed.push({ id: entry.name, target, mtimeMs: (await stat(target)).mtimeMs })
  }
  managed.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const retained = new Set([...keepIds, ...managed.slice(0, maxEntries).map((entry) => entry.id)])
  for (const entry of managed) {
    if (!retained.has(entry.id)) await rm(entry.target, { recursive: true, force: true })
  }
}

async function validateArtifacts(dist, serverDist, expected) {
  const indexFile = path.join(dist, 'index.html')
  const serverEntry = path.join(serverDist, 'index.js')
  const [index, distFiles, serverFiles] = await Promise.all([
    readFile(indexFile, 'utf8'),
    collectFiles(dist),
    collectFiles(serverDist),
  ])
  assert(index.includes('<div id="root">'), 'candidate Web build has no React root')
  assert(distFiles.some((file) => file.startsWith('assets/')), 'candidate Web build has no assets')
  assert(serverFiles.includes('index.js'), 'candidate server build has no unified entry')
  assert(!distFiles.some((file) => /(^|\/)\.env(?:\.|$)/.test(file)), 'candidate Web build contains an environment file')
  assert(!serverFiles.some((file) => /(^|\/)\.env(?:\.|$)/.test(file)), 'candidate server build contains an environment file')
  const hashes = {
    distIndexSha256: await sha256(indexFile),
    serverEntrySha256: await sha256(serverEntry),
  }
  if (expected) {
    assert(hashes.distIndexSha256 === expected.distIndexSha256, 'activated Web build hash differs from candidate')
    assert(hashes.serverEntrySha256 === expected.serverEntrySha256, 'activated server build hash differs from candidate')
  }
  return { ...hashes, distFileCount: distFiles.length, serverFileCount: serverFiles.length }
}

function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`[build-platform] ${path.basename(command)} failed: code=${String(code)} signal=${String(signal)}`))
    })
  })
}

function portOpen(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false)
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = (open) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function acquireLock() {
  await mkdir(runtimeRoot, { recursive: true, mode: 0o755 })
  try {
    const handle = await open(lockPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`)
    await handle.close()
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const lock = await readJson(lockPath).catch(() => ({}))
    const pid = Number(lock.pid)
    let alive = false
    if (Number.isInteger(pid) && pid > 1) {
      try { process.kill(pid, 0); alive = true } catch {}
    }
    assert(!alive, 'another build/activation process still owns the release lock')
    await rm(lockPath, { force: true })
    const handle = await open(lockPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), staleLockRecovered: true })}\n`)
    await handle.close()
  }
}

async function withLock(callback) {
  await acquireLock()
  try { return await callback() } finally { await rm(lockPath, { force: true }) }
}

function releaseId() {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')
  const entropy = createHash('sha256').update(`${process.pid}:${process.hrtime.bigint()}`).digest('hex').slice(0, 8)
  return `build-${stamp}-${process.pid}-${entropy}`
}

async function buildCandidate() {
  const id = releaseId()
  const candidate = safeChild(candidatesRoot, id)
  const dist = path.join(candidate, 'dist')
  const serverDist = path.join(candidate, 'server-dist')
  await mkdir(candidate, { recursive: true, mode: 0o755 })
  const node = process.execPath
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  assert(await exists(tsc), 'TypeScript compiler is missing; run npm ci first')
  assert(await exists(vite), 'Vite is missing; run npm ci first')
  try {
    await run(node, [tsc, '-b'])
    await run(node, [tsc, '-p', 'server/tsconfig.build.json', '--outDir', serverDist])
    await run(node, [vite, 'build', '--outDir', dist, '--emptyOutDir'])
    await run(node, ['--check', path.join(serverDist, 'index.js')])
    const evidence = await validateArtifacts(dist, serverDist)
    const manifest = {
      version: 1,
      releaseId: id,
      createdAt: new Date().toISOString(),
      ...evidence,
      secretsIncluded: false,
    }
    await atomicJson(path.join(candidate, 'manifest.json'), manifest)
    const previousPointer = await readJson(candidatePointer).catch(() => null)
    await atomicJson(candidatePointer, { version: 1, releaseId: id })
    if (previousPointer?.releaseId && previousPointer.releaseId !== id && idPattern.test(previousPointer.releaseId)) {
      await rm(safeChild(candidatesRoot, previousPointer.releaseId), { recursive: true, force: true })
    }
    return manifest
  } catch (error) {
    await rm(candidate, { recursive: true, force: true })
    throw error
  }
}

async function restoreActivationFailure(candidate, rollback, moved) {
  if (moved.newDist && await exists(liveDist)) await rename(liveDist, path.join(candidate, 'dist'))
  if (moved.newServer && await exists(liveServerDist)) await rename(liveServerDist, path.join(candidate, 'server-dist'))
  if (moved.oldDist && await exists(path.join(rollback, 'dist'))) await rename(path.join(rollback, 'dist'), liveDist)
  if (moved.oldServer && await exists(path.join(rollback, 'server-dist'))) await rename(path.join(rollback, 'server-dist'), liveServerDist)
}

async function activateCandidate({ optional = false } = {}) {
  if (!await exists(candidatePointer)) {
    if (optional) return { activated: false, reason: 'no-candidate' }
    throw new Error('[build-platform] no validated build candidate is available')
  }
  assert(!await portOpen(activationPort), `refusing to activate build while port ${activationPort} is listening`)
  const pointer = await readJson(candidatePointer)
  const candidate = safeChild(candidatesRoot, pointer.releaseId)
  const manifest = await readJson(path.join(candidate, 'manifest.json'))
  assert(manifest.releaseId === pointer.releaseId && manifest.version === 1, 'candidate manifest does not match pointer')
  await validateArtifacts(path.join(candidate, 'dist'), path.join(candidate, 'server-dist'), manifest)
  const currentDistExists = await exists(liveDist)
  const currentServerExists = await exists(liveServerDist)
  assert(currentDistExists === currentServerExists, 'live dist/server-dist must either both exist or both be absent')
  const rollback = safeChild(rollbacksRoot, pointer.releaseId)
  assert(!await exists(rollback), 'rollback directory already exists for candidate')
  await mkdir(rollback, { recursive: true, mode: 0o755 })
  const moved = { oldDist: false, oldServer: false, newDist: false, newServer: false }
  try {
    if (currentDistExists) { await rename(liveDist, path.join(rollback, 'dist')); moved.oldDist = true }
    if (currentServerExists) { await rename(liveServerDist, path.join(rollback, 'server-dist')); moved.oldServer = true }
    await rename(path.join(candidate, 'server-dist'), liveServerDist); moved.newServer = true
    await rename(path.join(candidate, 'dist'), liveDist); moved.newDist = true
    await validateArtifacts(liveDist, liveServerDist, manifest)
    await atomicJson(rollbackPointer, {
      version: 1,
      releaseId: pointer.releaseId,
      rollbackReleaseId: pointer.releaseId,
      hadPrevious: currentDistExists,
      activatedAt: new Date().toISOString(),
    })
    await rm(candidatePointer, { force: true })
    await rm(candidate, { recursive: true, force: true })
    await pruneManagedDirectories(rollbacksRoot, new Set([pointer.releaseId]))
    return { activated: true, releaseId: pointer.releaseId, rollbackAvailable: currentDistExists }
  } catch (error) {
    await restoreActivationFailure(candidate, rollback, moved)
    throw error
  }
}

async function rollbackBuild() {
  assert(!await portOpen(activationPort), `refusing to roll back build while port ${activationPort} is listening`)
  assert(await exists(rollbackPointer), 'no activated build rollback is available')
  const pointer = await readJson(rollbackPointer)
  assert(pointer.version === 1 && idPattern.test(pointer.releaseId), 'invalid rollback pointer')
  const rollback = safeChild(rollbacksRoot, pointer.rollbackReleaseId)
  if (pointer.hadPrevious) {
    assert(await exists(path.join(rollback, 'dist')) && await exists(path.join(rollback, 'server-dist')), 'previous build artifacts are incomplete')
  }
  const failedId = releaseId()
  const failed = safeChild(failedRoot, failedId)
  await mkdir(failed, { recursive: true, mode: 0o755 })
  if (await exists(liveDist)) await rename(liveDist, path.join(failed, 'dist'))
  if (await exists(liveServerDist)) await rename(liveServerDist, path.join(failed, 'server-dist'))
  if (pointer.hadPrevious) {
    await rename(path.join(rollback, 'dist'), liveDist)
    await rename(path.join(rollback, 'server-dist'), liveServerDist)
    await validateArtifacts(liveDist, liveServerDist)
  }
  await rm(rollbackPointer, { force: true })
  await rm(rollback, { recursive: true, force: true })
  await pruneManagedDirectories(failedRoot, new Set([failedId]))
  return { rolledBack: true, restoredPrevious: Boolean(pointer.hadPrevious), failedReleasePreserved: true }
}

async function discardCandidate() {
  if (!await exists(candidatePointer)) return { discarded: false }
  const pointer = await readJson(candidatePointer)
  await rm(safeChild(candidatesRoot, pointer.releaseId), { recursive: true, force: true })
  await rm(candidatePointer, { force: true })
  return { discarded: true }
}

async function main() {
  assert(Number.isInteger(activationPort) && activationPort >= 0 && activationPort <= 65535, 'invalid activation port')
  const args = new Set(process.argv.slice(2))
  const modes = ['--activate', '--activate-if-present', '--rollback', '--discard-candidate'].filter((mode) => args.has(mode))
  assert(modes.length <= 1 && args.size === modes.length, 'unsupported or conflicting build-platform arguments')
  const result = await withLock(async () => {
    if (args.has('--activate')) return activateCandidate()
    if (args.has('--activate-if-present')) return activateCandidate({ optional: true })
    if (args.has('--rollback')) return rollbackBuild()
    if (args.has('--discard-candidate')) return discardCandidate()
    const candidate = await buildCandidate()
    if (await portOpen(activationPort)) {
      return {
        built: true,
        activated: false,
        reason: 'active-service-preserved',
        releaseId: candidate.releaseId,
        distFileCount: candidate.distFileCount,
        serverFileCount: candidate.serverFileCount,
      }
    }
    return { built: true, ...(await activateCandidate()) }
  })
  console.log(JSON.stringify({ ok: true, ...result }))
}

await main()
