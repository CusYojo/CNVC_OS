import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { leads } from '../db/schema.js'
import { resolveLeadBusinessRegion } from './leadRegion.js'
import { deriveRadarSubjectName, isSpecificLeadSubjectName } from './leadSubjectName.js'
import { applyLeadFieldPolicy } from './leadFieldProvenance.js'

const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

export type LeadRegionBackfillCandidate = {
  id: string
  currentRegion: string | null
  currentSource: string | null
  currentConfidence: string | null
  proposedRegion: string
  proposedSource: string
  proposedConfidence: string
  patch: Record<string, unknown>
}

export function assertLeadRegionBackfillAllowed(env: NodeJS.ProcessEnv = process.env) {
  if (env.ALLOW_LEAD_REGION_BACKFILL !== 'true') {
    throw new Error('lead region backfill requires ALLOW_LEAD_REGION_BACKFILL=true and explicit database-write authorization')
  }
}

export async function previewLeadBusinessRegions() {
  const rows = await db.select().from(leads)
  let resolved = 0
  const candidates: LeadRegionBackfillCandidate[] = []
  for (const row of rows) {
    const scoring = objectValue(row.scoring)
    const radarProfile = objectValue(row.radarProfile)
    const profile = objectValue(radarProfile.profile)
    const sourceTitle = String(radarProfile.sourceTitle || '').trim()
    const isPaper = String(radarProfile.channel || '') === '论文'
    const derivedSubjectName = deriveRadarSubjectName({
      isPaper,
      companyNames: [
        objectValue(scoring.registry).companyName,
        row.companyName,
        profile.companyName,
      ],
      projectName: profile.projectName,
      lab: profile.lab,
      team: profile.teamComposition || row.team,
      title: sourceTitle || row.name,
      articleText: radarProfile.articleText || row.summary,
      excludedNames: [radarProfile.sourceName, radarProfile.accountName],
    })
    const subjectName = derivedSubjectName
      || (isSpecificLeadSubjectName(row.name, isPaper) ? row.name : '')
    const resolution = resolveLeadBusinessRegion({
      registry: objectValue(scoring.registry),
      profile,
      subjectName,
      companyName: row.companyName,
      sourceGroup: radarProfile.sourceGroup,
      channel: radarProfile.channel,
      sourceName: radarProfile.sourceName,
      accountName: radarProfile.accountName,
      sourceTitle,
      summary: row.summary,
      articleText: radarProfile.articleText,
    })
    if (!resolution) continue
    resolved += 1
    const confidenceRank = (value: unknown) => value === '高' ? 2 : value === '中' ? 1 : 0
    if (
      row.businessRegion
      && confidenceRank(resolution.confidence) < confidenceRank(row.businessRegionConfidence)
    ) continue
    if (
      row.businessRegion === resolution.region
      && row.businessRegionSource === resolution.source
      && row.businessRegionConfidence === resolution.confidence
    ) continue
    const patch = applyLeadFieldPolicy(
      row as unknown as Record<string, unknown>,
      {
        businessRegion: resolution.region,
        businessRegionSource: resolution.source,
        businessRegionConfidence: resolution.confidence,
      },
      'deterministic_backfill',
      {
        linkedFields: [['businessRegion', 'businessRegionSource', 'businessRegionConfidence']],
        operation: 'machine_refresh',
      },
    )
    if (!Object.keys(patch).length) continue
    candidates.push({
      id: row.id,
      currentRegion: row.businessRegion,
      currentSource: row.businessRegionSource,
      currentConfidence: row.businessRegionConfidence,
      proposedRegion: resolution.region,
      proposedSource: resolution.source,
      proposedConfidence: resolution.confidence,
      patch,
    })
  }
  return { scanned: rows.length, resolved, unresolved: rows.length - resolved, candidates }
}

export async function backfillLeadBusinessRegions() {
  assertLeadRegionBackfillAllowed()
  const preview = await previewLeadBusinessRegions()
  let updated = 0
  for (const candidate of preview.candidates) {
    await db.update(leads).set(candidate.patch as never).where(eq(leads.id, candidate.id))
    updated += 1
  }
  return { scanned: preview.scanned, updated, unresolved: preview.unresolved }
}
