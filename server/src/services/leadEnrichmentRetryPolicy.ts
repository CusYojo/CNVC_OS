export type LeadEnrichmentErrorClass =
  | 'rate_limit'
  | 'network'
  | 'model'
  | 'parse'
  | 'validation'
  | 'budget'
  | 'unknown'

export type LeadEnrichmentRetryDecision = {
  errorClass: LeadEnrichmentErrorClass
  retry: boolean
  retrySeconds: number
  terminalStatus: 'retrying' | 'dead_letter'
}

export function isLeadEnrichmentProviderBudgetError(error: unknown) {
  const value = error as { code?: unknown }
  const code = String(value?.code ?? '').normalize('NFKC').trim().toUpperCase()
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /INSUFFICIENT[_-]?(?:QUOTA|CREDIT|BALANCE)|QUOTA[_-]?EXCEEDED|BILLING|PAYMENT[_-]?REQUIRED/.test(code)
    || /额度不足|余额不足|令牌[^\n]{0,24}(?:额度|余额)[^\n]{0,12}不足|账户[^\n]{0,16}(?:额度|余额)[^\n]{0,12}不足|insufficient\s+(?:quota|credits?|balance)|quota\s+exceeded|credit\s+balance|billing\s+(?:limit|error)|payment\s+required/i.test(message)
}

export function classifyLeadEnrichmentError(error: unknown): LeadEnrichmentErrorClass {
  const value = error as { category?: unknown; code?: unknown }
  if (isLeadEnrichmentProviderBudgetError(error)) return 'budget'
  const declared = String(value?.category ?? '').normalize('NFKC').trim().toLowerCase()
  if (declared === 'rate' || declared === 'rate_limit') return 'rate_limit'
  if (['network', 'model', 'parse', 'validation', 'budget'].includes(declared)) {
    return declared as LeadEnrichmentErrorClass
  }
  const code = String(value?.code ?? '').toUpperCase()
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/BUDGET/.test(code)) return 'budget'
  if (/RATE|429|LIMIT/.test(code) || /rate.?limit|too many requests|限流/i.test(message)) return 'rate_limit'
  if (/NETWORK|TIMEOUT|ECONN|ENOTFOUND/.test(code) || /timeout|timed out|network|fetch failed|网关/i.test(message)) return 'network'
  if (/PARSE|JSON|SCHEMA/.test(code) || /parse|JSON|schema|zod|格式/i.test(message)) return 'parse'
  if (/VALIDATION/.test(code) || /validation|校验/i.test(message)) return 'validation'
  if (/MODEL|AI|LLM/.test(code)) return 'model'
  return 'unknown'
}

function retryDelaySeconds(errorClass: LeadEnrichmentErrorClass, attempt: number) {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  if (errorClass === 'rate_limit') return Math.min(7_200, 120 * safeAttempt)
  if (errorClass === 'network') return Math.min(3_600, 30 * (2 ** Math.min(7, safeAttempt - 1)))
  if (errorClass === 'model') return Math.min(3_600, 60 * safeAttempt)
  if (errorClass === 'parse' || errorClass === 'validation') return Math.min(900, 15 * safeAttempt)
  return Math.min(3_600, 30 * safeAttempt)
}

export function leadEnrichmentRetryDecision(input: {
  error: unknown
  executionAttempts: number
  maxAttempts: number
}): LeadEnrichmentRetryDecision {
  const errorClass = classifyLeadEnrichmentError(input.error)
  const explicitlyRetryable = (input.error as { retryable?: unknown })?.retryable !== false
  const retry = explicitlyRetryable && errorClass !== 'budget' && input.executionAttempts < input.maxAttempts
  return {
    errorClass,
    retry,
    retrySeconds: retry ? retryDelaySeconds(errorClass, input.executionAttempts) : 0,
    terminalStatus: retry ? 'retrying' : 'dead_letter',
  }
}
