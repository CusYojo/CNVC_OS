import { randomUUID } from 'node:crypto'
import { parseEvolutionSkillHostConfig } from '../runtime/evolution/evolutionSkillHostConfig.js'
import { readEvolutionSkillSampleSuiteFile } from '../runtime/evolution/evolutionSkillSampleSuite.js'
import { loadEvolutionDueDiligenceSampleSuite } from '../runtime/evolution/evolutionDueDiligenceSample.js'
import { captureEvolutionSkill } from '../runtime/evolution/evolutionSkillSnapshot.js'
import { createEvolutionDueDiligenceEvaluator } from '../runtime/evolution/evolutionDueDiligenceEvaluator.js'
import { createEvolutionSkillModelDeveloper } from '../runtime/evolution/evolutionSkillModelGateway.js'
import { createEvolutionSkillWorker } from '../runtime/evolution/evolutionSkillWorker.js'
import { DockerEvolutionEnvironment } from '../runtime/evolution/dockerEvolutionEnvironment.js'
import { MySqlAiEvolutionRepository } from '../repositories/mysql/mysqlAiEvolutionRepository.js'
import { MySqlAiEvolutionCandidateRepository } from '../repositories/mysql/mysqlAiEvolutionCandidateRepository.js'
import { aiConfigurationRepository, identityRepositories } from '../repositories/index.js'
import { aiEvolutionArtifactStore, authorizeAiEvolutionSkillRun } from './aiEvolutionApplicationService.js'
import { aiEvolutionExecutorRegistry } from './aiEvolutionExecutorRegistry.js'
import { getAiSkillDirectory, getAiSkillRoot } from './aiSkillService.js'
import { resolveAiModelById } from './aiModelSettingsService.js'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'

let active: { stop(): Promise<void> } | undefined
let starting: Promise<void> | undefined
let stopping = false

export function startAiEvolutionSkillHost() {
  if (stopping) return Promise.reject(Error('Skill evolution host is shutting down'))
  if (starting) return starting
  starting = initialize().finally(() => { starting = undefined })
  return starting
}

async function initialize() {
  const file = process.env.AI_EVOLUTION_SKILL_EXECUTOR_FILE?.trim()
  if (process.env.AI_EVOLUTION_ENABLED !== 'true' || !file) return
  if (active) throw Error('Skill evolution host already started')
  const config = parseEvolutionSkillHostConfig(await readEvolutionSkillSampleSuiteFile(file))
  const capability = await aiConfigurationRepository.findCapability(config.capabilityId)
  if (!capability || !capability.enabled || capability.kind !== 'skill'
    || capability.capabilityKey !== 'draft-due-diligence-report') throw Error('Unsupported skill evolution host capability')
  const route = await resolveAiModelById(config.modelId)
  if (!route) throw Error('Skill evolution model unavailable')
  const samples = await loadEvolutionDueDiligenceSampleSuite(config.sampleSuiteFile)
  const snapshot = await captureEvolutionSkill({ capabilityId: capability.id, capabilityKey: capability.capabilityKey,
    directory: getAiSkillDirectory(capability.capabilityKey), allowedRoot: getAiSkillRoot(),
    toolNames: capability.toolNames, dependencyNames: capability.dependencyNames, config: capability.config })
  const environment = new DockerEvolutionEnvironment(undefined, config.image)
  const evaluator = await createEvolutionDueDiligenceEvaluator({ route, image: config.image, maxOutputTokens: config.maxOutputTokens,
    samples, snapshot, environment, store: aiEvolutionArtifactStore, metric: config.metric })
  const developer = createEvolutionSkillModelDeveloper(route)
  const runs = new MySqlAiEvolutionRepository()
  const worker = createEvolutionSkillWorker({ workerId: `evolution-skill-${randomUUID()}`, runs,
    available: () => environment.available(), terminate: evaluator.terminate, registry: aiEvolutionExecutorRegistry,
    onError: () => console.error('[ai-evolution-skill] worker unavailable; recovery will retry'),
    executor: { runs, candidates: new MySqlAiEvolutionCandidateRepository(), artifacts: aiEvolutionArtifactStore,
      modelId: route.modelId, environment: config.image,
      executionProfileHash: evolutionContentHash({ evaluator: evaluator.profileHash, developer: developer.profileHash }),
      develop: developer.develop, evaluate: evaluator.evaluate,
      authorize: async run => {
        const baseline = await authorizeAiEvolutionSkillRun(run)
        const currentConfig = parseEvolutionSkillHostConfig(await readEvolutionSkillSampleSuiteFile(file))
        const currentSamples = await loadEvolutionDueDiligenceSampleSuite(config.sampleSuiteFile)
        if (evolutionContentHash(currentConfig) !== evolutionContentHash(config) || currentSamples.profileHash !== samples.profileHash) {
          throw evolutionError(409, 'EVOLUTION_AUTHORIZATION_CHANGED', '技能宿主配置或样本授权已变化，请重新冻结执行配置')
        }
        const actor = await identityRepositories.users.findById(run.ownerUserId)
        const current = actor && await resolveAiModelById(route.modelId, actor.role)
        if (!current || current.model !== route.model || current.providerId !== route.providerId || current.baseUrl !== route.baseUrl
          || current.apiKey !== route.apiKey) throw evolutionError(403, 'EVOLUTION_MODEL_UNAVAILABLE', '技能评测模型授权或配置已变化')
        if (baseline.contentHash !== snapshot.contentHash || baseline.packageHash !== snapshot.packageHash) {
          throw evolutionError(409, 'EVOLUTION_DEVELOPER_BASELINE', '技能宿主基线已变化，需要重新配置')
        }
        if (run.frozenSpec.target.type !== 'skill') throw Error('Invalid skill target')
        samples.select({ userId: run.ownerUserId, capabilityId: baseline.version.capabilityId, sampleIds: run.frozenSpec.target.sampleIds })
        return baseline
      } } })
  await worker.start()
  if (stopping) { await worker.stop(); return }
  active = worker
}

export async function stopAiEvolutionSkillHost() {
  stopping = true
  await starting?.catch(() => {})
  const host = active; active = undefined
  await host?.stop()
}
