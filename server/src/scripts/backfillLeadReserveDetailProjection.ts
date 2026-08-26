import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { normalizeLeadRegistry } from '../services/leadRegistry.js'
import { mergeRadarFundingRounds, mergeRadarSources } from '../services/leadRadarMerge.js'
import {
  mergeLeadScoringWithRetainedSources,
  mergeLeadSourceEntries,
  project36KrLeadDetail,
} from '../services/leadReserveProjection.js'

type JsonObject = Record<string, any>
type LeadReserveProjectionRow = RowDataPacket & {
  reserve_id: number
  src_id: string | null
  reserve_name: string | null
  detail_url: string | null
  detail_json: unknown
  lead_id: string
  scoring: unknown
  radar_profile: unknown
  funding_rounds: unknown
  sources: unknown
}

const apply = process.argv.includes('--apply')
const limitArgument = process.argv.find((argument) => argument.startsWith('--limit='))?.slice('--limit='.length)
const limit = limitArgument ? Math.max(1, Math.min(10_000, Number(limitArgument) || 10_000)) : 10_000
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const reserveTable = quoteMysqlIdentifier(mysqlTableName('lead_reserve'))
const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))

function record(value: unknown): JsonObject {
  if (!value) return {}
  if (typeof value === 'string') {
    try { return JSON.parse(value) as JsonObject } catch { return {} }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function meaningful(value: unknown): boolean {
  return typeof value === 'string' && Boolean(value.trim()) && !['待核验', '待核实', '未披露', '-', 'null'].includes(value.trim())
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const [rows] = await pool.query<LeadReserveProjectionRow[]>(
  `SELECT r.id reserve_id,r.src_id,r.name reserve_name,r.detail_url,r.detail_json,
          l.id lead_id,l.scoring,l.radar_profile,l.funding_rounds,l.sources
     FROM ${reserveTable} r JOIN ${leadsTable} l ON l.id=r.imported_lead_id
    WHERE r.imported=1 AND r.imported_lead_id IS NOT NULL AND r.detail_json IS NOT NULL
    ORDER BY r.id LIMIT ?`,
  [limit],
)

const patches: Array<{
  reserveId: number
  leadId: string
  name: string
  scoring: JsonObject
  radarProfile: JsonObject
  fundingRounds: unknown[]
  sources: unknown[]
  fields: string[]
}> = []
const summary = {
  mode: apply ? 'apply' : 'preview',
  candidates: rows.length,
  changed: 0,
  projectIntroductionAdded: 0,
  projectIntroductionUpgraded: 0,
  teamsAdded: 0,
  shareholdersRestored: 0,
  officialSitesAdded: 0,
  registryEvidenceAdded: 0,
  fundingRoundsAdded: 0,
}

for (const row of rows) {
  const currentScoring = record(row.scoring)
  const currentRadarProfile = record(row.radar_profile)
  const currentProfile = record(currentRadarProfile.profile)
  const projection = project36KrLeadDetail(row.detail_json, row.detail_url, row.reserve_name || '')
  const registry = normalizeLeadRegistry(currentScoring.registry, projection.registry, currentRadarProfile.registry)
  const retainedTeam = mergeLeadSourceEntries(projection.structuredTeam, currentScoring.structuredTeam, ['name'])
  const retainedShareholders = mergeLeadSourceEntries(
    projection.structuredShareholders,
    currentScoring.structuredShareholders,
    ['name'],
  )
  const sourceLabeledProfile = {
    ...record(currentScoring.sourceLabeledProfile),
    ...projection.sourceLabeledProfile,
  }
  const incomingScoring = {
    ...(projection.officialSite ? { officialSite: projection.officialSite } : {}),
    registryEvidence: mergeLeadSourceEntries(
      projection.registryEvidence,
      currentScoring.registryEvidence,
      ['field', 'sourceUrl', 'value'],
    ),
    sourceLabeledProfile,
    structuredTeam: retainedTeam,
    structuredShareholders: retainedShareholders,
    fundingRoundsResearched: mergeLeadSourceEntries(
      projection.fundingRounds,
      currentScoring.fundingRoundsResearched,
      ['sourceFinancingId', 'round', 'date'],
    ),
  }
  const scoring = mergeLeadScoringWithRetainedSources(currentScoring, incomingScoring, registry, {
    preserveDataQuality: true,
  })
  const radarProfile = {
    ...currentRadarProfile,
    profile: {
      projectName: projection.projectName,
      companyName: projection.companyName,
      projectRound: projection.projectRound,
      industry: projection.industry,
      region: projection.region,
      ...currentProfile,
      ...(!meaningful(currentProfile.projectIntroduction) && projection.introduction
        ? { projectIntroduction: projection.introduction } : {}),
      ...(!meaningful(currentProfile.logoUrl) && projection.logoUrl ? { logoUrl: projection.logoUrl } : {}),
    },
  }
  const fundingRounds = mergeRadarFundingRounds(row.funding_rounds, projection.fundingRounds)
  const source = projection.detailUrl ? [{
    title: projection.projectName,
    url: projection.detailUrl,
    publisher: '36氪项目库',
    category: '36氪',
    reliability: '中',
    excerpt: projection.oneWord || projection.introduction.slice(0, 500),
  }] : []
  const sources = mergeRadarSources(row.sources, source)
  const fields: string[] = []
  if (!meaningful(currentProfile.projectIntroduction) && projection.introduction) {
    fields.push('projectIntroduction'); summary.projectIntroductionAdded += 1
  }
  const currentIntro = record(currentScoring.sourceLabeledProfile).projectIntroduction
  if (projection.introduction && stable(currentIntro) !== stable(record(projection.sourceLabeledProfile).projectIntroduction)) {
    fields.push('sourceLabeledProjectIntroduction'); summary.projectIntroductionUpgraded += 1
  }
  const currentTeamCount = array(currentScoring.structuredTeam).length
  if (retainedTeam.length > currentTeamCount) {
    fields.push('structuredTeam'); summary.teamsAdded += retainedTeam.length - currentTeamCount
  }
  const currentShareholderCount = array(currentScoring.structuredShareholders).length
  if (retainedShareholders.length > currentShareholderCount) {
    fields.push('structuredShareholders'); summary.shareholdersRestored += retainedShareholders.length - currentShareholderCount
  }
  if (!meaningful(currentScoring.officialSite) && projection.officialSite) {
    fields.push('officialSite'); summary.officialSitesAdded += 1
  }
  const currentEvidenceCount = array(currentScoring.registryEvidence).length
  const nextEvidenceCount = array(scoring.registryEvidence).length
  if (nextEvidenceCount > currentEvidenceCount) {
    fields.push('registryEvidence'); summary.registryEvidenceAdded += nextEvidenceCount - currentEvidenceCount
  }
  const currentFundingCount = array(row.funding_rounds).length
  if (fundingRounds.length > currentFundingCount) {
    fields.push('fundingRounds'); summary.fundingRoundsAdded += fundingRounds.length - currentFundingCount
  }
  if (stable(scoring) !== stable(currentScoring)) fields.push('scoringProjection')
  if (stable(radarProfile) !== stable(currentRadarProfile)) fields.push('radarProfileProjection')
  if (stable(fundingRounds) !== stable(row.funding_rounds)) fields.push('fundingRoundsProjection')
  if (stable(sources) !== stable(row.sources)) fields.push('sourcesProjection')
  if (
    stable(scoring) === stable(currentScoring)
    && stable(radarProfile) === stable(currentRadarProfile)
    && stable(fundingRounds) === stable(row.funding_rounds)
    && stable(sources) === stable(row.sources)
  ) continue
  patches.push({
    reserveId: row.reserve_id,
    leadId: row.lead_id,
    name: projection.projectName,
    scoring,
    radarProfile,
    fundingRounds,
    sources,
    fields: [...new Set(fields)],
  })
}
summary.changed = patches.length

if (apply && patches.length) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    for (const patch of patches) {
      await connection.query(
        `UPDATE ${leadsTable}
            SET scoring=CAST(? AS JSON),radar_profile=CAST(? AS JSON),funding_rounds=CAST(? AS JSON),sources=CAST(? AS JSON)
          WHERE id=?`,
        [
          JSON.stringify(patch.scoring),
          JSON.stringify(patch.radarProfile),
          JSON.stringify(patch.fundingRounds),
          JSON.stringify(patch.sources),
          patch.leadId,
        ],
      )
    }
    await connection.query(
      `INSERT INTO ${auditTable}
        (id,user_id,user_name,module,action,target,result,request_id,created_at)
       VALUES (?,NULL,'（系统）','项目获取池','回填36氪详情映射',?,'success',?,NOW(3))`,
      [randomUUID(), JSON.stringify(summary), randomUUID()],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

const jinwu = patches.find((patch) => patch.name === '尽无服饰') || patches[0]
console.log(JSON.stringify({
  ...summary,
  sample: jinwu ? { leadId: jinwu.leadId, reserveId: jinwu.reserveId, fields: jinwu.fields } : null,
}, null, 2))
await pool.end()
