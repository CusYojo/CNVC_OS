import type { RowDataPacket } from 'mysql2'
import { createHash } from 'node:crypto'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  LEAD_INVESTMENT_PROFILE_SCHEMA_VERSION,
  LEAD_INVESTMENT_PROFILE_PROJECTION_VERSION,
  type LeadInvestmentProfileSummary,
} from '../contracts/leadInvestmentProfileContract.js'
import { LEAD_ENRICHMENT_SCHEMA_VERSION } from './leadEnrichmentContract.js'
import {
  buildLeadInvestmentProfile,
  isLeadInvestmentProfileFactKey,
  type LeadInvestmentProfileFact,
} from './leadInvestmentProfileService.js'
import {
  buildLeadInvestmentProfileDictionaries,
  type LeadAcademicInstitutionDictionaryRow,
  type LeadCustomerDictionaryRow,
  type LeadIndustryDictionaryRow,
  type LeadInstitutionDictionaryRow,
} from './leadInvestmentProfileDictionary.js'

const factsTable = quoteMysqlIdentifier(mysqlTableName('lead_facts'))
const evidenceTable = quoteMysqlIdentifier(mysqlTableName('lead_fact_evidence'))
const snapshotsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_snapshots'))
const projectionsTable = quoteMysqlIdentifier(mysqlTableName('lead_investment_profile_projections'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const institutionDictionaryTable = quoteMysqlIdentifier(mysqlTableName('lead_institution_dictionary'))
const customerDictionaryTable = quoteMysqlIdentifier(mysqlTableName('lead_customer_dictionary'))
const industryDictionaryTable = quoteMysqlIdentifier(mysqlTableName('lead_industry_dictionary'))
const academicInstitutionDictionaryTable = quoteMysqlIdentifier(mysqlTableName('lead_academic_institution_dictionary'))

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function safeInteger(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) ? value : null
}

function searchText(values: Array<string | undefined>) {
  return [...new Set(values.map((value) => value?.normalize('NFKC').trim()).filter(Boolean))].join(' ')
}

export function publicLeadInvestmentProfile(profile: LeadInvestmentProfileSummary) {
  const { sourceFactIds: _sourceFactIds, ...publicProfile } = profile
  return {
    ...publicProfile,
    products: publicProfile.products.slice(0, 2),
    institutions: publicProfile.institutions.slice(0, 2),
    academicLinks: publicProfile.academicLinks.slice(0, 2),
    customers: { ...publicProfile.customers, representatives: publicProfile.customers.representatives.slice(0, 2) },
  }
}

export function leadInvestmentProfileProjectionFingerprint(input: {
  schemaVersion: string
  snapshotHash: string
  dictionaryHash: string
}): string {
  return createHash('sha256').update(JSON.stringify([
    input.schemaVersion, input.snapshotHash, input.dictionaryHash,
  ])).digest('hex')
}

async function buildLeadInvestmentProfileProjection(input: {
  leadId: string
  snapshotId?: string
}, persist: boolean) {
  const [snapshotRows] = await pool.query<Array<RowDataPacket & {
    id: string; snapshot_hash: string; schema_version: string; status: string; frozen_at: Date;
    name: string; company_name: string | null; business_region: string | null;
    subject_profile: unknown; facts: unknown; conflicts: unknown;
  }>>(
    `SELECT s.id,s.snapshot_hash,s.schema_version,s.status,s.frozen_at,s.subject_profile,s.facts,s.conflicts,
            l.name,l.company_name,l.business_region
     FROM ${snapshotsTable} s JOIN ${leadsTable} l ON l.id=s.lead_id
     WHERE s.lead_id=? AND s.schema_version=?${input.snapshotId ? ' AND s.id=?' : ''}
     ORDER BY s.created_at DESC,s.id DESC LIMIT 1`,
    input.snapshotId
      ? [input.leadId, LEAD_ENRICHMENT_SCHEMA_VERSION, input.snapshotId]
      : [input.leadId, LEAD_ENRICHMENT_SCHEMA_VERSION],
  )
  const snapshot = snapshotRows[0]
  if (!snapshot) return null
  if (snapshot.status !== 'ready' && snapshot.status !== 'review') {
    throw new Error(`investment profile requires a frozen ready/review snapshot; received ${snapshot.status}`)
  }
  const subjectProfile = jsonValue(snapshot.subject_profile) as Record<string, unknown>
  const snapshotFacts = jsonValue(snapshot.facts)
  const verifiedSnapshotFacts = Array.isArray(snapshotFacts) ? snapshotFacts.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const item = value as Record<string, unknown>
    const evidenceIds = Array.isArray(item.evidenceIds) ? item.evidenceIds : []
    return item.verificationStatus === 'verified' && evidenceIds.length > 0 && typeof item.id === 'string'
      ? [item]
      : []
  }) : []
  const snapshotFactById = new Map(verifiedSnapshotFacts.map((fact) => [String(fact.id), fact]))
  const verifiedSnapshotFactIds = [...snapshotFactById.keys()]
  const snapshotEvidencePairs = verifiedSnapshotFacts.flatMap((fact) => (
    (fact.evidenceIds as unknown[]).map((evidenceId) => ({ factId: String(fact.id), evidenceId: String(evidenceId) }))
  ))
  const [factRows] = await pool.query<Array<RowDataPacket & {
    id: string; fact_key: string; instance_key: string; value: unknown; unit: string | null; currency: string | null;
    period_start: string | null; period_end: string | null; scope: string | null;
    evidence_level: string; verification_status: string; created_at: Date;
  }>>(
    verifiedSnapshotFactIds.length ? `SELECT f.id,f.fact_key,f.instance_key,f.value,f.unit,f.currency,f.period_start,f.period_end,
            f.scope,f.evidence_level,f.verification_status,f.created_at
     FROM ${factsTable} f
     WHERE f.lead_id=? AND f.id IN (${verifiedSnapshotFactIds.map(() => '?').join(',')})
       AND EXISTS (SELECT 1 FROM ${evidenceTable} e WHERE e.fact_id=f.id)
     ORDER BY f.fact_key,f.instance_key,f.id` : `SELECT f.id,f.fact_key,f.instance_key,f.value,f.unit,f.currency,
       f.period_start,f.period_end,f.scope,f.evidence_level,f.verification_status,f.created_at
       FROM ${factsTable} f WHERE 1=0`,
    verifiedSnapshotFactIds.length ? [input.leadId, ...verifiedSnapshotFactIds] : [],
  )
  if (factRows.length !== verifiedSnapshotFactIds.length) {
    throw new Error(`investment profile snapshot facts are incomplete: expected ${verifiedSnapshotFactIds.length}, received ${factRows.length}`)
  }
  const snapshotEvidenceIds = [...new Set(snapshotEvidencePairs.map((item) => item.evidenceId))]
  const [snapshotEvidenceRows] = await pool.query<Array<RowDataPacket & { id: string; fact_id: string; source_url: string }>>(
    snapshotEvidenceIds.length
      ? `SELECT id,fact_id,source_url FROM ${evidenceTable} WHERE id IN (${snapshotEvidenceIds.map(() => '?').join(',')})`
      : `SELECT id,fact_id,source_url FROM ${evidenceTable} WHERE 1=0`,
    snapshotEvidenceIds,
  )
  const availableEvidencePairs = new Set(snapshotEvidenceRows.map((row) => `${row.fact_id}\u0000${row.id}`))
  const missingEvidencePairs = snapshotEvidencePairs.filter((item) => (
    !availableEvidencePairs.has(`${item.factId}\u0000${item.evidenceId}`)
  ))
  if (missingEvidencePairs.length) {
    throw new Error(`investment profile snapshot evidence is incomplete: missing ${missingEvidencePairs.length}`)
  }
  const publicEvidenceFactIds = new Set(snapshotEvidenceRows
    .filter((row) => /^https?:\/\//i.test(row.source_url))
    .map((row) => row.fact_id))
  const [institutionRows, customerRows, industryRows, academicInstitutionRows] = await Promise.all([
    pool.query<Array<RowDataPacket & LeadInstitutionDictionaryRow>>(
      `SELECT canonical_name,aliases,institution_type,tier,major FROM ${institutionDictionaryTable} WHERE status='active'`,
    ),
    pool.query<Array<RowDataPacket & LeadCustomerDictionaryRow>>(
      `SELECT canonical_name,aliases,tier,confidentiality FROM ${customerDictionaryTable}
       WHERE status='active' AND tier IN ('A','B','C') AND confidentiality IN ('public','confidential','restricted')`,
    ),
    pool.query<Array<RowDataPacket & LeadIndustryDictionaryRow>>(
      `SELECT canonical_name,aliases,level1,level2,segment,chain_position FROM ${industryDictionaryTable} WHERE status='active'`,
    ),
    pool.query<Array<RowDataPacket & LeadAcademicInstitutionDictionaryRow>>(
      `SELECT canonical_name,aliases,institution_type FROM ${academicInstitutionDictionaryTable} WHERE status='active'`,
    ),
  ])
  const dictionarySnapshot = buildLeadInvestmentProfileDictionaries({
    institutions: institutionRows[0],
    customers: customerRows[0],
    industries: industryRows[0],
    academicInstitutions: academicInstitutionRows[0],
  })
  const { institutions, customers, industries, academicInstitutions, hash: dictionaryHash, hashes } = dictionarySnapshot
  const facts: LeadInvestmentProfileFact[] = factRows.filter((row) => publicEvidenceFactIds.has(row.id)).map((row) => {
    const frozen = snapshotFactById.get(row.id)
    if (!frozen) throw new Error(`investment profile snapshot fact ${row.id} is missing`)
    return {
      id: row.id,
      factKey: String(frozen.factKey || row.fact_key),
      instanceKey: typeof frozen.instanceKey === 'string' ? frozen.instanceKey : row.instance_key,
      value: frozen.value,
      unit: row.unit,
      currency: row.currency,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      scope: row.scope,
      evidenceLevel: typeof frozen.evidenceLevel === 'string' ? frozen.evidenceLevel : row.evidence_level,
      verificationStatus: 'verified',
      createdAt: row.created_at,
    }
  })
  const snapshotConflicts = jsonValue(snapshot.conflicts)
  const profileConflictCount = Array.isArray(snapshotConflicts) ? snapshotConflicts.filter((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const conflict = value as Record<string, unknown>
    return isLeadInvestmentProfileFactKey(conflict.factKey ?? conflict.fact_key)
  }).length : 0
  const profile = buildLeadInvestmentProfile({
    leadId: input.leadId,
    snapshotId: snapshot.id,
    snapshotHash: snapshot.snapshot_hash,
    entityType: typeof subjectProfile.entityType === 'string' ? subjectProfile.entityType : undefined,
    enrichmentSchemaVersion: snapshot.schema_version,
    subject: {
      name: snapshot.name,
      legalEntityName: snapshot.company_name || undefined,
      region: snapshot.business_region || undefined,
      profileReviewStatus: snapshot.status === 'review' ? 'review' : 'clear',
    },
    frozenAt: snapshot.frozen_at,
    projectedAt: new Date(),
    facts,
    conflictCount: profileConflictCount,
    dictionaries: { institutions, customers, industries, academicInstitutions, binding: hashes },
  })
  const productSearchText = searchText(profile.products.flatMap((item) => [
    item.name, item.productRoute, item.technologyRoute, item.productionStage,
  ]))
  const productRouteSearchText = searchText(profile.products.flatMap((item) => [item.productRoute, item.technologyRoute]))
  // The dedicated stage filter represents achieved/current industrialization.
  // Planned target stages remain visible but cannot masquerade as realized.
  const productionStageSearchText = searchText(profile.products
    .filter((item) => item.productionStageStatus === 'realized')
    .map((item) => item.productionStage))
  const institutionSearchText = searchText(profile.institutions.map((item) => item.name))
  const academicSearchText = searchText(profile.academicLinks.flatMap((item) => [
    item.institution, item.person, item.departmentLab, item.relationType,
  ]))
  const academicInstitutionSearchText = searchText(profile.academicLinks.flatMap((item) => [item.institution, item.departmentLab]))
  const academicRelationSearchText = searchText(profile.academicLinks.map((item) => item.relationType))
  const afterFingerprint = leadInvestmentProfileProjectionFingerprint({
    schemaVersion: LEAD_INVESTMENT_PROFILE_SCHEMA_VERSION,
    snapshotHash: snapshot.snapshot_hash,
    dictionaryHash,
  })
  if (!persist) return { profile, write: null }
  const [existingRows] = await pool.query<Array<RowDataPacket & {
    schema_version: string; snapshot_hash: string; dictionary_hash: string; profile_status: string; profile_payload: unknown;
  }>>(
    `SELECT schema_version,snapshot_hash,dictionary_hash,profile_status,profile_payload
     FROM ${projectionsTable} WHERE lead_id=? LIMIT 1`,
    [input.leadId],
  )
  const existing = existingRows[0]
  const beforeFingerprint = existing ? leadInvestmentProfileProjectionFingerprint({
    schemaVersion: existing.schema_version,
    snapshotHash: existing.snapshot_hash,
    dictionaryHash: existing.dictionary_hash,
  }) : null
  if (beforeFingerprint === afterFingerprint && existing?.profile_status !== 'stale' && existing?.profile_payload) {
    return { profile, write: { changed: false, beforeFingerprint, afterFingerprint } }
  }
  await pool.query(
    `INSERT INTO ${projectionsTable}
      (lead_id,schema_version,snapshot_id,snapshot_hash,dictionary_hash,industry_level1,industry_level2,
       industry_segment,industry_chain_position,products,institutions,academic_links,
       customer_representatives,product_search_text,product_route_search_text,production_stage_search_text,
       institution_search_text,academic_search_text,academic_institution_search_text,academic_relation_search_text,
       has_major_institution,has_commercialization_link,financing_status,latest_round,
       latest_round_date,latest_amount_display,latest_amount_value,latest_amount_currency,
       cumulative_amount_display,cumulative_amount_value,completed_round_count,valuation_display,
       valuation_value,valuation_type,valuation_currency,valuation_date,valuation_round,
       highest_customer_stage,verified_customer_count,tier_a_customer_count,tier_b_customer_count,
       tier_c_customer_count,verified_dimensions,
       applicable_dimensions,conflict_count,profile_status,source_fact_ids,facts_updated_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,CAST(? AS JSON),CAST(? AS JSON),CAST(? AS JSON),CAST(? AS JSON),
       ?, ?, ?, ?, ?, ?, ?,
       ?,?,?,?,
       ?,?,?,?,
       ?,?,?,?,
       ?,?,?,?,?,
       ?,?,?,?,?,?,
       ?,?,?,?,?,NOW(3))
     ON DUPLICATE KEY UPDATE
       schema_version=VALUES(schema_version),snapshot_id=VALUES(snapshot_id),snapshot_hash=VALUES(snapshot_hash),
       dictionary_hash=VALUES(dictionary_hash),
       industry_level1=VALUES(industry_level1),industry_level2=VALUES(industry_level2),
       industry_segment=VALUES(industry_segment),industry_chain_position=VALUES(industry_chain_position),
       products=VALUES(products),institutions=VALUES(institutions),academic_links=VALUES(academic_links),
       customer_representatives=VALUES(customer_representatives),product_search_text=VALUES(product_search_text),
       product_route_search_text=VALUES(product_route_search_text),production_stage_search_text=VALUES(production_stage_search_text),
       institution_search_text=VALUES(institution_search_text),academic_search_text=VALUES(academic_search_text),
       academic_institution_search_text=VALUES(academic_institution_search_text),
       academic_relation_search_text=VALUES(academic_relation_search_text),
       has_major_institution=VALUES(has_major_institution),has_commercialization_link=VALUES(has_commercialization_link),
       financing_status=VALUES(financing_status),latest_round=VALUES(latest_round),latest_round_date=VALUES(latest_round_date),
       latest_amount_display=VALUES(latest_amount_display),latest_amount_value=VALUES(latest_amount_value),
       latest_amount_currency=VALUES(latest_amount_currency),cumulative_amount_display=VALUES(cumulative_amount_display),
       cumulative_amount_value=VALUES(cumulative_amount_value),completed_round_count=VALUES(completed_round_count),
       valuation_display=VALUES(valuation_display),valuation_value=VALUES(valuation_value),
       valuation_type=VALUES(valuation_type),valuation_currency=VALUES(valuation_currency),
       valuation_date=VALUES(valuation_date),valuation_round=VALUES(valuation_round),
       highest_customer_stage=VALUES(highest_customer_stage),verified_customer_count=VALUES(verified_customer_count),
       tier_a_customer_count=VALUES(tier_a_customer_count),tier_b_customer_count=VALUES(tier_b_customer_count),
       tier_c_customer_count=VALUES(tier_c_customer_count),verified_dimensions=VALUES(verified_dimensions),
       applicable_dimensions=VALUES(applicable_dimensions),conflict_count=VALUES(conflict_count),
       profile_status=VALUES(profile_status),source_fact_ids=VALUES(source_fact_ids),
       facts_updated_at=VALUES(facts_updated_at),updated_at=NOW(3)`,
    [
      input.leadId, LEAD_INVESTMENT_PROFILE_SCHEMA_VERSION, snapshot.id, snapshot.snapshot_hash, dictionaryHash,
      profile.industry.level1 ?? null, profile.industry.level2 ?? null,
      profile.industry.segment ?? null, profile.industry.chainPosition ?? null,
      JSON.stringify(profile.products), JSON.stringify(profile.institutions), JSON.stringify(profile.academicLinks),
      JSON.stringify(profile.customers.representatives), productSearchText || null, productRouteSearchText || null,
      productionStageSearchText || null, institutionSearchText || null, academicSearchText || null,
      academicInstitutionSearchText || null, academicRelationSearchText || null,
      profile.institutions.some((item) => item.major),
      profile.academicLinks.some((item) => item.commercialization), profile.financing.status || null,
      profile.financing.latestRound ?? null, profile.financing.latestRoundDate ?? null,
      profile.financing.latestAmount ?? null, safeInteger(profile.financing.latestAmountValue),
      profile.financing.latestAmountCurrency ?? null, profile.financing.cumulativeAmount ?? null,
      safeInteger(profile.financing.cumulativeAmountValue), profile.financing.completedRoundCount,
      profile.valuation.value ?? null, safeInteger(profile.valuation.numericValue), profile.valuation.type ?? null,
      profile.valuation.currency ?? null, profile.valuation.date ?? null, profile.valuation.round ?? null,
      profile.customers.highestStage ?? null, profile.customers.verifiedCount, profile.customers.tierACount,
      profile.customers.tierBCount, profile.customers.tierCCount,
      profile.dataStatus.verifiedDimensions, profile.dataStatus.applicableDimensions,
      profile.dataStatus.conflictCount, profile.dataStatus.status, JSON.stringify(profile.sourceFactIds),
      profile.dataStatus.updatedAt ? new Date(profile.dataStatus.updatedAt) : null,
    ],
  )
  await pool.query(
    `UPDATE ${projectionsTable}
     SET projection_version=?,dictionary_binding=CAST(? AS JSON),profile_payload=CAST(? AS JSON),
         stale_reason=NULL,snapshot_created_at=?,projected_at=NOW(3),
         product_total_count=?,institution_total_count=?,academic_link_total_count=?,
         customer_total_count=?,mentioned_customer_count=?,engaged_customer_count=?,trial_customer_count=?,
         contracted_customer_count=?,delivered_customer_count=?,paying_customer_count=?
     WHERE lead_id=?`,
    [
      LEAD_INVESTMENT_PROFILE_PROJECTION_VERSION,
      JSON.stringify(hashes), JSON.stringify(publicLeadInvestmentProfile(profile)), snapshot.frozen_at,
      profile.productTotalCount, profile.institutionTotalCount, profile.academicLinkTotalCount,
      profile.customers.customerTotalCount, profile.customers.mentionedCount, profile.customers.engagedCount,
      profile.customers.trialCount, profile.customers.contractedCount, profile.customers.deliveredCount,
      profile.customers.payingCount, input.leadId,
    ],
  )
  return { profile, write: { changed: true, beforeFingerprint, afterFingerprint } }
}

export async function previewLeadInvestmentProfileProjection(input: {
  leadId: string
  snapshotId?: string
}) {
  return (await buildLeadInvestmentProfileProjection(input, false))?.profile ?? null
}

export async function refreshLeadInvestmentProfileProjection(input: {
  leadId: string
  snapshotId?: string
}) {
  return (await buildLeadInvestmentProfileProjection(input, true))?.profile ?? null
}

export function refreshLeadInvestmentProfileProjectionWithReceipt(input: {
  leadId: string
  snapshotId?: string
}) {
  return buildLeadInvestmentProfileProjection(input, true)
}
