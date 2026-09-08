import { z } from 'zod'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'
import { previewEvolutionSkillComparison } from './aiEvolutionSkillComparisonPreview.js'
import type { AiEvolutionArtifactStore } from './aiEvolutionArtifactStore.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const verdict = z.enum(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'SKIPPED'])
const checkpointSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('skill'),
  round: z.number().int().nonnegative(), baselineHash: hash, candidateHash: hash, summary: z.string(),
  evaluation: z.object({ suiteVersion: z.string(), candidateHash: hash, verdict,
    checks: z.array(z.object({ id: z.string(), verdict, evidence: z.string() }).strict()) }).strict(),
  artifacts: z.array(z.object({ storageKey: z.string(), sha256: hash, bytes: z.number().int().nonnegative(),
    kind: z.enum(['patch', 'web', 'server', 'screenshot', 'report', 'content']) }).strict()).min(1).max(5000),
}).strict()

/** Caller must authorize the run and its frozen sources before passing its checkpoint. */
export async function readEvolutionSkillCheckpoint(input: { runId: string; baselineHash: string; checkpoint: unknown;
  expectedHash?: string }, store: Pick<AiEvolutionArtifactStore, 'read'>) {
  const parsed = checkpointSchema.safeParse(input.checkpoint)
  if (!parsed.success) throw evolutionError(404, 'EVOLUTION_REPORT_NOT_FOUND', '技能评测报告尚不可用')
  const checkpoint = parsed.data
  const checkpointHash = evolutionContentHash(checkpoint)
  if (input.expectedHash !== undefined && input.expectedHash !== checkpointHash) {
    throw evolutionError(409, 'EVOLUTION_CHECKPOINT_CHANGED', '评测报告已更新，请刷新后下载')
  }
  if (checkpoint.baselineHash !== input.baselineHash || checkpoint.candidateHash !== checkpoint.evaluation.candidateHash
    || new Set(checkpoint.artifacts.map(row => row.storageKey)).size !== checkpoint.artifacts.length) {
    throw evolutionError(409, 'EVOLUTION_EVALUATION_BINDING', '技能检查点与任务不一致')
  }
  const comparison = await previewEvolutionSkillComparison({ runId: input.runId, baseRef: input.baselineHash,
    manifest: { sourceHash: checkpoint.candidateHash, artifacts: checkpoint.artifacts },
    evaluation: { hash: evolutionContentHash(checkpoint.evaluation), report: checkpoint.evaluation } }, store)
  return { checkpointHash, comparison, artifacts: checkpoint.artifacts }
}
