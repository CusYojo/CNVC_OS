import { z } from 'zod'
import type { EvolutionCandidateManifest, EvolutionEvaluationReport, EvolutionSkillComparisonPreview } from '../contracts/aiEvolutionEvaluationContract.js'
import type { AiEvolutionArtifactStore } from './aiEvolutionArtifactStore.js'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'
import { safeEvolutionSourcePath } from '../runtime/evolution/evolutionSourceSnapshot.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const artifact = z.object({ storageKey: z.string(), sha256: hash, bytes: z.number().int().nonnegative(),
  kind: z.enum(['patch', 'web', 'server', 'screenshot', 'report', 'content']) }).strict()
const check = z.object({ id: z.string(), verdict: z.string(), evidence: z.string() }).strict()
const side = z.object({ side: z.enum(['baseline', 'candidate']), skillHash: hash, artifact,
  supportingArtifacts: z.array(artifact).optional(), contentType: z.string(), assessment: z.object({ score: z.number().finite(), checks: z.array(check) }).strict() }).strict()
const schema = z.object({ schemaVersion: z.literal(1), baselineHash: hash, candidateHash: hash, baselineVersion: artifact, candidateVersion: artifact,
  runtime: z.object({ modelId: z.string(), modelVersion: z.string(), promptHash: z.string(), rendererVersion: z.string() }).strict(),
  metric: z.object({ name: z.string(), direction: z.enum(['higher', 'lower']), minimumImprovement: z.number().positive() }).strict(),
  comparisons: z.array(z.object({ sampleId: z.string(), inputHash: hash, sides: z.tuple([side, side]) }).strict()).min(1).max(100),
  evaluation: z.object({ suiteVersion: z.string(), candidateHash: hash, verdict: z.string(), checks: z.array(check) }).strict(),
}).strict()

export async function previewEvolutionSkillComparison(candidate: { runId: string; baseRef: string; contentHash?: string; manifest: Pick<EvolutionCandidateManifest, 'sourceHash' | 'artifacts'>;
  evaluation: { hash: string; report: EvolutionEvaluationReport } }, store: Pick<AiEvolutionArtifactStore, 'read'>): Promise<EvolutionSkillComparisonPreview> {
  const invalid = () => evolutionError(409, 'EVOLUTION_EVALUATION_BINDING', '技能对比报告与候选产物不一致')
  const index = (ref: z.infer<typeof artifact>) => {
    const found = candidate.manifest.artifacts.findIndex(row => row.storageKey === ref.storageKey && row.sha256 === ref.sha256 && row.bytes === ref.bytes)
    if (found < 0) throw invalid()
    return found
  }
  const reportArtifact = candidate.manifest.artifacts.filter(row => row.kind === 'report').at(-1)
  if (!reportArtifact || reportArtifact.bytes > 8 * 1024 * 1024) throw invalid()
  const report = schema.parse(JSON.parse((await store.read(candidate.runId, reportArtifact)).toString('utf8')))
  if (report.baselineHash !== candidate.baseRef || report.candidateHash !== candidate.manifest.sourceHash
    || evolutionContentHash(report.evaluation) !== evolutionContentHash(candidate.evaluation.report)
    || (candidate.contentHash ? evolutionContentHash({ candidateHash: candidate.contentHash, report: candidate.evaluation.report })
      : evolutionContentHash(candidate.evaluation.report)) !== candidate.evaluation.hash
    || new Set(report.comparisons.map(row => row.sampleId)).size !== report.comparisons.length) throw invalid()
  index(report.baselineVersion); index(report.candidateVersion)
  const samples = []
  for (const sample of report.comparisons) {
    if (sample.sides[0].side !== 'baseline' || sample.sides[1].side !== 'candidate') throw invalid()
    const sides = []
    for (const row of sample.sides) {
      if (row.skillHash !== (row.side === 'baseline' ? report.baselineHash : report.candidateHash)) throw invalid()
      const downloads = [{ label: '生成输出', index: index(row.artifact), kind: row.artifact.kind, bytes: row.artifact.bytes }]
      for (const ref of row.supportingArtifacts ?? []) index(ref)
      if (row.contentType === 'application/vnd.sbl.evolution-due-diligence+json' && row.supportingArtifacts?.length) {
        if (row.artifact.bytes > 2 * 1024 * 1024) throw invalid()
        const descriptor = z.object({ sampleId: z.string(), skillHash: hash, generation: artifact,
          artifacts: z.array(z.object({ path: z.string().refine(safeEvolutionSourcePath), artifact }).strict()).max(100) })
          .parse(JSON.parse((await store.read(candidate.runId, row.artifact)).toString('utf8')))
        if (descriptor.sampleId !== sample.sampleId || descriptor.skillHash !== row.skillHash) throw invalid()
        const refs = [descriptor.generation, ...descriptor.artifacts.map(file => file.artifact)]
        if (refs.some(ref => !row.supportingArtifacts!.some(item => item.storageKey === ref.storageKey && item.sha256 === ref.sha256 && item.bytes === ref.bytes))) throw invalid()
        downloads.push({ label: '原始与归一化数据包', index: index(descriptor.generation), kind: descriptor.generation.kind, bytes: descriptor.generation.bytes })
        downloads.push(...descriptor.artifacts.map(file => ({ label: file.path.split('/').at(-1)!, index: index(file.artifact), kind: file.artifact.kind, bytes: file.artifact.bytes })))
      } else downloads.push(...(row.supportingArtifacts ?? []).map(ref => ({ label: `${ref.kind} ${ref.sha256.slice(0, 12)}`, index: index(ref), kind: ref.kind, bytes: ref.bytes })))
      sides.push({ side: row.side, skillHash: row.skillHash, score: row.assessment.score, checks: row.assessment.checks, downloads })
    }
    samples.push({ id: sample.sampleId, inputHash: sample.inputHash, sides })
  }
  return { sourceHash: report.candidateHash, runtime: report.runtime, metric: report.metric, samples }
}
