import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { leads, radarCandidates } from '../db/schema.js'
import { normalizePaperIdentity } from '../services/leadEnrichmentContract.js'
import { authorContributions, doiFromPaperSource, fetchDoiPaperMetadata } from '../services/externalPaperMetadataService.js'
import { applyLeadFieldPolicy } from '../services/leadFieldProvenance.js'
import { mergePaperMetadataPreservingAuthors } from '../services/paperMetadata.js'
import { parseOpenAlexWorks } from '../services/radarCollectorService.js'
import { ingestRadarCandidates } from '../services/radarDataMigrationService.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function text(value: unknown) {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : ''
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

function argument(name: string) {
  const prefix = `--${name}=`
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || ''
}

function workId(values: unknown[]) {
  for (const value of values.map(text)) {
    const match = value.match(/(?:openalex\.org\/)?(W\d{5,})/i)
    if (match) return match[1].toUpperCase()
  }
  return ''
}

async function fetchOpenAlexWork(id: string) {
  const url = new URL(`https://api.openalex.org/works/${id}`)
  const apiKey = text(process.env.OPENALEX_API_KEY)
  if (apiKey) url.searchParams.set('api_key', apiKey)
  else url.searchParams.set('mailto', text(process.env.OPENALEX_MAILTO) || 'research@sbl.invalid')
  const response = await fetch(url, {
    headers: { 'user-agent': 'sbl-jedi-openalex-backfill/1.0' },
    signal: AbortSignal.timeout(45_000),
  })
  if (!response.ok) throw new Error(`OpenAlex ${id} HTTP ${response.status} ${response.statusText}`)
  return await response.json()
}

