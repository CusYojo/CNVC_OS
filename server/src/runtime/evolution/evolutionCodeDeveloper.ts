import { z } from 'zod'
import type { EvolutionSpec, EvolutionVerdict } from '../../contracts/aiEvolutionContract.js'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { applyEvolutionChanges, safeEvolutionSourcePath, type EvolutionRepositoryRegistration, type EvolutionSourceSnapshot } from './evolutionSourceSnapshot.js'

const resultSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  changes: z.array(z.object({ path: z.string().min(1).max(240), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    contentBase64: z.string().max(6_000_000).nullable() }).strict()).min(1).max(100),
}).strict()

const textResultSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  changes: z.array(z.object({ path: z.string().min(1).max(240), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    content: z.string().max(4_000_000).nullable() }).strict()).min(1).max(100),
}).strict().transform(result => ({ summary: result.summary,
  changes: result.changes.map(({ path, expectedSha256, content }) => ({ path, expectedSha256,
    contentBase64: content === null ? null : Buffer.from(content, 'utf8').toString('base64') })),
}))

export type EvolutionCodeEvaluation = {
  suiteVersion: string
  candidateHash: string
  verdict: EvolutionVerdict
  checks: { id: string; verdict: EvolutionVerdict; evidence: string }[]
}
export type EvolutionDeveloperDependencies = {
  signal?: AbortSignal
  modelId: string
  /** Durable lease/cancellation and deadline check; called before every external phase. */
  assertCanContinue: () => Promise<void>
  /** Must atomically reserve against the run's lifetime budget before invoking the model. */
  reserveModelTokens: (upperBound: number) => Promise<void>
  recordModelUsage: (actualTokens: number | null, reservedTokens: number) => Promise<void>
  develop: (input: { signal?: AbortSignal; modelId: string; specification: EvolutionSpec; files: EvolutionSourceSnapshot['files']; feedback: EvolutionCodeEvaluation | null; maxOutputTokens: number }) => Promise<{ text: string; totalTokens: number | null; format?: 'utf8-patch' }>
  evaluate: (snapshot: EvolutionSourceSnapshot) => Promise<EvolutionCodeEvaluation>
  checkpoint: (value: { round: number; candidateHash: string; evaluation: EvolutionCodeEvaluation; summary: string }) => Promise<void>
}

/** Model output can propose file changes, never commands, permissions, acceptance rules or verdicts. */
export async function developEvolutionCode(spec: EvolutionSpec, baseline: EvolutionSourceSnapshot, registration: EvolutionRepositoryRegistration, deps: EvolutionDeveloperDependencies) {
  if (spec.target.type !== 'code' || spec.kind !== 'code' || spec.target.repositoryId !== baseline.repositoryId || spec.target.baseCommit !== baseline.baseCommit) {
    throw evolutionError(409, 'EVOLUTION_DEVELOPER_BASELINE', '开发规格与源码基线不一致')
  }
  let candidate = baseline
  let feedback: EvolutionCodeEvaluation | null = null
  let lastFailureHash = ''
  let summary = ''
  const within = (file: string, paths: string[]) => paths.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))
  if (registration.contextPaths?.some((context) => !safeEvolutionSourcePath(context) || !within(context, registration.readablePaths))) {
    throw evolutionError(409, 'EVOLUTION_CONTEXT_SCOPE', '模型参考上下文超出登记的读取范围')
  }
  const contextPaths = [...spec.target.allowedPaths, ...registration.contextPaths ?? []]
  for (let round = 0; round <= spec.budget.maxRepairRounds; round++) {
    await deps.assertCanContinue()
    // Send text sources only; a file's hash still binds edits to its exact original bytes.
    const files = candidate.files.filter((file) => within(file.path, contextPaths) && /\.(tsx?|jsx?|json|css|html|md|mjs|cjs)$/.test(file.path))
    const inputBytes = Buffer.byteLength(JSON.stringify({ spec, files, feedback }), 'utf8')
    const maxOutputTokens = Math.min(16_000, Math.floor(spec.budget.maxModelTokens / 2))
    // UTF-8 bytes conservatively bound input tokens; accounting remains marked estimated when provider usage is unknown.
    const reserved = inputBytes + maxOutputTokens + 4096 // Fixed gateway instructions and message framing.
    if (reserved > spec.budget.maxModelTokens) throw evolutionError(409, 'EVOLUTION_CONTEXT_BUDGET', '当前源码上下文超出任务预算，请缩小读取范围')
    await deps.reserveModelTokens(reserved)
    const response = await deps.develop({ signal: deps.signal, modelId: deps.modelId, specification: spec, files, feedback, maxOutputTokens })
    await deps.recordModelUsage(response.totalTokens, reserved)
    await deps.assertCanContinue()
    const result = response.format === 'utf8-patch'
      ? resultSchema.parse(textResultSchema.parse(JSON.parse(response.text)))
      : resultSchema.parse(JSON.parse(response.text))
    candidate = applyEvolutionChanges(candidate, registration, spec.target.allowedPaths, result.changes)
    summary = result.summary
    await deps.assertCanContinue()
    const evaluation = await deps.evaluate(candidate)
    if (evaluation.candidateHash !== candidate.contentHash || !evaluation.suiteVersion || !evaluation.checks.length) {
      throw evolutionError(409, 'EVOLUTION_EVALUATION_BINDING', '独立评估没有绑定当前候选或缺少验收证据')
    }
    await deps.checkpoint({ round, candidateHash: candidate.contentHash, evaluation, summary })
    if (evaluation.verdict === 'PASS' && evaluation.checks.every((check) => check.verdict === 'PASS' && check.evidence.trim())) {
      await deps.assertCanContinue()
      return { candidate, evaluation, summary, repairRounds: round }
    }
    if (evaluation.verdict !== 'FAIL') throw evolutionError(409, 'EVOLUTION_EVALUATION_INCOMPLETE', '独立验收尚未完成或证据不足')
    const failureHash = evolutionContentHash({ candidate: candidate.contentHash, checks: evaluation.checks })
    if (failureHash === lastFailureHash) throw evolutionError(409, 'EVOLUTION_REPEATED_FAILURE', '相同候选重复失败且没有有效变化')
    lastFailureHash = failureHash
    feedback = evaluation
  }
  throw evolutionError(409, 'EVOLUTION_REPAIR_BUDGET_EXHAUSTED', '已用完修复轮次，保留最近验收证据')
}
