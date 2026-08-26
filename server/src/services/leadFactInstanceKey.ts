import type { LeadEnrichmentTopicKey } from './leadEnrichmentContract.js'

export const LEAD_FACT_SINGLETON_INSTANCE_KEY = 'singleton' as const

export function normalizeLeadFactInstanceKey(value: unknown): string {
  const normalized = String(value ?? '').normalize('NFKC').trim().toLowerCase()
    .replace(/\s+/g, ' ')
  return (normalized || LEAD_FACT_SINGLETON_INSTANCE_KEY).slice(0, 128)
}

/**
 * Basic profile fields are one current value per subject. Every other web-research topic
 * can legitimately contain more than one row (rounds, people, shareholders, periods,
 * products, patents, customers, events, markets or transactions), so the model must bind
 * each candidate to a stable record identity before the host can compare versions safely.
 */
export function leadFactRequiresInstanceKey(topicKey: LeadEnrichmentTopicKey): boolean {
  return topicKey !== 'basic_profile'
}

export function leadFactIdentityKey(factKey: unknown, instanceKey: unknown): string {
  return `${String(factKey ?? '').normalize('NFKC').trim()}\u0000${normalizeLeadFactInstanceKey(instanceKey)}`
}
