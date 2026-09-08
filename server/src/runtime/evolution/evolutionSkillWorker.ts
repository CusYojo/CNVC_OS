import { createEvolutionSkillExecutor } from './evolutionSkillExecutor.js'
import { EvolutionRunCoordinator } from './evolutionRunCoordinator.js'
import { EvolutionWorkerLifecycle } from './evolutionWorkerLifecycle.js'
import type { AiEvolutionExecutorRegistry } from '../../services/aiEvolutionExecutorRegistry.js'

/** Host supplies isolated generation cleanup; this worker cannot claim or recover code runs. */
export function createEvolutionSkillWorker(input: {
  workerId: string; executor: Parameters<typeof createEvolutionSkillExecutor>[0]
  runs: ConstructorParameters<typeof EvolutionRunCoordinator>[0]
  available: () => Promise<boolean>
  terminate: ConstructorParameters<typeof EvolutionRunCoordinator>[3]
  registry: AiEvolutionExecutorRegistry; onError: (error: unknown) => void
}) {
  const coordinator = new EvolutionRunCoordinator(input.runs, input.workerId, createEvolutionSkillExecutor(input.executor), input.terminate, 'skill')
  const lifecycle = new EvolutionWorkerLifecycle(coordinator, input.available, input.onError)
  let unregister: (() => void) | undefined
  let stopped = false
  return {
    async start() {
      await lifecycle.start()
      try {
        if (stopped) throw Error('Skill worker stopped during registration')
        unregister = input.registry.register(lifecycle, 'skill')
      } catch (error) { await lifecycle.stop(); throw error }
    },
    async stop() { stopped = true; unregister?.(); unregister = undefined; await lifecycle.stop() },
    available: () => lifecycle.available(),
  }
}
