import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { parseEvolutionHostConfig } from '../runtime/evolution/evolutionHostConfig.js'
import { DockerEvolutionEnvironment } from '../runtime/evolution/dockerEvolutionEnvironment.js'
import { createEvolutionCodeWorker } from '../runtime/evolution/evolutionCodeWorker.js'
import { createEvolutionCodeEvaluator } from '../runtime/evolution/evolutionCodeEvaluator.js'
import { createEvolutionModelDeveloper } from '../runtime/evolution/evolutionModelGateway.js'
import { runEvolutionLeadPageGate } from '../runtime/evolution/evolutionLeadPageScenario.js'
import type { EvolutionBrowser } from '../runtime/evolution/evolutionBrowserGate.js'
import { MySqlAiEvolutionRepository } from '../repositories/mysql/mysqlAiEvolutionRepository.js'
import { MySqlAiEvolutionCandidateRepository } from '../repositories/mysql/mysqlAiEvolutionCandidateRepository.js'
import { identityRepositories } from '../repositories/index.js'
import { resolveAiModelById } from './aiModelSettingsService.js'
import { aiEvolutionArtifactStore, authorizeAiEvolutionCodeRun } from './aiEvolutionApplicationService.js'
import { aiEvolutionExecutorRegistry } from './aiEvolutionExecutorRegistry.js'
import { evolutionContentHash, evolutionError } from './aiEvolutionPolicyService.js'

let active: { stop(): Promise<void> } | undefined
let starting: Promise<void> | undefined
let stopping = false

export function startAiEvolutionHost() {
  if (stopping) return Promise.reject(new Error('Evolution host is shutting down'))
  if (starting) return starting
  starting = initializeAiEvolutionHost().finally(() => { starting = undefined })
  return starting
}

async function initializeAiEvolutionHost() {
  if (process.env.AI_EVOLUTION_ENABLED !== 'true') return
  const file = process.env.AI_EVOLUTION_EXECUTOR_FILE?.trim()
  // Experience-only installations do not require a code worker.
  if (!file) return
  if (active) throw Error('Evolution host already started')
  if (!path.isAbsolute(file)) throw Error('Evolution executor configuration must use an absolute path')
  const bytes = await readFile(file)
  if (bytes.length > 32 * 1024) throw Error('Evolution executor configuration too large')
  const config = parseEvolutionHostConfig(JSON.parse(bytes.toString('utf8')))
  const route = await resolveAiModelById(config.modelId)
  if (!route) throw Error('Evolution development model unavailable')
  const environment = new DockerEvolutionEnvironment(undefined, config.image)
  if (!await environment.available()) throw Error('Evolution Docker environment unavailable')
  const require = createRequire(import.meta.url)
  const runtime = require(config.browserModulePath) as { chromium: { launch(options: { channel: string; headless: true }): Promise<EvolutionBrowser & { close(): Promise<void> }> } }
  const browser = await runtime.chromium.launch({ channel: config.browserChannel, headless: true })
  try {
    const runs = new MySqlAiEvolutionRepository()
    const evaluate = createEvolutionCodeEvaluator({ environment, environmentId: config.image, store: aiEvolutionArtifactStore,
      scriptsRoot: path.resolve('server/scripts'), suiteVersion: config.suiteVersion, functionalGate: config.functionalGate,
      pageGate: ({ files, control }) => runEvolutionLeadPageGate({ browser, files, control, store: aiEvolutionArtifactStore }) })
    const worker = createEvolutionCodeWorker({ workerId: `evolution-${randomUUID()}`, runs, environment, registry: aiEvolutionExecutorRegistry,
      // Never log provider credentials, model output or raw subprocess errors.
      onError: () => console.error('[ai-evolution] worker unavailable; recovery will retry'),
      executor: { runs, candidates: new MySqlAiEvolutionCandidateRepository(), artifacts: aiEvolutionArtifactStore,
        executionProfileHash: evolutionContentHash({ modelId: route.modelId, model: route.model, providerId: route.providerId,
          baseUrl: route.baseUrl, image: config.image, suiteVersion: config.suiteVersion, functionalGate: config.functionalGate,
          browserChannel: config.browserChannel, developerPromptVersion: 1 }),
        modelId: route.modelId, develop: createEvolutionModelDeveloper(route), evaluate,
        authorize: async (run) => {
          const registration = await authorizeAiEvolutionCodeRun(run)
          const actor = await identityRepositories.users.findById(run.ownerUserId)
          const current = actor && await resolveAiModelById(route.modelId, actor.role)
          if (!current || current.providerId !== route.providerId || current.model !== route.model || current.baseUrl !== route.baseUrl
            || current.apiKey !== route.apiKey) throw evolutionError(403, 'EVOLUTION_MODEL_UNAVAILABLE', '任务模型授权或配置已变化，请重新确认执行配置')
          return registration
        },
      } })
    await worker.start()
    active = { stop: async () => { try { await worker.stop() } finally { await browser.close() } } }
  } catch (error) { await browser.close(); throw error }
}

export async function stopAiEvolutionHost() {
  stopping = true
  // Startup may still be opening the browser; wait so shutdown cannot leak a late-created worker.
  await starting?.catch(() => {})
  const host = active
  active = undefined
  await host?.stop()
}
