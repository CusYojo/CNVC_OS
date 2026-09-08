import { readEvolutionReevaluationBase } from './aiEvolutionReevaluationBase.js'
import { z } from 'zod'
import { aiEvolutionService, getAiEvolutionCandidateForUser } from './aiEvolutionApplicationService.js'
import { aiEvolutionReleaseRegistry } from './aiEvolutionReleaseRegistry.js'
import { aiEvolutionRepositoryRegistry } from './aiEvolutionRepositoryRegistry.js'
import { evolutionError } from './aiEvolutionPolicyService.js'
import { createEvolutionReevaluationSpec } from './aiEvolutionReevaluationSpec.js'

const targetInput = z.object({ targetEnvironment: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) }).strict()
async function current(userId: string, candidateId: string, environment: string) {
  const candidate = await getAiEvolutionCandidateForUser(userId, candidateId)
  const run = await aiEvolutionService.authorizeRun(userId, candidate.runId)
  if (run.frozenSpec.target.type !== 'code') throw evolutionError(409, 'EVOLUTION_RELEASE_KIND', '重新基线评估仅适用于代码进化')
  const repositoryId = run.frozenSpec.target.repositoryId
  const target = await aiEvolutionReleaseRegistry.resolve(userId, repositoryId, environment)
  const repository = await aiEvolutionRepositoryRegistry.resolve(userId, repositoryId)
  const baseCommit = await readEvolutionReevaluationBase(target, repository.root)
  const latestTarget = await aiEvolutionReleaseRegistry.resolve(userId, repositoryId, environment)
  const latestRepository = await aiEvolutionRepositoryRegistry.resolve(userId, repositoryId)
  if (latestTarget.root !== target.root || latestTarget.baseRef !== target.baseRef || latestRepository.root !== repository.root) {
    throw evolutionError(409, 'EVOLUTION_REEVALUATION_CHANGED', '仓库或目标配置已变化，请重新查看方案')
  }
  await aiEvolutionService.authorizeRun(userId, candidate.runId)
  return { candidate, run, baseCommit }
}

export async function planAiEvolutionReevaluation(userId: string, candidateId: string, input: unknown) {
  const request = targetInput.parse(input)
  const state = await current(userId, candidateId, request.targetEnvironment)
  return { candidateId, candidateHash: state.candidate.contentHash, oldBaseCommit: state.candidate.baseRef,
    baseCommit: state.baseCommit, targetEnvironment: request.targetEnvironment, required: state.candidate.baseRef !== state.baseCommit }
}

export async function createAiEvolutionReevaluation(userId: string, candidateId: string, input: unknown, key: unknown) {
  const request = targetInput.extend({ candidateHash: z.string().regex(/^[a-f0-9]{64}$/), baseCommit: z.string().regex(/^[a-f0-9]{40}$/) }).parse(input)
  const state = await current(userId, candidateId, request.targetEnvironment)
  if (state.candidate.contentHash !== request.candidateHash || state.baseCommit !== request.baseCommit) {
    throw evolutionError(409, 'EVOLUTION_REEVALUATION_CHANGED', '候选或目标基线已变化，请重新查看方案')
  }
  const spec = createEvolutionReevaluationSpec(state.run.frozenSpec, state.baseCommit)
  // This creates a proposal only. The ordinary execution path will run all fixed gates again.
  const proposal = await aiEvolutionService.create(userId, { spec }, key)
  return { proposal, sourceCandidateId: candidateId, requiresExecution: true }
}
