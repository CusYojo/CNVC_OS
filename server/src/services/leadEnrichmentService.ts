import { createHash, randomUUID } from 'node:crypto'
import type { PoolConnection } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  LEAD_ENRICHMENT_SCHEMA_VERSION,
  LEAD_ENRICHMENT_TERMINAL_TOPIC_STATUSES,
  LEAD_ENRICHMENT_TOPIC_KEYS,
  canonicalEnrichmentJson,
  classifyPaperContent,
  curateLeadResearchMetadata,
  enrichmentSnapshotHash,
  initialTopicStates,
  leadDeepEnrichmentFactKeyAllowed,
  leadDetailEnrichmentTopicApplies,
  leadEnrichmentRuntimePolicy,
  normalizePaperIdentity,
  type LeadEnrichmentTopicKey,
  type LeadEnrichmentTopicStatus,
  type LeadEntityType,
  type LeadEntityStatus,
  type LeadEvidenceLevel,
  type LeadFactVerificationStatus,
} from './leadEnrichmentContract.js'
import { sourceDocumentContainsQuote } from './leadSourceDocumentService.js'
import { companyRegistrationEligibility, normalizeLeadRegistry } from './leadRegistry.js'
import { normalizeLeadFactInstanceKey } from './leadFactInstanceKey.js'
import { refreshLeadInvestmentProfileProjection } from './leadInvestmentProfileProjectionService.js'
import { refreshLeadResearchProfileProjection } from './leadResearchProfileProjectionService.js'
import { runLeadEnrichmentSnapshotPostCommit } from './leadEnrichmentSnapshotPostCommit.js'

type JsonObject = Record<string, unknown>

const jobsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_jobs'))
const topicRunsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_topic_runs'))
const factsTable = quoteMysqlIdentifier(mysqlTableName('lead_facts'))
const evidenceTable = quoteMysqlIdentifier(mysqlTableName('lead_fact_evidence'))
const conflictsTable = quoteMysqlIdentifier(mysqlTableName('lead_fact_conflicts'))
const snapshotsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_snapshots'))
const investmentProfilesTable = quoteMysqlIdentifier(mysqlTableName('lead_investment_profile_projections'))
const researchProfilesTable = quoteMysqlIdentifier(mysqlTableName('lead_research_profile_projections'))
const customerDictionaryTable = quoteMysqlIdentifier(mysqlTableName('lead_customer_dictionary'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const entitiesTable = quoteMysqlIdentifier(mysqlTableName('lead_entities'))
const relationsTable = quoteMysqlIdentifier(mysqlTableName('lead_entity_relations'))
const sourceDocumentsTable = quoteMysqlIdentifier(mysqlTableName('lead_source_documents'))
const scoreJobsTable = quoteMysqlIdentifier(mysqlTableName('lead_score_jobs'))
const auditLogsTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))

function object(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {}
  } catch { return {} }
}

function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : ''
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function leadEvidenceLevelRank(level: LeadEvidenceLevel | string) {
  return level === 'E1' ? 3 : level === 'E2' ? 2 : level === 'E3' ? 1 : 0
}

function factIntroductionValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return text(String(value)).slice(0, 500)
  if (Array.isArray(value)) return value.map((item) => factIntroductionValue(item)).filter(Boolean).slice(0, 8).join('、')
  if (value && typeof value === 'object') {
    return Object.entries(value as JsonObject).slice(0, 12)
      .map(([key, item]) => `${key}：${factIntroductionValue(item)}`).filter((item) => !item.endsWith('：')).join('；').slice(0, 1_000)
  }
  return ''
}

export function verifiedSubjectIntroductions(facts: Array<{
  id: string; subject_type: string; fact_key: string; value: unknown; verification_status: string;
}>) {
  const verified = facts.filter((fact) => fact.verification_status === 'verified')
  const compose = (predicate: (fact: typeof verified[number]) => boolean) => {
    const selected = verified.filter(predicate).slice(0, 10)
    const lines = selected.map((fact) => factIntroductionValue(fact.value)).filter(Boolean)
    return {
      text: lines.length ? [...new Set(lines)].join('；').slice(0, 2_000) : null,
      factIds: [...new Set(selected.map((fact) => fact.id).filter(Boolean))],
    }
  }
  const company = compose((fact) => fact.subject_type === 'company' && /^(?:profile|registry|product)\./.test(fact.fact_key))
  const team = compose((fact) => fact.subject_type === 'team' || /^(?:team|paper\.authors|paper\.research_team|paper\.affiliations)/.test(fact.fact_key))
  const project = compose((fact) => ['project', 'research'].includes(fact.subject_type) && /^(?:profile|paper|research|product|technology)\./.test(fact.fact_key))
  return {
    companyIntroduction: company.text, companyFactIds: company.factIds,
    teamIntroduction: team.text, teamFactIds: team.factIds,
    projectIntroduction: project.text, projectFactIds: project.factIds,
  }
}

function normalizeUrl(value: unknown): string {
  const raw = text(value)
  try {
    const url = new URL(raw)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|spm|from|source|ref|fbclid|gclid)/i.test(key)) url.searchParams.delete(key)
    }
    url.protocol = url.protocol.toLowerCase()
    url.hostname = url.hostname.toLowerCase()
    return url.toString().replace(/\?$/, '')
  } catch { return '' }
}

export function leadEntityTypeForLead(row: { company_name: string | null; radar_profile: unknown }): LeadEntityType {
  const radar = object(row.radar_profile)
  if (text(radar.channel) === '论文') return 'research'
  const subjectType = text(object(radar.aiSubjectReview).subjectType).toLowerCase()
  if (subjectType === 'project' || subjectType === 'team') return subjectType
  if (text(row.company_name)) return 'company'
  return 'unknown'
}

function initialEntityStatus(row: { company_name: string | null; radar_profile: unknown }, entityType: LeadEntityType) {
  if (entityType === 'research') {
    const radar = object(row.radar_profile)
    const paperMeta = object(radar.paperMeta)
    return normalizePaperIdentity({
      provider: object(paperMeta.metadataSource).provider,
      sourceName: radar.sourceName,
      sourceId: radar.sourceId,
      arxivId: paperMeta.arxivId,
      openAlexId: paperMeta.openAlexId,
      doi: paperMeta.doi,
      landingPageUrl: radar.link,
      fullTextUrl: paperMeta.fullTextUrl,
      pdfUrl: paperMeta.pdfUrl,
    }).sourceStatus === 'confirmed' ? 'confirmed' : 'ambiguous'
  }
  return text(row.company_name) ? 'claimed' : entityType === 'unknown' ? 'missing' : 'inferred'
}

function normalizedEntityName(value: unknown) {
  return text(value).replace(/\s+/g, ' ').toLocaleLowerCase()
}

async function ensureEntity(connection: PoolConnection, input: {
  leadId: string; entityType: LeadEntityType; canonicalName: string; status: string;
  aliases?: string[]; identifiers?: JsonObject;
}) {
  const normalizedName = normalizedEntityName(input.canonicalName) || `unknown:${input.leadId}`
  const [rows] = await connection.query<Array<RowDataPacket & {
    id: string; status: string; aliases: unknown; identifiers: unknown
  }>>(
    `SELECT id,status,aliases,identifiers FROM ${entitiesTable}
     WHERE lead_id=? AND entity_type=? AND normalized_name=? LIMIT 1 FOR UPDATE`,
    [input.leadId, input.entityType, normalizedName],
  )
  const existing = rows[0]
  const aliases = [...new Set([
    ...array(existing?.aliases).map(text),
    ...(input.aliases || []).map(text),
  ].filter(Boolean))]
  const identifiers = { ...object(existing?.identifiers), ...(input.identifiers || {}) }
  if (existing) {
    await connection.query(
      `UPDATE ${entitiesTable}
       SET canonical_name=?,status=IF(status='confirmed','confirmed',?),aliases=CAST(? AS JSON),
           identifiers=CAST(? AS JSON),updated_at=NOW(3) WHERE id=?`,
      [input.canonicalName || '主体待确认', input.status, JSON.stringify(aliases), JSON.stringify(identifiers), existing.id],
    )
    return existing.id
  }
  const entityId = randomUUID()
  await connection.query(
    `INSERT INTO ${entitiesTable}
      (id,lead_id,entity_type,canonical_name,normalized_name,status,aliases,identifiers,created_at,updated_at)
     VALUES (?,?,?,?,?,?,CAST(? AS JSON),CAST(? AS JSON),NOW(3),NOW(3))`,
    [entityId, input.leadId, input.entityType, input.canonicalName || '主体待确认', normalizedName, input.status,
      JSON.stringify(aliases), JSON.stringify(identifiers)],
  )
  return entityId
}

type LeadEntityGraphDraftKey = 'primary' | 'company' | 'project' | 'team'
type LeadEntityGraphDraft = {
  key: LeadEntityGraphDraftKey
  entityType: LeadEntityType
  canonicalName: string
  status: string
  aliases: string[]
  identifiers: JsonObject
}
type LeadEntityRelationDraft = {
  from: LeadEntityGraphDraftKey
  to: LeadEntityGraphDraftKey
  relationType: string
  status: string
}

export function buildLeadEntityGraphPlan(lead: {
  id: string; name: string; company_name: string | null; radar_profile: unknown; scoring: unknown;
}, entityType: LeadEntityType, entityStatus: string) {
  const radar = object(lead.radar_profile)
  const scoring = object(lead.scoring)
  const registry = normalizeLeadRegistry(object(scoring.registry), object(radar.registry))
  const profile = object(radar.profile)
  const paperMeta = object(radar.paperMeta)
  const website = normalizeUrl(scoring.officialSite || scoring.website || radar.officialSite || radar.website || profile.website)
  const websiteDomain = website ? new URL(website).hostname.replace(/^www\./, '') : ''
  const legalCompanyName = text(lead.company_name || registry.companyName || radar.companyName)
  const companyShortNames = [...new Set([text(scoring.shortName), text(radar.shortName)].filter(Boolean))]
  const companyBrandNames = [...new Set([text(scoring.brandName), text(radar.brandName), ...array(scoring.brandNames).map(text), ...array(radar.brandNames).map(text)].filter(Boolean))]
  const companyFormerNames = [...new Set([...array(scoring.formerNames).map(text), ...array(radar.formerNames).map(text)].filter(Boolean))]
  const companyAliases = [...new Set([
    legalCompanyName, text(lead.company_name), text(registry.companyName),
    ...companyShortNames, ...companyBrandNames, ...companyFormerNames,
    ...(entityType === 'company' ? [text(lead.name), ...array(scoring.aliases).map(text), ...array(radar.aliases).map(text)] : []),
  ].filter(Boolean))]
  const companyIdentifiers = Object.fromEntries(Object.entries({
    legalName: legalCompanyName, shortNames: companyShortNames, brandNames: companyBrandNames,
    formerNames: companyFormerNames, creditCode: text(registry.creditCode), websiteDomain,
    legalRepresentative: text(registry.legalRepresentative),
    registeredAddress: text(registry.registeredAddress || registry.regLocation),
    registrationStatus: text(registry.registrationStatus),
  }).filter(([, value]) => Boolean(value)))
  const explicitProjectName = text(
    radar.projectName || profile.projectName || scoring.projectName || object(paperMeta.project).name,
  )
  const explicitTeamName = text(
    object(paperMeta.researchTeam).name || radar.teamName || profile.teamName || scoring.teamName,
  )
  const primaryName = entityType === 'company'
    ? legalCompanyName || text(lead.name)
    : entityType === 'project' ? explicitProjectName || text(lead.name)
      : entityType === 'team' ? explicitTeamName || text(lead.name)
        : text(lead.name || lead.company_name)
  const entities: LeadEntityGraphDraft[] = [{
    key: 'primary', entityType, canonicalName: primaryName || '主体待确认', status: entityStatus,
    aliases: entityType === 'company' ? companyAliases : [...new Set([
      text(lead.name), entityType === 'project' ? explicitProjectName : '', entityType === 'team' ? explicitTeamName : '',
    ].filter(Boolean))],
    identifiers: entityType === 'research' ? {
      provider: object(paperMeta.metadataSource).provider,
      arxivId: paperMeta.arxivId, openAlexId: paperMeta.openAlexId, doi: paperMeta.doi,
    } : entityType === 'company' ? companyIdentifiers : {},
  }]
  const relations: LeadEntityRelationDraft[] = []
  if (entityType !== 'company' && legalCompanyName) {
    entities.push({
      key: 'company', entityType: 'company', canonicalName: legalCompanyName, status: 'claimed',
      aliases: companyAliases, identifiers: companyIdentifiers,
    })
    relations.push({
      from: 'primary', to: 'company',
      relationType: entityType === 'research' ? 'commercialization_subject'
        : entityType === 'team' ? 'forming_company' : 'operated_by',
      status: 'claimed',
    })
  }
  if (entityType === 'company' && explicitProjectName
    && normalizedEntityName(explicitProjectName) !== normalizedEntityName(primaryName)) {
    entities.push({
      key: 'project', entityType: 'project', canonicalName: explicitProjectName, status: 'claimed',
      aliases: [explicitProjectName], identifiers: {},
    })
    relations.push({ from: 'project', to: 'primary', relationType: 'operated_by', status: 'claimed' })
  }
  if (entityType === 'research') {
    const researchTeamName = explicitTeamName || `${primaryName || '该成果'}研究团队`
    entities.push({
      key: 'team', entityType: 'team', canonicalName: researchTeamName, status: 'confirmed',
      aliases: [researchTeamName], identifiers: {},
    })
    relations.push({ from: 'primary', to: 'team', relationType: 'authored_by_team', status: 'confirmed' })
  } else if (entityType === 'company' || entityType === 'project') {
    const teamName = explicitTeamName || `${primaryName || '该主体'}核心团队`
    entities.push({
      key: 'team', entityType: 'team', canonicalName: teamName,
      status: explicitTeamName ? 'claimed' : 'inferred', aliases: [teamName], identifiers: {},
    })
    relations.push({
      from: 'team', to: entityType === 'company' && entities.some((entity) => entity.key === 'project') ? 'project' : 'primary',
      relationType: 'core_team_of', status: explicitTeamName ? 'claimed' : 'inferred',
    })
  }
  return { primaryKey: 'primary' as const, entities, relations }
}

