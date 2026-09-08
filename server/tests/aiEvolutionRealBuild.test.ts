import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import { buildEvolutionInDocker } from '../src/runtime/evolution/evolutionDockerBuild.js'
import { AiEvolutionArtifactStore } from '../src/services/aiEvolutionArtifactStore.js'
import { runEvolutionTestGate } from '../src/runtime/evolution/evolutionTestGate.js'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { captureEvolutionSource, type EvolutionSourceFile } from '../src/runtime/evolution/evolutionSourceSnapshot.js'
import { DockerEvolutionEnvironment } from '../src/runtime/evolution/dockerEvolutionEnvironment.js'

test('real fixed-commit platform builds inside offline Docker without activation', { skip: process.env.EVOLUTION_REAL_BUILD_TEST !== 'true' }, async () => {
  const image = process.env.EVOLUTION_BUILD_IMAGE!
  assert.match(image, /^sha256:[a-f0-9]{64}$/)
  const root = process.cwd()
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const source = await captureEvolutionSource({ id: 'platform-test', root,
    readablePaths: ['src', 'server/src', 'public', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'server/tsconfig.json', 'server/tsconfig.build.json', 'tailwind.config.js', 'postcss.config.js'],
    editablePaths: ['src'], protectedPaths: ['server/src'],
  }, commit)
  const platformFiles: EvolutionSourceFile[] = await Promise.all(['build-evolution-candidate.mjs', 'build-evolution-web.mjs'].map(async (name) => {
    const content = await readFile(path.join(root, 'server/scripts', name))
    return { path: name, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), contentBase64: content.toString('base64') }
  }))
  const environment = new DockerEvolutionEnvironment(undefined, image)
  const identity = { runId: randomUUID(), attempt: 1, leaseToken: 1, inputHash: source.contentHash }
  if (process.env.EVOLUTION_REAL_GATES_TEST === 'true') {
    await environment.create(identity)
    try {
      await environment.importSnapshot(identity, source)
      const setup = await environment.evaluateNode(identity, `const fs=require('node:fs'),assert=require('node:assert/strict');fs.symlinkSync('/opt/evolution-dependencies/node_modules','/workspace/source/node_modules');assert.throws(()=>fs.writeFileSync('/opt/evolution-gates/projectDeletionAuthorization.test.ts','tampered'));`)
      assert.equal(setup.exitCode, 0, setup.stderr)
      for (const gate of [{ id: 'permissions' as const, file: 'projectDeletionAuthorization.test.ts', minimumTests: 2 },
        { id: 'contract' as const, file: 'leadEnrichmentContract.test.ts', minimumTests: 20 }]) {
        const result = await runEvolutionTestGate({ ...gate, environment, timeoutMs: 60000,
          control: { identity, signal: new AbortController().signal, assertCanContinue: async () => {} } })
        assert.equal(result.verdict, 'PASS', `${result.stdout}\n${result.stderr}`)
        console.log(`FIXED_GATE_VERIFIED ${gate.id} tests=${result.tests}`)
      }
    } finally { await environment.terminate(identity) }
    return
  }
  if (process.env.EVOLUTION_REAL_EXPORT_TEST === 'true') {
    const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-real-export-'))
    try {
      const store = new AiEvolutionArtifactStore(root)
      const result = await buildEvolutionInDocker({ snapshot: source, patchHash: '0'.repeat(64), scriptsRoot: path.resolve('server/scripts'),
        environment, store, control: { identity, signal: new AbortController().signal, assertCanContinue: async () => {} } })
      assert.ok(result.files.some((file) => file.path === 'dist/index.html'))
      assert.ok(result.files.some((file) => file.path === 'server-dist/index.js'))
      const index = JSON.parse((await store.read(identity.runId, result.pathIndex)).toString())
      assert.equal(index.build.activated, false)
      assert.equal(index.files.length, result.files.length)
      for (const file of result.artifacts) await store.read(identity.runId, file)
      console.log(`REAL_EXPORT_VERIFIED files=${result.files.length} blobs=${result.artifacts.length}`)
    } finally {
      await environment.terminate(identity)
      if (process.env.EVOLUTION_KEEP_EXPORT === 'true') console.log(`EXPORT_RETAINED ${root} run=${identity.runId}`)
      else await rm(root, { recursive: true, force: true })
    }
    return
  }
  await environment.create(identity)
  try {
    await environment.importSnapshot(identity, source)
    await environment.importSnapshot(identity, { ...source, files: platformFiles }, 'platform')
    const prepare = await environment.evaluateNode(identity, `
      const fs = require('node:fs'), assert = require('node:assert/strict'), crypto = require('node:crypto');
      const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      assert.equal(hash('/workspace/source/package-lock.json'), hash('/opt/evolution-dependencies/package-lock.json'));
      fs.symlinkSync('/opt/evolution-dependencies/node_modules', '/workspace/source/node_modules');
    `)
    assert.equal(prepare.exitCode, 0, prepare.stderr)
    const build = await environment.evaluateNode(identity, `
      import('/workspace/platform/build-evolution-candidate.mjs').then(async ({buildEvolutionCandidate}) => {
        const manifest = await buildEvolutionCandidate({sourceRoot:'/workspace/source', outputRoot:'/workspace/output', baseCommit:${JSON.stringify(commit)}, patchHash:'${'0'.repeat(64)}'});
        const fs = require('node:fs'), assert = require('node:assert/strict');
        assert.equal(fs.existsSync('/workspace/source/dist'), false);
        assert.equal(fs.existsSync('/workspace/source/server-dist'), false);
        assert.equal(fs.existsSync('/workspace/source/.runtime/build-candidate.json'), false);
        console.log('EVOLUTION_BUILD_EVIDENCE:' + JSON.stringify({ activated:manifest.activated, artifacts:manifest.artifacts.length, node:process.version }));
      }).catch(error => { console.error(error); process.exitCode=1 });
    `, 300_000)
    assert.equal(build.exitCode, 0, `${build.stdout}\n${build.stderr}`)
    assert.match(build.stdout, /EVOLUTION_BUILD_EVIDENCE:/)
    console.log(build.stdout.slice(-1200))
  } finally { await environment.terminate(identity) }
})
