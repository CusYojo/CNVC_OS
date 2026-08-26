import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { collectCompanyIntel } from '../services/inProcessAiWorkflowService.js'
import {
  commitLeadPublicIntel,
  meaningfulPublicIntelText,
  missingLeadCompanyIntelFields,
  type PublicIntelResult,
} from '../services/leadPublicIntelService.js'
import { isSpecificLeadSubjectName } from '../services/leadSubjectName.js'

type LeadRow = RowDataPacket & {
  id: string
  name: string
  company_name: string | null
  scoring: unknown
  radar_profile: unknown
}

const apply = process.argv.includes('--apply')
const retry = process.argv.includes('--retry')
const limitArgument = process.argv.find((argument) => argument.startsWith('--limit='))?.slice('--limit='.length)
const after = process.argv.find((argument) => argument.startsWith('--after='))?.slice('--after='.length) || ''
const leadId = process.argv.find((argument) => argument.startsWith('--lead-id='))?.slice('--lead-id='.length) || ''
const model = process.argv.find((argument) => argument.startsWith('--model='))?.slice('--model='.length) || 'gpt-5.6-sol'
const limit = Math.max(1, Math.min(Number(limitArgument) || 25, 250))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const priorAttemptFilter = retry
  ? ''
  : "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(scoring,'$.registryEnrichment.method')),'')<>'codex-evidence-bound-web-enrichment-v1'"

const [rows] = leadId
  ? await pool.query<LeadRow[]>(
      `SELECT id,name,company_name,scoring,radar_profile FROM ${leadsTable}
       WHERE pool_status NOT IN ('已删除','已合并') AND id=? LIMIT 1`,
      [leadId],
    )
  : await pool.query<LeadRow[]>(
      `SELECT id,name,company_name,scoring,radar_profile
       FROM ${leadsTable}
       WHERE pool_status NOT IN ('已删除','已合并') AND id>? ${priorAttemptFilter}
       ORDER BY id LIMIT ?`,
      [after, limit * 8],
    )

const summary = {
  mode: apply ? 'apply' : 'preview',
  model,
  scanned: 0,
  attempted: 0,
  enriched: 0,
  searchOnly: 0,
  skippedResearch: 0,
  skippedInvalidSubject: 0,
  skippedPreviouslyAttempted: 0,
  failed: 0,
  completedFields: {} as Record<string, number>,
  nextCursor: after,
}

for (const row of rows) {
  if (summary.attempted >= limit) break
  summary.scanned += 1
  summary.nextCursor = row.id
  const radar = row.radar_profile && typeof row.radar_profile === 'object' && !Array.isArray(row.radar_profile)
    ? row.radar_profile as Record<string, unknown>
    : {}
  const scoring = (() => {
    if (row.scoring && typeof row.scoring === 'object' && !Array.isArray(row.scoring)) {
      return row.scoring as Record<string, unknown>
    }
    if (typeof row.scoring === 'string') {
      try { return JSON.parse(row.scoring) as Record<string, unknown> } catch { return {} }
    }
    return {}
  })()
  const priorEnrichment = scoring.registryEnrichment && typeof scoring.registryEnrichment === 'object'
    ? scoring.registryEnrichment as Record<string, unknown>
    : {}
  if (!retry && priorEnrichment.method === 'codex-evidence-bound-web-enrichment-v1') {
    summary.skippedPreviouslyAttempted += 1
    continue
  }
  if (String(radar.channel || '') === '论文' || Object.keys(
    radar.paperMeta && typeof radar.paperMeta === 'object' ? radar.paperMeta as object : {},
  ).length) {
    summary.skippedResearch += 1
    continue
  }
  const company = meaningfulPublicIntelText(row.company_name) || meaningfulPublicIntelText(row.name)
  // 品牌简称可以进入实体检索，但写回的法律字段仍必须通过
  // leadCompanyIntelExtractionService 的逐字段证据和法定名称校验。
  if (!company || !isSpecificLeadSubjectName(company)) {
    summary.skippedInvalidSubject += 1
    continue
  }
  const missingBefore = missingLeadCompanyIntelFields({ scoring: row.scoring, radarProfile: row.radar_profile })
  if (!missingBefore.length) continue
  summary.attempted += 1
  try {
    const intel = await collectCompanyIntel({
      company,
      registryFields: missingBefore,
      topics: ['企业官网与工商登记信息'],
      model,
    }) as PublicIntelResult
    const completed = intel.registryEnrichment?.completedFields || []
    if (completed.length) {
      summary.enriched += 1
      for (const field of completed) summary.completedFields[field] = (summary.completedFields[field] || 0) + 1
    } else {
      summary.searchOnly += 1
    }
    if (apply) {
      await commitLeadPublicIntel({ company, intel, targetLeadId: row.id })
    }
    console.log(JSON.stringify({
      event: 'lead_registry_codex_enrichment',
      leadId: row.id,
      company,
      requestedFields: missingBefore,
      completedFields: completed,
      status: intel.registryEnrichment?.status || 'search_only',
      evidence: intel.registryEvidence || [],
      ...(!apply ? { sources: intel.sources || [] } : {}),
      applied: apply,
    }))
  } catch (error) {
    summary.failed += 1
    console.error(JSON.stringify({
      event: 'lead_registry_codex_enrichment_failed',
      leadId: row.id,
      company,
      error: error instanceof Error ? error.message : String(error),
    }))
  }
}

console.log(JSON.stringify({ ok: summary.failed === 0, ...summary }, null, 2))
await pool.end()
