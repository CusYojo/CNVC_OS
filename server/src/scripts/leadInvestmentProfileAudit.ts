import assert from 'node:assert/strict'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlConfig, mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { LEAD_INVESTMENT_PROFILE_SCHEMA_VERSION } from '../contracts/leadInvestmentProfileContract.js'
import {
  buildLeadInvestmentProfileDictionaries,
  type LeadAcademicInstitutionDictionaryRow,
  type LeadCustomerDictionaryRow,
  type LeadIndustryDictionaryRow,
  type LeadInstitutionDictionaryRow,
} from '../services/leadInvestmentProfileDictionary.js'

const profiles = quoteMysqlIdentifier(mysqlTableName('lead_investment_profile_projections'))
const snapshots = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_snapshots'))
const institutions = quoteMysqlIdentifier(mysqlTableName('lead_institution_dictionary'))
const customers = quoteMysqlIdentifier(mysqlTableName('lead_customer_dictionary'))
const industries = quoteMysqlIdentifier(mysqlTableName('lead_industry_dictionary'))
const academicInstitutions = quoteMysqlIdentifier(mysqlTableName('lead_academic_institution_dictionary'))
const profileTableName = mysqlTableName('lead_investment_profile_projections')
const requiredTableNames = [
  profileTableName,
  mysqlTableName('lead_institution_dictionary'),
  mysqlTableName('lead_customer_dictionary'),
  mysqlTableName('lead_industry_dictionary'),
  mysqlTableName('lead_academic_institution_dictionary'),
]
const requiredCheckConstraints = [
  'ck_lead_institution_dictionary_status', 'ck_lead_institution_dictionary_version',
  'ck_lead_customer_dictionary_tier', 'ck_lead_customer_dictionary_confidentiality',
  'ck_lead_customer_dictionary_status', 'ck_lead_customer_dictionary_version',
  'ck_lead_industry_dictionary_status', 'ck_lead_industry_dictionary_version',
  'ck_lead_academic_institution_dictionary_status', 'ck_lead_academic_institution_dictionary_version',
  'ck_lead_investment_profile_counts', 'ck_lead_investment_profile_status',
  'ck_lead_investment_profile_customer_stage',
]

