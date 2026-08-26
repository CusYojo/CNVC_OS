import { canonicalEnrichmentJson } from './leadEnrichmentContract.js'
import { leadFactIdentityKey, normalizeLeadFactInstanceKey } from './leadFactInstanceKey.js'

type CandidateFact = {
  factKey: string
  instanceKey?: string
  value: unknown
  sourceUrls: string[]
}

function displayConflictValue(value: unknown) {
  if (typeof value === 'string') return value.slice(0, 1_000)
  return canonicalEnrichmentJson(value).slice(0, 1_000)
}

export function detectLeadCandidateFactConflicts<T extends CandidateFact>(facts: T[]) {
  const grouped = new Map<string, T[]>()
  for (const fact of facts) {
    const identity = leadFactIdentityKey(fact.factKey, fact.instanceKey)
    grouped.set(identity, [...(grouped.get(identity) || []), fact])
  }
  const conflicts: Array<{ factKey: string; instanceKey: string; values: string[]; sourceUrls: string[]; reason: string }> = []
  const nonConflictingFacts: T[] = []
  for (const candidates of grouped.values()) {
    const factKey = candidates[0].factKey
    const instanceKey = normalizeLeadFactInstanceKey(candidates[0].instanceKey)
    const values = new Map<string, unknown>()
    for (const candidate of candidates) values.set(canonicalEnrichmentJson(candidate.value), candidate.value)
    if (values.size <= 1) {
      nonConflictingFacts.push(...candidates)
      continue
    }
    conflicts.push({
      factKey,
      instanceKey,
      values: [...values.values()].map(displayConflictValue),
      sourceUrls: [...new Set(candidates.flatMap((candidate) => candidate.sourceUrls))],
      reason: '宿主检测到同一事实键出现多个不同值，禁止静默合并',
    })
  }
  return { facts: nonConflictingFacts, conflicts }
}
