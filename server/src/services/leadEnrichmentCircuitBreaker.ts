export type LeadEnrichmentGatewayErrorClass = 'network' | 'rate_limit' | 'model' | 'billing' | string

export function createLeadEnrichmentCircuitBreaker(input: {
  failureThreshold?: number
  cooldownMs?: number
  billingCooldownMs?: number
  now?: () => number
} = {}) {
  const failureThreshold = Math.max(1, Math.floor(input.failureThreshold ?? 5))
  const cooldownMs = Math.max(1, Math.floor(input.cooldownMs ?? 60_000))
  const billingCooldownMs = Math.max(cooldownMs, Math.floor(input.billingCooldownMs ?? 15 * 60_000))
  const now = input.now ?? Date.now
  let consecutiveFailures = 0
  let openUntilMs = 0
  let openReason: 'gateway_failures' | 'billing' | null = null

  const isGatewayFailure = (errorClass: LeadEnrichmentGatewayErrorClass) => (
    ['network', 'rate_limit', 'model'].includes(String(errorClass).normalize('NFKC').trim().toLowerCase())
  )
  const snapshot = () => {
    const open = openUntilMs > now()
    return {
      open,
      openUntil: open ? new Date(openUntilMs).toISOString() : null,
      openReason: open ? openReason : null,
      consecutiveFailures,
      failureThreshold,
      cooldownMs,
      billingCooldownMs,
    }
  }
  return {
    canRequest() { return !snapshot().open },
    recordSuccess() {
      consecutiveFailures = 0
      openUntilMs = 0
      openReason = null
      return snapshot()
    },
    recordFailure(errorClass: LeadEnrichmentGatewayErrorClass) {
      if (String(errorClass).normalize('NFKC').trim().toLowerCase() === 'billing') {
        consecutiveFailures = Math.max(consecutiveFailures, failureThreshold)
        openUntilMs = Math.max(openUntilMs, now() + billingCooldownMs)
        openReason = 'billing'
        return snapshot()
      }
      if (!isGatewayFailure(errorClass)) return snapshot()
      consecutiveFailures += 1
      if (consecutiveFailures >= failureThreshold) {
        openUntilMs = Math.max(openUntilMs, now() + cooldownMs)
        openReason = 'gateway_failures'
      }
      return snapshot()
    },
    snapshot,
  }
}
