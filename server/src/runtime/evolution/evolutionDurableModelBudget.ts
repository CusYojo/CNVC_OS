import type { MySqlAiEvolutionRepository } from '../../repositories/mysql/mysqlAiEvolutionRepository.js'
import { evolutionContentHash, evolutionError, type EvolutionLeaseIdentity } from '../../services/aiEvolutionPolicyService.js'
import type { EvolutionDeveloperDependencies } from './evolutionCodeDeveloper.js'

type BudgetRepository = Pick<MySqlAiEvolutionRepository, 'reserveModelCall' | 'settleModelCall'>

/** Per-attempt adapter; persisted call keys prevent accidental invocation after restarting the same attempt. */
export function createEvolutionDurableModelBudget(repository: BudgetRepository, identity: EvolutionLeaseIdentity, modelId: string) {
  let round = 0
  let pending: { reservationId: string; reserved: number } | null = null
  const reserveModelTokens: EvolutionDeveloperDependencies['reserveModelTokens'] = async (upperBound) => {
    if (pending) throw evolutionError(409, 'EVOLUTION_MODEL_CALL_PENDING', '上次调用用量尚未记录')
    const result = await repository.reserveModelCall(identity, `attempt-${identity.attempt}:round-${round}`,
      evolutionContentHash({ modelId, inputHash: identity.inputHash, round, upperBound }), upperBound)
    if (!result.mayInvoke) throw evolutionError(409, 'EVOLUTION_MODEL_CALL_UNCERTAIN', '此调用可能已执行，不能重复调用；保留预留记录供恢复核对')
    pending = { reservationId: result.reservationId, reserved: upperBound }
  }
  const recordModelUsage: EvolutionDeveloperDependencies['recordModelUsage'] = async (actualTokens, reserved) => {
    if (!pending || pending.reserved !== reserved) throw evolutionError(409, 'EVOLUTION_MODEL_RESERVATION_MISSING', '找不到本次模型调用的预算预留')
    const result = await repository.settleModelCall(identity, pending.reservationId, actualTokens)
    pending = null
    round++
    if (result.budgetExceeded) throw evolutionError(409, 'EVOLUTION_BUDGET_EXCEEDED', '实际模型用量超出任务总预算，已停止继续调用')
  }
  return { reserveModelTokens, recordModelUsage }
}
