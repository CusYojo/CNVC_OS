import { z } from 'zod'
import type { MySqlAiEvolutionRepository } from '../../repositories/mysql/mysqlAiEvolutionRepository.js'
import type { MySqlAiEvolutionCandidateRepository } from '../../repositories/mysql/mysqlAiEvolutionCandidateRepository.js'
import type { AiEvolutionArtifactStore } from '../../services/aiEvolutionArtifactStore.js'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { evaluationHasRequiredEvidence, type EvolutionCandidateManifest } from '../../contracts/aiEvolutionEvaluationContract.js'
import type { ClaimedEvolutionRun, EvolutionExecutionControl, PreparedEvolutionResult } from './evolutionRunCoordinator.js'
import { createEvolutionDurableModelBudget } from './evolutionDurableModelBudget.js'
import { evaluateEvolutionSkill, type EvolutionSkillVersion } from './evolutionSkillEvaluation.js'

const responseSchema = z.object({ summary: z.string().trim().min(1).max(4000), instructions: z.string().trim().min(1).max(100_000),
  references: z.array(z.object({ name: z.string().trim().min(1).max(240), content: z.string().max(100_000) }).strict()).max(100) }).strict()
type Budget = ReturnType<typeof createEvolutionDurableModelBudget>
type Evaluation = Awaited<ReturnType<typeof evaluateEvolutionSkill>>

