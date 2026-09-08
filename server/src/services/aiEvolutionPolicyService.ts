import { createHash } from 'node:crypto'
import type { EvolutionBudget, EvolutionScope, EvolutionSpec } from '../contracts/aiEvolutionContract.js'

export function evolutionError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code })
}

/** Only verified database/session identity is accepted by the calling service. */
export type EvolutionActor = { userId: string; enabled: boolean }
export type EvolutionPolicyDependencies = {
  canAccessProject: (userId: string, projectId: string) => Promise<boolean>
  canAccessSource: (userId: string, source: EvolutionSpec['sourceRefs'][number]) => Promise<boolean>
  canManageScope: (userId: string, scope: EvolutionScope, target: EvolutionSpec['target']) => Promise<boolean>
  canDevelopRepository: (userId: string, repositoryId: string) => Promise<boolean>
  canManageCapability: (userId: string, capabilityId: string) => Promise<boolean>
  codeEnvironmentAvailable: () => Promise<boolean>
  budgetLimit: EvolutionBudget
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  throw evolutionError(400, 'EVOLUTION_INVALID_HASH_INPUT', '进化内容必须为有效 JSON')
}

export function evolutionContentHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export function assertEvolutionOwner(actor: EvolutionActor, ownerUserId: string) {
  if (!actor.enabled || actor.userId !== ownerUserId) {
    throw evolutionError(404, 'EVOLUTION_NOT_FOUND', '进化对象不存在或无权访问')
  }
}

export async function assertEvolutionSpecAccess(actor: EvolutionActor, spec: EvolutionSpec, deps: EvolutionPolicyDependencies, execute = false) {
  if (!actor.enabled) throw evolutionError(403, 'EVOLUTION_USER_DISABLED', '当前账号不可用')
  if (spec.scope.type === 'user') {
    if (spec.scope.key !== actor.userId) throw evolutionError(403, 'EVOLUTION_SCOPE_FORBIDDEN', '不能替其他用户保存个人规则')
  } else if (!await deps.canManageScope(actor.userId, spec.scope, spec.target)) {
    throw evolutionError(403, 'EVOLUTION_SCOPE_FORBIDDEN', '缺少此作用域的进化授权')
  }
  if (spec.businessProjectId && !await deps.canAccessProject(actor.userId, spec.businessProjectId)) {
    throw evolutionError(403, 'EVOLUTION_PROJECT_FORBIDDEN', '无权访问关联项目')
  }
  for (const source of spec.sourceRefs) {
    if (!await deps.canAccessSource(actor.userId, source)) throw evolutionError(403, 'EVOLUTION_SOURCE_FORBIDDEN', '无权引用提案来源')
  }
  if (!execute) return
  if (spec.questions.some((question) => !question.answer?.trim())) throw evolutionError(409, 'EVOLUTION_NEEDS_INPUT', '请先回答提案中的问题')
  for (const key of ['maxDurationSeconds', 'maxModelTokens', 'maxRepairRounds'] as const) {
    if (spec.budget[key] > deps.budgetLimit[key]) throw evolutionError(409, 'EVOLUTION_BUDGET_EXCEEDED', '提案预算超出服务端限额')
  }
  if (spec.target.type === 'code') {
    if (!await deps.canDevelopRepository(actor.userId, spec.target.repositoryId)) {
      throw evolutionError(403, 'EVOLUTION_REPOSITORY_FORBIDDEN', '缺少目标仓库的明确开发授权')
    }
    if (spec.target.databaseChange || spec.target.permissionChange) {
      throw evolutionError(409, 'EVOLUTION_SEPARATE_REVIEW_REQUIRED', '数据库或权限变更需要独立方案和授权')
    }
    if (!await deps.codeEnvironmentAvailable()) throw evolutionError(503, 'EVOLUTION_ENVIRONMENT_UNAVAILABLE', '隔离代码执行环境不可用')
  }
  if (spec.target.type === 'skill' && !await deps.canManageCapability(actor.userId, spec.target.capabilityId)) {
    throw evolutionError(403, 'EVOLUTION_CAPABILITY_FORBIDDEN', '缺少目标技能的管理授权')
  }
}

export type EvolutionLeaseIdentity = { runId: string; attempt: number; leaseToken: number; inputHash: string }
export function assertEvolutionLease(
  stored: EvolutionLeaseIdentity & { leaseExpiresAt: Date; cancelRequestedAt: Date | null },
  submitted: EvolutionLeaseIdentity,
  now: Date,
) {
  if (stored.runId !== submitted.runId || stored.attempt !== submitted.attempt || stored.leaseToken !== submitted.leaseToken
    || stored.inputHash !== submitted.inputHash || stored.leaseExpiresAt.getTime() <= now.getTime()) {
    throw evolutionError(409, 'EVOLUTION_STALE_EXECUTOR', '执行权已失效，拒绝接收旧执行器结果')
  }
  if (stored.cancelRequestedAt) throw evolutionError(409, 'EVOLUTION_CANCEL_REQUESTED', '任务已请求取消，不能接收成功结果')
}
