export type LeadScoreRuntimeError = Error & {
  code?: string
  retryable?: boolean
  retryAfterMs?: number
}

export type LeadScoreRetryPolicy = {
  retryable: boolean
  deferImmediately: boolean
  delayMs: number
  category: 'circuit' | 'rate_limit' | 'concurrency' | 'timeout' | 'upstream' | 'permanent'
}

const CIRCUIT_FALLBACK_MS = 300_000
const RATE_LIMIT_FALLBACK_MS = 60_000
const CONCURRENCY_FALLBACK_MS = 15_000
const TRANSIENT_FALLBACK_MS = 60_000

function boundedDelay(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(1_000, Math.min(86_400_000, Math.round(parsed))) : fallback
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? '')
}

export function leadScoreRetryPolicy(error: unknown): LeadScoreRetryPolicy {
  const value = error as LeadScoreRuntimeError
  const code = String(value?.code ?? '').toUpperCase()
  const message = errorMessage(error).toLowerCase()
  if (value?.retryable === false) {
    return { retryable: false, deferImmediately: false, delayMs: 0, category: 'permanent' }
  }
  if (code === 'LEAD_AGENT_CIRCUIT_OPEN' || /熔断|circuit[ _-]?open/.test(message)) {
    return {
      retryable: true,
      deferImmediately: true,
      delayMs: boundedDelay(value?.retryAfterMs, CIRCUIT_FALLBACK_MS),
      category: 'circuit',
    }
  }
  if (code === 'LEAD_AGENT_RATE_LIMIT' || /rate limit|too many requests|\b429\b|请求速率/.test(message)) {
    return {
      retryable: true,
      deferImmediately: true,
      delayMs: boundedDelay(value?.retryAfterMs, RATE_LIMIT_FALLBACK_MS),
      category: 'rate_limit',
    }
  }
  if (code === 'LEAD_AGENT_CONCURRENCY_LIMIT' || /并发.*上限|concurrenc/.test(message)) {
    return {
      retryable: true,
      deferImmediately: true,
      delayMs: boundedDelay(value?.retryAfterMs, CONCURRENCY_FALLBACK_MS),
      category: 'concurrency',
    }
  }
  if (/timeout|timed out|超时|abort/.test(message)) {
    return { retryable: true, deferImmediately: false, delayMs: TRANSIENT_FALLBACK_MS, category: 'timeout' }
  }
  return { retryable: true, deferImmediately: false, delayMs: TRANSIENT_FALLBACK_MS, category: 'upstream' }
}

export function shouldAttemptLeadScoreFallback(
  error: unknown,
  currentAttempt: number,
  totalAttempts: number,
) {
  const policy = leadScoreRetryPolicy(error)
  return currentAttempt < totalAttempts && policy.retryable && !policy.deferImmediately
}

export function publicLeadScoreError(error?: string) {
  const policy = leadScoreRetryPolicy(error ? new Error(error) : new Error(''))
  if (policy.category === 'circuit') return 'AI 评分服务暂时熔断，系统将等待服务恢复后自动重试'
  if (policy.category === 'rate_limit') return 'AI 评分服务当前请求较多，系统将稍后自动重试'
  if (policy.category === 'concurrency') return 'AI 评分任务并发已满，系统将排队后自动重试'
  if (policy.category === 'timeout') return 'AI 评分服务响应超时，系统将自动重试'
  return error ? 'AI 评分暂未完成，请检查服务状态后重试' : undefined
}

export function publicLeadScoreDeadLetterError(error?: string) {
  const policy = leadScoreRetryPolicy(error ? new Error(error) : new Error(''))
  if (policy.category === 'circuit') return '任务因 AI 评分服务熔断未能完成'
  if (policy.category === 'rate_limit') return '任务因 AI 评分服务持续限流未能完成'
  if (policy.category === 'concurrency') return '任务因 AI 评分队列持续繁忙未能完成'
  if (policy.category === 'timeout') return '任务因 AI 评分服务多次响应超时未能完成'
  return error ? 'AI 评分在多个自动恢复周期后仍未完成' : undefined
}
