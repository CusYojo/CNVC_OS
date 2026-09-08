import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { DockerEvolutionEnvironment } from './dockerEvolutionEnvironment.js'
import type { EvolutionSourceSnapshot } from './evolutionSourceSnapshot.js'
import type { EvolutionExecutionControl } from './evolutionRunCoordinator.js'
import type { AiEvolutionArtifactStore } from '../../services/aiEvolutionArtifactStore.js'
import { evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { collectEvolutionBuildArtifacts } from './evolutionBuildArtifacts.js'

/** Platform scriptsRoot is server configuration, never a candidate-provided path. */
export async function buildEvolutionInDocker(input: {
  snapshot: EvolutionSourceSnapshot; patchHash: string; scriptsRoot: string
  control: EvolutionExecutionControl; environment: DockerEvolutionEnvironment; store: AiEvolutionArtifactStore
}) {
  const { snapshot, environment, control } = input
  const lock = snapshot.files.find((file) => file.path === 'package-lock.json')
  if (!lock || !/^[a-f0-9]{64}$/.test(input.patchHash) || !path.isAbsolute(input.scriptsRoot)) {
    throw evolutionError(409, 'EVOLUTION_BUILD_BINDING', '缺少锁定依赖或可信构建参数')
  }
  await control.assertCanContinue()
  const files = await Promise.all(['build-evolution-candidate.mjs', 'build-evolution-web.mjs'].map(async (name) => {
    const bytes = await readFile(path.join(input.scriptsRoot, name))
    return { path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') }
  }))
  // Each repair round starts with a fresh environment; no candidate files survive from a previous round.
  await environment.terminate(control.identity)
  await control.assertCanContinue()
  await environment.create(control.identity)
  await environment.importSnapshot(control.identity, snapshot)
  await environment.importSnapshot(control.identity, { ...snapshot, files }, 'platform')
  await control.assertCanContinue()
  const prepare = await environment.evaluateNode(control.identity, `
    const fs = require('node:fs'), assert = require('node:assert/strict'), crypto = require('node:crypto');
    const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    assert.equal(hash('/workspace/source/package-lock.json'), ${JSON.stringify(lock.sha256)});
    assert.equal(hash('/opt/evolution-dependencies/package-lock.json'), ${JSON.stringify(lock.sha256)});
    fs.symlinkSync('/opt/evolution-dependencies/node_modules', '/workspace/source/node_modules');
  `)
  if (prepare.exitCode !== 0) throw evolutionError(409, 'EVOLUTION_DEPENDENCY_MISMATCH', '容器依赖与候选锁文件不一致')
  const build = await environment.evaluateNode(control.identity, `
    import('/workspace/platform/build-evolution-candidate.mjs').then(async ({buildEvolutionCandidate}) => {
      await buildEvolutionCandidate({ sourceRoot:'/workspace/source', outputRoot:'/workspace/output',
        baseCommit:${JSON.stringify(snapshot.baseCommit)}, patchHash:${JSON.stringify(input.patchHash)} });
      const fs = require('node:fs'), crypto = require('node:crypto');
      const bytes = fs.readFileSync('/workspace/output/manifest.json');
      console.log('EVOLUTION_MANIFEST:' + JSON.stringify({ path:'manifest.json', bytes:bytes.length,
        sha256:crypto.createHash('sha256').update(bytes).digest('hex') }));
    }).catch(() => { console.error('candidate build failed'); process.exitCode = 1 });
  `, 300_000)
  await control.assertCanContinue()
  const log = await input.store.put(control.identity.runId, Buffer.from(JSON.stringify({ stdout: build.stdout, stderr: build.stderr, exitCode: build.exitCode })), 'report')
  if (build.exitCode !== 0) throw evolutionError(422, 'EVOLUTION_BUILD_FAILED', `候选构建未通过，日志产物：${log.storageKey}`)
  const line = build.stdout.split(/\r?\n/).filter((value) => value.startsWith('EVOLUTION_MANIFEST:')).at(-1)
  if (!line) throw evolutionError(409, 'EVOLUTION_BUILD_BINDING', '构建没有返回产物清单')
  const descriptor = JSON.parse(line.slice('EVOLUTION_MANIFEST:'.length)) as { path: string; bytes: number; sha256: string }
  if (descriptor.path !== 'manifest.json' || descriptor.bytes > 2 * 1024 * 1024) throw evolutionError(409, 'EVOLUTION_BUILD_BINDING', '构建清单路径或大小异常')
  const manifest = JSON.parse((await environment.readOutputFile(control.identity, descriptor, control.assertCanContinue)).toString('utf8'))
  const exported = await collectEvolutionBuildArtifacts({ identity: control.identity, baseCommit: snapshot.baseCommit,
    patchHash: input.patchHash, lockHash: lock.sha256, manifest, environment, store: input.store, assertCanContinue: control.assertCanContinue })
  return { ...exported, log, lockHash: lock.sha256 }
}
