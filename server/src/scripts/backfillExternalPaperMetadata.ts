import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { leads, radarCandidates } from '../db/schema.js'
import { authorContributions, doiFromPaperSource, fetchDoiPaperMetadata } from '../services/externalPaperMetadataService.js'
import { applyLeadFieldPolicy } from '../services/leadFieldProvenance.js'
import { mergePaperMetadataPreservingAuthors } from '../services/paperMetadata.js'
import { ingestRadarCandidates } from '../services/radarDataMigrationService.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean)
  return text(value).split(/[,，;；]/).map((item) => item.trim()).filter(Boolean)
}

function argument(name: string): string {
  const prefix = `--${name}=`
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? ''
}

async function main() {
  const apply = process.argv.includes('--apply')
  const requestedLeadId = argument('lead-id')
  const candidateRows = await db.select({ payload: radarCandidates.payload }).from(radarCandidates)
  const candidateBySourceId = new Map(candidateRows.map((row) => [text(row.payload.source_id), row.payload]))
  const leadRows = await db.select({
    id: leads.id,
    name: leads.name,
    source: leads.source,
    team: leads.team,
    sources: leads.sources,
    radarProfile: leads.radarProfile,
    fieldProvenance: leads.fieldProvenance,
  }).from(leads)
  const selected = leadRows.flatMap((lead) => {
    const radarProfile = object(lead.radarProfile)
    if (text(radarProfile.channel) !== '论文' || text(radarProfile.sourceName) !== 'OpenAlex') return []
    if (requestedLeadId && lead.id !== requestedLeadId) return []
    const paperMeta = object(radarProfile.paperMeta)
    const candidate = candidateBySourceId.get(text(radarProfile.sourceId)) ?? {}
    const profile = object(candidate.project_profile)
    const doi = doiFromPaperSource([
      candidate.doi,
      candidate.link,
      candidate.pdf_url,
      profile.paper_pdf_url,
      radarProfile.link,
      paperMeta.pdfUrl,
    ].map(text).find((value) => doiFromPaperSource(value)) || '')
    return doi ? [{ lead, radarProfile, paperMeta, candidate, doi }] : []
  })

  const outcomes: JsonObject[] = []
  for (const item of selected) {
    try {
      const external = await fetchDoiPaperMetadata(item.doi)
      const authors = external.authors.length > 0 ? external.authors : list(item.paperMeta.authors)
      const projectName = text(item.paperMeta.projectName) || item.lead.name
      const contributions = authorContributions(authors)
      const rights = {
        ...(external.license ? { articleLicense: {
          ...external.license,
          status: 'confirmed' as const,
          scope: 'article' as const,
        } } : {}),
        intellectualProperty: {
          status: 'undisclosed' as const,
          label: '未披露' as const,
          note: '论文或成果开放许可不等于知识产权归属' as const,
        },
      }
      const researchMetadata = {
        doi: external.doi,
        resourceType: external.resourceType,
        title: external.title || text(item.paperMeta.title),
        titleOriginal: external.title || text(item.paperMeta.titleOriginal),
        authors,
        firstAuthor: authors[0] || '',
        secondAuthor: authors[1] || '',
        affiliations: external.affiliations,
        researchTeam: {
          name: `${projectName}联合研究团队`,
          basis: 'paper_coauthorship' as const,
          memberCount: authors.length,
        },
        authorContributions: contributions,
        rights,
        venue: external.venue || text(item.paperMeta.venue),
        publishedAt: external.publishedAt,
        declaredPublishedAt: external.declaredPublishedAt,
        publicationDateStatus: external.publicationDateStatus,
        publicationDateBasis: external.publicationDateBasis,
        pdfUrl: external.pdfUrl || text(item.paperMeta.pdfUrl),
        metadataSource: {
          ...external.metadataSource,
          declaredPublishedAt: external.declaredPublishedAt,
          publicationDateStatus: external.publicationDateStatus,
          publicationDateBasis: external.publicationDateBasis,
        },
      }
      const radarProfile = {
        ...item.radarProfile,
        sourceName: 'OpenAlex',
        sourceGroup: '论文',
        link: external.landingPageUrl,
        paperMeta: mergePaperMetadataPreservingAuthors(item.paperMeta, researchMetadata as unknown as JsonObject),
      }
      const existingSources = Array.isArray(item.lead.sources) ? item.lead.sources : []
      const sources = existingSources.length > 0
        ? existingSources.map((value, index) => index === 0 ? { ...object(value), url: external.landingPageUrl, publisher: external.metadataSource.provider } : value)
        : [{ title: external.title || item.lead.name, url: external.landingPageUrl, publisher: external.metadataSource.provider, reliability: '高', category: '第三方数据库', excerpt: '' }]
      if (apply) {
        const patch = applyLeadFieldPolicy(
          item.lead as unknown as Record<string, unknown>,
          {
            source: '项目发现雷达 · OpenAlex',
            team: authors.join('、'),
            sources,
            radarProfile,
          },
          'deterministic_backfill',
          { alwaysReplaceFields: ['source', 'team', 'sources', 'radarProfile'], operation: 'machine_refresh' },
        )
        if (Object.keys(patch).length > 0) await db.update(leads).set(patch as never).where(eq(leads.id, item.lead.id))
        await ingestRadarCandidates([{
          ...item.candidate,
          source: 'openalex',
          source_name: 'OpenAlex',
          source_group: '论文',
          link: external.landingPageUrl,
          doi: external.doi,
          authors,
          first_author: authors[0] || '',
          second_author: authors[1] || '',
          published_at: external.publishedAt,
          declared_published_at: external.declaredPublishedAt,
          publication_date_status: external.publicationDateStatus,
          publication_date_basis: external.publicationDateBasis,
          journal_ref: external.venue,
          pdf_url: external.pdfUrl || text(item.candidate.pdf_url),
          paper_affiliations: external.affiliations,
          paper_research_team: researchMetadata.researchTeam,
          paper_author_contributions: contributions,
          paper_rights: rights,
          paper_metadata_source: researchMetadata.metadataSource,
          paper_resource_type: external.resourceType,
        }])
      }
      outcomes.push({
        id: item.lead.id,
        name: item.lead.name,
        doi: external.doi,
        source: 'OpenAlex',
        publishedAt: external.publishedAt,
        declaredPublishedAt: external.declaredPublishedAt,
        publicationDateStatus: external.publicationDateStatus,
        resourceType: external.resourceType,
        authors: authors.length,
        affiliations: external.affiliations.map((affiliation) => affiliation.name),
        license: external.license?.label || '未披露',
        link: external.landingPageUrl,
        updated: apply,
      })
    } catch (cause) {
      outcomes.push({ id: item.lead.id, name: item.lead.name, doi: item.doi, error: cause instanceof Error ? cause.message : String(cause), updated: false })
    }
  }
  const errors = outcomes.filter((outcome) => outcome.error)
  console.log(JSON.stringify({
    ok: errors.length === 0 && selected.length === outcomes.length,
    mode: apply ? 'apply' : 'preview',
    selected: selected.length,
    resolved: outcomes.length - errors.length,
    updated: outcomes.filter((outcome) => outcome.updated).length,
    errors,
    outcomes,
  }, null, 2))
  if (errors.length > 0) process.exitCode = 1
}

await main().finally(async () => pool.end())
