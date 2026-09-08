import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { evaluationHasRequiredEvidence, EVOLUTION_REQUIRED_CHECKS, type EvolutionEvaluationReport } from '../../contracts/aiEvolutionEvaluationContract.js'
import type { EvolutionExecutionControl } from './evolutionRunCoordinator.js'
import type { AiEvolutionArtifactStore } from '../../services/aiEvolutionArtifactStore.js'

export type EvolutionSkillVersion = {
  capabilityId: string; instructions: string; references: { name: string; content: string }[];
  dependencies: { name: string; contentHash: string }[]; toolPermissionHash: string;
}
type Sample = { id: string; input: string; materialHashes: string[] }
type Runtime = { modelId: string; modelVersion: string; promptHash: string; rendererVersion: string }
type Output = { content: Buffer; contentType: string; supportingArtifacts?: Awaited<ReturnType<AiEvolutionArtifactStore['put']>>[] }
type Assessment = { checks: EvolutionEvaluationReport['checks']; score: number }
type SideResult = { side: 'baseline' | 'candidate'; skillHash: string; artifact: Awaited<ReturnType<AiEvolutionArtifactStore['put']>>; supportingArtifacts?: Output['supportingArtifacts']; contentType: string; assessment: Assessment }

/** Version contents and samples are frozen before either side runs. Evaluator is platform-owned. */
export async function evaluateEvolutionSkill(input: {
  baseline: EvolutionSkillVersion; candidate: EvolutionSkillVersion; samples: Sample[]; runtime: Runtime;
  suiteVersion: string; control: EvolutionExecutionControl; store: Pick<AiEvolutionArtifactStore, 'put'>;
  /** Host-controlled score definition; never supplied by the skill developer. */
  metric: { name: string; direction: 'higher' | 'lower'; minimumImprovement: number };
  run: (input: { skill: EvolutionSkillVersion; sample: Sample; runtime: Runtime; signal: AbortSignal }) => Promise<Output>;
  assess: (input: { sample: Sample; output: Output; runtime: Runtime; signal: AbortSignal }) => Promise<Assessment>;
}) {
  const baseline = structuredClone(input.baseline), candidate = structuredClone(input.candidate)
  const samples = structuredClone(input.samples), runtime = structuredClone(input.runtime), metric = structuredClone(input.metric)
  if (!samples.length || samples.length > 100 || new Set(samples.map((sample) => sample.id)).size !== samples.length
    || !metric.name.trim() || !Number.isFinite(metric.minimumImprovement) || metric.minimumImprovement <= 0
    || Object.values(runtime).some((value) => !value.trim()) || !input.suiteVersion.trim()) throw Error('Invalid frozen skill evaluation configuration')
  if (baseline.capabilityId !== candidate.capabilityId || baseline.toolPermissionHash !== candidate.toolPermissionHash
    || evolutionContentHash(baseline.dependencies) !== evolutionContentHash(candidate.dependencies)) {
    throw evolutionError(409, 'EVOLUTION_SEPARATE_REVIEW_REQUIRED', '技能依赖或工具权限变化必须转入代码级检查')
  }
  const baselineHash = evolutionContentHash(baseline), candidateHash = evolutionContentHash(candidate)
  if (baselineHash === candidateHash) throw evolutionError(409, 'EVOLUTION_NO_CHANGE', '技能候选没有内容变化')
  const artifacts: Awaited<ReturnType<typeof input.store.put>>[] = []
  const comparisons: { sampleId: string; inputHash: string; sides: SideResult[] }[] = []
  for (const sample of samples) {
    const sides: SideResult[] = []
    for (const [side, skill] of [['baseline', baseline], ['candidate', candidate]] as const) {
      input.control.signal.throwIfAborted()
      await input.control.assertCanContinue()
      const generated = await input.run({ skill: structuredClone(skill), sample: structuredClone(sample), runtime: structuredClone(runtime), signal: input.control.signal })
      if (!generated.content.length || !generated.contentType.trim()) throw Error('Skill evaluation produced no readable artifact')
      const output = { content: Buffer.from(generated.content), contentType: generated.contentType,
        supportingArtifacts: structuredClone(generated.supportingArtifacts) }
      await input.control.assertCanContinue()
      const artifact = await input.store.put(input.control.identity.runId, output.content, 'content')
      artifacts.push(artifact)
      if (output.supportingArtifacts) artifacts.push(...output.supportingArtifacts)
      await input.control.assertCanContinue()
      const assessed = await input.assess({ sample: structuredClone(sample), output: { ...output, content: Buffer.from(output.content) }, runtime: structuredClone(runtime), signal: input.control.signal })
      if (!Number.isFinite(assessed.score)) throw Error('Skill assessment lacks a finite measured score')
      const assessment = structuredClone(assessed)
      sides.push({ side, skillHash: evolutionContentHash(skill), artifact, supportingArtifacts: output.supportingArtifacts, contentType: output.contentType, assessment })
    }
    comparisons.push({ sampleId: sample.id, inputHash: evolutionContentHash(sample), sides })
  }
  input.control.signal.throwIfAborted()
  await input.control.assertCanContinue()
  const checks = EVOLUTION_REQUIRED_CHECKS.skill.map((id) => ({ id,
    verdict: comparisons.every((row) => {
      const checks = row.sides[1].assessment.checks
      return new Set(checks.map((check) => check.id)).size === checks.length
        && checks.every((check) => check.verdict === 'PASS' && check.evidence.trim())
        && checks.some((check) => check.id === id && check.verdict === 'PASS' && check.evidence.trim())
    }) ? 'PASS' as const : 'FAIL' as const,
    evidence: `固定样本 ${comparisons.length} 个；逐样本结果保存在对比报告中`,
  }))
  const baselineScore = comparisons.reduce((sum, row) => sum + row.sides[0].assessment.score, 0) / comparisons.length
  const candidateScore = comparisons.reduce((sum, row) => sum + row.sides[1].assessment.score, 0) / comparisons.length
  const improvement = (candidateScore - baselineScore) * (metric.direction === 'higher' ? 1 : -1)
  checks.push({ id: 'improvement', verdict: improvement >= metric.minimumImprovement ? 'PASS' : 'FAIL',
    evidence: `${metric.name}: baseline=${baselineScore}, candidate=${candidateScore}, improvement=${improvement}, required=${metric.minimumImprovement}` })
  const evaluation: EvolutionEvaluationReport = { suiteVersion: input.suiteVersion, candidateHash,
    verdict: checks.every((check) => check.verdict === 'PASS') ? 'PASS' : 'FAIL', checks }
  const baselineVersion = await input.store.put(input.control.identity.runId, Buffer.from(JSON.stringify(baseline)), 'content')
  const candidateVersion = await input.store.put(input.control.identity.runId, Buffer.from(JSON.stringify(candidate)), 'content')
  artifacts.push(baselineVersion, candidateVersion)
  const report = await input.store.put(input.control.identity.runId,
    Buffer.from(JSON.stringify({ schemaVersion: 1, baselineHash, candidateHash, baselineVersion, candidateVersion, runtime, metric, comparisons, evaluation })), 'report')
  artifacts.push(report)
  const uniqueArtifacts = new Map<string, typeof artifacts[number]>()
  for (const artifact of artifacts) {
    const previous = uniqueArtifacts.get(artifact.storageKey)
    if (previous && (previous.sha256 !== artifact.sha256 || previous.bytes !== artifact.bytes)) {
      throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '同一技能产物存储键存在矛盾的内容摘要')
    }
    if (!previous) uniqueArtifacts.set(artifact.storageKey, artifact)
  }
  return { evaluation, artifacts: [...uniqueArtifacts.values()], baselineHash, candidateHash, eligibleForApproval: evaluationHasRequiredEvidence('skill', evaluation) }
}
