import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { buildLeadResearchProfile, refreshLeadResearchProfileProjection } from '../services/leadResearchProfileProjectionService.js'

const apply = process.argv.includes('--apply')
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length)
const limit = Math.min(10_000, Math.max(1, Number.parseInt(limitArg || '500', 10) || 500))
const leadIds = [...new Set((process.argv.find((arg) => arg.startsWith('--lead-ids='))?.slice('--lead-ids='.length) || '').split(',').map((value) => value.trim()).filter(Boolean))]
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const profilesTable = quoteMysqlIdentifier(mysqlTableName('lead_research_profile_projections'))

const [rows] = await pool.query<Array<RowDataPacket & { id: string; name: string; radar_profile: unknown; updated_at: Date; current_hash: string | null }>>(
  `SELECT l.id,l.name,l.radar_profile,l.created_at updated_at,p.source_hash current_hash
   FROM ${leadsTable} l LEFT JOIN ${profilesTable} p ON p.lead_id=l.id
   WHERE l.pool_status NOT IN ('解析失败','已合并','已删除','已注销','已转专属项目')
     AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.radar_profile,'$.channel')),'')='论文'
     ${leadIds.length ? `AND l.id IN (${leadIds.map(() => '?').join(',')})` : ''}
   ORDER BY l.created_at DESC,l.id DESC LIMIT ?`,
  [...leadIds, limit],
)

const preview = rows.map((row) => {
  const profile = buildLeadResearchProfile({ leadId: row.id, name: row.name, radarProfile: row.radar_profile, updatedAt: row.updated_at })
  return {
    leadId: row.id,
    status: profile.dataStatus.status,
    source: profile.dataStatus.source,
    authors: profile.team.authors.length,
    affiliations: profile.team.affiliations.length,
    categories: profile.direction.categories.length,
    artifacts: [profile.progress.codeUrl, profile.progress.datasetUrl, profile.progress.modelUrl].filter(Boolean).length,
    current: Boolean(row.current_hash),
  }
})

if (!apply) {
  console.log(JSON.stringify({
    mode: 'preview', database: mysqlConfig.database, tablePrefix: mysqlConfig.tablePrefix,
    selected: rows.length, modelCalls: 0,
    coverage: {
      withCurrentProjection: preview.filter((item) => item.current).length,
      withAuthors: preview.filter((item) => item.authors > 0).length,
      withAffiliations: preview.filter((item) => item.affiliations > 0).length,
      withCategories: preview.filter((item) => item.categories > 0).length,
      withArtifacts: preview.filter((item) => item.artifacts > 0).length,
    },
    sample: preview.slice(0, 20),
  }, null, 2))
  await pool.end()
  process.exit(0)
}

let changed = 0
let unchanged = 0
const failures: Array<{ leadId: string; error: string }> = []
for (const row of rows) {
  try {
    const result = await refreshLeadResearchProfileProjection({ leadId: row.id })
    if (!result) throw new Error('research lead disappeared')
    if (result.write.changed) changed += 1
    else unchanged += 1
  } catch (error) {
    failures.push({ leadId: row.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000) })
  }
}
console.log(JSON.stringify({ mode: 'apply', database: mysqlConfig.database, selected: rows.length, changed, unchanged, failed: failures.length, modelCalls: 0, failures }, null, 2))
await pool.end()
if (failures.length) process.exitCode = 1
