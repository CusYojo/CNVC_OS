import {
  LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS,
  type LeadEnrichmentTopicKey,
} from './leadEnrichmentContract.js'

export type LeadDeepCollectionReason =
  | 'no_current_snapshot'
  | 'snapshot_stale'
  | 'snapshot_has_gaps'
  | 'forced_refresh'

export type LeadDeepCollectionSnapshot = {
  status: string
  topicStates: unknown
  coverage: number
  createdAt: string | Date
}

export type LeadDeepCollectionPlan = {
  selected: boolean
  reasons: LeadDeepCollectionReason[]
  gapTopics: LeadEnrichmentTopicKey[]
  snapshotAgeDays: number | null
}

const RETRYABLE_TOPIC_STATES = new Set(['partial', 'missing', 'review', 'failed', 'dead_letter'])

function object(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)) } catch { return {} }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function leadDeepCollectionGapTopics(topicStates: unknown): LeadEnrichmentTopicKey[] {
  const states = object(topicStates)
  return LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS.filter((topicKey) => (
    RETRYABLE_TOPIC_STATES.has(String(states[topicKey] ?? ''))
  ))
}

export function planLeadDeepCollection(input: {
  snapshot: LeadDeepCollectionSnapshot | null
  hasActiveJob: boolean
  maxAgeDays: number
  retryGaps: boolean
  force: boolean
  now?: Date
}): LeadDeepCollectionPlan {
  const snapshotCreatedAt = input.snapshot ? new Date(input.snapshot.createdAt).getTime() : Number.NaN
  const now = (input.now ?? new Date()).getTime()
  const snapshotAgeDays = Number.isFinite(snapshotCreatedAt)
    ? Math.max(0, (now - snapshotCreatedAt) / 86_400_000)
    : null
  const gapTopics = input.snapshot ? leadDeepCollectionGapTopics(input.snapshot.topicStates) : []
  const reasons: LeadDeepCollectionReason[] = []

  if (input.force) reasons.push('forced_refresh')
  if (!input.snapshot) reasons.push('no_current_snapshot')
  if (input.snapshot && input.maxAgeDays > 0 && snapshotAgeDays !== null && snapshotAgeDays >= input.maxAgeDays) {
    reasons.push('snapshot_stale')
  }
  if (input.snapshot && input.retryGaps && (input.snapshot.status === 'review' || gapTopics.length > 0)) {
    reasons.push('snapshot_has_gaps')
  }

  return {
    selected: !input.hasActiveJob && reasons.length > 0,
    reasons,
    gapTopics,
    snapshotAgeDays,
  }
}
