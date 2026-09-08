import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'

test('reviewed build import only stages; activation verifies every file and rollback restores prior artifacts', {
  skip: process.platform === 'win32' ? 'Requires POSIX permission semantics; verified in isolated Linux Docker' : false,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-stage-'))
  const source = path.join(root, 'input'), target = path.join(root, 'target')
  const script = path.resolve('server/scripts/build-platform.mjs')
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [script, ...args], { cwd: target,
    env: { ...process.env, NODE_ENV: 'test', CYBERNAUT_BUILD_ACTIVATION_PORT: '0' }, windowsHide: true })
  const files = { 'dist/index.html': '<div id="root"></div>', 'dist/assets/app.js': 'console.log("new")', 'server-dist/index.js': 'export const version = "new"' }
  try {
    for (const base of [source, target]) for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(base, name)), { recursive: true })
      await writeFile(path.join(base, name), base === source ? content : content.replaceAll('new', 'old'))
    }
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, activated: false, baseCommit: 'a'.repeat(40), patchHash: 'b'.repeat(64), lockHash: 'c'.repeat(64),
      artifacts: Object.entries(files).map(([name, content]) => ({ path: name, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') })) }))
    await writeFile(path.join(source, 'manifest.json'), manifest)
    const digest = createHash('sha256').update(manifest).digest('hex')
    const output = JSON.parse((await run(`--stage-evolution=${source}`, `--manifest-sha256=${digest}`)).stdout)
    assert.equal(output.activated, false)
    assert.match(await readFile(path.join(target, 'server-dist/index.js'), 'utf8'), /old/)
    await assert.rejects(run(`--stage-evolution=${source}`, `--manifest-sha256=${digest}`))
    const stagedAsset = path.join(target, '.runtime/build-candidates', output.releaseId, 'dist/assets/app.js')
    await writeFile(stagedAsset, 'tampered')
    await assert.rejects(run('--activate'))
    assert.match(await readFile(path.join(target, 'server-dist/index.js'), 'utf8'), /old/)
    await writeFile(stagedAsset, files['dist/assets/app.js'])
    assert.equal(JSON.parse((await run('--activate')).stdout).activated, true)
    assert.match(await readFile(path.join(target, 'server-dist/index.js'), 'utf8'), /new/)
    assert.equal(JSON.parse((await run('--rollback')).stdout).rolledBack, true)
    assert.match(await readFile(path.join(target, 'server-dist/index.js'), 'utf8'), /old/)
    await assert.rejects(access(path.join(target, '.runtime/build-candidate.json')))
  } finally { await rm(root, { recursive: true, force: true }) }
})
