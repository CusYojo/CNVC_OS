import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[build release acceptance] ${message}`)
}

async function exists(target: string) {
  try { await access(target); return true } catch { return false }
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

async function writeArtifacts(root: string, webVersion: string, serverVersion: string) {
  const dist = path.join(root, 'dist')
  const serverDist = path.join(root, 'server-dist')
  await mkdir(path.join(dist, 'assets'), { recursive: true })
  await mkdir(serverDist, { recursive: true })
  const index = `<!doctype html><div id="root">${webVersion}</div><script src="/assets/app.js"></script>\n`
  const serverEntry = `export const buildVersion = ${JSON.stringify(serverVersion)}\n`
  await writeFile(path.join(dist, 'index.html'), index)
  await writeFile(path.join(dist, 'assets/app.js'), `globalThis.__build=${JSON.stringify(webVersion)}\n`)
  await writeFile(path.join(dist, 'company-logo.png'), 'test-logo\n', { mode: 0o600 })
  await chmod(path.join(dist, 'company-logo.png'), 0o600)
  await writeFile(path.join(serverDist, 'index.js'), serverEntry)
  return { index, serverEntry }
}

function run(script: string, cwd: string, port: number, mode: '--activate' | '--rollback') {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script, mode], {
      cwd,
      env: { ...process.env, NODE_ENV: 'test', CYBERNAUT_BUILD_ACTIVATION_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code, output }))
  })
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cybernaut-build-release-'))
const script = path.resolve('server/scripts/build-platform.mjs')
const releaseId = 'build-20260811T120000000Z-4242-a1b2c3d4'
const candidate = path.join(temporaryRoot, '.runtime/build-candidates', releaseId)
const server = net.createServer()

try {
  const oldArtifacts = await writeArtifacts(temporaryRoot, 'web-v1', 'server-v1')
  const nextArtifacts = await writeArtifacts(candidate, 'web-v2', 'server-v2')
  const manifestFile = path.join(candidate, 'manifest.json')
  const manifest = {
    version: 1,
    releaseId,
    createdAt: '2026-08-11T12:00:00.000Z',
    distIndexSha256: digest(nextArtifacts.index),
    serverEntrySha256: digest(nextArtifacts.serverEntry),
    distFileCount: 3,
    serverFileCount: 1,
    secretsIncluded: false,
  }
  await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`, { mode: 0o600 })
  await mkdir(path.join(temporaryRoot, '.runtime'), { recursive: true })
  const pointer = path.join(temporaryRoot, '.runtime/build-candidate.json')
  await writeFile(pointer, `${JSON.stringify({ version: 1, releaseId })}\n`, { mode: 0o600 })
  await chmod(pointer, 0o600)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address === 'object', 'test listener did not expose a port')
  const blocked = await run(script, temporaryRoot, address.port, '--activate')
  assert(blocked.code !== 0 && blocked.output.includes('refusing to activate build while port'), 'active listener must block artifact activation')
  assert((await readFile(path.join(temporaryRoot, 'dist/index.html'), 'utf8')) === oldArtifacts.index, 'blocked activation changed live Web artifacts')
  assert((await readFile(path.join(temporaryRoot, 'server-dist/index.js'), 'utf8')) === oldArtifacts.serverEntry, 'blocked activation changed live server artifacts')

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await writeFile(manifestFile, `${JSON.stringify({ ...manifest, distIndexSha256: '0'.repeat(64) })}\n`, { mode: 0o600 })
  const invalidCandidate = await run(script, temporaryRoot, address.port, '--activate')
  assert(invalidCandidate.code !== 0 && invalidCandidate.output.includes('differs from candidate'), 'candidate hash mismatch must block activation')
  assert((await readFile(path.join(temporaryRoot, 'dist/index.html'), 'utf8')) === oldArtifacts.index, 'invalid candidate changed live Web artifacts')
  assert((await readFile(path.join(temporaryRoot, 'server-dist/index.js'), 'utf8')) === oldArtifacts.serverEntry, 'invalid candidate changed live server artifacts')
  await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`, { mode: 0o600 })

  const activated = await run(script, temporaryRoot, address.port, '--activate')
  assert(activated.code === 0, `stopped activation failed: ${activated.output}`)
  assert((await readFile(path.join(temporaryRoot, 'dist/index.html'), 'utf8')) === nextArtifacts.index, 'activation did not publish Web candidate')
  assert((await readFile(path.join(temporaryRoot, 'server-dist/index.js'), 'utf8')) === nextArtifacts.serverEntry, 'activation did not publish server candidate')
  assert(((await stat(path.join(temporaryRoot, 'dist/company-logo.png'))).mode & 0o004) !== 0, 'activation did not make Web static files public-readable')
  assert(!await exists(pointer), 'candidate pointer remained after activation')
  assert((await stat(path.join(temporaryRoot, '.runtime/build-rollback.json'))).mode % 0o1000 === 0o600, 'rollback pointer is not owner-only')

  const rolledBack = await run(script, temporaryRoot, address.port, '--rollback')
  assert(rolledBack.code === 0, `rollback failed: ${rolledBack.output}`)
  assert((await readFile(path.join(temporaryRoot, 'dist/index.html'), 'utf8')) === oldArtifacts.index, 'rollback did not restore previous Web artifacts')
  assert((await readFile(path.join(temporaryRoot, 'server-dist/index.js'), 'utf8')) === oldArtifacts.serverEntry, 'rollback did not restore previous server artifacts')
  assert(((await stat(path.join(temporaryRoot, 'dist/company-logo.png'))).mode & 0o004) !== 0, 'rollback did not make restored Web static files public-readable')
  assert(!await exists(path.join(temporaryRoot, '.runtime/build-rollback.json')), 'rollback pointer remained after restoration')
  assert(await exists(path.join(temporaryRoot, '.runtime/build-failed')), 'failed candidate was not preserved for diagnosis')

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'active-listener-blocks-activation-with-live-artifacts-unchanged',
      'invalid-candidate-hash-blocks-activation-with-live-artifacts-unchanged',
      'stopped-activation-publishes-validated-web-and-server-pair',
      'web-static-files-public-readable-after-activation-and-rollback',
      'rollback-pointer-owner-only',
      'rollback-restores-previous-web-and-server-pair',
      'failed-release-preserved-for-diagnosis',
    ],
    productionFilesChanged: 0,
    processMutation: false,
  }))
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(temporaryRoot, { recursive: true, force: true })
}
