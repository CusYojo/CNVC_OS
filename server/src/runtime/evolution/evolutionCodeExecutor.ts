import type { MySqlAiEvolutionRepository } from '../../repositories/mysql/mysqlAiEvolutionRepository.js'
import type { MySqlAiEvolutionCandidateRepository } from '../../repositories/mysql/mysqlAiEvolutionCandidateRepository.js'
import type { AiEvolutionArtifactStore } from '../../services/aiEvolutionArtifactStore.js'
import { evaluationHasRequiredEvidence, type EvolutionCandidateManifest } from '../../contracts/aiEvolutionEvaluationContract.js'
import { evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { captureEvolutionSource, type EvolutionRepositoryRegistration, type EvolutionSourceSnapshot } from './evolutionSourceSnapshot.js'
import { developEvolutionCode, type EvolutionDeveloperDependencies } from './evolutionCodeDeveloper.js'
import { createEvolutionDurableModelBudget } from './evolutionDurableModelBudget.js'
import { createEvolutionCandidatePatch } from './evolutionCandidatePatch.js'
import type { ClaimedEvolutionRun, EvolutionExecutionControl, PreparedEvolutionResult } from './evolutionRunCoordinator.js'

type RunRepository = Pick<MySqlAiEvolutionRepository, 'transition' | 'saveCheckpoint' | 'reserveModelCall' | 'settleModelCall' | 'bindExecutionProfile'>
type Dependencies = {
  runs: RunRepository
  candidates: Pick<MySqlAiEvolutionCandidateRepository, 'completeRun'>
  artifacts: Pick<AiEvolutionArtifactStore, 'verifyManifest' | 'put'>
  /** Resolves server-controlled registry and rechecks current execution grants. */
  authorize: (run: ClaimedEvolutionRun) => Promise<EvolutionRepositoryRegistration>
  modelId: string
  executionProfileHash: string
  develop: EvolutionDeveloperDependencies['develop']
  evaluate: (snapshot: EvolutionSourceSnapshot, control: EvolutionExecutionControl, patchHash: string) => Promise<{
    evaluation: Awaited<ReturnType<EvolutionDeveloperDependencies['evaluate']>>
    manifest: EvolutionCandidateManifest
  }>
}

export function createEvolutionCodeExecutor(deps: Dependencies) {
  return async (run: ClaimedEvolutionRun, control: EvolutionExecutionControl): Promise<PreparedEvolutionResult> => {
    const spec = run.frozenSpec
    if (spec.kind !== 'code' || spec.target.type !== 'code') throw evolutionError(409, 'EVOLUTION_EXECUTOR_KIND', '执行器仅处理代码进化')
    await control.assertCanContinue()
    const registration = await deps.authorize(run)
    await deps.runs.bindExecutionProfile(control.identity, deps.executionProfileHash)
    const baseline = await captureEvolutionSource(registration, spec.target.baseCommit)
    await deps.runs.transition(control.identity, 'executing')
    let finalManifest: EvolutionCandidateManifest | undefined
    const remainingSpec = { ...spec, budget: { ...spec.budget, maxRepairRounds: Math.max(0, spec.budget.maxRepairRounds - run.repairRounds) } }
    const result = await developEvolutionCode(remainingSpec, baseline, registration, {
      modelId: deps.modelId, signal: control.signal, assertCanContinue: control.assertCanContinue,
      ...createEvolutionDurableModelBudget(deps.runs, control.identity, deps.modelId),
      develop: deps.develop,
      evaluate: async (candidate) => {
        const patch = createEvolutionCandidatePatch(baseline, candidate)
        const artifact = await deps.artifacts.put(run.id, patch.content, 'patch')
        if (artifact.sha256 !== patch.sha256) throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '差异产物与候选不一致')
        const checked = await deps.evaluate(candidate, control, patch.sha256)
        if (checked.manifest.sourceHash !== candidate.contentHash || checked.manifest.patchHash !== patch.sha256) throw evolutionError(409, 'EVOLUTION_EVALUATION_BINDING', '产物与候选源码或差异不一致')
        finalManifest = { ...checked.manifest, artifacts: [
          ...checked.manifest.artifacts.filter((item) => item.storageKey !== artifact.storageKey), artifact,
        ] }
        return checked.evaluation
      },
      checkpoint: async (value) => { await deps.runs.saveCheckpoint(control.identity, value, run.repairRounds + value.round) },
    })
    if (!finalManifest || !evaluationHasRequiredEvidence('code', result.evaluation)) throw evolutionError(409, 'EVOLUTION_EVALUATION_INCOMPLETE', '独立验收证据不完整')
    const manifest = finalManifest
    await deps.artifacts.verifyManifest(run.id, manifest)
    await deps.runs.transition(control.identity, 'evaluating')
    return { commit: async () => {
      await deps.authorize(run)
      await deps.artifacts.verifyManifest(run.id, manifest)
      await deps.candidates.completeRun(control.identity, { baseRef: baseline.baseCommit, summary: result.summary, manifest, evaluation: result.evaluation })
    } }
  }
}
