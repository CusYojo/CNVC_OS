import { recoverEvolutionRelease, type EvolutionReleaseReceipt } from './evolutionReleaseCoordinator.js'
import type { EvolutionReleaseLockControl } from '../../services/aiEvolutionReleaseLock.js'
import { evolutionError } from '../../services/aiEvolutionPolicyService.js'

export type EvolutionRecoveryAdapter = {
  inspect: (receipt: EvolutionReleaseReceipt, signal: AbortSignal) => Promise<'candidate' | 'previous' | 'unknown'>;
  health: (receipt: EvolutionReleaseReceipt, version: 'candidate' | 'previous', signal: AbortSignal) => Promise<boolean>;
  rollback: (receipt: EvolutionReleaseReceipt, signal: AbortSignal) => Promise<void>;
}

/** Called under the target lock with a receipt read from the authoritative claim event. */
export async function runEvolutionReleaseRecovery(input: {
  claim: { status: string; receipt: EvolutionReleaseReceipt };
  control: EvolutionReleaseLockControl;
  authorize: () => Promise<void>;
  adapter: EvolutionRecoveryAdapter;
  finish: (receipt: EvolutionReleaseReceipt, outcome: 'active' | 'failed' | 'rolled_back') => Promise<void>;
}) {
  const guard = async () => { await input.control.assertHeld(); await input.authorize(); await input.control.assertHeld() }
  await guard()
  if (['active', 'failed', 'rolled_back'].includes(input.claim.status)) {
    return { outcome: input.claim.status as 'active' | 'failed' | 'rolled_back', receipt: input.claim.receipt, duplicate: true }
  }
  if (input.claim.status !== 'activating') throw evolutionError(409, 'EVOLUTION_RELEASE_STATE', '没有待恢复的发布')
  const guarded = async <T>(operation: () => Promise<T>) => {
    await guard()
    const result = await operation()
    await guard()
    return result
  }
  const result = await recoverEvolutionRelease({
    receipt: input.claim.receipt, authorize: guard,
    inspect: receipt => guarded(() => input.adapter.inspect(receipt, input.control.signal)),
    health: (receipt, version) => guarded(() => input.adapter.health(receipt, version, input.control.signal)),
    rollback: receipt => guarded(() => input.adapter.rollback(receipt, input.control.signal)),
    finish: async (receipt, outcome) => { await guard(); await input.finish(receipt, outcome) },
  })
  return { ...result, duplicate: false }
}
