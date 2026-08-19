import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { leads, radarCandidates } from '../db/schema.js'
import { applyLeadFieldPolicy } from '../services/leadFieldProvenance.js'
import { mergePaperMetadataPreservingAuthors } from '../services/paperMetadata.js'
import { parseFeedEntries } from '../services/radarCollectorService.js'
import { ingestRadarCandidates } from '../services/radarDataMigrationService.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function arxivId(value: unknown): string {
  return text(value).match(/(?:arxiv(?:\.org)?[:/]\s*)?(\d{4}\.\d{4,5})(?:v\d+)?/i)?.[1] ?? ''
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

async function fetchArxivAuthors(ids: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  for (const batch of chunks(ids, 50)) {
    const url = new URL('https://export.arxiv.org/api/query')
    url.searchParams.set('id_list', batch.join(','))
    url.searchParams.set('max_results', String(batch.length))
    const response = await fetch(url, {
      headers: { 'User-Agent': 'sbl-jedi-paper-author-backfill/1.0 (metadata repair)' },
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`arXiv API HTTP ${response.status} ${response.statusText}`)
    for (const entry of parseFeedEntries(await response.text())) {
      const id = arxivId(entry.id || entry.link)
      if (id && entry.authors.length > 0) result.set(id, entry.authors)
    }
  }
  return result
}

async function main() {
  const apply = process.argv.includes('--apply')
  const leadRows = await db.select({
    id: leads.id,
    name: leads.name,
    radarProfile: leads.radarProfile,
    fieldProvenance: leads.fieldProvenance,
  }).from(leads)
  const missing = leadRows.filter((lead) => {
    const radarProfile = object(lead.radarProfile)
    const paperMeta = object(radarProfile.paperMeta)
    return text(radarProfile.channel) === '论文'
      && (!Array.isArray(paperMeta.authors) || paperMeta.authors.length === 0)
      && Boolean(arxivId(radarProfile.sourceId || paperMeta.pdfUrl || paperMeta.titleOriginal))
  })
  const ids = [...new Set(missing.map((lead) => {
    const radarProfile = object(lead.radarProfile)
    const paperMeta = object(radarProfile.paperMeta)
    return arxivId(radarProfile.sourceId || paperMeta.pdfUrl || paperMeta.titleOriginal)
  }).filter(Boolean))]
  const authorsById = await fetchArxivAuthors(ids)

  let updatedLeads = 0
  let updatedCandidates = 0
  if (apply) {
    const candidateRows = await db.select({ payload: radarCandidates.payload }).from(radarCandidates)
    const repairedCandidates = candidateRows.flatMap((row) => {
      const payload = object(row.payload)
      const id = arxivId(payload.source_id || payload.id || payload.link || payload.pdf_url)
      const authors = authorsById.get(id)
      if (!authors?.length) return []
      return [{
        ...payload,
        authors,
        first_author: authors[0] || '',
        second_author: authors[1] || '',
      }]
    })
    if (repairedCandidates.length > 0) {
      updatedCandidates = await ingestRadarCandidates(repairedCandidates)
    }

    for (const lead of missing) {
      const radarProfile = object(lead.radarProfile)
      const paperMeta = object(radarProfile.paperMeta)
      const id = arxivId(radarProfile.sourceId || paperMeta.pdfUrl || paperMeta.titleOriginal)
      const authors = authorsById.get(id)
      if (!authors?.length) continue
      const patch = applyLeadFieldPolicy(
        lead as unknown as Record<string, unknown>,
        { radarProfile: {
          ...radarProfile,
          paperMeta: mergePaperMetadataPreservingAuthors(paperMeta, {
            authors,
            firstAuthor: authors[0] || '',
            secondAuthor: authors[1] || '',
          }),
        } },
        'deterministic_backfill',
        { alwaysReplaceFields: ['radarProfile'], operation: 'machine_refresh' },
      )
      if (Object.keys(patch).length === 0) continue
      await db.update(leads).set(patch as never).where(eq(leads.id, lead.id))
      updatedLeads += 1
    }
  }

  const unresolved = missing.flatMap((lead) => {
    const radarProfile = object(lead.radarProfile)
    const paperMeta = object(radarProfile.paperMeta)
    const id = arxivId(radarProfile.sourceId || paperMeta.pdfUrl || paperMeta.titleOriginal)
    return authorsById.has(id) ? [] : [{ id: lead.id, arxivId: id, name: lead.name }]
  })
  console.log(JSON.stringify({
    ok: unresolved.length === 0,
    mode: apply ? 'apply' : 'preview',
    missingLeads: missing.length,
    requestedArxivIds: ids.length,
    resolvedAuthors: authorsById.size,
    updatedLeads,
    updatedCandidates,
    unresolved,
  }, null, 2))
}

await main().finally(async () => pool.end())