export function leadFactSubjectEntityType(input: {
  factKey: string
  topicKey: LeadEnrichmentTopicKey
  primaryType: LeadEntityType
  availableTypes: Iterable<LeadEntityType>
}): LeadEntityType {
  const available = new Set(input.availableTypes)
  const key = text(input.factKey).toLowerCase()
  const prefer = (...types: LeadEntityType[]) => types.find((type) => available.has(type)) || input.primaryType
  if (/^(?:team\.|profile\.team_|paper\.(?:authors|research_team|author_contributions|affiliations|author_affiliations))/.test(key)) {
    return prefer('team', input.primaryType)
  }
  if (/^(?:registry\.|profile\.company_|ownership\.|financial\.|customer\.|contract\.|order\.|delivery\.|cash_collection\.|transaction\.)/.test(key)) {
    return prefer('company', input.primaryType)
  }
  if (/^financing\./.test(key)) return prefer('company', input.primaryType)
  if (key === 'research.grant' || /^(?:paper\.|research\.)/.test(key)) return prefer('research', 'project', input.primaryType)
  if (/^(?:profile\.project_|profile\.(?:user_problem|solution|application_scenario|research_stage|commercialization_stage))/.test(key)) {
    return prefer('project', 'research', input.primaryType)
  }
  if (input.primaryType === 'company'
    && /^(?:product\.|technology\.|competition\.|profile\.(?:product|project_|user_problem|solution|application_scenario|research_stage|commercialization_stage))/.test(key)) {
    return prefer('project', 'company')
  }
  return input.primaryType
}

export function leadFactEntityRelationType(factKey: string, primaryType: LeadEntityType): string | null {
  const key = text(factKey).toLowerCase()
  if (key === 'profile.operating_company') return 'operated_by'
  if (key === 'profile.commercialization_subject') return 'commercialization_subject'
  if (key === 'profile.technology_source') return 'technology_source'
  if (key === 'financing.subject') return 'financing_subject'
  if (key === 'patent.owner' || key === 'ip.owner') return 'ip_owner'
  if (key === 'profile.forming_company' && primaryType === 'team') return 'forming_company'
  return null
}

async function ensureLeadEntityGraph(connection: PoolConnection, lead: {
  id: string; name: string; company_name: string | null; radar_profile: unknown; scoring: unknown;
}, entityType: LeadEntityType, entityStatus: string) {
  const plan = buildLeadEntityGraphPlan(lead, entityType, entityStatus)
  const ids = new Map<LeadEntityGraphDraftKey, string>()
  for (const entity of plan.entities) {
    ids.set(entity.key, await ensureEntity(connection, {
      leadId: lead.id, entityType: entity.entityType, canonicalName: entity.canonicalName,
      status: entity.status, aliases: entity.aliases, identifiers: entity.identifiers,
    }))
  }
  for (const relation of plan.relations) {
    const fromId = ids.get(relation.from)
    const toId = ids.get(relation.to)
    if (!fromId || !toId || fromId === toId) continue
    await connection.query(
      `INSERT INTO ${relationsTable}
        (id,lead_id,from_entity_id,to_entity_id,relation_type,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,NOW(3),NOW(3))
       ON DUPLICATE KEY UPDATE status=IF(status='confirmed','confirmed',VALUES(status)),updated_at=NOW(3)`,
      [randomUUID(), lead.id, fromId, toId, relation.relationType, relation.status],
    )
  }
  return ids.get(plan.primaryKey)!
}

export async function refreshLeadEnrichmentProjection(leadId: string, jobId?: string) {
  const [jobRows] = await pool.query<Array<RowDataPacket & {
    id: string; status: string; entity_type: string; entity_status: string; updated_at: Date;
  }>>(
    `SELECT id,status,entity_type,entity_status,updated_at FROM ${jobsTable}
     WHERE lead_id=?${jobId ? ' AND id=?' : ' AND schema_version=?'} ORDER BY created_at DESC,id DESC LIMIT 1`,
    jobId ? [leadId, jobId] : [leadId, LEAD_ENRICHMENT_SCHEMA_VERSION],
  )
  const job = jobRows[0]
  if (!job) return null
  const [topicRows] = await pool.query<Array<RowDataPacket & { topic_key: string; status: string }>>(
    `SELECT topic_key,status FROM ${topicRunsTable} WHERE job_id=?`, [job.id],
  )
  const counts = topicRows.reduce<Record<string, number>>((result, row) => ({
    ...result, [row.status]: (result[row.status] || 0) + 1,
  }), {})
  const applicableRows = topicRows.filter((row) => row.status !== 'not_applicable')
  const completed = applicableRows.filter((row) => LEAD_ENRICHMENT_TERMINAL_TOPIC_STATUSES.has(row.status as LeadEnrichmentTopicStatus)).length
  const projection = {
    jobId: job.id,
    status: job.status,
    entityType: job.entity_type,
    entityStatus: job.entity_status,
    completedTopics: completed,
    totalTopics: applicableRows.length,
    topicCounts: counts,
    updatedAt: job.updated_at instanceof Date ? job.updated_at.toISOString() : String(job.updated_at),
  }
  await pool.query(
    `UPDATE ${leadsTable} SET scoring=JSON_SET(COALESCE(scoring,JSON_OBJECT()),'$.enrichment',CAST(? AS JSON)) WHERE id=?`,
    [JSON.stringify(projection), leadId],
  )
  return projection
}

export type LeadEnrichmentExecutionPhase = 'resolving_entity' | 'planning' | 'searching' | 'fetching' | 'extracting' | 'validating'

export async function recordLeadEnrichmentTopicPhase(input: {
  topicRunId: string
  leaseOwner: string
  phase: LeadEnrichmentExecutionPhase
}) {
  const at = new Date().toISOString()
  const [result] = await pool.query(
    `UPDATE ${topicRunsTable}
     SET metrics=JSON_SET(COALESCE(metrics,JSON_OBJECT()),
       '$.currentPhase',?,'$.phaseUpdatedAt',?,
       '$.phaseTransitions',JSON_ARRAY_APPEND(
         COALESCE(JSON_EXTRACT(metrics,'$.phaseTransitions'),JSON_ARRAY()),'$',CAST(? AS JSON))),
       updated_at=NOW(3)
     WHERE id=? AND status='running' AND lease_owner=?`,
    [input.phase, at, JSON.stringify({ phase: input.phase, at }), input.topicRunId, input.leaseOwner],
  )
  return Number((result as { affectedRows?: number }).affectedRows || 0) === 1
}

export async function enqueueLeadEnrichmentJob(input: {
  leadId: string
  triggerType: string
  triggerEventId?: string | null
  priority?: number
  idempotencyToken?: string
}, suppliedConnection?: PoolConnection) {
  if (!leadEnrichmentRuntimePolicy().acceptNewJobs) {
    return { queued: false, reason: 'accept_new_jobs_disabled', jobId: null }
  }
  const connection = suppliedConnection ?? await pool.getConnection()
  const ownTransaction = !suppliedConnection
  try {
    if (ownTransaction) await connection.beginTransaction()
    const [leadRows] = await connection.query<Array<RowDataPacket & {
      id: string
      name: string
      company_name: string | null
      radar_profile: unknown
      scoring: unknown
      pool_status: string
    }>>(`SELECT id,name,company_name,radar_profile,scoring,pool_status FROM ${leadsTable} WHERE id=? FOR UPDATE`, [input.leadId])
    const lead = leadRows[0]
    if (!lead || ['已删除', '已合并', '已注销', '已转专属项目'].includes(lead.pool_status)) {
      if (ownTransaction) await connection.commit()
      return { queued: false, reason: lead ? 'lead_not_active' : 'lead_not_found', jobId: null }
    }
    const knownRegistry = normalizeLeadRegistry(
      object(object(lead.scoring).registry), object(object(lead.radar_profile).registry),
    )
    const registration = companyRegistrationEligibility(knownRegistry.registrationStatus)
    if (!registration.eligibleForLeadPool) {
      await excludeDeregisteredLeadFromPoolWithConnection(connection, {
        leadId: lead.id, registrationStatus: registration.normalizedStatus,
        actor: { userName: '（系统准入规则）' },
      })
      if (ownTransaction) await connection.commit()
      return { queued: false, reason: 'company_deregistered', jobId: null }
    }
    const entityType = leadEntityTypeForLead(lead)
    const entityStatus = initialEntityStatus(lead, entityType)
    const entityId = await ensureLeadEntityGraph(connection, lead, entityType, entityStatus)
    const radar = object(lead.radar_profile)
    const hasCommercialCompany = entityType === 'research' && Boolean(text(radar.companyName || lead.company_name))
    const states = initialTopicStates({ entityType, hasCommercialCompany })
    const triggerType = text(input.triggerType) || 'pipeline-ready'
    if (triggerType.length > 48) throw new Error('lead enrichment triggerType exceeds 48 characters')
    const idempotencyKey = sha256([
      LEAD_ENRICHMENT_SCHEMA_VERSION,
      input.leadId,
      triggerType,
      text(input.triggerEventId) || 'no-event',
      text(input.idempotencyToken) || 'default',
    ].join(':'))
    const jobId = randomUUID()
    const [insert] = await connection.query(
      `INSERT IGNORE INTO ${jobsTable}
        (id,lead_id,schema_version,trigger_type,trigger_event_id,idempotency_key,entity_id,entity_type,entity_status,status,priority,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'queued',?,NOW(3),NOW(3))`,
      [jobId, input.leadId, LEAD_ENRICHMENT_SCHEMA_VERSION,
        triggerType, input.triggerEventId ?? null,
        idempotencyKey, entityId, entityType, entityStatus,
        Math.max(1, Math.min(1_000, Math.round(input.priority ?? 100)))],
    )
    const inserted = Number((insert as { affectedRows?: number }).affectedRows || 0) === 1
    const [jobRows] = await connection.query<Array<RowDataPacket & { id: string }>>(
      `SELECT id FROM ${jobsTable} WHERE idempotency_key=?`, [idempotencyKey],
    )
    const persistedJobId = jobRows[0]?.id
    if (!persistedJobId) throw new Error('enrichment job idempotency lookup failed')
    if (inserted) {
      await connection.query(
        `INSERT INTO ${topicRunsTable}
          (id,job_id,lead_id,topic_key,status,next_attempt_at,created_at,updated_at)
         VALUES ${LEAD_ENRICHMENT_TOPIC_KEYS.map(() => '(?,?,?,?,?,NOW(3),NOW(3),NOW(3))').join(',')}`,
        LEAD_ENRICHMENT_TOPIC_KEYS.flatMap((topic) => [randomUUID(), persistedJobId, input.leadId, topic, states[topic]]),
      )
      await connection.query(
        `UPDATE ${leadsTable} SET scoring=JSON_SET(COALESCE(scoring,JSON_OBJECT()),'$.enrichment',CAST(? AS JSON)) WHERE id=?`,
        [JSON.stringify({
          jobId: persistedJobId, status: 'queued', entityType, entityStatus,
          completedTopics: Object.values(states).filter((status) => status !== 'not_applicable' && LEAD_ENRICHMENT_TERMINAL_TOPIC_STATUSES.has(status)).length,
          totalTopics: Object.values(states).filter((status) => status !== 'not_applicable').length,
          topicCounts: Object.values(states).reduce<Record<string, number>>((counts, status) => ({ ...counts, [status]: (counts[status] || 0) + 1 }), {}),
          updatedAt: new Date().toISOString(),
        }), input.leadId],
      )
    }
    if (ownTransaction) await connection.commit()
    return { queued: inserted, reason: inserted ? null : 'duplicate', jobId: persistedJobId, entityType, topicStates: states }
  } catch (error) {
    if (ownTransaction) await connection.rollback()
    throw error
  } finally {
    if (ownTransaction) connection.release()
  }
}

