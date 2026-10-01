export type DiscoveryPersonKind = 'ranking' | 'research' | 'expert'

export interface DiscoveryPersonEvidence {
  title: string
  url: string
  publishedAt: string
  publisher: string
}

export interface DiscoveryPerson {
  identityKey: string
  name: string
  kind: DiscoveryPersonKind
  organization: string
  field: string
  identityStatus: 'source_confirmed' | 'algorithmic' | 'unverified'
  sourceLabel: string
  evidence: DiscoveryPersonEvidence[]
}

export interface ResearchCandidate {
  source: string
  sourceGroup: string | null
  payload: Record<string, unknown>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 500) : ''
}

function safeUrl(value: unknown): string {
  const url = text(value)
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : ''
  } catch { return '' }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function peopleFromResearchCandidates(candidates: ResearchCandidate[]): DiscoveryPerson[] {
  const people = new Map<string, DiscoveryPerson>()
  candidates.forEach((candidate) => {
    if (candidate.sourceGroup !== '论文' && !['openalex', 'arxiv'].includes(candidate.source.toLowerCase())) return
    const payload = candidate.payload
    const url = safeUrl(payload.link || payload.url || payload.openalex_id)
    const title = text(payload.title)
    if (!url || !title) return
    const authors = Array.isArray(payload.paper_authors) ? payload.paper_authors : []
    authors.slice(0, 30).forEach((value, authorIndex) => {
      const author = record(value)
      const name = text(author?.name).slice(0, 120)
      if (!name) return
      const openAlexId = text(author?.openAlexAuthorId).replace(/^https?:\/\/openalex\.org\//i, '')
      const orcid = text(author?.orcid).replace(/^https?:\/\/orcid\.org\//i, '')
      const identityKey = openAlexId ? `openalex:${openAlexId}` : orcid ? `orcid:${orcid}` : `paper:${encodeURIComponent(url)}:${authorIndex}`
      const affiliations = Array.isArray(author?.affiliations) ? author.affiliations : []
      const organization = text(record(affiliations[0])?.name)
      const publisher = candidate.source.toLowerCase() === 'openalex' ? 'OpenAlex' : candidate.source.toLowerCase() === 'arxiv' ? 'arXiv' : text(candidate.source)
      const evidence = { title, url, publishedAt: text(payload.published_at || payload.publishedAt).slice(0, 10), publisher }
      const previous = people.get(identityKey)
      if (previous) {
        if (!previous.evidence.some((item) => item.url === url)) people.set(identityKey, {
          ...previous, organization: previous.organization || organization, evidence: [...previous.evidence, evidence],
        })
      } else {
        people.set(identityKey, {
          identityKey, name, kind: 'research', organization, field: text(payload.primary_topic || payload.source_group),
          identityStatus: openAlexId || orcid ? 'algorithmic' : 'unverified',
          sourceLabel: `${publisher} 科研成果`,
          evidence: [evidence],
        })
      }
    })
  })
  return [...people.values()]
}
