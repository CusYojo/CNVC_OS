import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  LEAD_COMPANY_INTEL_FIELDS,
  type LeadCompanyIntelField,
} from '../services/leadCompanyIntelExtractionService.js'
import {
  LEAD_COMPANY_WEB_SEARCH_METHOD,
  searchCompaniesWithCodex,
  shouldAttemptLeadCompanyWebSearch,
  type CodexCompanyWebSearchResult,
} from '../services/leadCompanyWebSearchService.js'
import {
  commitLeadPublicIntel,
  meaningfulPublicIntelText,
  missingLeadCompanyIntelFields,
  type PublicIntelResult,
} from '../services/leadPublicIntelService.js'

type LeadRow = RowDataPacket & {
  id: string
  name: string
  company_name: string | null
  scoring: unknown
  radar_profile: unknown
}

type Candidate = {
  company: string
  requestedFields: LeadCompanyIntelField[]
  rows: LeadRow[]
}

const apply = process.argv.includes('--apply')
const retry = process.argv.includes('--retry')
const retryNoMatch = process.argv.includes('--retry-no-match')
const retryMissingIntroduction = process.argv.includes('--retry-missing-introduction')
const limit = Math.max(1, Math.min(Number(
  process.argv.find((argument) => argument.startsWith('--limit='))?.slice('--limit='.length),
) || 100, 2_000))
const batchSize = Math.max(1, Math.min(Number(
  process.argv.find((argument) => argument.startsWith('--batch-size='))?.slice('--batch-size='.length),
) || 5, 20))
const concurrency = Math.max(1, Math.min(Number(
  process.argv.find((argument) => argument.startsWith('--concurrency='))?.slice('--concurrency='.length),
) || 1, 8))
const model = process.argv.find((argument) => argument.startsWith('--model='))?.slice('--model='.length) || 'gpt-5.6-sol'
const companyFilters = new Set(process.argv
  .filter((argument) => argument.startsWith('--company='))
  .map((argument) => identity(argument.slice('--company='.length))))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const LEGAL_COMPANY_NAME = /(?:有限责任公司|股份有限公司|有限公司|集团有限公司|公司)$/

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown> } catch { return {} }
  }
  return {}
}

function identity(value: unknown) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()
}

const [rows] = await pool.query<LeadRow[]>(
  `SELECT id,name,company_name,scoring,radar_profile FROM ${leadsTable}
   WHERE pool_status NOT IN ('已删除','已合并')
   ORDER BY id`,
)

const groups = new Map<string, Candidate>()
let skippedNonCompany = 0
let skippedComplete = 0
let skippedPreviouslyAttempted = 0
for (const row of rows) {
  const radar = record(row.radar_profile)
  const explicitCompany = meaningfulPublicIntelText(row.company_name)
    || meaningfulPublicIntelText(radar.companyName)
  const company = explicitCompany
    || (LEGAL_COMPANY_NAME.test(meaningfulPublicIntelText(row.name)) ? meaningfulPublicIntelText(row.name) : '')
  // A populated company_name is allowed to be a brand or group alias. The web-search step
  // must resolve it to one evidence-backed legal entity before any registry facts are saved.
  if (!company) {
    skippedNonCompany += 1
    continue
  }
  if (companyFilters.size && !companyFilters.has(identity(company))) continue
  const scoring = record(row.scoring)
  const prior = record(scoring.registryEnrichment)
  const missing = missingLeadCompanyIntelFields({
    scoring,
    radarProfile: row.radar_profile,
    companyName: row.company_name,
  })
  if (!missing.length) {
    skippedComplete += 1
    continue
  }
  if (!shouldAttemptLeadCompanyWebSearch({
    priorMethod: prior.method,
    priorStatus: prior.status,
    missingFields: missing,
    retry,
    retryNoMatch,
    retryMissingIntroduction,
    companyIntroductionMissing: !meaningfulPublicIntelText(scoring.companyIntroduction),
  })) {
    skippedPreviouslyAttempted += 1
    continue
  }
  const key = identity(company)
  const current = groups.get(key) || { company, requestedFields: [], rows: [] }
  current.rows.push(row)
  current.requestedFields = [...new Set([...current.requestedFields, ...missing])]
  groups.set(key, current)
}

const candidates = [...groups.values()].slice(0, limit)
const batches: Candidate[][] = []
for (let offset = 0; offset < candidates.length; offset += batchSize) {
  batches.push(candidates.slice(offset, offset + batchSize))
}

const summary = {
  mode: apply ? 'apply' : 'preview',
  model,
  databaseRows: rows.length,
  eligibleCompanies: groups.size,
  selectedCompanies: candidates.length,
  selectedLeadRows: candidates.reduce((sum, item) => sum + item.rows.length, 0),
  completedCompanies: 0,
  completedLeadRows: 0,
  noMatchCompanies: 0,
  failedBatches: 0,
  failedCommits: 0,
  completedFields: {} as Record<string, number>,
  skippedNonCompany,
  skippedComplete,
  skippedPreviouslyAttempted,
}