async function excludeDeregisteredLeadFromPoolWithConnection(connection: PoolConnection, input: {
  leadId: string
  registrationStatus: string
  sourceUrl?: string
  actor?: { userId?: string | null; userName?: string }
}) {
  const registration = companyRegistrationEligibility(input.registrationStatus)
  if (registration.eligibleForLeadPool) return { excluded: false, reason: null }
  const [leadRows] = await connection.query<Array<RowDataPacket & { pool_status: string }>>(
    `SELECT pool_status FROM ${leadsTable} WHERE id=? FOR UPDATE`, [input.leadId],
  )
  if (!leadRows[0]) return { excluded: false, reason: 'lead_not_found' }
  const alreadyExcluded = leadRows[0].pool_status === '已注销'
  const decision = {
    status: 'rejected', code: 'COMPANY_DEREGISTERED', reason: registration.reason,
    registrationStatus: registration.normalizedStatus, sourceUrl: text(input.sourceUrl),
    decidedAt: new Date().toISOString(),
  }
  await connection.query(
    `UPDATE ${leadsTable}
     SET pool_status='已注销',score=0,
       scoring=JSON_SET(COALESCE(scoring,JSON_OBJECT()),
         '$.admission',CAST(? AS JSON),'$.ratingV3.status','invalidated','$.ratingV3.invalidatedReason','COMPANY_DEREGISTERED')
     WHERE id=?`,
    [JSON.stringify(decision), input.leadId],
  )
  await connection.query(`DELETE FROM ${scoreJobsTable} WHERE lead_id=?`, [input.leadId])
  const [topics] = await connection.query(
    `UPDATE ${topicRunsTable} tr JOIN ${jobsTable} j ON j.id=tr.job_id
     SET tr.status='missing',tr.completed_at=NOW(3),tr.lease_owner=NULL,tr.lease_expires_at=NULL,
         tr.last_error='cancelled: company deregistered',tr.updated_at=NOW(3)
     WHERE j.lead_id=? AND tr.status IN ('queued','retrying','running')`, [input.leadId],
  )
  const [jobs] = await connection.query(
    `UPDATE ${jobsTable}
     SET status='rejected',completed_at=NOW(3),lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=NOW(3)
     WHERE lead_id=? AND status IN ('queued','running','retrying')`,
    [registration.reason, input.leadId],
  )
  if (!alreadyExcluded) {
    await connection.query(
      `INSERT INTO ${auditLogsTable}
        (id,user_id,user_name,module,action,target,result,request_id,created_at)
       VALUES (?,?,?,'项目获取池','注销企业移出共享线索池',?,'success',?,NOW(3))`,
      [randomUUID(), input.actor?.userId ?? null, text(input.actor?.userName) || '（系统）',
        JSON.stringify({ leadId: input.leadId, ...decision }), randomUUID()],
    )
  }
  return {
    excluded: true, reason: registration.reason, registrationStatus: registration.normalizedStatus,
    alreadyExcluded,
    cancelledJobs: Number((jobs as { affectedRows?: number }).affectedRows || 0),
    cancelledTopics: Number((topics as { affectedRows?: number }).affectedRows || 0),
  }
}

export async function excludeDeregisteredLeadFromPool(input: {
  leadId: string
  registrationStatus: string
  sourceUrl?: string
  actor?: { userId?: string | null; userName?: string }
}, suppliedConnection?: PoolConnection) {
  const registration = companyRegistrationEligibility(input.registrationStatus)
  if (registration.eligibleForLeadPool) return { excluded: false, reason: null }
  const connection = suppliedConnection ?? await pool.getConnection()
  const ownTransaction = !suppliedConnection
  try {
    if (ownTransaction) await connection.beginTransaction()
    const result = await excludeDeregisteredLeadFromPoolWithConnection(connection, input)
    if (ownTransaction) await connection.commit()
    return result
  } catch (error) {
    if (ownTransaction) await connection.rollback()
    throw error
  } finally {
    if (ownTransaction) connection.release()
  }
}

export async function getLeadEnrichmentStatus(leadId: string) {
  const [jobRows] = await pool.query<Array<RowDataPacket & {
    id: string; schema_version: string; trigger_type: string; entity_type: string; entity_status: string; status: string;
    priority: number; execution_attempts: number; last_error: string | null; created_at: Date;
    updated_at: Date; completed_at: Date | null; entity_id: string | null;
    canonical_name: string | null; aliases: unknown; identifiers: unknown
  }>>(
    `SELECT j.id,j.schema_version,j.trigger_type,j.entity_type,j.entity_status,j.status,j.priority,j.execution_attempts,j.last_error,
            j.created_at,j.updated_at,j.completed_at,j.entity_id,e.canonical_name,e.aliases,e.identifiers
     FROM ${jobsTable} j LEFT JOIN ${entitiesTable} e ON e.id=j.entity_id
     WHERE j.lead_id=? AND j.schema_version=? ORDER BY j.created_at DESC,j.id DESC LIMIT 1`,
    [leadId, LEAD_ENRICHMENT_SCHEMA_VERSION],
  )
  const job = jobRows[0]
  if (!job) return { leadId, status: 'not_started', job: null, entity: null, entities: [], relations: [], topics: [], snapshot: null }
  const [entities] = await pool.query<Array<RowDataPacket & {
    id: string; entity_type: string; canonical_name: string; status: string; aliases: unknown; identifiers: unknown;
  }>>(
    `SELECT id,entity_type,canonical_name,status,aliases,identifiers FROM ${entitiesTable}
     WHERE lead_id=? ORDER BY FIELD(status,'confirmed','claimed','inferred','ambiguous','missing'),entity_type,canonical_name,id`,
    [leadId],
  )
  const [relations] = await pool.query<Array<RowDataPacket & {
    id: string; relation_type: string; status: string; evidence_fact_id: string | null;
    from_entity_id: string; from_entity_type: string; from_entity_name: string;
    to_entity_id: string; to_entity_type: string; to_entity_name: string;
  }>>(
    `SELECT r.id,r.relation_type,r.status,r.evidence_fact_id,
            source.id from_entity_id,source.entity_type from_entity_type,source.canonical_name from_entity_name,
            target.id to_entity_id,target.entity_type to_entity_type,target.canonical_name to_entity_name
     FROM ${relationsTable} r
     JOIN ${entitiesTable} source ON source.id=r.from_entity_id
     JOIN ${entitiesTable} target ON target.id=r.to_entity_id
     WHERE r.lead_id=? AND r.status<>'superseded'
     ORDER BY r.relation_type,source.canonical_name,target.canonical_name,r.id`,
    [leadId],
  )
  const [topics] = await pool.query<Array<RowDataPacket & {
    id: string; topic_key: string; status: string; execution_attempts: number; metrics: unknown;
    last_error: string | null; started_at: Date | null; completed_at: Date | null; updated_at: Date
  }>>(
    `SELECT id,topic_key,status,execution_attempts,metrics,last_error,started_at,completed_at,updated_at
     FROM ${topicRunsTable} WHERE job_id=? ORDER BY FIELD(topic_key,${LEAD_ENRICHMENT_TOPIC_KEYS.map(() => '?').join(',')})`,
    [job.id, ...LEAD_ENRICHMENT_TOPIC_KEYS],
  )
  const [snapshotRows] = await pool.query<Array<RowDataPacket & {
    id: string; status: string; snapshot_hash: string; schema_version: string; coverage: number; frozen_at: Date;
    subject_profile: unknown;
  }>>(
    `SELECT id,status,snapshot_hash,schema_version,coverage,frozen_at,subject_profile FROM ${snapshotsTable}
     WHERE job_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, [job.id],
  )
  const snapshotProfile = object(snapshotRows[0]?.subject_profile)
  const snapshotIntroductions = object(snapshotProfile.introductions)
  return {
    leadId,
    status: job.status,
    job: {
      id: job.id, schemaVersion: job.schema_version, triggerType: job.trigger_type, entityType: job.entity_type,
      entityStatus: job.entity_status, status: job.status, priority: Number(job.priority),
      attempts: Number(job.execution_attempts), error: job.last_error,
      createdAt: job.created_at, updatedAt: job.updated_at, completedAt: job.completed_at,
    },
    entity: job.entity_id ? {
      id: job.entity_id, canonicalName: job.canonical_name || '',
      aliases: array(job.aliases).map(text).filter(Boolean), identifiers: object(job.identifiers),
    } : null,
    entities: entities.map((entity) => ({
      id: entity.id, entityType: entity.entity_type, canonicalName: entity.canonical_name, status: entity.status,
      aliases: array(entity.aliases).map(text).filter(Boolean), identifiers: object(entity.identifiers),
    })),
    relations: relations.map((relation) => ({
      id: relation.id, relationType: relation.relation_type, status: relation.status,
      evidenceFactId: relation.evidence_fact_id,
      from: { id: relation.from_entity_id, entityType: relation.from_entity_type, canonicalName: relation.from_entity_name },
      to: { id: relation.to_entity_id, entityType: relation.to_entity_type, canonicalName: relation.to_entity_name },
    })),
    topics: topics.map((topic) => ({
      id: topic.id, topicKey: topic.topic_key, status: topic.status,
      attempts: Number(topic.execution_attempts), metrics: object(topic.metrics), error: topic.last_error,
      startedAt: topic.started_at, completedAt: topic.completed_at, updatedAt: topic.updated_at,
    })),
    snapshot: snapshotRows[0] ? {
      id: snapshotRows[0].id, status: snapshotRows[0].status, hash: snapshotRows[0].snapshot_hash,
      schemaVersion: snapshotRows[0].schema_version, coverage: Number(snapshotRows[0].coverage),
      frozenAt: snapshotRows[0].frozen_at,
      introductions: {
        companyIntroduction: text(snapshotIntroductions.companyIntroduction) || null,
        companyFactIds: array(snapshotIntroductions.companyFactIds).map(text).filter(Boolean),
        teamIntroduction: text(snapshotIntroductions.teamIntroduction) || null,
        teamFactIds: array(snapshotIntroductions.teamFactIds).map(text).filter(Boolean),
        projectIntroduction: text(snapshotIntroductions.projectIntroduction) || null,
        projectFactIds: array(snapshotIntroductions.projectFactIds).map(text).filter(Boolean),
      },
    } : null,
  }
}

export async function getLeadEnrichmentDisplayProfile(leadId: string) {
  const [rows] = await pool.query<Array<RowDataPacket & {
    subject_profile: unknown; frozen_at: Date;
  }>>(
    `SELECT subject_profile,frozen_at FROM ${snapshotsTable}
     WHERE lead_id=? AND schema_version=? ORDER BY created_at DESC,id DESC LIMIT 1`,
    [leadId, LEAD_ENRICHMENT_SCHEMA_VERSION],
  )
  const profile = object(rows[0]?.subject_profile)
  const introductions = object(profile.introductions)
  const factGroups = {
    companyIntroduction: array(introductions.companyFactIds).map(text).filter(Boolean),
    teamIntroduction: array(introductions.teamFactIds).map(text).filter(Boolean),
    projectIntroduction: array(introductions.projectFactIds).map(text).filter(Boolean),
  }
  const factIds = [...new Set(Object.values(factGroups).flat())]
  const [sourceRows] = factIds.length ? await pool.query<Array<RowDataPacket & {
    fact_id: string; source_url: string; title: string | null; publisher: string | null; accessed_at: Date;
  }>>(
    `SELECT fact_id,source_url,title,publisher,accessed_at FROM ${evidenceTable}
     WHERE fact_id IN (${factIds.map(() => '?').join(',')})
       AND (source_url LIKE 'http://%' OR source_url LIKE 'https://%')
     ORDER BY fact_id,created_at,id`,
    factIds,
  ) : [[]]
  const sourcesByFact = new Map<string, Array<{
    sourceUrl: string; title: string | null; publisher: string | null; accessedAt: Date;
  }>>()
  for (const source of sourceRows) {
    sourcesByFact.set(source.fact_id, [...(sourcesByFact.get(source.fact_id) || []), {
      sourceUrl: source.source_url, title: source.title, publisher: source.publisher, accessedAt: source.accessed_at,
    }])
  }
  const introductionSources = (ids: string[]) => [...new Map(ids.flatMap((id) => sourcesByFact.get(id) || [])
    .map((source) => [source.sourceUrl, source])).values()]
  return {
    leadId,
    frozenAt: rows[0]?.frozen_at ?? null,
    introductions: {
      companyIntroduction: text(introductions.companyIntroduction) || null,
      teamIntroduction: text(introductions.teamIntroduction) || null,
      projectIntroduction: text(introductions.projectIntroduction) || null,
    },
    introductionSources: {
      companyIntroduction: introductionSources(factGroups.companyIntroduction),
      teamIntroduction: introductionSources(factGroups.teamIntroduction),
      projectIntroduction: introductionSources(factGroups.projectIntroduction),
    },
  }
}

export type LeadEntityConfirmationIdentifiers = {
  creditCode?: string
  websiteDomain?: string
  legalRepresentative?: string
  registeredAddress?: string
}

function normalizeEntityConfirmationIdentifiers(input: LeadEntityConfirmationIdentifiers = {}) {
  const rawDomain = text(input.websiteDomain).toLowerCase()
  let websiteDomain = ''
  if (rawDomain) {
    try {
      websiteDomain = new URL(rawDomain.includes('://') ? rawDomain : `https://${rawDomain}`).hostname
        .replace(/^www\./, '').toLowerCase()
    } catch { websiteDomain = '' }
  }
  return Object.fromEntries(Object.entries({
    creditCode: text(input.creditCode).replace(/\s+/g, '').toUpperCase(),
    websiteDomain,
    legalRepresentative: text(input.legalRepresentative),
    registeredAddress: text(input.registeredAddress),
  }).filter(([, value]) => Boolean(value)))
}

