import { eq, or } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { leads, radarCandidates } from '../db/schema.js'
import { applyLeadFieldPolicy } from '../services/leadFieldProvenance.js'

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

function key(value: unknown): string {
  return text(value).normalize('NFKC').toLocaleLowerCase('zh-CN')
}

function paperMetadata(payload: JsonObject) {
  const profile = object(payload.project_profile)
  const authors = list(payload.authors ?? profile.paper_authors)
  return {
    title: text(payload.title ?? profile.paper_title),
    titleOriginal: text(payload.title ?? profile.paper_title),
    authors,
    firstAuthor: text(payload.first_author ?? profile.paper_first_author) || authors[0] || '',
    secondAuthor: text(payload.second_author ?? profile.paper_second_author) || authors[1] || '',
    categories: list(payload.categories ?? profile.paper_categories),
    venue: text(payload.journal_ref ?? profile.paper_venue),
    comment: text(payload.comment ?? profile.paper_comment),
    pdfUrl: text(payload.pdf_url ?? profile.paper_pdf_url),
    abstract: text(payload.summary).slice(0, 4_000),
    abstractOriginal: text(payload.summary).slice(0, 4_000),
    publishedAt: text(payload.published_at),
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const candidates = await db.select({ payload: radarCandidates.payload })
    .from(radarCandidates)
    .where(or(eq(radarCandidates.source, 'arxiv'), eq(radarCandidates.sourceGroup, 'arxiv')))
  const byTitle = new Map<string, ReturnType<typeof paperMetadata>>()
  for (const candidate of candidates) {
    const metadata = paperMetadata(object(candidate.payload))
    if (metadata.title) byTitle.set(key(metadata.title), metadata)
  }

  const paperLeads = (await db.select({
    id: leads.id,
    name: leads.name,
    radarProfile: leads.radarProfile,
    fieldProvenance: leads.fieldProvenance,
  }).from(leads))
    .filter((lead) => text(object(lead.radarProfile).channel) === '论文')
  let matched = 0
  let updated = 0
  const unmatched: Array<{ id: string; name: string }> = []
  for (const lead of paperLeads) {
    const existing = object(lead.radarProfile)
    const existingPaper = object(existing.paperMeta)
    const metadata = byTitle.get(key(lead.name))
      ?? byTitle.get(key(existingPaper.titleOriginal))
      ?? byTitle.get(key(existingPaper.title))
    if (!metadata) {
      unmatched.push({ id: lead.id, name: lead.name })
      continue
    }
    matched += 1
    if (!apply) continue
    const patch = applyLeadFieldPolicy(
      lead as unknown as Record<string, unknown>,
      { radarProfile: {
        ...existing,
        paperMeta: { ...existingPaper, ...metadata },
      } },
      'deterministic_backfill',
      { alwaysReplaceFields: ['radarProfile'], operation: 'machine_refresh' },
    )
    await db.update(leads).set(patch as never).where(eq(leads.id, lead.id))
    updated += 1
  }

  console.log(JSON.stringify({
    ok: true,
    mode: apply ? 'apply' : 'preview',
    radarPaperCandidates: candidates.length,
    paperLeads: paperLeads.length,
    matched,
    updated,
    unmatchedCount: unmatched.length,
    unmatched: unmatched.slice(0, 100),
  }))
}

await main().finally(async () => pool.end())