function publicIntel(candidate: Candidate, result: CodexCompanyWebSearchResult | undefined): PublicIntelResult {
  const evidence = result?.evidence || []
  const values = Object.fromEntries(evidence.map((item) => [item.field, item.value]))
  const sources = result?.sources || []
  return {
    positioning: String(values.companyIntroduction || '未检索到可核验的公司介绍。'),
    canonicalCompanyName: String(values.companyName || ''),
    companyIntroduction: String(values.companyIntroduction || ''),
    website: String(values.website || ''),
    registeredCapital: String(values.registeredCapital || '待核验'),
    legalRepresentative: String(values.legalRepresentative || '待核验'),
    foundedAt: String(values.foundedAt || '待核验'),
    creditCode: String(values.creditCode || ''),
    registrationStatus: String(values.registrationStatus || ''),
    companyType: String(values.companyType || ''),
    region: '待核验',
    registeredAddress: String(values.registeredAddress || '待核验'),
    fundingRounds: [], shareholders: [], competitors: [], companyNews: [],
    sources,
    searchEvidence: sources.map((source) => ({
      query: `Codex 内置联网搜索：${candidate.company}`,
      title: source.title,
      url: source.url,
      reliability: source.reliability,
    })),
    registryEvidence: evidence,
    registryEnrichment: {
      method: LEAD_COMPANY_WEB_SEARCH_METHOD,
      model,
      requestedFields: candidate.requestedFields,
      completedFields: evidence.map((item) => item.field),
      status: evidence.length ? 'completed' : 'no_match',
    },
    confidence: Math.min(0.9, evidence.length / Math.max(1, candidate.requestedFields.length)),
    fetchedAt: new Date().toISOString(),
  }
}

let batchCursor = 0
async function worker() {
  while (batchCursor < batches.length) {
    const batchIndex = batchCursor++
    const batch = batches[batchIndex]
    let searched: Awaited<ReturnType<typeof searchCompaniesWithCodex>>
    try {
      searched = await searchCompaniesWithCodex({
        companies: batch.map((item) => ({ company: item.company, requestedFields: item.requestedFields })),
        model,
      })
    } catch (error) {
      summary.failedBatches += 1
      console.error(JSON.stringify({
        event: 'codex_company_batch_failed',
        batchIndex,
        companies: batch.map((item) => item.company),
        error: error instanceof Error ? error.message : String(error),
      }))
      continue
    }
    if (searched.error) {
      summary.failedBatches += 1
      console.error(JSON.stringify({ event: 'codex_company_batch_failed', batchIndex, companies: batch.map((item) => item.company), error: searched.error }))
      continue
    }
    const byCompany = new Map(searched.results.map((item) => [identity(item.company), item]))
    for (const candidate of batch) {
      const result = byCompany.get(identity(candidate.company))
      const intel = publicIntel(candidate, result)
      const completed = intel.registryEnrichment?.completedFields || []
      if (completed.length) {
        summary.completedCompanies += 1
        for (const field of completed) summary.completedFields[field] = (summary.completedFields[field] || 0) + 1
      } else {
        summary.noMatchCompanies += 1
      }
      if (apply) {
        for (const [rowIndex, row] of candidate.rows.entries()) {
          try {
            // Make duplicate formal rows produce distinct immutable raw events while retaining
            // the same evidence package and company identity.
            const targetedIntel = rowIndex
              ? { ...intel, searchEvidence: (intel.searchEvidence || []).map((item) => ({ ...item, query: `${item.query || ''}｜target:${row.id}` })) }
              : intel
            await commitLeadPublicIntel({ company: candidate.company, intel: targetedIntel, targetLeadId: row.id })
            summary.completedLeadRows += 1
          } catch (error) {
            summary.failedCommits += 1
            console.error(JSON.stringify({ event: 'codex_company_commit_failed', leadId: row.id, company: candidate.company, error: error instanceof Error ? error.message : String(error) }))
          }
        }
      }
      console.log(JSON.stringify({
        event: 'codex_company_enriched',
        batchIndex,
        company: candidate.company,
        leadRows: candidate.rows.length,
        completedFields: completed,
        sources: result?.sources.length || 0,
        ...(!apply ? {
          evidence: result?.evidence || [],
          sourceDetails: result?.sources || [],
        } : {}),
        applied: apply,
      }))
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()))
console.log(JSON.stringify({ ok: summary.failedBatches === 0 && summary.failedCommits === 0, ...summary }, null, 2))
await pool.end()
