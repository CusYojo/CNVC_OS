import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { leads } from '../db/schema.js'
import { resolveLeadBusinessRegion } from './leadRegion.js'
import { deriveRadarSubjectName, isSpecificLeadSubjectName } from './leadSubjectName.js'

const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

export async function backfillLeadBusinessRegions() {
  const rows = await db.select().from(leads)
  let updated = 0
  let resolved = 0
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
    await db.update(leads).set({
      businessRegion: resolution.region,
      businessRegionSource: resolution.source,
      businessRegionConfidence: resolution.confidence,
    }).where(eq(leads.id, row.id))
    updated += 1
  }
  return { scanned: rows.length, updated, unresolved: rows.length - resolved }
}