export function createEvolutionSkillExecutor(deps: {
  runs: Pick<MySqlAiEvolutionRepository, 'transition' | 'saveCheckpoint' | 'reserveModelCall' | 'settleModelCall' | 'bindExecutionProfile'>
  candidates: Pick<MySqlAiEvolutionCandidateRepository, 'completeRun'>
  artifacts: Pick<AiEvolutionArtifactStore, 'put' | 'verifyManifest'>
  modelId: string; executionProfileHash: string; environment: string
  authorize: (run: ClaimedEvolutionRun) => Promise<{ version: EvolutionSkillVersion; authorizationHash: string }>
  develop: (input: { skill: EvolutionSkillVersion; spec: ClaimedEvolutionRun['frozenSpec']; feedback: Evaluation['evaluation'] | null;
    signal: AbortSignal; maxOutputTokens: number }) => Promise<{ text: string; totalTokens: number | null }>
  /** Host evaluator freezes requested samples/runtime and meters all comparison model calls through this budget. */
  evaluate: (input: { ownerUserId: string; baseline: EvolutionSkillVersion; candidate: EvolutionSkillVersion; sampleIds: string[];
    control: EvolutionExecutionControl; budget: Budget }) => Promise<Evaluation>
}) {
  return async (run: ClaimedEvolutionRun, control: EvolutionExecutionControl): Promise<PreparedEvolutionResult> => {
    const spec = structuredClone(run.frozenSpec)
    if (spec.kind !== 'skill' || spec.target.type !== 'skill') throw evolutionError(409, 'EVOLUTION_EXECUTOR_KIND', '执行器仅处理技能进化')
    const target = spec.target
    await control.assertCanContinue()
    const authorized = structuredClone(await deps.authorize(run))
    if (!/^[a-f0-9]{64}$/.test(authorized.authorizationHash)) throw evolutionError(409, 'EVOLUTION_AUTHORIZATION_CHANGED', '技能执行授权缺少有效版本摘要')
    const baseline = authorized.version
    const baseHash = evolutionContentHash(baseline)
    if (baseline.capabilityId !== target.capabilityId || baseHash !== target.baseContentHash) throw evolutionError(409, 'EVOLUTION_DEVELOPER_BASELINE', '技能基线与提案不一致')
    const originalControl = control
    control = { ...originalControl, assertCanContinue: async () => {
      await originalControl.assertCanContinue()
      const current = await deps.authorize(run)
      if (current.authorizationHash !== authorized.authorizationHash) throw evolutionError(403, 'EVOLUTION_AUTHORIZATION_CHANGED', '技能执行授权已变化，请重新确认任务')
      if (evolutionContentHash(current.version) !== baseHash) throw evolutionError(409, 'EVOLUTION_DEVELOPER_BASELINE', '技能执行基线已变化')
      await originalControl.assertCanContinue()
    } }
    await deps.runs.bindExecutionProfile(control.identity, evolutionContentHash({ executionProfileHash: deps.executionProfileHash,
      authorizationHash: authorized.authorizationHash, baselineHash: baseHash }))
    await control.assertCanContinue()
    await deps.runs.transition(control.identity, 'executing')
    const durableBudget = createEvolutionDurableModelBudget(deps.runs, control.identity, deps.modelId)
    const budget: Budget = { recordModelUsage: durableBudget.recordModelUsage,
      reserveModelTokens: async amount => { await control.assertCanContinue(); await durableBudget.reserveModelTokens(amount) } }
    let candidate = baseline, feedback: Evaluation['evaluation'] | null = null
    for (let round = 0; round <= Math.max(0, spec.budget.maxRepairRounds - run.repairRounds); round++) {
      await control.assertCanContinue()
      const maxOutputTokens = Math.min(16000, Math.floor(spec.budget.maxModelTokens / 2))
      const reserved = Buffer.byteLength(JSON.stringify({ candidate, spec, feedback }), 'utf8') + maxOutputTokens + 4096
      await budget.reserveModelTokens(reserved)
      const response = await deps.develop({ skill: structuredClone(candidate), spec: structuredClone(spec), feedback: structuredClone(feedback), signal: control.signal, maxOutputTokens })
      await budget.recordModelUsage(response.totalTokens, reserved)
      await control.assertCanContinue()
      const generated = responseSchema.parse(JSON.parse(response.text))
      if (new Set(generated.references.map(item => item.name)).size !== generated.references.length) throw evolutionError(409, 'EVOLUTION_SKILL_REFERENCES', '技能参考资料名称重复')
      const next = { ...baseline, instructions: generated.instructions, references: generated.references }
      if (evolutionContentHash(next) === evolutionContentHash(candidate)) throw evolutionError(409, 'EVOLUTION_NO_CHANGE', '技能候选没有有效变化')
      candidate = next
      const evaluated = await deps.evaluate({ ownerUserId: run.ownerUserId, baseline: structuredClone(baseline), candidate: structuredClone(candidate),
        sampleIds: [...target.sampleIds], control, budget })
      if (evaluated.baselineHash !== baseHash || evaluated.candidateHash !== evolutionContentHash(candidate)
        || evaluated.evaluation.candidateHash !== evaluated.candidateHash) throw evolutionError(409, 'EVOLUTION_EVALUATION_BINDING', '技能评估未绑定当前版本')
      await deps.runs.saveCheckpoint(control.identity, { schemaVersion: 1, kind: 'skill', round,
        baselineHash: evaluated.baselineHash, candidateHash: evaluated.candidateHash,
        summary: generated.summary, evaluation: evaluated.evaluation, artifacts: evaluated.artifacts }, run.repairRounds + round)
      if (evaluated.eligibleForApproval && evaluationHasRequiredEvidence('skill', evaluated.evaluation)
        && evaluated.evaluation.checks.some(check => check.id === 'improvement' && check.verdict === 'PASS')) {
        const patch = await deps.artifacts.put(run.id, Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'skill', baseHash,
          candidateHash: evaluated.candidateHash, baseline, candidate })), 'patch')
        const manifest: EvolutionCandidateManifest = { schemaVersion: 1, sourceHash: evaluated.candidateHash, patchHash: patch.sha256,
          dependencyLockHash: evolutionContentHash(baseline.dependencies), environment: deps.environment, artifacts: [...evaluated.artifacts, patch] }
        await deps.artifacts.verifyManifest(run.id, manifest)
        await deps.runs.transition(control.identity, 'evaluating')
        return { commit: async () => {
          await control.assertCanContinue()
          await deps.artifacts.verifyManifest(run.id, manifest)
          await deps.candidates.completeRun(control.identity, { baseRef: baseHash, summary: generated.summary, manifest, evaluation: evaluated.evaluation })
        } }
      }
      if (evaluated.evaluation.verdict !== 'FAIL') throw evolutionError(409, 'EVOLUTION_EVALUATION_INCOMPLETE', '技能验收证据不完整')
      feedback = evaluated.evaluation
    }
    throw evolutionError(409, 'EVOLUTION_REPAIR_BUDGET_EXHAUSTED', '技能修复轮次已用完，保留对比证据')
  }
}
