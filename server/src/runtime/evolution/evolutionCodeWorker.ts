import { createEvolutionCodeExecutor } from './evolutionCodeExecutor.js'
import { EvolutionRunCoordinator } from './evolutionRunCoordinator.js'
import { EvolutionWorkerLifecycle } from './evolutionWorkerLifecycle.js'
import type { AiEvolutionExecutorRegistry } from '../../services/aiEvolutionExecutorRegistry.js'
import type { DockerEvolutionEnvironment } from './dockerEvolutionEnvironment.js'

/** Compose the durable execution path. Only the host may supply model, registry and evaluation dependencies. */
export function createEvolutionCodeWorker(input: {
  workerId: string
  executor: Parameters<typeof createEvolutionCodeExecutor>[0]
  runs: ConstructorParameters<typeof EvolutionRunCoordinator>[0]
  environment: Pick<DockerEvolutionEnvironment, 'available' | 'terminate'>
  registry: AiEvolutionExecutorRegistry
  onError: (error: unknown) => void
}) {
  const coordinator = new EvolutionRunCoordinator(input.runs, input.workerId, createEvolutionCodeExecutor(input.executor),
    (identity) => input.environment.terminate(identity), 'code')
  const lifecycle = new EvolutionWorkerLifecycle(coordinator, () => input.environment.available(), input.onError)
  let unregister: (() => void) | undefined
  let stopped = false
  return {
    async start() {
      await lifecycle.start()
      try {
        if (stopped) throw Error('Evolution worker stopped during registration')
        unregister = input.registry.register(lifecycle)
      }
      catch (error) { await lifecycle.stop(); throw error }
    },
    async stop() {
      stopped = true
      unregister?.()
      unregister = undefined
      await lifecycle.stop()
    },
    available: () => lifecycle.available(),
  }
}