async function normalizedOpenAlexOrDoiFallback(id: string, doiInputs: unknown[]) {
  try {
    const work = await fetchOpenAlexWork(id)
    const [normalized] = parseOpenAlexWorks({
      key: 'openalex', name: 'OpenAlex', url: 'https://api.openalex.org/works', group: '论文',
      type: 'openalex_api', frequency: 'manual-backfill', enabled: true,
    } as never, { results: [work] }, 1)
    if (!normalized) throw new Error(`OpenAlex ${id} cannot be normalized`)
    return { normalized, fallback: '' }
  } catch (openAlexError) {
    const doi = doiInputs.map(doiFromPaperSource).find(Boolean) || ''
    if (!doi) throw openAlexError
    const external = await fetchDoiPaperMetadata(doi)
    const authors = external.authors
    const contributions = authorContributions(authors)
    const sourceIdentity = {
      ...normalizePaperIdentity({ provider: 'openalex', openAlexId: id, sourceId: id, doi, landingPageUrl: external.landingPageUrl, pdfUrl: external.pdfUrl }),
      sourceStatus: 'review',
      reviewReasons: [`OpenAlex ${id} unavailable; metadata recovered from ${external.metadataSource.provider}`],
    }
    return {
      fallback: external.metadataSource.provider,
      normalized: {
        title: external.title, summary: '', link: external.landingPageUrl, authors,
        doi: external.doi, pdf_url: external.pdfUrl, published_at: external.publishedAt,
        declared_published_at: external.declaredPublishedAt,
        publication_date_status: external.publicationDateStatus,
        publication_date_basis: external.publicationDateBasis,
        paper_resource_type: external.resourceType,
        paper_affiliations: external.affiliations,
        paper_author_affiliations: [],
        paper_authors: authors.map((name, index) => ({
          name, normalizedName: name.normalize('NFKC').toLocaleLowerCase('en-US'), position: index + 1,
          role: index === 0 ? 'first_author' : 'coauthor', affiliations: [], identityStatus: 'claimed',
          evidenceUrl: external.metadataSource.url,
        })),
        paper_research_team: { name: `${external.title}联合研究团队`, basis: 'paper_coauthorship', memberCount: authors.length },
        paper_author_contributions: contributions,
        paper_rights: {
          ...(external.license ? { articleLicense: { ...external.license, status: 'confirmed', scope: 'article' } } : {}),
          intellectualProperty: { status: 'undisclosed', label: '未披露', note: '论文或成果开放许可不等于知识产权归属' },
        },
        paper_metadata_source: external.metadataSource,
        paper_source_identity: sourceIdentity,
        paper_content_links: [
          { url: external.landingPageUrl, contentType: 'landing_page' },
          ...(external.pdfUrl ? [{ url: external.pdfUrl, contentType: 'paper_pdf' }] : []),
        ],
      } as JsonObject,
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const requestedLeadId = argument('lead-id')
  const limit = Math.max(1, Math.min(500, Number(argument('limit')) || 500))
  const candidateRows = await db.select({ payload: radarCandidates.payload }).from(radarCandidates)
  const candidateBySourceId = new Map(candidateRows.map((row) => [text(row.payload.source_id), row.payload]))
  const leadRows = await db.select({
    id: leads.id, name: leads.name, source: leads.source, team: leads.team, sources: leads.sources,
    radarProfile: leads.radarProfile, fieldProvenance: leads.fieldProvenance,
  }).from(leads)
  const selected = leadRows.flatMap((lead) => {
    const radar = object(lead.radarProfile)
    if (text(radar.channel) !== '论文' || (requestedLeadId && lead.id !== requestedLeadId)) return []
    const meta = object(radar.paperMeta)
    const id = workId([radar.sourceId, meta.openAlexId, radar.link, lead.source, object(meta.metadataSource).url])
    const identity = normalizePaperIdentity({
      provider: object(meta.metadataSource).provider, sourceName: radar.sourceName || lead.source,
      sourceId: radar.sourceId, openAlexId: id, arxivId: meta.arxivId, doi: meta.doi,
      landingPageUrl: radar.link, pdfUrl: meta.pdfUrl,
    })
    const candidate = candidateBySourceId.get(text(radar.sourceId)) || candidateBySourceId.get(id) || {}
    return identity.provider === 'openalex' && id ? [{ lead, radar, meta, id, candidate }] : []
  }).slice(0, limit)

  const outcomes: JsonObject[] = []
  for (const item of selected) {
    try {
      const { normalized, fallback } = await normalizedOpenAlexOrDoiFallback(item.id, [
        item.meta.doi, item.radar.link, item.meta.pdfUrl, item.candidate.doi,
        item.candidate.link, item.candidate.pdf_url, object(item.candidate.project_profile).paper_pdf_url,
      ])
      const authors = strings(normalized.authors)
      const projectName = text(item.meta.projectName) || item.lead.name
      const paperMeta = mergePaperMetadataPreservingAuthors(item.meta, {
        title: normalized.title,
        titleOriginal: normalized.title,
        abstract: normalized.summary,
        abstractOriginal: normalized.summary,
        authors,
        firstAuthor: authors[0] || '',
        secondAuthor: authors[1] || '',
        openAlexId: item.id,
        doi: normalized.doi,
        publishedAt: normalized.published_at,
        declaredPublishedAt: normalized.declared_published_at,
        publicationDateStatus: normalized.publication_date_status,
        publicationDateBasis: normalized.publication_date_basis,
        pdfUrl: normalized.pdf_url,
        resourceType: normalized.paper_resource_type,
        affiliations: normalized.paper_affiliations,
        authorAffiliations: normalized.paper_author_affiliations,
        paperAuthors: normalized.paper_authors,
        researchTeam: { ...object(normalized.paper_research_team), name: `${projectName}联合研究团队` },
        authorContributions: normalized.paper_author_contributions,
        rights: normalized.paper_rights,
        metadataSource: normalized.paper_metadata_source,
        sourceIdentity: normalized.paper_source_identity,
        contentLinks: normalized.paper_content_links,
      })
      const radarProfile = {
        ...item.radar, sourceName: 'OpenAlex', sourceGroup: '论文', sourceId: item.id,
        link: normalized.link, publishedAt: normalized.published_at, paperMeta,
      }
      const existingSources = Array.isArray(item.lead.sources) ? item.lead.sources : []
      const sources = existingSources.length
        ? existingSources.map((source, index) => index === 0 ? { ...object(source), url: normalized.link, publisher: 'OpenAlex' } : source)
        : [{ title: normalized.title, url: normalized.link, publisher: 'OpenAlex', reliability: '高', category: '第三方数据库', excerpt: normalized.summary }]
      if (apply) {
        const patch = applyLeadFieldPolicy(item.lead as unknown as Record<string, unknown>, {
          source: '项目发现雷达 · OpenAlex', team: authors.join('、'), sources, radarProfile,
        }, 'deterministic_backfill', {
          alwaysReplaceFields: ['source', 'team', 'sources', 'radarProfile'], operation: 'machine_refresh',
        })
        if (Object.keys(patch).length) await db.update(leads).set(patch as never).where(eq(leads.id, item.lead.id))
        await ingestRadarCandidates([{ ...item.candidate, ...normalized, source: 'openalex', source_id: item.id, source_name: 'OpenAlex', source_group: '论文' }])
      }
      const sourceStatus = fallback || text(object(normalized.paper_source_identity).sourceStatus) === 'review'
        || text(normalized.publication_date_status) === 'source_declared_future' ? 'review' : 'confirmed'
      outcomes.push({
        leadId: item.lead.id, name: item.lead.name, workId: item.id, provider: 'OpenAlex',
        authors: authors.length, affiliations: Array.isArray(normalized.paper_affiliations) ? normalized.paper_affiliations.length : 0,
        publishedAt: normalized.published_at, declaredPublishedAt: normalized.declared_published_at,
        publicationDateStatus: normalized.publication_date_status, landingPageUrl: normalized.link,
        pdfUrl: normalized.pdf_url, fallbackMetadataProvider: fallback || null, sourceStatus, updated: apply,
      })
    } catch (error) {
      outcomes.push({ leadId: item.lead.id, name: item.lead.name, workId: item.id, error: error instanceof Error ? error.message : String(error), updated: false })
    }
  }
  const errors = outcomes.filter((row) => row.error)
  console.log(JSON.stringify({
    ok: errors.length === 0, mode: apply ? 'apply' : 'preview', provider: 'OpenAlex',
    selected: selected.length, resolved: outcomes.length - errors.length, updated: outcomes.filter((row) => row.updated).length,
    errors, outcomes,
  }, null, 2))
  if (errors.length) process.exitCode = 1
}

await main().finally(async () => await pool.end())