export async function confirmLeadEnrichmentEntity(input: {
  leadId: string
  canonicalName: string
  entityType?: Exclude<LeadEntityType, 'unknown'>
  identifiers?: LeadEntityConfirmationIdentifiers
  reason: string
  actor: { userId: string; userName: string }
}) {
  const canonicalName = text(input.canonicalName).replace(/\s+/g, ' ')
  const reason = text(input.reason)
  if (canonicalName.length < 2 || canonicalName.length > 255) throw new Error('确认主体名称长度必须为2-255个字符')
  if (reason.length < 4 || reason.length > 2_000) throw new Error('主体确认依据长度必须为4-2000个字符')
  const suppliedIdentifiers = normalizeEntityConfirmationIdentifiers(input.identifiers)
  const connection = await pool.getConnection()
  let jobId = ''
  try {
    await connection.beginTransaction()
    const [leadRows] = await connection.query<Array<RowDataPacket & {
      pool_status: string; company_name: string | null; scoring: unknown; radar_profile: unknown
    }>>(`SELECT pool_status,company_name,scoring,radar_profile FROM ${leadsTable} WHERE id=? FOR UPDATE`, [input.leadId])
    const lead = leadRows[0]
    if (!lead || ['已删除', '已合并', '已注销', '已转专属项目'].includes(lead.pool_status)) {
      throw Object.assign(new Error('线索已退出有效共享池，不能确认补全主体'), { code: 'LEAD_NOT_ACTIVE' })
    }
    const knownRegistrationStatus = text(object(object(lead.scoring).registry).registrationStatus)
      || text(object(object(lead.radar_profile).registry).registrationStatus)
    if (!companyRegistrationEligibility(knownRegistrationStatus).eligibleForLeadPool) {
      throw Object.assign(new Error('登记状态明确为注销的企业不能确认进入共享线索池'), { code: 'COMPANY_DEREGISTERED' })
    }
    const [jobRows] = await connection.query<Array<RowDataPacket & {
      id: string; entity_id: string | null; entity_type: string; entity_status: string; status: string
    }>>(
      `SELECT id,entity_id,entity_type,entity_status,status FROM ${jobsTable}
       WHERE lead_id=? ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, [input.leadId],
    )
    const job = jobRows[0]
    if (!job?.entity_id) throw Object.assign(new Error('当前补全任务没有可确认的主体'), { code: 'ENTITY_NOT_FOUND' })
    jobId = job.id
    const [entityRows] = await connection.query<Array<RowDataPacket & {
      id: string; canonical_name: string; normalized_name: string; status: string; aliases: unknown; identifiers: unknown
    }>>(`SELECT id,canonical_name,normalized_name,status,aliases,identifiers FROM ${entitiesTable} WHERE id=? FOR UPDATE`, [job.entity_id])
    const entity = entityRows[0]
    if (!entity) throw Object.assign(new Error('补全主体不存在'), { code: 'ENTITY_NOT_FOUND' })
    if (job.entity_status === 'confirmed' && entity.status === 'confirmed'
      && job.entity_type !== 'unknown' && (!input.entityType || input.entityType === job.entity_type)) {
      await connection.commit()
      return {
        confirmed: true, alreadyConfirmed: true, leadId: input.leadId, jobId,
        entity: { id: entity.id, canonicalName: entity.canonical_name, aliases: array(entity.aliases), identifiers: object(entity.identifiers) },
        resumedTopics: 0,
      }
    }
    const confirmedEntityType = input.entityType || (job.entity_type === 'unknown' ? '' : job.entity_type)
    if (!['company', 'project', 'team', 'research'].includes(confirmedEntityType)) {
      throw Object.assign(new Error('确认未知主体时必须选择公司、项目、团队或科研成果类型'), {
        code: 'ENTITY_TYPE_REQUIRED', status: 400,
      })
    }
    const normalizedName = normalizedEntityName(canonicalName)
    const [collisionRows] = await connection.query<Array<RowDataPacket & { id: string }>>(
      `SELECT id FROM ${entitiesTable}
       WHERE lead_id=? AND entity_type=? AND normalized_name=? AND id<>? LIMIT 1 FOR UPDATE`,
      [input.leadId, confirmedEntityType, normalizedName, entity.id],
    )
    if (collisionRows[0]) {
      throw Object.assign(new Error('同一线索下已存在相同规范名称的主体，请先处理主体合并'), { code: 'ENTITY_CONFIRMATION_COLLISION' })
    }
    const aliases = [...new Set([
      ...array(entity.aliases).map(text), text(entity.canonical_name), canonicalName,
    ].filter(Boolean))]
    const identifiers = { ...object(entity.identifiers), ...suppliedIdentifiers }
    await connection.query(
      `UPDATE ${entitiesTable}
       SET entity_type=?,canonical_name=?,normalized_name=?,status='confirmed',aliases=CAST(? AS JSON),identifiers=CAST(? AS JSON),updated_at=NOW(3)
       WHERE id=?`,
      [confirmedEntityType, canonicalName, normalizedName, JSON.stringify(aliases), JSON.stringify(identifiers), entity.id],
    )
    const desiredTopicStates = initialTopicStates({
      entityType: confirmedEntityType as LeadEntityType,
      hasCommercialCompany: confirmedEntityType === 'research'
        && Boolean(text(lead.company_name) || text(object(lead.radar_profile).companyName)),
    })
    for (const topicKey of LEAD_ENRICHMENT_TOPIC_KEYS) {
      const desiredStatus = desiredTopicStates[topicKey]
      await connection.query(
        `UPDATE ${topicRunsTable}
         SET status=?,completed_at=IF(?='not_applicable',NOW(3),NULL),next_attempt_at=NOW(3),updated_at=NOW(3)
         WHERE job_id=? AND topic_key=? AND execution_attempts=0 AND status IN ('queued','not_applicable')`,
        [desiredStatus, desiredStatus, jobId, topicKey],
      )
    }
    const [topicRows] = await connection.query<Array<RowDataPacket & {
      id: string; execution_attempts: number; metrics: unknown
    }>>(
      `SELECT id,execution_attempts,metrics FROM ${topicRunsTable}
       WHERE job_id=? AND status='review'
         AND JSON_UNQUOTE(JSON_EXTRACT(metrics,'$.reason'))='entity_confirmation_required'
       ORDER BY created_at,id FOR UPDATE`, [jobId],
    )
    const confirmedAt = new Date().toISOString()
    for (const topic of topicRows) {
      const metrics = object(topic.metrics)
      const confirmations = Array.isArray(metrics.entityConfirmations) ? metrics.entityConfirmations : []
      metrics.entityConfirmations = [...confirmations, {
        previousEntityStatus: job.entity_status, attempts: Number(topic.execution_attempts || 0),
        canonicalName, actorId: input.actor.userId, actorName: text(input.actor.userName) || '管理员', reason, at: confirmedAt,
      }]
      delete metrics.reason
      await connection.query(
        `UPDATE ${topicRunsTable}
         SET status='queued',next_attempt_at=NOW(3),lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,
             completed_at=NULL,metrics=CAST(? AS JSON),updated_at=NOW(3) WHERE id=?`,
        [JSON.stringify(metrics), topic.id],
      )
    }
    await connection.query(
      `UPDATE ${jobsTable}
       SET entity_type=?,entity_status='confirmed',status=IF(? > 0,'queued',status),
           completed_at=IF(? > 0,NULL,completed_at),lease_owner=IF(? > 0,NULL,lease_owner),
           lease_expires_at=IF(? > 0,NULL,lease_expires_at),last_error=IF(? > 0,NULL,last_error),updated_at=NOW(3)
       WHERE id=?`,
      [confirmedEntityType, topicRows.length, topicRows.length, topicRows.length, topicRows.length, topicRows.length, jobId],
    )
    await connection.query(
      `INSERT INTO ${auditLogsTable}
        (id,user_id,user_name,module,action,target,result,request_id,created_at)
       VALUES (?,?,?,'项目获取池','人工确认联网补全主体',?,'success',?,NOW(3))`,
      [randomUUID(), input.actor.userId, text(input.actor.userName).slice(0, 64) || '管理员', JSON.stringify({
        leadId: input.leadId, jobId, entityId: entity.id, previousEntityType: job.entity_type,
        entityType: confirmedEntityType,
        previousEntityStatus: job.entity_status, canonicalName, identifiers, reason,
        resumedTopics: topicRows.length, confirmedAt,
      }), randomUUID()],
    )
    await connection.commit()
    await refreshLeadEnrichmentProjection(input.leadId, jobId)
    return {
      confirmed: true, alreadyConfirmed: false, leadId: input.leadId, jobId,
      entityType: confirmedEntityType,
      entity: { id: entity.id, canonicalName, aliases, identifiers }, resumedTopics: topicRows.length,
    }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally { connection.release() }
}

export async function retryLeadEnrichmentTopic(input: {
  leadId: string
  topicKey: LeadEnrichmentTopicKey
  reason?: string
  actor?: { userId: string; userName: string }
}) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [leadRows] = await connection.query<Array<RowDataPacket & { pool_status: string }>>(
      `SELECT pool_status FROM ${leadsTable} WHERE id=? FOR UPDATE`, [input.leadId],
    )
    const lead = leadRows[0]
    if (!lead || ['已删除', '已合并', '已注销', '已转专属项目'].includes(lead.pool_status)) {
      await connection.commit()
      return false
    }
    const [rows] = await connection.query<Array<RowDataPacket & {
      id: string; job_id: string; status: string; execution_attempts: number
    }>>(
      `SELECT tr.id,tr.job_id,tr.status,tr.execution_attempts
       FROM ${topicRunsTable} tr JOIN ${jobsTable} j ON j.id=tr.job_id
       WHERE j.lead_id=? AND tr.topic_key=?
       ORDER BY j.created_at DESC,j.id DESC LIMIT 1 FOR UPDATE`,
      [input.leadId, input.topicKey],
    )
    const topic = rows[0]
    if (!topic || !['failed', 'dead_letter', 'review', 'partial', 'missing'].includes(topic.status)) {
      await connection.commit()
      return false
    }
    const retryReason = text(input.reason) || (input.actor ? '管理员手动重试专题' : '系统重新排队专题')
    const retryEvent = {
      previousStatus: topic.status,
      attempts: Number(topic.execution_attempts || 0),
      actorId: input.actor?.userId ?? null,
      actorName: text(input.actor?.userName) || '（系统）',
      reason: retryReason,
      at: new Date().toISOString(),
    }
    const [result] = await connection.query(
      `UPDATE ${topicRunsTable}
       SET status='queued',next_attempt_at=NOW(3),lease_owner=NULL,lease_expires_at=NULL,
           last_error=NULL,completed_at=NULL,
           metrics=JSON_SET(COALESCE(metrics,JSON_OBJECT()),'$.manualRetries',
             JSON_ARRAY_APPEND(COALESCE(JSON_EXTRACT(metrics,'$.manualRetries'),JSON_ARRAY()),'$',CAST(? AS JSON))),
           updated_at=NOW(3)
       WHERE id=? AND status=?`,
      [JSON.stringify(retryEvent), topic.id, topic.status],
    )
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      await connection.rollback()
      return false
    }
    await connection.query(
      `UPDATE ${jobsTable} SET status='queued',completed_at=NULL,last_error=NULL,updated_at=NOW(3) WHERE id=?`,
      [topic.job_id],
    )
    if (input.actor) {
      await connection.query(
        `INSERT INTO ${auditLogsTable}
          (id,user_id,user_name,module,action,target,result,request_id,created_at)
         VALUES (?,?,?,'项目获取池','手动重试联网补全专题',?,'success',?,NOW(3))`,
        [randomUUID(), input.actor.userId, text(input.actor.userName).slice(0, 64) || '管理员',
          JSON.stringify({ leadId: input.leadId, topicKey: input.topicKey, ...retryEvent }), randomUUID()],
      )
    }
    await connection.commit()
    return true
  } catch (error) {
    await connection.rollback()
    throw error
  } finally { connection.release() }
}

export async function listLeadEnrichmentConflicts(leadId: string) {
  const [rows] = await pool.query<Array<RowDataPacket & {
    id: string; topic_key: LeadEnrichmentTopicKey; fact_key: string; instance_key: string; status: string; severity: string;
    candidate_fact_ids: unknown; automatic_reason: string | null; resolution: unknown;
    resolved_by: string | null; resolved_at: Date | null; created_at: Date; updated_at: Date;
  }>>(
    `SELECT id,topic_key,fact_key,instance_key,status,severity,candidate_fact_ids,automatic_reason,resolution,
            resolved_by,resolved_at,created_at,updated_at
     FROM ${conflictsTable} WHERE lead_id=? ORDER BY status='open' DESC,severity='material' DESC,created_at DESC,id DESC`,
    [leadId],
  )
  const candidateFactIds = [...new Set(rows.flatMap((row) => array(row.candidate_fact_ids).map(String)).filter(Boolean))]
  const [candidateRows] = candidateFactIds.length ? await pool.query<Array<RowDataPacket & {
    id: string; value: unknown; evidence_level: string; verification_status: string; is_current: number;
  }>>(
    `SELECT id,value,evidence_level,verification_status,is_current FROM ${factsTable}
     WHERE lead_id=? AND id IN (${candidateFactIds.map(() => '?').join(',')})`,
    [leadId, ...candidateFactIds],
  ) : [[]]
  const [candidateEvidenceRows] = candidateFactIds.length ? await pool.query<Array<RowDataPacket & {
    id: string; fact_id: string; source_url: string; title: string | null; publisher: string | null;
    quote: string; reliability: string | null;
  }>>(
    `SELECT id,fact_id,source_url,title,publisher,quote,reliability FROM ${evidenceTable}
     WHERE fact_id IN (${candidateFactIds.map(() => '?').join(',')}) ORDER BY fact_id,created_at,id`,
    candidateFactIds,
  ) : [[]]
  const evidenceByCandidate = new Map<string, Array<{
    id: string; sourceUrl: string; title: string | null; publisher: string | null;
    quote: string; reliability: string | null;
  }>>()
  for (const evidence of candidateEvidenceRows) {
    evidenceByCandidate.set(evidence.fact_id, [...(evidenceByCandidate.get(evidence.fact_id) || []), {
      id: evidence.id, sourceUrl: evidence.source_url, title: evidence.title, publisher: evidence.publisher,
      quote: evidence.quote, reliability: evidence.reliability,
    }])
  }
  const candidatesById = new Map(candidateRows.map((candidate) => [candidate.id, {
    id: candidate.id, value: jsonValue(candidate.value), evidenceLevel: candidate.evidence_level,
    verificationStatus: candidate.verification_status, isCurrent: Boolean(candidate.is_current),
    evidence: evidenceByCandidate.get(candidate.id) || [],
  }]))
  return rows.map((row) => ({
    id: row.id, topicKey: row.topic_key, factKey: row.fact_key, instanceKey: row.instance_key,
    status: row.status, severity: row.severity,
    candidateFactIds: array(row.candidate_fact_ids), automaticReason: row.automatic_reason,
    candidates: array(row.candidate_fact_ids).map(String).flatMap((id) => {
      const candidate = candidatesById.get(id)
      return candidate ? [candidate] : []
    }),
    resolution: object(row.resolution), resolvedBy: row.resolved_by, resolvedAt: row.resolved_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }))
}

export async function listLeadEnrichmentFacts(input: {
  leadId: string
  topicKey?: LeadEnrichmentTopicKey
  page?: number
  pageSize?: number
  projection?: 'audit' | 'verified-display'
}) {
  const page = Math.max(1, Math.floor(input.page || 1))
  const pageSize = Math.max(1, Math.min(100, Math.floor(input.pageSize || 25)))
  const offset = (page - 1) * pageSize
  const filters = ['display_fact.lead_id=?', 'display_fact.is_current=1']
  const parameters: unknown[] = [input.leadId]
  const displayProjection = input.projection === 'verified-display'
  if (displayProjection) {
    filters.push("display_fact.verification_status='verified'")
    filters.push(`EXISTS (
      SELECT 1 FROM ${evidenceTable} display_evidence
      WHERE display_evidence.fact_id=display_fact.id
        AND (display_evidence.source_url LIKE 'http://%' OR display_evidence.source_url LIKE 'https://%')
    )`)
    // Ordinary detail responses must not expose a confidential customer's real
    // identity through raw fact values or evidence metadata. The public profile
    // already carries the approved anonymized label, so omit the whole related
    // fact instance here instead of relying on renderer-side masking.
    filters.push(`NOT (
      (display_fact.fact_key LIKE 'customer.%'
        OR display_fact.fact_key LIKE 'contract.%'
        OR display_fact.fact_key LIKE 'order.%'
        OR display_fact.fact_key LIKE 'delivery.%'
        OR display_fact.fact_key LIKE 'cash_collection.%')
      AND (
        EXISTS (
          SELECT 1 FROM ${factsTable} confidential_fact
          WHERE confidential_fact.lead_id=display_fact.lead_id
            AND confidential_fact.subject_id=display_fact.subject_id
            AND confidential_fact.instance_key=display_fact.instance_key
            AND confidential_fact.fact_key='customer.confidentiality'
            AND confidential_fact.is_current=1
            AND confidential_fact.verification_status='verified'
            AND LOWER(JSON_UNQUOTE(confidential_fact.value)) REGEXP '保密|受限|confidential|restricted'
        )
        OR EXISTS (
          SELECT 1 FROM ${factsTable} customer_name_fact
          JOIN ${customerDictionaryTable} sensitive_customer
            ON sensitive_customer.status='active'
           AND sensitive_customer.confidentiality IN ('confidential','restricted')
           AND (
             LOWER(JSON_UNQUOTE(customer_name_fact.value))=LOWER(sensitive_customer.canonical_name)
             OR EXISTS (
               SELECT 1 FROM JSON_TABLE(
                 sensitive_customer.aliases,'$[*]' COLUMNS(alias VARCHAR(255) PATH '$')
               ) sensitive_alias
               WHERE LOWER(sensitive_alias.alias)=LOWER(JSON_UNQUOTE(customer_name_fact.value))
             )
           )
          WHERE customer_name_fact.lead_id=display_fact.lead_id
            AND customer_name_fact.subject_id=display_fact.subject_id
            AND customer_name_fact.instance_key=display_fact.instance_key
            AND customer_name_fact.fact_key IN (
              'customer.name','customer.formal','customer.framework_agreement','customer.pilot','customer.trial','customer.intent'
            )
            AND customer_name_fact.is_current=1
            AND customer_name_fact.verification_status='verified'
        )
      )
    )`)
  }
  if (input.topicKey) {
    filters.push('display_fact.topic_key=?')
    parameters.push(input.topicKey)
  }
  const where = filters.join(' AND ')
  const [countRows] = await pool.query<Array<RowDataPacket & { count: number }>>(
    `SELECT COUNT(*) count FROM ${factsTable} display_fact WHERE ${where}`,
    parameters,
  )
  const [rows] = await pool.query<Array<RowDataPacket & {
    id: string; topic_key: LeadEnrichmentTopicKey; subject_type: string; subject_id: string;
    fact_key: string; instance_key: string; value: unknown; unit: string | null; currency: string | null;
    period_start: Date | string | null; period_end: Date | string | null; scope: string | null;
    evidence_level: string; verification_status: string; version: number; created_at: Date;
    investment_profile_source: number;
  }>>(
    `SELECT id,topic_key,subject_type,subject_id,fact_key,instance_key,value,unit,currency,period_start,period_end,scope,
            evidence_level,verification_status,version,created_at,
            ${displayProjection ? `EXISTS (
              SELECT 1 FROM ${investmentProfilesTable} profile
              WHERE profile.lead_id=display_fact.lead_id
                AND JSON_CONTAINS(profile.source_fact_ids,JSON_QUOTE(display_fact.id))
            )` : 'FALSE'} investment_profile_source
     FROM ${factsTable} display_fact WHERE ${where}
     ORDER BY FIELD(topic_key,${LEAD_ENRICHMENT_TOPIC_KEYS.map(() => '?').join(',')}),fact_key,id
     LIMIT ? OFFSET ?`,
    [...parameters, ...LEAD_ENRICHMENT_TOPIC_KEYS, pageSize, offset],
  )
  const factIds = rows.map((row) => row.id)
  const [evidenceRows] = factIds.length ? await pool.query<Array<RowDataPacket & {
    id: string; fact_id: string; source_url: string; source_type: string; content_type: string | null;
    title: string | null; publisher: string | null; quote: string; locator: string | null;
    page_hash: string | null; reliability: string | null; published_at: Date | null; accessed_at: Date;
  }>>(
    `SELECT id,fact_id,source_url,source_type,content_type,title,publisher,quote,locator,page_hash,
            reliability,published_at,accessed_at
     FROM ${evidenceTable} WHERE fact_id IN (${factIds.map(() => '?').join(',')})
       ${displayProjection ? "AND (source_url LIKE 'http://%' OR source_url LIKE 'https://%')" : ''}
     ORDER BY fact_id,created_at,id`,
    factIds,
  ) : [[]]
  const evidenceByFact = new Map<string, Array<Record<string, unknown>>>()
  for (const evidence of evidenceRows) {
    const projectedEvidence = displayProjection ? {
      sourceUrl: evidence.source_url, title: evidence.title, publisher: evidence.publisher,
      publishedAt: evidence.published_at, accessedAt: evidence.accessed_at,
    } : {
      id: evidence.id, sourceUrl: evidence.source_url, sourceType: evidence.source_type,
      contentType: evidence.content_type, title: evidence.title, publisher: evidence.publisher,
      quote: evidence.quote, locator: evidence.locator, pageHash: evidence.page_hash,
      reliability: evidence.reliability, publishedAt: evidence.published_at, accessedAt: evidence.accessed_at,
    }
    evidenceByFact.set(evidence.fact_id, [...(evidenceByFact.get(evidence.fact_id) || []), projectedEvidence])
  }
  const total = Number(countRows[0]?.count || 0)
  return {
    leadId: input.leadId, page, pageSize, total, hasMore: offset + rows.length < total,
    facts: rows.map((row) => displayProjection ? {
      id: row.id, subjectType: row.subject_type, factKey: row.fact_key, instanceKey: row.instance_key,
      value: jsonValue(row.value), verificationStatus: 'verified',
      investmentProfileSource: Boolean(row.investment_profile_source),
      evidence: evidenceByFact.get(row.id) || [],
    } : ({
      id: row.id, topicKey: row.topic_key, subjectType: row.subject_type, subjectId: row.subject_id,
      factKey: row.fact_key, instanceKey: row.instance_key, value: jsonValue(row.value),
      unit: row.unit, currency: row.currency, periodStart: row.period_start, periodEnd: row.period_end,
      scope: row.scope, evidenceLevel: row.evidence_level, verificationStatus: row.verification_status,
      version: Number(row.version), createdAt: row.created_at, evidence: evidenceByFact.get(row.id) || [],
    })),
  }
}

export async function resolveLeadEnrichmentConflict(input: {
  leadId: string
  conflictId: string
  decision: 'accept_fact' | 'dismiss'
  selectedFactId?: string
  reason: string
  actor: { userId: string; userName: string }
}) {
  const connection = await pool.getConnection()
  let topicKey: LeadEnrichmentTopicKey | null = null
  try {
    await connection.beginTransaction()
    const [conflicts] = await connection.query<Array<RowDataPacket & {
      id: string; topic_key: LeadEnrichmentTopicKey; fact_key: string; instance_key: string; status: string; candidate_fact_ids: unknown;
    }>>(`SELECT id,topic_key,fact_key,instance_key,status,candidate_fact_ids FROM ${conflictsTable} WHERE id=? AND lead_id=? FOR UPDATE`, [input.conflictId, input.leadId])
    const conflict = conflicts[0]
    if (!conflict) throw Object.assign(new Error('enrichment conflict not found'), { code: 'NOT_FOUND' })
    if (conflict.status !== 'open') throw Object.assign(new Error('enrichment conflict already resolved'), { code: 'CONFLICT_ALREADY_RESOLVED' })
    let selectedFact: {
      id: string; subject_id: string; fact_key: string; instance_key: string; evidence_level: LeadEvidenceLevel
    } | null = null
    if (input.decision === 'accept_fact') {
      if (!text(input.selectedFactId)) throw new Error('accept_fact requires selectedFactId')
      const [facts] = await connection.query<Array<RowDataPacket & {
        id: string; subject_id: string; fact_key: string; instance_key: string; evidence_level: LeadEvidenceLevel;
      }>>(
        `SELECT id,subject_id,fact_key,instance_key,evidence_level FROM ${factsTable}
         WHERE id=? AND lead_id=? AND fact_key=? AND instance_key=? LIMIT 1 FOR UPDATE`,
        [input.selectedFactId, input.leadId, conflict.fact_key, conflict.instance_key],
      )
      if (!facts[0]) throw new Error('selected fact does not belong to this conflict subject')
      const candidateIds = array(conflict.candidate_fact_ids).map(String)
      if (candidateIds.length && !candidateIds.includes(facts[0].id)) throw new Error('selected fact is not a candidate of this conflict')
      selectedFact = facts[0]
      await connection.query(
        `UPDATE ${factsTable}
         SET is_current=0,valid_until=COALESCE(valid_until,NOW(3))
         WHERE lead_id=? AND subject_id=? AND fact_key=? AND instance_key=? AND is_current=1 AND id<>?`,
        [input.leadId, selectedFact.subject_id, selectedFact.fact_key, selectedFact.instance_key, selectedFact.id],
      )
      await connection.query(
        `UPDATE ${factsTable}
         SET is_current=1,verification_status=?,valid_until=NULL,valid_from=NOW(3)
         WHERE id=? AND lead_id=?`,
        [selectedFact.evidence_level === 'E3' ? 'unverified' : 'verified', selectedFact.id, input.leadId],
      )
    } else {
      const candidateIds = array(conflict.candidate_fact_ids).map(String)
      if (candidateIds.length) {
        await connection.query(
          `UPDATE ${factsTable}
           SET is_current=0,verification_status='rejected',valid_until=COALESCE(valid_until,NOW(3))
           WHERE lead_id=? AND id IN (${candidateIds.map(() => '?').join(',')})`,
          [input.leadId, ...candidateIds],
        )
      }
    }
    topicKey = conflict.topic_key
    const resolution = {
      decision: input.decision,
      selectedFactId: input.decision === 'accept_fact' ? input.selectedFactId : null,
      reason: text(input.reason),
      resolvedAt: new Date().toISOString(),
    }
    await connection.query(
      `UPDATE ${conflictsTable} SET status='resolved',resolution=CAST(? AS JSON),resolved_by=?,resolved_at=NOW(3),updated_at=NOW(3)
       WHERE id=? AND lead_id=? AND status='open'`,
      [JSON.stringify(resolution), input.actor.userId, input.conflictId, input.leadId],
    )
    await connection.query(
      `INSERT INTO ${quoteMysqlIdentifier(mysqlTableName('audit_logs'))}
        (id,user_id,user_name,module,action,target,result,request_id,created_at)
       VALUES (?,?,?,'项目获取池','裁决联网补全事实冲突',?,'success',?,NOW(3))`,
      [randomUUID(), input.actor.userId, text(input.actor.userName).slice(0, 64) || '管理员',
        JSON.stringify({ leadId: input.leadId, conflictId: input.conflictId, topicKey, ...resolution }), randomUUID()],
    )
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally { connection.release() }
  if (topicKey) await retryLeadEnrichmentTopic({ leadId: input.leadId, topicKey })
  return { resolved: true, leadId: input.leadId, conflictId: input.conflictId, topicKey }
}

export type LeadFactCandidate = {
  leadId: string
  topicRunId?: string | null
  topicKey: LeadEnrichmentTopicKey
  subjectType: string
  subjectId: string
  factKey: string
  instanceKey?: string | null
  value: unknown
  unit?: string | null
  currency?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  scope?: string | null
  conflictReason?: string | null
  acceptanceMode?: 'strict' | 'web_hit'
  evidenceLevel: LeadEvidenceLevel
  verificationStatus: LeadFactVerificationStatus
  evidence: Array<{
    sourceUrl: string
    sourceDocumentId?: string | null
    sourceType: string
    contentType?: string
    title?: string
    publisher?: string
    quote: string
    locator?: string
    pageHash?: string
    reliability?: string
    publishedAt?: Date | null
    accessedAt?: Date | null
  }>
}

export function validateLeadFactCandidate(input: LeadFactCandidate) {
  const factKey = text(input.factKey)
  const instanceKey = normalizeLeadFactInstanceKey(input.instanceKey)
  const subjectId = text(input.subjectId)
  if (!LEAD_ENRICHMENT_TOPIC_KEYS.includes(input.topicKey)) throw new Error('unknown enrichment topic')
  if (!factKey || !subjectId) throw new Error('fact requires factKey and subjectId')
  const webHit = input.acceptanceMode === 'web_hit'
  const formalValue = !['missing', 'not_applicable', 'rejected'].includes(input.verificationStatus)
  const evidence = input.evidence.flatMap((item) => {
    const sourceUrl = normalizeUrl(item.sourceUrl)
    const quote = text(item.quote)
    if (!sourceUrl || (!webHit && !quote)) return []
    return [{ ...item, sourceUrl, quote }]
  })
  if (formalValue && evidence.length === 0) {
    throw new Error(webHit ? 'web-hit fact requires a source URL' : 'non-empty formal fact requires source URL and quote')
  }
  if (!webHit && input.evidenceLevel === 'E3'
    && ['financing', 'ownership', 'customers_contracts', 'financial_operations', 'transaction_exit'].includes(input.topicKey)
    && input.verificationStatus === 'verified') {
    throw new Error('material fact supported only by E3 evidence cannot be verified')
  }
  const numericTokens = canonicalEnrichmentJson(input.value).match(/\d+(?:[.,]\d+)*/g) || []
  if (!webHit && formalValue && numericTokens.length) {
    const key = factKey.toLowerCase()
    const hasPeriod = Boolean(text(input.periodStart) || text(input.periodEnd) || text(input.scope))
    const hasUnit = Boolean(text(input.unit) || text(input.currency) || text(input.scope))
    if (/^(?:financial\.|ownership\.percentage|ownership\.snapshot_date|market\.|news\.event_date|news\.reported_date)/.test(key) && !hasPeriod) {
      throw new Error('time-bound numeric fact requires a period or scope')
    }
    if (/(?:amount|valuation|revenue|profit|cash_flow|contract\.value|order\.value|market\.size|market\.growth|percentage|performance|capacity|yield)/.test(key) && !hasUnit) {
      throw new Error('numeric fact requires unit, currency or scope')
    }
  }
  if (!webHit && formalValue) {
    const quoteTokens = evidence.map((item) => item.quote).join(' ').match(/\d+(?:[.,]\d+)*/g) || []
    const normalizedQuoteTokens = new Set(quoteTokens.map((token) => token.replace(/[,，]/g, '')))
    const unsupported = numericTokens.find((token) => !normalizedQuoteTokens.has(token.replace(/[,，]/g, '')))
    if (unsupported) throw new Error('numeric fact value is not present in the cited quote')
    if (typeof input.value === 'string') {
      const normalizedValue = input.value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
      const supportedByQuote = normalizedValue.length > 0 && evidence.some((item) => (
        item.quote.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '').includes(normalizedValue)
      ))
      let supportedWebsiteUrl = false
      if (factKey === 'profile.website') {
        try {
          const valueOrigin = new URL(input.value).origin
          supportedWebsiteUrl = evidence.some((item) => new URL(item.sourceUrl).origin === valueOrigin)
        } catch { supportedWebsiteUrl = false }
      }
      if (!supportedByQuote && !supportedWebsiteUrl) {
        throw new Error('string fact value is not present in the cited quote')
      }
    }
  }
  return {
    ...input,
    factKey,
    instanceKey,
    subjectId,
    subjectType: text(input.subjectType) || 'unknown',
    valueHash: sha256(canonicalEnrichmentJson(input.value)),
    evidence,
  }
}

function relationTargetNames(value: unknown) {
  if (typeof value === 'string') return [text(value)]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const record = value as JsonObject
  const preferredKeys = /^(?:name|companyName|legalName|owner|subject|organization|entity|technologySource)$/i
  return [...new Set(Object.entries(record)
    .filter(([key, item]) => preferredKeys.test(key) && typeof item === 'string')
    .map(([, item]) => text(item)).filter(Boolean))]
}

async function bindLeadEntityRelationEvidence(
  connection: PoolConnection,
  candidate: ReturnType<typeof validateLeadFactCandidate>,
  factId: string,
) {
  if (candidate.verificationStatus !== 'verified') return false
  const [jobRows] = await connection.query<Array<RowDataPacket & {
    entity_id: string | null; entity_type: LeadEntityType;
  }>>(
    `SELECT entity_id,entity_type FROM ${jobsTable} WHERE lead_id=? AND schema_version=? ORDER BY created_at DESC,id DESC LIMIT 1`,
    [candidate.leadId, LEAD_ENRICHMENT_SCHEMA_VERSION],
  )
  const primary = jobRows[0]
  const relationType = leadFactEntityRelationType(candidate.factKey, primary?.entity_type || 'unknown')
  if (!primary?.entity_id || !relationType) return false
  const targetNames = new Set(relationTargetNames(candidate.value).map(normalizedEntityName))
  if (!targetNames.size) return false
  const [entityRows] = await connection.query<Array<RowDataPacket & {
    id: string; entity_type: LeadEntityType; canonical_name: string; aliases: unknown;
  }>>(
    `SELECT id,entity_type,canonical_name,aliases FROM ${entitiesTable} WHERE lead_id=? FOR UPDATE`,
    [candidate.leadId],
  )
  const targetType = relationType === 'technology_source' ? null : 'company'
  const target = entityRows.find((entity) => (
    entity.id !== primary.entity_id
    && (!targetType || entity.entity_type === targetType)
    && [entity.canonical_name, ...array(entity.aliases).map(text)]
      .some((name) => targetNames.has(normalizedEntityName(name)))
  ))
  if (!target) return false
  await connection.query(
    `UPDATE ${relationsTable} SET status='superseded',updated_at=NOW(3)
     WHERE lead_id=? AND from_entity_id=? AND relation_type=? AND evidence_fact_id IS NOT NULL AND evidence_fact_id<>?`,
    [candidate.leadId, primary.entity_id, relationType, factId],
  )
  await connection.query(
    `INSERT INTO ${relationsTable}
      (id,lead_id,from_entity_id,to_entity_id,relation_type,status,evidence_fact_id,created_at,updated_at)
     VALUES (?,?,?,?,?,'confirmed',?,NOW(3),NOW(3))
     ON DUPLICATE KEY UPDATE status='confirmed',evidence_fact_id=VALUES(evidence_fact_id),updated_at=NOW(3)`,
    [randomUUID(), candidate.leadId, primary.entity_id, target.id, relationType, factId],
  )
  return true
}

export async function persistLeadFact(input: LeadFactCandidate) {
  const candidate = validateLeadFactCandidate(input)
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    if (candidate.topicRunId) {
      const [schemaRows] = await connection.query<Array<RowDataPacket & {
        schema_version: string; entity_type: LeadEntityType;
      }>>(
        `SELECT j.schema_version,j.entity_type FROM ${topicRunsTable} tr
         JOIN ${jobsTable} j ON j.id=tr.job_id
         WHERE tr.id=? AND tr.lead_id=? LIMIT 1 FOR UPDATE`,
        [candidate.topicRunId, candidate.leadId],
      )
      const currentSchemaJob = schemaRows[0]?.schema_version === LEAD_ENRICHMENT_SCHEMA_VERSION
      if (currentSchemaJob && (!leadDetailEnrichmentTopicApplies({
        topicKey: candidate.topicKey,
        entityType: schemaRows[0].entity_type,
      }) || !leadDeepEnrichmentFactKeyAllowed(candidate.factKey))) {
        throw new Error(`topic or fact key is excluded from ${LEAD_ENRICHMENT_SCHEMA_VERSION}`)
      }
    }
    if (candidate.acceptanceMode !== 'web_hit'
      && !['missing', 'not_applicable', 'rejected'].includes(candidate.verificationStatus)) {
      const documentIds = [...new Set(candidate.evidence.map((item) => text(item.sourceDocumentId)).filter(Boolean))]
      if (documentIds.length !== candidate.evidence.length) {
        throw new Error('formal evidence requires a persisted source document')
      }
      const [documents] = await connection.query<Array<RowDataPacket & {
        id: string; final_url: string; content_hash: string; extracted_text: string;
      }>>(
        `SELECT id,final_url,content_hash,extracted_text FROM ${sourceDocumentsTable}
         WHERE id IN (${documentIds.map(() => '?').join(',')})`, documentIds,
      )
      const byId = new Map(documents.map((document) => [document.id, document]))
      for (const evidence of candidate.evidence) {
        const document = byId.get(text(evidence.sourceDocumentId))
        if (!document) throw new Error('formal evidence source document is missing')
        if (text(evidence.pageHash) && text(evidence.pageHash) !== document.content_hash) {
          throw new Error('formal evidence page hash does not match the persisted source document')
        }
        if (!sourceDocumentContainsQuote(document.extracted_text, evidence.quote)) {
          throw new Error('formal evidence quote is not present in the persisted source document')
        }
      }
    }
    const [currentRows] = await connection.query<Array<RowDataPacket & {
      id: string
      value_hash: string
      version: number
      evidence_level: LeadEvidenceLevel
      verification_status: LeadFactVerificationStatus
    }>>(
      `SELECT id,value_hash,version,evidence_level,verification_status FROM ${factsTable}
       WHERE lead_id=? AND subject_id=? AND fact_key=? AND instance_key=? AND is_current=1
       ORDER BY version DESC LIMIT 1 FOR UPDATE`,
      [candidate.leadId, candidate.subjectId, candidate.factKey, candidate.instanceKey],
    )
    const current = currentRows[0]
    const insertEvidenceRows = async (factId: string) => {
      for (const item of candidate.evidence) {
        await connection.query(
          `INSERT IGNORE INTO ${evidenceTable}
            (id,fact_id,source_document_id,source_url,canonical_url_hash,source_type,content_type,title,publisher,quote,
             locator,page_hash,reliability,published_at,accessed_at,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(3))`,
          [randomUUID(), factId, item.sourceDocumentId ?? null, item.sourceUrl, sha256(item.sourceUrl), text(item.sourceType) || 'web',
            text(item.contentType) || classifyPaperContent({ url: item.sourceUrl }), text(item.title) || null,
            text(item.publisher) || null, item.quote, text(item.locator) || null, text(item.pageHash) || null,
            text(item.reliability) || null, item.publishedAt ?? null, item.accessedAt ?? new Date()],
        )
      }
    }
    if (current?.value_hash === candidate.valueHash) {
      await insertEvidenceRows(current.id)
      await bindLeadEntityRelationEvidence(connection, candidate, current.id)
      await connection.commit()
      return { inserted: false, factId: current.id, version: Number(current.version), unchanged: true }
    }
    const [existingCandidateRows] = await connection.query<Array<RowDataPacket & { id: string; version: number }>>(
      `SELECT id,version FROM ${factsTable}
       WHERE lead_id=? AND subject_id=? AND fact_key=? AND instance_key=? AND value_hash=?
       ORDER BY version DESC LIMIT 1 FOR UPDATE`,
      [candidate.leadId, candidate.subjectId, candidate.factKey, candidate.instanceKey, candidate.valueHash],
    )
    if (current && existingCandidateRows[0]) {
      await insertEvidenceRows(existingCandidateRows[0].id)
      await connection.commit()
      return {
        inserted: false, factId: existingCandidateRows[0].id, version: Number(existingCandidateRows[0].version),
        unchanged: true, conflicted: leadEvidenceLevelRank(current.evidence_level) === leadEvidenceLevelRank(candidate.evidenceLevel),
        rejectedLowerPriority: leadEvidenceLevelRank(current.evidence_level) > leadEvidenceLevelRank(candidate.evidenceLevel),
      }
    }
    const [versionRows] = await connection.query<Array<RowDataPacket & { version: number }>>(
      `SELECT COALESCE(MAX(version),0) version FROM ${factsTable}
       WHERE lead_id=? AND subject_id=? AND fact_key=? AND instance_key=? FOR UPDATE`,
      [candidate.leadId, candidate.subjectId, candidate.factKey, candidate.instanceKey],
    )
    const version = Number(versionRows[0]?.version || 0) + 1
    const insertFactVersion = async (input: {
      factId: string; isCurrent: boolean; verificationStatus: LeadFactVerificationStatus; supersedesFactId?: string | null;
    }) => {
      await connection.query(
        `INSERT INTO ${factsTable}
          (id,lead_id,topic_run_id,topic_key,subject_type,subject_id,fact_key,instance_key,value,value_hash,
           unit,currency,period_start,period_end,scope,evidence_level,verification_status,version,
           supersedes_fact_id,is_current,valid_from,valid_until,created_at)
         VALUES (?,?,?,?,?,?,?,?,CAST(? AS JSON),?,?,?,?,?,?,?,?,?,?,?,NOW(3),IF(?=1,NULL,NOW(3)),NOW(3))`,
        [input.factId, candidate.leadId, candidate.topicRunId ?? null, candidate.topicKey, candidate.subjectType,
          candidate.subjectId, candidate.factKey, candidate.instanceKey, canonicalEnrichmentJson(candidate.value), candidate.valueHash,
          text(candidate.unit) || null, text(candidate.currency) || null, text(candidate.periodStart) || null,
          text(candidate.periodEnd) || null, text(candidate.scope) || null, candidate.evidenceLevel,
          input.verificationStatus, version, input.supersedesFactId ?? null, input.isCurrent ? 1 : 0, input.isCurrent ? 1 : 0],
      )
      await insertEvidenceRows(input.factId)
    }
    if (current) {
      const currentRank = leadEvidenceLevelRank(current.evidence_level)
      const incomingRank = leadEvidenceLevelRank(candidate.evidenceLevel)
      if (incomingRank <= currentRank) {
        const candidateFactId = randomUUID()
        const sameRank = incomingRank === currentRank
        await insertFactVersion({
          factId: candidateFactId, isCurrent: false,
          verificationStatus: sameRank ? 'conflicted' : 'rejected', supersedesFactId: null,
        })
        if (sameRank) {
          await connection.query(`UPDATE ${factsTable} SET verification_status='conflicted' WHERE id=?`, [current.id])
        }
        const conflictId = randomUUID()
        const resolution = sameRank ? {} : {
          decision: 'prefer_higher_evidence', selectedFactId: current.id,
          reason: `${current.evidence_level}优先于${candidate.evidenceLevel}`,
          resolvedAt: new Date().toISOString(),
        }
        await connection.query(
          `INSERT INTO ${conflictsTable}
            (id,lead_id,topic_key,fact_key,instance_key,status,severity,candidate_fact_ids,automatic_reason,resolution,resolved_at,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,CAST(? AS JSON),?,CAST(? AS JSON),IF(?='resolved',NOW(3),NULL),NOW(3),NOW(3))`,
          [conflictId, candidate.leadId, candidate.topicKey, candidate.factKey, candidate.instanceKey, sameRank ? 'open' : 'resolved',
            sameRank ? 'material' : 'minor', JSON.stringify([current.id, candidateFactId]),
            text(candidate.conflictReason) || (sameRank
              ? '同等级来源给出不同事实值，禁止静默覆盖'
              : '较低等级证据未覆盖当前事实'),
            JSON.stringify(resolution), sameRank ? 'open' : 'resolved'],
        )
        await connection.commit()
        return {
          inserted: true, factId: candidateFactId, version, unchanged: false,
          conflicted: sameRank, rejectedLowerPriority: !sameRank, conflictId,
        }
      }
    }
    if (current) {
      await connection.query(`UPDATE ${factsTable} SET is_current=0,valid_until=NOW(3) WHERE id=?`, [current.id])
    }
    const factId = randomUUID()
    await insertFactVersion({
      factId, isCurrent: true, verificationStatus: candidate.verificationStatus, supersedesFactId: current?.id ?? null,
    })
    await bindLeadEntityRelationEvidence(connection, candidate, factId)
    if (current && leadEvidenceLevelRank(candidate.evidenceLevel) > leadEvidenceLevelRank(current.evidence_level)) {
      await connection.query(
        `INSERT INTO ${conflictsTable}
          (id,lead_id,topic_key,fact_key,instance_key,status,severity,candidate_fact_ids,automatic_reason,resolution,resolved_at,created_at,updated_at)
         VALUES (?,?,?,?,?,'resolved','minor',CAST(? AS JSON),'高等级证据替代较低等级事实',CAST(? AS JSON),NOW(3),NOW(3),NOW(3))`,
        [randomUUID(), candidate.leadId, candidate.topicKey, candidate.factKey, candidate.instanceKey, JSON.stringify([current.id, factId]),
          JSON.stringify({ decision: 'prefer_higher_evidence', selectedFactId: factId, resolvedAt: new Date().toISOString() })],
      )
    }
    await connection.commit()
    return { inserted: true, factId, version, unchanged: false }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

export type SnapshotFact = {
  id: string
  topicKey: string
  subjectType: string
  subjectId: string
  factKey: string
  instanceKey?: string
  value: unknown
  evidenceLevel: string
  verificationStatus: string
  evidenceIds: string[]
}

export function buildLeadEnrichmentSnapshot(input: {
  leadId: string
  jobId: string
  entityType: LeadEntityType
  entityStatus?: LeadEntityStatus
  entities?: unknown[]
  relations?: unknown[]
  topicRuns?: unknown[]
  topicStates: Record<LeadEnrichmentTopicKey, LeadEnrichmentTopicStatus>
  facts: SnapshotFact[]
  evidenceIndex: Record<string, unknown>
  gaps: unknown[]
  conflicts: unknown[]
  paper?: unknown
}) {
  const missingTopics = LEAD_ENRICHMENT_TOPIC_KEYS.filter((topic) => !LEAD_ENRICHMENT_TERMINAL_TOPIC_STATUSES.has(input.topicStates[topic]))
  if (missingTopics.length) throw new Error(`enrichment snapshot has non-terminal topics: ${missingTopics.join(',')}`)
  const paperIdentity = object(object(input.paper).identity)
  const paperMetadata = object(object(input.paper).metadata)
  const entityStatus = input.entityStatus ?? (input.entityType === 'unknown' ? 'missing' : 'confirmed')
  const hasReview = input.entityType === 'unknown' || ['ambiguous', 'missing'].includes(entityStatus)
    || Object.values(input.topicStates).some((status) => ['review', 'failed', 'dead_letter'].includes(status))
    || input.conflicts.length > 0
    || text(paperIdentity.sourceStatus) === 'review'
    || text(paperMetadata.publicationDateStatus) === 'source_declared_future'
  const sortedFacts = input.facts.map((fact) => ({
    ...fact, instanceKey: normalizeLeadFactInstanceKey(fact.instanceKey),
  })).sort((left, right) => (
    `${left.topicKey}|${left.subjectId}|${left.factKey}|${left.instanceKey}|${left.id}`
      .localeCompare(`${right.topicKey}|${right.subjectId}|${right.factKey}|${right.instanceKey}|${right.id}`)
  ))
  const sortedTopicRuns = [...(input.topicRuns ?? [])].sort((left, right) => (
    canonicalEnrichmentJson(left).localeCompare(canonicalEnrichmentJson(right))
  ))
  const applicableTopicStates = Object.values(input.topicStates).filter((status) => status !== 'not_applicable')
  const coverage = applicableTopicStates.length
    ? Math.round(applicableTopicStates.filter((status) => status === 'completed' || status === 'partial').length / applicableTopicStates.length * 100)
    : 100
  const content = {
    schemaVersion: LEAD_ENRICHMENT_SCHEMA_VERSION,
    leadId: input.leadId,
    entityType: input.entityType,
    entityStatus,
    entities: input.entities ?? [],
    relations: input.relations ?? [],
    topicRuns: sortedTopicRuns,
    topicStates: input.topicStates,
    facts: sortedFacts,
    evidenceIndex: input.evidenceIndex,
    gaps: input.gaps,
    conflicts: input.conflicts,
    ...(input.paper === undefined ? {} : { paper: input.paper }),
  }
  return {
    ...content,
    jobId: input.jobId,
    status: hasReview ? 'review' as const : 'ready' as const,
    coverage,
    // Topic-run IDs, attempts, timings and metrics are execution audit data. They stay in
    // the immutable snapshot, but must not turn an unchanged fact/evidence set into a new
    // semantic snapshot and trigger another V3 rating.
    snapshotHash: enrichmentSnapshotHash({ ...content, topicRuns: undefined }),
  }
}

export async function freezeLeadEnrichmentSnapshot(jobId: string) {
  const connection = await pool.getConnection()
  let transactionCommitted = false
  let connectionReleased = false
  let snapshot: ReturnType<typeof buildLeadEnrichmentSnapshot> | null = null
  let snapshotId = ''
  let inserted = false
  try {
    await connection.beginTransaction()
    const [identityRows] = await connection.query<Array<RowDataPacket & { lead_id: string }>>(
      `SELECT lead_id FROM ${jobsTable} WHERE id=? LIMIT 1`, [jobId],
    )
    if (!identityRows[0]) throw new Error('enrichment job not found')
    const [leadRows] = await connection.query<Array<RowDataPacket & {
      name: string; company_name: string | null; industry: string | null; summary: string | null;
      team: string | null; radar_profile: unknown; pool_status: string
    }>>(
      `SELECT name,company_name,industry,summary,team,radar_profile,pool_status
       FROM ${leadsTable} WHERE id=? FOR UPDATE`, [identityRows[0].lead_id],
    )
    if (!leadRows[0] || ['已删除', '已合并', '已注销', '已转专属项目'].includes(leadRows[0].pool_status)) {
      throw Object.assign(new Error('线索已退出有效共享池，不生成补全快照'), {
        code: 'LEAD_ENRICHMENT_JOB_INACTIVE', retryable: false,
      })
    }
    const [jobRows] = await connection.query<Array<RowDataPacket & {
      id: string; lead_id: string; entity_type: LeadEntityType; entity_status: LeadEntityStatus; status: string
    }>>(`SELECT id,lead_id,entity_type,entity_status,status FROM ${jobsTable} WHERE id=? FOR UPDATE`, [jobId])
    const job = jobRows[0]
    if (!job) throw new Error('enrichment job not found')
    if (job.status === 'rejected') {
      throw Object.assign(new Error('补全任务已停止，不生成补全快照'), {
        code: 'LEAD_ENRICHMENT_JOB_INACTIVE', retryable: false,
      })
    }
    const [topicRows] = await connection.query<Array<RowDataPacket & {
      id: string; topic_key: LeadEnrichmentTopicKey; status: LeadEnrichmentTopicStatus;
      prompt_version: string | null; model: string | null; toolset_version: string | null;
      query_plan: unknown; metrics: unknown; execution_attempts: number;
      started_at: Date | null; completed_at: Date | null;
    }>>(
      `SELECT id,topic_key,status,prompt_version,model,toolset_version,query_plan,metrics,execution_attempts,
              started_at,completed_at
       FROM ${topicRunsTable} WHERE job_id=? ORDER BY topic_key`, [jobId],
    )
    const topicStates = Object.fromEntries(topicRows.map((row) => [row.topic_key, row.status])) as Record<LeadEnrichmentTopicKey, LeadEnrichmentTopicStatus>
    const [rawFactRows] = await connection.query<Array<RowDataPacket & {
      id: string; topic_key: string; subject_type: string; subject_id: string; fact_key: string; instance_key: string;
      value: unknown; evidence_level: string; verification_status: string
    }>>(`SELECT id,topic_key,subject_type,subject_id,fact_key,instance_key,value,evidence_level,verification_status
         FROM ${factsTable} WHERE lead_id=? AND is_current=1 ORDER BY topic_key,subject_id,fact_key,instance_key,id`, [job.lead_id])
    const factRows = rawFactRows.filter((row) => (
      leadDetailEnrichmentTopicApplies({
        topicKey: row.topic_key as LeadEnrichmentTopicKey,
        entityType: job.entity_type,
      }) && leadDeepEnrichmentFactKeyAllowed(row.fact_key)
    ))
    const factIds = factRows.map((row) => row.id)
    const evidenceRows = factIds.length ? await connection.query<Array<RowDataPacket & {
      id: string; fact_id: string; source_document_id: string | null; source_url: string; source_type: string; content_type: string;
      title: string | null; publisher: string | null; quote: string; locator: string | null; reliability: string | null
    }>>(`SELECT id,fact_id,source_document_id,source_url,source_type,content_type,title,publisher,quote,locator,reliability
          FROM ${evidenceTable} WHERE fact_id IN (${factIds.map(() => '?').join(',')}) ORDER BY fact_id,id`, factIds) : [[]]
    const evidence = evidenceRows[0]
    const evidenceByFact = new Map<string, string[]>()
    const evidenceIndex: Record<string, unknown> = {}
    for (const row of evidence) {
      evidenceByFact.set(row.fact_id, [...(evidenceByFact.get(row.fact_id) || []), row.id])
      evidenceIndex[row.id] = {
        sourceDocumentId: row.source_document_id, sourceUrl: row.source_url, sourceType: row.source_type, contentType: row.content_type,
        title: row.title, publisher: row.publisher, quote: row.quote, locator: row.locator, reliability: row.reliability,
      }
    }
    const [rawConflictRows] = await connection.query<Array<RowDataPacket & JsonObject>>(
      `SELECT id,topic_key,fact_key,instance_key,severity,candidate_fact_ids,automatic_reason
       FROM ${conflictsTable} WHERE lead_id=? AND status='open' ORDER BY created_at,id`, [job.lead_id],
    )
    const conflictRows = rawConflictRows.filter((row) => (
      leadDetailEnrichmentTopicApplies({
        topicKey: text(row.topic_key) as LeadEnrichmentTopicKey,
        entityType: job.entity_type,
      }) && leadDeepEnrichmentFactKeyAllowed(row.fact_key)
    ))
    const paperMeta = object(object(leadRows[0]?.radar_profile).paperMeta)
    const curatedPaperMeta = curateLeadResearchMetadata(paperMeta)
    const normalizedFactRows = factRows.map((row) => ({
      ...row,
      value: jsonValue(row.value),
    }))
    const introductions = verifiedSubjectIntroductions(normalizedFactRows)
    const [entityRows] = await connection.query<Array<RowDataPacket & JsonObject>>(
      `SELECT id,entity_type,canonical_name,status,aliases,identifiers FROM ${entitiesTable} WHERE lead_id=? ORDER BY entity_type,canonical_name,id`,
      [job.lead_id],
    )
    const [relationRows] = await connection.query<Array<RowDataPacket & JsonObject>>(
      `SELECT id,from_entity_id,to_entity_id,relation_type,status,evidence_fact_id FROM ${relationsTable}
       WHERE lead_id=? AND status<>'superseded' ORDER BY relation_type,id`,
      [job.lead_id],
    )
    const scopedFactIds = new Set(factIds)
    const scopedRelationRows = relationRows.filter((row) => (
      !text(row.evidence_fact_id) || scopedFactIds.has(text(row.evidence_fact_id))
    ))
    const paper = job.entity_type === 'research' ? {
      identity: normalizePaperIdentity({
        provider: object(paperMeta.metadataSource).provider,
        sourceName: object(leadRows[0]?.radar_profile).sourceName,
        sourceId: object(leadRows[0]?.radar_profile).sourceId,
        arxivId: paperMeta.arxivId,
        openAlexId: paperMeta.openAlexId,
        doi: paperMeta.doi,
        landingPageUrl: object(leadRows[0]?.radar_profile).link,
        fullTextUrl: paperMeta.fullTextUrl,
        pdfUrl: paperMeta.pdfUrl,
      }),
      metadata: curatedPaperMeta,
    } : undefined
    snapshot = buildLeadEnrichmentSnapshot({
      leadId: job.lead_id,
      jobId,
      entityType: job.entity_type,
      entityStatus: job.entity_status,
      entities: entityRows.map((row) => ({ ...row, aliases: array(row.aliases), identifiers: object(row.identifiers) })),
      relations: scopedRelationRows,
      topicRuns: topicRows.map((row) => ({
        id: row.id, topicKey: row.topic_key, status: row.status, promptVersion: row.prompt_version,
        model: row.model, toolsetVersion: row.toolset_version, queryPlan: array(row.query_plan),
        metrics: object(row.metrics), attempts: Number(row.execution_attempts),
        startedAt: row.started_at, completedAt: row.completed_at,
      })),
      topicStates,
      facts: normalizedFactRows.map((row) => ({
        id: row.id, topicKey: row.topic_key, subjectType: row.subject_type, subjectId: row.subject_id,
        factKey: row.fact_key, instanceKey: row.instance_key, value: row.value,
        evidenceLevel: row.evidence_level, verificationStatus: row.verification_status,
        evidenceIds: evidenceByFact.get(row.id) || [],
      })),
      evidenceIndex,
      gaps: topicRows.filter((row) => ['missing', 'partial', 'not_applicable'].includes(row.status))
        .map((row) => ({ topicKey: row.topic_key, status: row.status })),
      conflicts: conflictRows.map((row) => ({ ...row, candidate_fact_ids: array(row.candidate_fact_ids) })),
      ...(paper ? { paper } : {}),
    })
    snapshotId = randomUUID()
    const [result] = await connection.query(
      `INSERT IGNORE INTO ${snapshotsTable}
        (id,lead_id,job_id,schema_version,status,snapshot_hash,topic_states,subject_profile,facts,evidence_index,gaps,conflicts,coverage,frozen_at,created_at)
       VALUES (?,?,?,?,?,?,CAST(? AS JSON),CAST(? AS JSON),CAST(? AS JSON),CAST(? AS JSON),CAST(? AS JSON),CAST(? AS JSON),?,NOW(3),NOW(3))`,
      [snapshotId, job.lead_id, jobId, LEAD_ENRICHMENT_SCHEMA_VERSION, snapshot.status, snapshot.snapshotHash,
        canonicalEnrichmentJson(snapshot.topicStates), canonicalEnrichmentJson({
          entityType: snapshot.entityType,
          entityStatus: snapshot.entityStatus,
          entities: snapshot.entities,
          relations: snapshot.relations,
          topicRuns: snapshot.topicRuns,
          identity: {
            name: leadRows[0]?.name || '',
            companyName: leadRows[0]?.company_name || '',
            industry: leadRows[0]?.industry || '',
            summary: leadRows[0]?.summary || '',
            team: leadRows[0]?.team || '',
          },
          introductions,
          paper: snapshot.paper,
        }),
        canonicalEnrichmentJson(snapshot.facts),
        canonicalEnrichmentJson(snapshot.evidenceIndex), canonicalEnrichmentJson(snapshot.gaps),
        canonicalEnrichmentJson(snapshot.conflicts), snapshot.coverage],
    )
    inserted = Number((result as { affectedRows?: number }).affectedRows || 0) === 1
    const [persistedRows] = await connection.query<Array<RowDataPacket & { id: string }>>(
      `SELECT id FROM ${snapshotsTable} WHERE lead_id=? AND snapshot_hash=? AND schema_version=?`,
      [job.lead_id, snapshot.snapshotHash, LEAD_ENRICHMENT_SCHEMA_VERSION],
    )
    snapshotId = persistedRows[0]?.id || snapshotId
    if (inserted) {
      await connection.query(
        `UPDATE ${investmentProfilesTable}
         SET profile_status='stale',stale_reason='snapshot_changed',updated_at=NOW(3)
         WHERE lead_id=? AND snapshot_hash<>?`,
        [job.lead_id, snapshot.snapshotHash],
      )
      await connection.query(
        `UPDATE ${researchProfilesTable}
         SET profile_status='stale',updated_at=NOW(3)
         WHERE lead_id=? AND COALESCE(snapshot_hash,'')<>?`,
        [job.lead_id, snapshot.snapshotHash],
      )
    }
    await connection.query(
      `UPDATE ${jobsTable}
       SET status=?,completed_at=NOW(3),lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=NOW(3)
       WHERE id=?`,
      [snapshot.status === 'ready' ? 'snapshot_ready' : 'review', jobId],
    )
    await connection.commit()
    transactionCommitted = true
    connection.release()
    connectionReleased = true
    const frozenSnapshot = snapshot
    const postCommit = await runLeadEnrichmentSnapshotPostCommit({
      enqueueRating: false,
      projectionTarget: job.entity_type === 'research' ? 'research' : 'investment',
    }, {
      refreshEnrichmentProjection: async () => {
        const projection = await refreshLeadEnrichmentProjection(job.lead_id, jobId)
        if (!projection) throw new Error('enrichment projection target disappeared after snapshot commit')
        return projection
      },
      refreshInvestmentProfileProjection: async () => {
        const profile = await refreshLeadInvestmentProfileProjection({ leadId: job.lead_id, snapshotId })
        if (!profile) throw new Error('investment profile snapshot disappeared after snapshot commit')
        return profile
      },
      refreshResearchProfileProjection: async () => {
        const result = await refreshLeadResearchProfileProjection({ leadId: job.lead_id, snapshotId })
        if (!result) throw new Error('research profile target disappeared after snapshot commit')
        return result.profile
      },
      enqueueRating: async () => false,
      recordFailures: async (failures) => {
        await pool.query(
          `UPDATE ${jobsTable} SET last_error=?,updated_at=NOW(3) WHERE id=?`,
          [`post_commit: ${failures.map((failure) => `${failure.step}: ${failure.message}`).join(' | ')}`.slice(0, 4_000), jobId],
        )
      },
      reportFailure: (failure) => {
        console.error(`[lead-enrichment] snapshot post-commit ${failure.step} failed: ${failure.message}`)
      },
    })
    return { inserted, snapshotId, snapshot: frozenSnapshot, ...postCommit }
  } catch (error) {
    if (!transactionCommitted) await connection.rollback()
    throw error
  } finally {
    if (!connectionReleased) connection.release()
  }
}

export async function loadLeadEnrichmentSnapshot(snapshotId: string, leadId?: string) {
  const [rows] = await pool.query<Array<RowDataPacket & {
    id: string; lead_id: string; status: string; snapshot_hash: string; schema_version: string;
    topic_states: unknown; subject_profile: unknown; facts: unknown; evidence_index: unknown; gaps: unknown; conflicts: unknown;
    coverage: number; frozen_at: Date
  }>>(
    `SELECT * FROM ${snapshotsTable} WHERE id=?${leadId ? ' AND lead_id=?' : ''} LIMIT 1`,
    leadId ? [snapshotId, leadId] : [snapshotId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id, leadId: row.lead_id, status: row.status, snapshotHash: row.snapshot_hash,
    schemaVersion: row.schema_version, topicStates: object(row.topic_states), subjectProfile: object(row.subject_profile), facts: array(row.facts),
    evidenceIndex: object(row.evidence_index), gaps: array(row.gaps), conflicts: array(row.conflicts),
    coverage: Number(row.coverage), frozenAt: row.frozen_at,
  }
}

export function leadRatingSubjectProfile(snapshotSubjectProfile: unknown) {
  const profile = object(snapshotSubjectProfile)
  const identity = object(profile.identity)
  const introductions = object(profile.introductions)
  return {
    entityType: text(profile.entityType),
    entityStatus: text(profile.entityStatus),
    entities: array(profile.entities),
    relations: array(profile.relations),
    identity: {
      name: text(identity.name),
      companyName: text(identity.companyName),
      industry: text(identity.industry),
    },
    introductions: {
      companyIntroduction: text(introductions.companyIntroduction) || null,
      teamIntroduction: text(introductions.teamIntroduction) || null,
      projectIntroduction: text(introductions.projectIntroduction) || null,
    },
    ...(profile.paper === undefined ? {} : { paper: profile.paper }),
  }
}