async function main() {
  const [presence] = await pool.query<Array<RowDataPacket & { table_name: string }>>(
    `SELECT TABLE_NAME AS table_name FROM information_schema.tables
     WHERE table_schema=DATABASE() AND table_name IN (${requiredTableNames.map(() => '?').join(',')})`,
    requiredTableNames,
  )
  const presentTableNames = new Set(presence.map((row) => row.table_name))
  const missingTableNames = requiredTableNames.filter((tableName) => !presentTableNames.has(tableName))
  if (missingTableNames.length) {
    throw new Error(`lead investment profile audit requires migration 0092; missing tables: ${missingTableNames.join(',')}; no database writes were attempted`)
  }
  const [constraintRows] = await pool.query<Array<RowDataPacket & { constraint_name: string }>>(
    `SELECT CONSTRAINT_NAME AS constraint_name FROM information_schema.table_constraints
     WHERE table_schema=DATABASE() AND constraint_type='CHECK'
       AND table_name IN (${requiredTableNames.map(() => '?').join(',')})`,
    requiredTableNames,
  )
  const constraintNames = new Set(constraintRows.map((row) => row.constraint_name))
  const missingCheckConstraints = requiredCheckConstraints.filter((name) => !constraintNames.has(name))
  assert.deepEqual(missingCheckConstraints, [], 'investment profile runtime CHECK constraints are incomplete')

  const [institutionRows, customerRows, industryRows, academicInstitutionRows] = await Promise.all([
    pool.query<Array<RowDataPacket & LeadInstitutionDictionaryRow>>(
      `SELECT canonical_name,aliases,institution_type,tier,major FROM ${institutions} WHERE status='active'`,
    ),
    pool.query<Array<RowDataPacket & LeadCustomerDictionaryRow>>(
      `SELECT canonical_name,aliases,tier,confidentiality FROM ${customers}
       WHERE status='active' AND tier IN ('A','B','C') AND confidentiality IN ('public','confidential','restricted')`,
    ),
    pool.query<Array<RowDataPacket & LeadIndustryDictionaryRow>>(
      `SELECT canonical_name,aliases,level1,level2,segment,chain_position FROM ${industries} WHERE status='active'`,
    ),
    pool.query<Array<RowDataPacket & LeadAcademicInstitutionDictionaryRow>>(
      `SELECT canonical_name,aliases,institution_type FROM ${academicInstitutions} WHERE status='active'`,
    ),
  ])
  const currentDictionaryHash = buildLeadInvestmentProfileDictionaries({
    institutions: institutionRows[0], customers: customerRows[0], industries: industryRows[0],
    academicInstitutions: academicInstitutionRows[0],
  }).hash

  const [coverageRows] = await pool.query<Array<RowDataPacket & {
    profile_status: string; count: number; verified_dimensions: number; applicable_dimensions: number;
    conflicts: number; verified_customers: number;
  }>>(
    `SELECT profile_status,COUNT(*) AS count,
            SUM(verified_dimensions) AS verified_dimensions,
            SUM(applicable_dimensions) AS applicable_dimensions,
            SUM(conflict_count) AS conflicts,
            SUM(verified_customer_count) AS verified_customers
     FROM ${profiles} GROUP BY profile_status ORDER BY profile_status`,
  )
  const [integrityRows] = await pool.query<Array<RowDataPacket & {
    total: number; stale: number; invalid_snapshot_binding: number; fresh_dictionary_mismatch: number;
    stale_dictionary_mismatch: number; invalid_coverage: number; invalid_profile_status: number;
    exposed_confidential_name: number; invalid_schema_version: number; latest_snapshot_mismatch: number;
    source_fact_snapshot_mismatch: number; source_fact_without_http_evidence: number;
  }>>(
    `SELECT COUNT(*) AS total,
            SUM(p.profile_status='stale') AS stale,
            SUM(p.schema_version<>?) AS invalid_schema_version,
            SUM(CASE WHEN s.id IS NULL OR s.snapshot_hash<>p.snapshot_hash
                       OR s.status NOT IN ('ready','review') THEN 1 ELSE 0 END) AS invalid_snapshot_binding,
            SUM(CASE WHEN p.profile_status<>'stale' AND NOT (p.snapshot_id <=> (
              SELECT s2.id FROM ${snapshots} s2
              WHERE s2.lead_id=p.lead_id AND s2.status IN ('ready','review')
              ORDER BY s2.created_at DESC,s2.id DESC LIMIT 1
            )) THEN 1 ELSE 0 END) AS latest_snapshot_mismatch,
            SUM(CASE WHEN p.profile_status<>'stale' AND p.dictionary_hash<>? THEN 1 ELSE 0 END) AS fresh_dictionary_mismatch,
            SUM(CASE WHEN p.profile_status='stale' AND p.dictionary_hash<>? THEN 1 ELSE 0 END) AS stale_dictionary_mismatch,
            SUM(CASE WHEN p.verified_dimensions<0 OR p.applicable_dimensions<0
                       OR p.verified_dimensions>p.applicable_dimensions OR p.conflict_count<0
                       OR p.completed_round_count<0 OR p.verified_customer_count<0
                       OR p.tier_a_customer_count<0 OR p.tier_b_customer_count<0 OR p.tier_c_customer_count<0
                     THEN 1 ELSE 0 END) AS invalid_coverage,
            SUM(p.profile_status NOT IN ('verified','partial','conflicted','missing','not_applicable','stale')) AS invalid_profile_status,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM JSON_TABLE(
                COALESCE(p.source_fact_ids,JSON_ARRAY()), '$[*]' COLUMNS(fact_id VARCHAR(64) PATH '$')
              ) AS pf WHERE NOT EXISTS (
                SELECT 1 FROM JSON_TABLE(
                  COALESCE(s.facts,JSON_ARRAY()), '$[*]' COLUMNS(
                    fact_id VARCHAR(64) PATH '$.id',
                    verification_status VARCHAR(32) PATH '$.verificationStatus',
                    evidence_ids JSON PATH '$.evidenceIds'
                  )
                ) AS sf WHERE sf.fact_id=pf.fact_id AND sf.verification_status='verified'
                  AND JSON_LENGTH(COALESCE(sf.evidence_ids,JSON_ARRAY()))>0
              )
            ) THEN 1 ELSE 0 END) AS source_fact_snapshot_mismatch,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM JSON_TABLE(
                COALESCE(p.source_fact_ids,JSON_ARRAY()), '$[*]' COLUMNS(fact_id VARCHAR(64) PATH '$')
              ) AS pf WHERE NOT EXISTS (
                SELECT 1 FROM JSON_TABLE(
                  COALESCE(s.facts,JSON_ARRAY()), '$[*]' COLUMNS(
                    fact_id VARCHAR(64) PATH '$.id',
                    verification_status VARCHAR(32) PATH '$.verificationStatus',
                    evidence_ids JSON PATH '$.evidenceIds'
                  )
                ) AS sf JOIN JSON_TABLE(
                  COALESCE(sf.evidence_ids,JSON_ARRAY()), '$[*]' COLUMNS(evidence_id VARCHAR(64) PATH '$')
                ) AS se ON TRUE
                WHERE sf.fact_id=pf.fact_id AND sf.verification_status='verified'
                  AND JSON_UNQUOTE(JSON_EXTRACT(
                    COALESCE(s.evidence_index,JSON_OBJECT()),
                    CONCAT('$."',se.evidence_id,'".sourceUrl')
                  )) REGEXP '^https?://'
              )
            ) THEN 1 ELSE 0 END) AS source_fact_without_http_evidence,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM JSON_TABLE(
                COALESCE(p.customer_representatives,JSON_ARRAY()),
                '$[*]' COLUMNS(name VARCHAR(255) PATH '$.name', anonymized BOOLEAN PATH '$.anonymized')
              ) AS c WHERE c.anonymized=TRUE AND EXISTS (
                SELECT 1 FROM ${customers} d
                WHERE d.status='active' AND d.confidentiality<>'public'
                  AND (
                    c.name LIKE CONCAT('%',d.canonical_name,'%')
                    OR EXISTS (
                      SELECT 1 FROM JSON_TABLE(
                        COALESCE(d.aliases,JSON_ARRAY()), '$[*]' COLUMNS(alias VARCHAR(255) PATH '$')
                      ) AS a WHERE a.alias<>'' AND c.name LIKE CONCAT('%',a.alias,'%')
                    )
                  )
              )
            ) THEN 1 ELSE 0 END) AS exposed_confidential_name
     FROM ${profiles} p LEFT JOIN ${snapshots} s ON s.id=p.snapshot_id AND s.lead_id=p.lead_id`,
    [LEAD_INVESTMENT_PROFILE_SCHEMA_VERSION, currentDictionaryHash, currentDictionaryHash],
  )
  const integrity = integrityRows[0]
  assert.equal(Number(integrity?.invalid_snapshot_binding || 0), 0,
    'a projection is not bound to its frozen snapshot id/hash')
  assert.equal(Number(integrity?.invalid_schema_version || 0), 0,
    'a projection uses an unsupported schema version')
  assert.equal(Number(integrity?.latest_snapshot_mismatch || 0), 0,
    'a non-stale projection is not bound to the latest ready/review snapshot')
  assert.equal(Number(integrity?.source_fact_snapshot_mismatch || 0), 0,
    'a projection source fact is absent, unverified or evidence-free in its bound snapshot')
  assert.equal(Number(integrity?.source_fact_without_http_evidence || 0), 0,
    'a projection source fact has no HTTP(S) evidence frozen in the bound snapshot')
  assert.equal(Number(integrity?.fresh_dictionary_mismatch || 0), 0,
    'a non-stale projection does not use the current controlled dictionary hash')
  assert.equal(Number(integrity?.invalid_coverage || 0), 0, 'projection coverage is outside its valid range')
  assert.equal(Number(integrity?.invalid_profile_status || 0), 0, 'projection status is outside the controlled vocabulary')
  assert.equal(Number(integrity?.exposed_confidential_name || 0), 0,
    'an anonymized customer exposes a controlled confidential customer name or alias')

  const [indexRows] = await pool.query<Array<RowDataPacket & { index_name: string; columns: string }>>(
    `SELECT INDEX_NAME AS index_name,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
     FROM information_schema.statistics
     WHERE table_schema=DATABASE() AND table_name=?
     GROUP BY index_name ORDER BY index_name`,
    [profileTableName],
  )
  const indexNames = new Set(indexRows.map((row) => row.index_name))
  for (const required of [
    'PRIMARY', 'idx_lead_investment_profiles_industry', 'idx_lead_investment_profiles_financing',
    'idx_lead_investment_profiles_funding_sort',
    'idx_lead_investment_profiles_valuation', 'idx_lead_investment_profiles_customer',
    'idx_lead_investment_profiles_valuation_sort', 'idx_lead_investment_profiles_updated_sort',
    'idx_lead_investment_profiles_status', 'idx_lead_investment_profiles_institution',
    'idx_lead_investment_profiles_customer_tier_a', 'idx_lead_investment_profiles_customer_tier_b',
    'idx_lead_investment_profiles_customer_tier_c',
  ]) assert(indexNames.has(required), `missing investment profile index ${required}`)

  const [sampleRows] = await pool.query<Array<RowDataPacket & { latest_round: string }>>(
    `SELECT latest_round FROM ${profiles} WHERE latest_round IS NOT NULL LIMIT 1`,
  )
  let explain: Array<Record<string, unknown>> = []
  if (sampleRows[0]?.latest_round) {
    const [explainRows] = await pool.query<Array<RowDataPacket & {
      type: string; possible_keys: string | null; key: string | null; rows: number;
    }>>(
      `EXPLAIN SELECT lead_id FROM ${profiles}
       WHERE latest_round=? ORDER BY latest_round_date DESC LIMIT 20`,
      [sampleRows[0].latest_round],
    )
    explain = explainRows.map((row) => ({
      type: row.type, possibleKeys: row.possible_keys, selectedKey: row.key, estimatedRows: Number(row.rows),
    }))
    assert(explainRows.some((row) => String(row.possible_keys || '').includes('idx_lead_investment_profiles_financing')),
      'funding filter query plan cannot use the financing index')
  }

  const customerTierPlans = [] as Array<{ tier: string; possibleKeys: string | null; selectedKey: string | null }>
  for (const tier of [
    { label: 'A', column: 'tier_a_customer_count', index: 'idx_lead_investment_profiles_customer_tier_a' },
    { label: 'B', column: 'tier_b_customer_count', index: 'idx_lead_investment_profiles_customer_tier_b' },
    { label: 'C', column: 'tier_c_customer_count', index: 'idx_lead_investment_profiles_customer_tier_c' },
  ]) {
    const [rows] = await pool.query<Array<RowDataPacket & { possible_keys: string | null; key: string | null }>>(
      `EXPLAIN SELECT lead_id FROM ${profiles} WHERE ${tier.column}>0 ORDER BY lead_id LIMIT 20`,
    )
    assert(rows.some((row) => String(row.possible_keys || '').includes(tier.index)),
      `customer tier ${tier.label} filter query plan cannot use ${tier.index}`)
    customerTierPlans.push({ tier: tier.label, possibleKeys: rows[0]?.possible_keys ?? null, selectedKey: rows[0]?.key ?? null })
  }

  const sortPlans = [] as Array<{ sort: string; selectedKey: string | null; estimatedRows: number }>
  for (const plan of [
    { sort: 'funding', column: 'latest_round_date', expectedKey: 'idx_lead_investment_profiles_funding_sort' },
    { sort: 'valuation', column: 'valuation_value', expectedKey: 'idx_lead_investment_profiles_valuation_sort' },
    { sort: 'customer', column: 'highest_customer_stage', expectedKey: 'idx_lead_investment_profiles_customer' },
    { sort: 'profileUpdated', column: 'facts_updated_at', expectedKey: 'idx_lead_investment_profiles_updated_sort' },
  ]) {
    const [rows] = await pool.query<Array<RowDataPacket & { key: string | null; rows: number }>>(
      `EXPLAIN SELECT lead_id FROM ${profiles} ORDER BY ${plan.column} DESC,lead_id DESC LIMIT 20`,
    )
    assert(rows.some((row) => row.key === plan.expectedKey), `${plan.sort} sort query plan did not select ${plan.expectedKey}`)
    sortPlans.push({ sort: plan.sort, selectedKey: rows[0]?.key ?? null, estimatedRows: Number(rows[0]?.rows || 0) })
  }

  console.log(JSON.stringify({
    ok: true,
    readOnly: true,
    database: mysqlConfig.database,
    tablePrefix: mysqlConfig.tablePrefix,
    coverage: coverageRows.map((row) => ({
      status: row.profile_status,
      count: Number(row.count),
      verifiedDimensions: Number(row.verified_dimensions || 0),
      applicableDimensions: Number(row.applicable_dimensions || 0),
      conflicts: Number(row.conflicts || 0),
      verifiedCustomers: Number(row.verified_customers || 0),
    })),
    integrity: {
      total: Number(integrity?.total || 0),
      stale: Number(integrity?.stale || 0),
      invalidSchemaVersion: 0,
      invalidSnapshotBinding: 0,
      latestSnapshotMismatch: 0,
      sourceFactSnapshotMismatch: 0,
      sourceFactWithoutHttpEvidence: 0,
      freshDictionaryMismatch: 0,
      staleDictionaryMismatch: Number(integrity?.stale_dictionary_mismatch || 0),
      invalidCoverage: 0,
      invalidProfileStatus: 0,
      exposedConfidentialName: 0,
    },
    indexes: indexRows.map((row) => ({ name: row.index_name, columns: row.columns })),
    checkConstraints: { required: requiredCheckConstraints.length, missing: [] },
    evaluability: {
      dataQualityAndConfidentiality: Number(integrity?.total || 0) > 0 ? 'evaluated' : 'not_evaluable_empty_projection',
      financingFilterPlan: sampleRows[0]?.latest_round ? 'evaluated' : 'not_evaluable_no_financing_sample',
    },
    explain,
    customerTierPlans,
    sortPlans,
    databaseWrites: 0,
  }, null, 2))
}

await main().finally(async () => pool.end())
