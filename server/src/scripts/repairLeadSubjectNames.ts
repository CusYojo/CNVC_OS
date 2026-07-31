import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { leads } from '../db/schema.js'
import {
  reviewRadarCandidatesWithAi,
  type RadarAiReviewResult,
} from '../services/radarAiReviewService.js'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function firstSourceTitle(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const source = asRecord(value[0])
  return typeof source.title === 'string' ? source.title.trim() : ''
}

function toRadarCandidate(row: typeof leads.$inferSelect): Record<string, unknown> {
  const radarProfile = asRecord(row.radarProfile)
  const profile = asRecord(radarProfile.profile)
  return {
    source: `lead-repair:${String(radarProfile.channel || 'radar')}`,
    source_id: String(radarProfile.radarSourceKey || row.id),
    title: String(radarProfile.sourceTitle || firstSourceTitle(row.sources) || row.name),
    summary: row.summary || '',
    article_text: radarProfile.articleText || '',
    project_profile: {
      project_name: profile.projectName || row.name,
      company_name: profile.companyName || row.companyName || '',
      legal_entity: row.companyName || '',
      project_round: profile.projectRound || '',
      financing_amount: profile.financingAmount || '',
      latest_valuation: profile.latestValuation || '',
      institutions: profile.institutions || '',
      core_highlights: profile.coreHighlights || '',
      team_composition: profile.teamComposition || row.team || '',
      lab: profile.lab || '',
    },
  }
}

function reviewProfile(
  radarProfile: Record<string, unknown>,
  review: RadarAiReviewResult,
) {
  const profile = asRecord(radarProfile.profile)
  const accepted = review.status === 'accepted'
  return {
    ...radarProfile,
    qualityRejected: !accepted,
    qualityRejectReason: accepted
      ? ''
      : review.rejectReason || (
        review.status === 'failed'
          ? 'AI 主体审查暂不可用'
          : '未通过 AI 投资线索审查'
      ),
    aiSubjectReview: {
      decision: review.decision,
      subjectType: review.subjectType,
      subjectName: review.subjectName,
      legalName: review.legalName,
      evidence: review.evidence,
      confidence: review.confidence,
      rejectReason: review.rejectReason,
      model: review.model,
      reviewedAt: review.reviewedAt,
      cacheHit: review.cacheHit,
    },
    profile: accepted ? {
      ...profile,
      projectName: review.subjectName,
      companyName: review.legalName
        || (review.subjectType === 'company' ? review.subjectName : ''),
    } : profile,
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const sinceArg = process.argv.find((value) => value.startsWith('--since='))
  const sinceValue = sinceArg?.slice('--since='.length)
  const since = sinceValue ? new Date(sinceValue) : null
  const limitArg = process.argv.find((value) => value.startsWith('--limit='))
  const limit = Math.max(1, Math.min(Number(limitArg?.slice('--limit='.length)) || 50, 200))
  if (sinceValue && Number.isNaN(since?.getTime())) {
    throw new Error(`invalid --since timestamp: ${sinceValue}`)
  }
  if (apply && !since) {
    throw new Error('--apply requires --since=<ISO timestamp> to prevent an unbounded repair')
  }

  const radarSourceCondition = sql`COALESCE(${leads.source}, '') LIKE '项目发现雷达%'`
  const rows = await db.select().from(leads)
    .where(since
      ? and(radarSourceCondition, gte(leads.createdAt, since))
      : radarSourceCondition)
    .orderBy(desc(leads.createdAt))
    .limit(limit)
  const reviews = await reviewRadarCandidatesWithAi(rows.map(toRadarCandidate))

  const counts = {
    accepted: 0,
    rejected: 0,
    review: 0,
    failed: 0,
    renamed: 0,
    hidden: 0,
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const review = reviews[index]
    counts[review.status] += 1
    const accepted = review.status === 'accepted'
    const nextName = accepted ? review.subjectName.slice(0, 128) : row.name
    const nextCompanyName = accepted
      ? (
          review.legalName
          || (review.subjectType === 'company' ? review.subjectName : '')
        ).slice(0, 128) || null
      : row.companyName
    if (accepted && nextName !== row.name) counts.renamed += 1
    if (!accepted) counts.hidden += 1
    console.log(JSON.stringify({
      id: row.id,
      status: review.status,
      currentName: row.name,
      nextName,
      subjectType: review.subjectType,
      confidence: review.confidence,
      reason: review.rejectReason,
      cacheHit: review.cacheHit,
    }))
    if (!apply) continue

    await db.update(leads).set({
      ...(accepted ? {
        name: nextName,
        companyName: nextCompanyName,
      } : {}),
      radarProfile: reviewProfile(asRecord(row.radarProfile), review),
    }).where(eq(leads.id, row.id))
  }

  console.log(JSON.stringify({
    mode: apply ? 'applied' : 'preview',
    reviewed: rows.length,
    ...counts,
  }))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
