import type { MySqlAiExperienceRepository } from '../repositories/mysql/mysqlAiExperienceRepository.js'
import { evolutionError } from './aiEvolutionPolicyService.js'

export function createAiExperienceCheckBudget(repository: Pick<MySqlAiExperienceRepository, 'reserveOutputCheck' | 'settleOutputCheck'>,
  userId: string, taskId: string, binding: Parameters<MySqlAiExperienceRepository['reserveOutputCheck']>[2]) {
  const frozen = Object.freeze({ ...binding })
  let reservation: { id: string; tokens: number } | undefined
  return {
    async reserveModelTokens(tokens: number) {
      const result = await repository.reserveOutputCheck(userId, taskId, frozen, tokens)
      if (!result.mayInvoke) throw evolutionError(409, 'EVOLUTION_MODEL_CALL_UNCERTAIN', '该检查已调用或可能已调用，不能重复提交')
      reservation = { id: result.reservationId, tokens }
    },
    async recordModelUsage(actual: number | null, reserved: number) {
      if (!reservation || reservation.tokens !== reserved) throw evolutionError(409, 'EVOLUTION_MODEL_RESERVATION_MISSING', '检查预留不存在')
      const result = await repository.settleOutputCheck(userId, taskId, reservation.id, actual)
      if (result.budgetExceeded) throw evolutionError(409, 'EVOLUTION_BUDGET_EXCEEDED', '实际检查用量超出预算')
    },
  }
}
