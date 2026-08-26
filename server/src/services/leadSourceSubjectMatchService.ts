import type { LeadEnrichmentTopicKey } from './leadEnrichmentContract.js'

function normalized(value: unknown) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function leadSourceSupportsSubject(input: {
  topicKey: LeadEnrichmentTopicKey
  sourceText: string
  subjectAliases: string[]
}) {
  if (input.topicKey === 'market_policy') return true
  const source = normalized(input.sourceText)
  if (!source) return false
  const aliases = [...new Set(input.subjectAliases.map(normalized).filter((alias) => alias.length >= 2))]
  return aliases.some((alias) => source.includes(alias))
}
