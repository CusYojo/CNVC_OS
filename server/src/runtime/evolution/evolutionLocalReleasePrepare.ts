import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { captureEvolutionRuntimeIdentity } from '../../services/aiEvolutionRuntimeIdentity.js'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { parseEvolutionReleaseReceipt, type EvolutionReleaseReceipt } from './evolutionReleaseCoordinator.js'

const command = promisify(execFile)
const resultSchema = z.object({ ok: z.literal(true), staged: z.literal(true), activated: z.literal(false),
  releaseId: z.string().regex(/^build-[0-9]{8}T[0-9]{9}Z-[0-9]+-[a-f0-9]{8}$/) }).passthrough()

export async function prepareLocalEvolutionRelease(input: {
  targetRoot: string; bundleRoot: string; manifestSha256: string; candidateHash: string;
  authorize: () => Promise<void>; run?: typeof command;
}): Promise<EvolutionReleaseReceipt> {
  if (!/^[a-f0-9]{64}$/.test(input.manifestSha256) || !/^[a-f0-9]{64}$/.test(input.candidateHash)) throw Error('Invalid release digest')
  const [targetRoot, bundleRoot] = await Promise.all([realpath(input.targetRoot), realpath(input.bundleRoot)])
  if (targetRoot === bundleRoot || bundleRoot.startsWith(targetRoot + path.sep)) throw Error('Release bundle must be outside target root')
  await input.authorize()
  const previousIdentity = await captureEvolutionRuntimeIdentity(path.join(targetRoot, 'server-dist/index.js'))
  const script = path.join(targetRoot, 'server', 'scripts', 'build-platform.mjs')
  if (await realpath(script) !== script) throw Error('Build platform script path is redirected')
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
  const execute = input.run ?? command
  const result = await execute(process.execPath, [script, `--stage-evolution=${bundleRoot}`, `--manifest-sha256=${input.manifestSha256}`],
    { cwd: targetRoot, env, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 })
  if (result.stderr.trim()) throw evolutionError(503, 'EVOLUTION_RELEASE_PREPARE_OUTPUT', '发布准备产生了未确认的错误输出')
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean)
  if (lines.length !== 1) throw evolutionError(503, 'EVOLUTION_RELEASE_PREPARE_OUTPUT', '发布准备结果格式不明确')
  const staged = resultSchema.parse(JSON.parse(lines[0]))
  await input.authorize()
  const candidateDirectory = path.join(targetRoot, '.runtime', 'build-candidates', staged.releaseId)
  const pointer = JSON.parse(await readFile(path.join(targetRoot, '.runtime', 'build-candidate.json'), 'utf8'))
  if (pointer.version !== 1 || pointer.releaseId !== staged.releaseId) throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '暂存指针与发布结果不一致')
  const candidateIdentity = await captureEvolutionRuntimeIdentity(path.join(candidateDirectory, 'server-dist/index.js'))
  if (!candidateIdentity) throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '暂存候选缺少完整运行身份')
  const receipt = parseEvolutionReleaseReceipt({ releaseId: staged.releaseId, candidateHash: input.candidateHash,
    previousReleaseId: previousIdentity ? `runtime:${evolutionContentHash(previousIdentity)}` : null,
    candidateIdentity, previousIdentity })
  await input.authorize()
  // Re-read immutable entry bytes after the last authorization check.
  const confirmed = await captureEvolutionRuntimeIdentity(path.join(candidateDirectory, 'server-dist/index.js'))
  if (!confirmed || evolutionContentHash(confirmed) !== evolutionContentHash(receipt.candidateIdentity)) {
    throw evolutionError(409, 'EVOLUTION_RELEASE_BINDING', '暂存候选在准备期间发生变化')
  }
  return receipt
}
