import { createEvolutionDueDiligenceGenerator } from './evolutionDueDiligenceGenerator.js'
import { createEvolutionSkillPageReviewer } from './evolutionSkillPageReviewer.js'
import { createEvolutionDueDiligenceAssessment } from './evolutionDueDiligenceAssessment.js'
import { compareEvolutionDueDiligence } from './evolutionDueDiligenceComparison.js'
import { prepareEvolutionDueDiligenceRenderer } from './evolutionDueDiligenceRenderer.js'
import type { createEvolutionSkillExecutor } from './evolutionSkillExecutor.js'
import type { freezeEvolutionSkillSampleSuite } from './evolutionSkillSampleSuite.js'
import type { EvolutionModelRoute } from './evolutionModelGateway.js'
import type { DockerEvolutionEnvironment } from './dockerEvolutionEnvironment.js'
import type { EvolutionLeaseIdentity } from '../../services/aiEvolutionPolicyService.js'
import { evolutionContentHash, evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { saveEvolutionSkillPackage } from './evolutionSkillPackage.js'

type Sample = Parameters<ReturnType<typeof createEvolutionDueDiligenceGenerator>['generate']>[0]['sample']
type Renderer = Awaited<ReturnType<typeof prepareEvolutionDueDiligenceRenderer>>
type ExecutorInput = Parameters<typeof createEvolutionSkillExecutor>[0]

/** One host-owned evaluator per immutable configuration. Coordinator must use terminate after each attempt. */
export async function createEvolutionDueDiligenceEvaluator(input: {
  route: EvolutionModelRoute; image: string; maxOutputTokens: number;
  samples: ReturnType<typeof freezeEvolutionSkillSampleSuite<Sample>>;
  snapshot: Parameters<typeof prepareEvolutionDueDiligenceRenderer>[0]['skillSnapshot'];
  environment: Parameters<typeof prepareEvolutionDueDiligenceRenderer>[0]['environment'] & Pick<DockerEvolutionEnvironment, 'terminate'>;
  store: Parameters<typeof compareEvolutionDueDiligence>[0]['store'];
  metric: Parameters<typeof compareEvolutionDueDiligence>[0]['metric'];
  fetchImpl?: typeof fetch;
}) {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.image) || !Number.isInteger(input.maxOutputTokens)
    || input.maxOutputTokens < 1 || input.maxOutputTokens > 32000) throw Error('Invalid fixed due diligence evaluator configuration')
  const snapshot = structuredClone(input.snapshot), metric = structuredClone(input.metric), route = Object.freeze({ ...input.route })
  const { maxOutputTokens, environment, samples, store } = input
  const scriptHash = createHash('sha256').update(await readFile(path.resolve('server/scripts/render-evolution-due-diligence.mjs'))).digest('hex')
  const rendererHash = evolutionContentHash({ scriptHash, packageHash: snapshot.packageHash })
  const generator = createEvolutionDueDiligenceGenerator(route, input.fetchImpl)
  const reviewer = createEvolutionSkillPageReviewer(route, input.fetchImpl)
  const profileHash = evolutionContentHash({ version: 1, image: input.image, packageHash: snapshot.packageHash,
    baselineHash: snapshot.contentHash, generator: generator.profileHash, reviewer: reviewer.profileHash,
    samples: samples.profileHash, rendererHash, metric, maxOutputTokens })
  const prepared = new Map<string, Promise<Renderer>>()
  const key = (identity: EvolutionLeaseIdentity) => evolutionContentHash(identity)
  const evaluate: ExecutorInput['evaluate'] = async args => {
    await args.control.assertCanContinue()
    if (evolutionContentHash(args.baseline) !== snapshot.contentHash) {
      throw evolutionError(409, 'EVOLUTION_DEVELOPER_BASELINE', '技能评测渲染包与任务基线不一致')
    }
    const selected = samples.select({ userId: args.ownerUserId, capabilityId: args.baseline.capabilityId, sampleIds: args.sampleIds })
    const assessment = createEvolutionDueDiligenceAssessment(selected.assessment, reviewer.review)
    const identityKey = key(args.control.identity)
    if (!prepared.has(identityKey)) prepared.set(identityKey, prepareEvolutionDueDiligenceRenderer({ environment,
      control: args.control, skillSnapshot: snapshot }))
    const renderer = await prepared.get(identityKey)!
    if (renderer.rendererHash !== rendererHash) throw evolutionError(409, 'EVOLUTION_EVALUATION_BINDING', '固定渲染脚本已变化，必须重新冻结执行配置')
    await args.control.assertCanContinue()
    const result = await compareEvolutionDueDiligence({ ...args, samples: selected.samples, generator, renderer, store,
      metric, suiteVersion: `${selected.suiteId}:${profileHash}`, modelId: route.modelId, modelVersion: route.model,
      maxOutputTokens, assess: assessment.assess })
    for (const version of [args.baseline, args.candidate]) {
      await args.control.assertCanContinue()
      const saved = await saveEvolutionSkillPackage({ runId: args.control.identity.runId, snapshot, version }, store)
      if (!result.artifacts.some(artifact => artifact.storageKey === saved.artifact.storageKey)) result.artifacts.push(saved.artifact)
    }
    return result
  }
  return { profileHash, evaluate,
    terminate: async (identity: EvolutionLeaseIdentity) => {
      // Wait for a late preparation before teardown so startup cannot leave a new container after cleanup.
      await prepared.get(key(identity))?.catch(() => {})
      await environment.terminate(identity)
      prepared.delete(key(identity))
    } }
}
