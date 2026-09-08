import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'
import type { DockerEvolutionEnvironment } from './dockerEvolutionEnvironment.js'
import type { EvolutionExecutionControl } from './evolutionRunCoordinator.js'
import type { captureEvolutionSkill } from './evolutionSkillSnapshot.js'

const resultSchema = z.object({ files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative().max(16 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(100),
  checks: z.array(z.object({ id: z.string(), passed: z.boolean(), exitCode: z.number().int().nullable(), executionError: z.string().nullable() }).strict()).max(20),
}).strict()

/** One fixed baseline package per owned environment; model output supplies data only. Coordinator owns termination. */
export async function prepareEvolutionDueDiligenceRenderer(input: {
  environment: Pick<DockerEvolutionEnvironment, 'create' | 'importSnapshot' | 'writeInputFile' | 'evaluateNode' | 'readOutputFile'>
  control: EvolutionExecutionControl; skillSnapshot: Awaited<ReturnType<typeof captureEvolutionSkill>>;
}) {
  const { environment, control } = input
  const snapshot = structuredClone(input.skillSnapshot)
  if (evolutionContentHash(snapshot.manifest) !== snapshot.packageHash || evolutionContentHash(snapshot.version) !== snapshot.contentHash
    || snapshot.files.length !== snapshot.manifest.length || snapshot.files.some((file, index) => {
      const row = snapshot.manifest[index], bytes = Buffer.from(file.contentBase64, 'base64')
      return file.path !== row.name || file.bytes !== row.bytes || file.sha256 !== row.contentHash
        || bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256
    })) throw evolutionError(409, 'EVOLUTION_DEVELOPER_BASELINE', '渲染器技能包快照不完整')
  const script = await readFile(path.resolve('server/scripts/render-evolution-due-diligence.mjs'))
  const scriptHash = createHash('sha256').update(script).digest('hex')
  const rendererHash = evolutionContentHash({ scriptHash, packageHash: snapshot.packageHash })
  await control.assertCanContinue()
  await environment.create(control.identity)
  await control.assertCanContinue()
  await environment.importSnapshot(control.identity, { schemaVersion: 1, repositoryId: snapshot.version.capabilityId,
    baseCommit: snapshot.packageHash, contentHash: rendererHash,
    files: [...snapshot.files.map(file => ({ ...file, path: `skill/${file.path}` })),
      { path: 'render.mjs', bytes: script.length, sha256: scriptHash, contentBase64: script.toString('base64') }],
  }, 'platform')
  return { rendererHash, render: async (data: { report: Record<string, unknown>; diligenceData: Record<string, unknown>; evidence: Record<string, unknown> }) => {
    await control.assertCanContinue()
    const id = randomUUID()
    await environment.writeInputFile(control.identity, `${id}.json`, Buffer.from(JSON.stringify(data)))
    await control.assertCanContinue()
    const result = await environment.evaluateNode(control.identity,
      `const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,['/workspace/platform/render.mjs',${JSON.stringify(id)}],{encoding:'utf8',timeout:280000,maxBuffer:512000});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.error?1:r.status??1);`, 300_000)
    if (result.exitCode !== 0) throw evolutionError(409, 'EVOLUTION_RENDER_FAILED', '隔离报告渲染未返回完整产物清单')
    const metadata = resultSchema.parse(JSON.parse(result.stdout))
    if (new Set(metadata.files.map(file => file.path)).size !== metadata.files.length
      || metadata.files.some(file => !file.path.startsWith(`${id}/`))
      || metadata.files.reduce((sum, file) => sum + file.bytes, 0) > 64 * 1024 * 1024) {
      throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '渲染输出清单越界或超限')
    }
    const files = []
    for (const file of metadata.files) files.push({ ...file, content: await environment.readOutputFile(control.identity, file, control.assertCanContinue) })
    await control.assertCanContinue()
    return { rendererHash, checks: metadata.checks, files }
  } }
}
