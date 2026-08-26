import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { leads } from '../db/schema.js'
import { applyLeadFieldPolicy } from '../services/leadFieldProvenance.js'
import { mergePaperMetadataPreservingAuthors } from '../services/paperMetadata.js'
import { arxivPaperId, fetchArxivResearchMetadata } from '../services/paperResearchMetadataService.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean)
  return text(value).split(/[,，;；]/).map((item) => item.trim()).filter(Boolean)
}

function argument(name: string): string {
  const prefix = `--${name}=`
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? ''
}

async function concurrentMap<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(values.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++
      result[index] = await mapper(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
  return result
}

async function main() {
  const apply = process.argv.includes('--apply')
  const requestedLeadId = argument('lead-id')
  const requestedLimit = Number.parseInt(argument('limit'), 10)
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : Number.POSITIVE_INFINITY
  const rows = await db.select({
    id: leads.id,
    name: leads.name,
    radarProfile: leads.radarProfile,
    fieldProvenance: leads.fieldProvenance,
  }).from(leads)
  const paperLeads = rows.flatMap((lead) => {
    const radarProfile = object(lead.radarProfile)
    const paperMeta = object(radarProfile.paperMeta)
    if (text(radarProfile.channel) !== '论文') return []
    if (requestedLeadId && lead.id !== requestedLeadId) return []
    const id = arxivPaperId([
      radarProfile.sourceId,
      radarProfile.link,
      paperMeta.pdfUrl,
      paperMeta.metadataSource && object(paperMeta.metadataSource).url,
    ].map(text).find(Boolean) || '')
    if (!id) return []
    return [{
      lead,
      radarProfile,
      paperMeta,
      arxivId: id,
      authors: stringList(paperMeta.authors),
      projectName: text(paperMeta.projectName) || lead.name,
    }]
  }).slice(0, limit)

  const outcomes = await concurrentMap(paperLeads, 3, async (item) => {
    try {
      const researchMetadata = await fetchArxivResearchMetadata({
        arxivId: item.arxivId,
        authors: item.authors,
        projectName: item.projectName,
      })
      if (apply) {
        const patch = applyLeadFieldPolicy(
          item.lead as unknown as Record<string, unknown>,
          { radarProfile: {
            ...item.radarProfile,
            paperMeta: mergePaperMetadataPreservingAuthors(item.paperMeta, researchMetadata as unknown as JsonObject),
          } },
          'deterministic_backfill',
          { alwaysReplaceFields: ['radarProfile'], operation: 'machine_refresh' },
        )
        if (Object.keys(patch).length > 0) {
          await db.update(leads).set(patch as never).where(eq(leads.id, item.lead.id))
        }
      }
      return {
        id: item.lead.id,
        name: item.lead.name,
        arxivId: item.arxivId,
        affiliations: researchMetadata.affiliations.map((affiliation) => affiliation.name),
        researchTeam: researchMetadata.researchTeam.name,
        authors: researchMetadata.researchTeam.memberCount,
        contributionRoles: researchMetadata.authorContributions.map((contribution) => contribution.label),
        articleLicense: researchMetadata.rights.articleLicense?.label || '未披露',
        intellectualProperty: researchMetadata.rights.intellectualProperty.label,
        updated: apply,
      }
    } catch (cause) {
      return {
        id: item.lead.id,
        name: item.lead.name,
        arxivId: item.arxivId,
        error: cause instanceof Error ? cause.message : String(cause),
        updated: false,
      }
    }
  })
  const errors = outcomes.filter((outcome) => 'error' in outcome)
  console.log(JSON.stringify({
    ok: errors.length === 0,
    mode: apply ? 'apply' : 'preview',
    selectedPaperLeads: paperLeads.length,
    resolved: outcomes.length - errors.length,
    updated: outcomes.filter((outcome) => outcome.updated).length,
    errors,
    outcomes,
  }, null, 2))
  if (errors.length > 0) process.exitCode = 1
}

await main().finally(async () => pool.end())
