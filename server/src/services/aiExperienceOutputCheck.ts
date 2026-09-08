import { z } from 'zod'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'
import type { resolveAiExperiences } from './aiExperienceResolver.js'

const verdict = z.enum(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'SKIPPED'])
const itemSchema = z.object({ versionId: z.string().min(1), verdict,
  explanation: z.string().trim().min(1).max(4000), excerpts: z.array(z.string().min(1).max(2000)).max(10) }).strict()
export const experienceOutputItemsSchema = z.array(itemSchema).max(1000)
function aggregate(checks: z.infer<typeof experienceOutputItemsSchema>) {
  return !checks.length ? 'NOT_RUN' : checks.some(check => check.verdict === 'FAIL') ? 'FAIL'
    : checks.every(check => check.verdict === 'PASS') ? 'PASS' : 'BLOCKED'
}
export const experienceOutputCheckSchema = z.object({
  schemaVersion: z.literal(1), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  outputHash: z.string().regex(/^[a-f0-9]{64}$/), checkerVersion: z.string().min(1).max(160),
  verdict, checks: experienceOutputItemsSchema,
}).strict().superRefine((value, context) => {
  if (value.verdict !== aggregate(value.checks) || new Set(value.checks.map(check => check.versionId)).size !== value.checks.length
    || value.checks.some(check => check.verdict === 'PASS' && !check.excerpts.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '遵守检查总结果与分项证据不一致' })
  }
})
export type ExperienceOutputCheck = z.infer<typeof experienceOutputCheckSchema>
type Snapshot = ReturnType<typeof resolveAiExperiences>['snapshot']

export function assertExperienceCheckVersions(result: ExperienceOutputCheck, snapshot: Record<string, unknown>) {
  const loaded = z.array(z.object({ versionId: z.string().min(1) }).passthrough()).parse(snapshot.loaded)
  const ids = new Set(loaded.map(item => item.versionId))
  if (ids.size !== loaded.length || result.checks.length !== ids.size || result.checks.some(item => !ids.has(item.versionId))) {
    throw evolutionError(409, 'EVOLUTION_OUTPUT_CHECK_EVIDENCE', '遵守检查与冻结经验版本不一致')
  }
}

/** Host supplies the checker; neither the task output nor the generated proposal chooses its verdict. */
export async function checkAiExperienceOutput(input: {
  snapshot: Snapshot; snapshotHash: string; output: string; checkerVersion: string; signal?: AbortSignal
  assertAuthorized: () => Promise<void>
  assess: (input: { rules: Snapshot['loaded']; output: string; signal?: AbortSignal }) => Promise<unknown>
}): Promise<ExperienceOutputCheck> {
  input.signal?.throwIfAborted()
  await input.assertAuthorized()
  const snapshot = structuredClone(input.snapshot)
  if (evolutionContentHash(snapshot) !== input.snapshotHash) throw evolutionError(409, 'EVOLUTION_APPLICATION_CORRUPT', '经验快照校验失败')
  const ids = snapshot.loaded.map(rule => rule.versionId)
  if (new Set(ids).size !== ids.length) throw evolutionError(409, 'EVOLUTION_APPLICATION_CORRUPT', '经验版本重复')
  const checks = ids.length ? z.array(itemSchema).max(1000).parse(await input.assess({ rules: structuredClone(snapshot.loaded), output: input.output, signal: input.signal })) : []
  input.signal?.throwIfAborted()
  await input.assertAuthorized()
  if (checks.length !== ids.length || new Set(checks.map(check => check.versionId)).size !== ids.length
    || checks.some(check => !ids.includes(check.versionId)
      || (check.verdict === 'PASS' && !check.excerpts.length)
      || check.excerpts.some(excerpt => !input.output.includes(excerpt)))) {
    throw evolutionError(409, 'EVOLUTION_OUTPUT_CHECK_EVIDENCE', '遵守检查遗漏版本或引用了实际输出中不存在的证据')
  }
  const outcome = aggregate(checks)
  return experienceOutputCheckSchema.parse({ schemaVersion: 1, snapshotHash: input.snapshotHash,
    outputHash: evolutionContentHash({ output: input.output }), checkerVersion: input.checkerVersion,
    verdict: outcome, checks })
}
