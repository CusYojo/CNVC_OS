import type { MySqlAiExperienceRepository } from '../repositories/mysql/mysqlAiExperienceRepository.js'
import type { EvolutionModelRoute } from '../runtime/evolution/evolutionModelGateway.js'
import { AiExperienceApplicationService } from './aiExperienceApplicationService.js'
import { createAiExperienceCheckBudget } from './aiExperienceCheckBudget.js'
import { aiExperienceCheckerVersion, createAiExperienceModelChecker } from './aiExperienceModelChecker.js'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'
import { experienceOutputCheckSchema } from './aiExperienceOutputCheck.js'

/** Internal completion entry: caller must authorize the original task, project, frozen sources and model. */
export async function completeAiExperienceCheck(input: {
  repository: MySqlAiExperienceRepository; userId: string; taskId: string; output: string
  route: EvolutionModelRoute; maxTokens: number; assertAuthorized: () => Promise<void>
  signal?: AbortSignal; fetchImpl?: typeof fetch
}) {
  input.signal?.throwIfAborted()
  await input.assertAuthorized()
  const application = await input.repository.findApplication(input.userId, input.taskId)
  if (!application) throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '任务没有经验应用记录')
  const outputHash = evolutionContentHash({ output: input.output })
  const checkerVersion = aiExperienceCheckerVersion(input.route)
  if (application.checkResult) {
    const previous = experienceOutputCheckSchema.parse(application.checkResult)
    if (previous.outputHash !== outputHash || previous.checkerVersion !== checkerVersion || previous.snapshotHash !== application.snapshotHash) {
      throw evolutionError(409, 'EVOLUTION_OUTPUT_CHECK_CONFLICT', '完成回调与已有检查不一致')
    }
    return application
  }
  const budget = createAiExperienceCheckBudget(input.repository, input.userId, input.taskId,
    { snapshotHash: application.snapshotHash, outputHash, checkerVersion, maxTokens: input.maxTokens })
  const checker = createAiExperienceModelChecker(input.route, budget, input.fetchImpl)
  const service = new AiExperienceApplicationService(input.repository, async () => { throw Error('Completion must use the existing frozen snapshot') })
  return service.checkOutput({ userId: input.userId, taskId: input.taskId, taskType: application.taskType,
    conversationId: application.conversationId ?? undefined, businessProjectId: application.businessProjectId ?? undefined },
    { ...checker, output: input.output, signal: input.signal, assertAuthorized: input.assertAuthorized })
}
