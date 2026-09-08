import { evolutionError } from '../../services/aiEvolutionPolicyService.js'
import { parseEvolutionReleaseReceipt, type EvolutionReleaseReceipt } from './evolutionReleaseCoordinator.js'

/** Executes a user-approved rollback only while the exact candidate is still active. */
export async function coordinateRequestedEvolutionRollback(input: {
  receipt: EvolutionReleaseReceipt
  authorize: () => Promise<void>
  claim: (receipt: EvolutionReleaseReceipt) => Promise<void>
  inspect: (receipt: EvolutionReleaseReceipt) => Promise<'candidate' | 'previous' | 'unknown'>
  rollback: (receipt: EvolutionReleaseReceipt) => Promise<void>
  health: (receipt: EvolutionReleaseReceipt, version: 'previous') => Promise<boolean>
  finish: (receipt: EvolutionReleaseReceipt, outcome: 'rolled_back') => Promise<void>
}) {
  const receipt = Object.freeze(parseEvolutionReleaseReceipt(input.receipt))
  if (!receipt.previousReleaseId || !receipt.previousIdentity) {
    throw evolutionError(409, 'EVOLUTION_ROLLBACK_UNAVAILABLE', '该发布没有可验证的上一版本')
  }
  await input.authorize()
  if (await input.inspect(receipt) !== 'candidate') {
    throw evolutionError(409, 'EVOLUTION_ROLLBACK_STATE', '当前运行版本已变化，不能使用此回退批准')
  }
  await input.claim(receipt)
  await input.authorize()
  if (await input.inspect(receipt) !== 'candidate') {
    throw evolutionError(409, 'EVOLUTION_ROLLBACK_STATE', '取得回退执行权后运行版本发生变化')
  }
  await input.rollback(receipt)
  if (await input.inspect(receipt) !== 'previous' || !await input.health(receipt, 'previous')
    || await input.inspect(receipt) !== 'previous') {
    throw evolutionError(503, 'EVOLUTION_ROLLBACK_RECOVERY_REQUIRED', '回退后的版本身份或健康状态尚未确认')
  }
  await input.finish(receipt, 'rolled_back')
  return { outcome: 'rolled_back' as const, receipt }
}

/** Reconciles an already-consumed rollback approval after publisher interruption. */
export async function recoverRequestedEvolutionRollback(input: {
  receipt: EvolutionReleaseReceipt
  authorize: () => Promise<void>
  inspect: (receipt: EvolutionReleaseReceipt) => Promise<'candidate' | 'previous' | 'unknown'>
  rollback: (receipt: EvolutionReleaseReceipt) => Promise<void>
  health: (receipt: EvolutionReleaseReceipt, version: 'previous') => Promise<boolean>
  finish: (receipt: EvolutionReleaseReceipt, outcome: 'rolled_back') => Promise<void>
}) {
  const receipt = Object.freeze(parseEvolutionReleaseReceipt(input.receipt))
  if (!receipt.previousReleaseId || !receipt.previousIdentity) throw evolutionError(409, 'EVOLUTION_ROLLBACK_UNAVAILABLE', '回退记录没有可验证的上一版本')
  const uncertain = () => evolutionError(503, 'EVOLUTION_ROLLBACK_RECOVERY_REQUIRED', '回退恢复尚未确认实际版本及健康状态')
  await input.authorize()
  let state: 'candidate' | 'previous' | 'unknown'
  try { state = await input.inspect(receipt) } catch { throw uncertain() }
  if (state === 'unknown') throw uncertain()
  if (state === 'candidate') {
    await input.authorize()
    if (await input.inspect(receipt) !== 'candidate') throw uncertain()
    try { await input.rollback(receipt) } catch { throw uncertain() }
  }
  if (await input.inspect(receipt) !== 'previous' || !await input.health(receipt, 'previous')
    || await input.inspect(receipt) !== 'previous') throw uncertain()
  await input.finish(receipt, 'rolled_back')
  return { outcome: 'rolled_back' as const, receipt }
}
