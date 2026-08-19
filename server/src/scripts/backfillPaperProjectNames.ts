import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { leads, radarCandidates } from '../db/schema.js'
import { applyLeadFieldPolicy } from '../services/leadFieldProvenance.js'
import { resolvePaperProjectIdentity } from '../services/paperIdentity.js'
import { reviewRadarCandidatesWithAi, type RadarAiReviewResult } from '../services/radarAiReviewService.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalized(value: unknown): string {
  return text(value).normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
}

function sourceIdOf(payload: JsonObject): string {
  return text(payload.source_id || payload.id || payload.openalex_id)
}

function candidateForLead(
  lead: { name: string; radarProfile: unknown },
  candidatesBySourceId: Map<string, JsonObject>,
  candidatesByTitle: Map<string, JsonObject>,
): JsonObject {
  const radarProfile = object(lead.radarProfile)
  const paperMeta = object(radarProfile.paperMeta)
  const sourceId = text(radarProfile.sourceId)
  const title = text(paperMeta.titleOriginal || paperMeta.title || radarProfile.sourceTitle || lead.name)
  return candidatesBySourceId.get(sourceId)
    || candidatesByTitle.get(normalized(title))
    || {
      source: 'paper-backfill',
      source_group: '论文',
      source_id: sourceId || `lead:${lead.name}`,
      title,
      summary: text(paperMeta.abstractOriginal || paperMeta.abstract || lead.name),
      authors: Array.isArray(paperMeta.authors) ? paperMeta.authors : [],
      categories: Array.isArray(paperMeta.categories) ? paperMeta.categories : [],
      pdf_url: text(paperMeta.pdfUrl),
    }
}

function identityForLead(lead: { name: string; radarProfile: unknown }, review?: RadarAiReviewResult) {
  const radarProfile = object(lead.radarProfile)
  const paperMeta = object(radarProfile.paperMeta)
  return resolvePaperProjectIdentity({
    titleOriginal: paperMeta.titleOriginal || paperMeta.title || radarProfile.sourceTitle || lead.name,
    titleZh: paperMeta.titleZh || object(radarProfile.aiSubjectReview).translatedTitle,
    modelProjectName: review?.paperProjectName || paperMeta.projectNameOriginal,
    modelProjectNameZh: review?.paperProjectNameZh || paperMeta.projectName,
  })
}

async function main() {
  const apply = process.argv.includes('--apply')
  const limitArg = process.argv.find((value) => value.startsWith('--limit='))
  const limit = limitArg ? Math.max(1, Number(limitArg.slice('--limit='.length)) || 1) : undefined
  const leadId = process.argv.find((value) => value.startsWith('--lead-id='))?.slice('--lead-id='.length)

  const candidateRows = await db.select({ payload: radarCandidates.payload }).from(radarCandidates)
  const paperCandidates = candidateRows
    .map((row) => object(row.payload))
    .filter((payload) => text(payload.source_group) === '论文' || /arxiv|openalex/i.test(text(payload.source)))
  const candidatesBySourceId = new Map<string, JsonObject>()
  const candidatesByTitle = new Map<string, JsonObject>()
  for (const candidate of paperCandidates) {
    const sourceId = sourceIdOf(candidate)
    const title = text(candidate.title)
    if (sourceId) candidatesBySourceId.set(sourceId, candidate)
    if (title) candidatesByTitle.set(normalized(title), candidate)
  }

  let paperLeads = (await db.select({
    id: leads.id,
    name: leads.name,
    radarProfile: leads.radarProfile,
    scoring: leads.scoring,
    fieldProvenance: leads.fieldProvenance,
  }).from(leads)).filter((lead) => text(object(lead.radarProfile).channel) === '论文')
  if (leadId) paperLeads = paperLeads.filter((lead) => lead.id === leadId)
  if (limit) paperLeads = paperLeads.slice(0, limit)

  const candidates = paperLeads.map((lead) => candidateForLead(lead, candidatesBySourceId, candidatesByTitle))
  const reviews = apply ? await reviewRadarCandidatesWithAi(candidates) : []
  const proposed = paperLeads.map((lead, index) => {
    const review = reviews[index]
    const acceptedReview = review?.status === 'accepted' && review.subjectType === 'paper' ? review : undefined
    const identity = identityForLead(lead, acceptedReview)
    const radarProfile = object(lead.radarProfile)
    const profile = object(radarProfile.profile)
    const paperMeta = object(radarProfile.paperMeta)
    return {
      lead,
      review: acceptedReview,
      identity,
      oldProjectName: text(paperMeta.projectName || profile.projectName || paperMeta.titleZh || lead.name),
    }
  })

  const changed = proposed.filter((item) => item.identity.projectName && item.identity.projectName !== item.oldProjectName)
  if (apply) {
    await db.transaction(async (tx) => {
      for (const item of proposed) {
        if (!item.identity.projectName) continue
        const radarProfile = object(item.lead.radarProfile)
        const profile = object(radarProfile.profile)
        const paperMeta = object(radarProfile.paperMeta)
        const scoring = object(item.lead.scoring)
        const nextRadarProfile = {
          ...radarProfile,
          profile: { ...profile, projectName: item.identity.projectName },
          paperMeta: {
            ...paperMeta,
            projectName: item.identity.projectName,
            projectNameOriginal: item.identity.projectNameOriginal,
          },
          ...(item.review ? {
            aiSubjectReview: {
              ...object(radarProfile.aiSubjectReview),
              decision: item.review.decision,
              subjectType: item.review.subjectType,
              subjectName: item.review.subjectName,
              legalName: item.review.legalName,
              evidence: item.review.evidence,
              translatedTitle: item.review.translatedTitle,
              paperProjectName: item.review.paperProjectName,
              paperProjectNameZh: item.review.paperProjectNameZh,
              translatedSummary: item.review.translatedSummary,
              confidence: item.review.confidence,
              model: item.review.model,
              reviewedAt: item.review.reviewedAt,
              cacheHit: item.review.cacheHit,
            },
          } : {}),
        }
        const patchInput: Record<string, unknown> = { radarProfile: nextRadarProfile }
        if (Object.keys(scoring).length) patchInput.scoring = { ...scoring, projectName: item.identity.projectName }
        const patch = applyLeadFieldPolicy(
          item.lead as unknown as Record<string, unknown>,
          patchInput,
          'deterministic_backfill',
          { alwaysReplaceFields: Object.keys(patchInput), operation: 'machine_refresh' },
        )
        await tx.update(leads).set(patch as never).where(eq(leads.id, item.lead.id))
      }
    })
  }

  console.log(JSON.stringify({
    ok: true,
    mode: apply ? 'apply' : 'preview',
    paperCandidates: paperCandidates.length,
    paperLeads: paperLeads.length,
    reviewed: reviews.length,
    acceptedReviews: proposed.filter((item) => item.review).length,
    changed: changed.length,
    samples: proposed.slice(0, 30).map((item) => ({
      id: item.lead.id,
      paperTitle: item.lead.name,
      oldProjectName: item.oldProjectName,
      projectName: item.identity.projectName,
      projectNameOriginal: item.identity.projectNameOriginal,
      reviewStatus: item.review?.status || (apply ? 'fallback' : 'not-run'),
    })),
  }, null, 2))
}

await main().finally(async () => pool.end())

