import { createHash } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  LEAD_RESEARCH_PROFILE_PROJECTION_VERSION,
  LEAD_RESEARCH_PROFILE_SCHEMA_VERSION,
  type LeadResearchProfileSummary,
} from '../contracts/leadResearchProfileContract.js'
import {
  LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS,
  LEAD_ENRICHMENT_SCHEMA_VERSION,
  leadDetailEnrichmentTopicApplies,
  type LeadEnrichmentTopicKey,
} from './leadEnrichmentContract.js'

type JsonObject = Record<string, unknown>
export type LeadResearchProfileFact = { id: string; factKey: string; value: unknown; createdAt?: string | Date }

const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const snapshotsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_snapshots'))
const projectionsTable = quoteMysqlIdentifier(mysqlTableName('lead_research_profile_projections'))

function object(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)) } catch { return {} }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function list(value: unknown): unknown[] {
  if (typeof value === 'string') {
    try { return list(JSON.parse(value)) } catch { return [] }
  }
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).normalize('NFKC').trim() : ''
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return unique(value.flatMap(strings))
  const valueText = text(value)
  return valueText ? unique(valueText.split(/[、,，;；|]/u).map((item) => item.trim())) : []
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.normalize('NFKC').trim()).filter(Boolean))]
}

function firstFact(facts: LeadResearchProfileFact[], ...keys: string[]) {
  return facts.find((fact) => keys.includes(fact.factKey) && (text(fact.value) || list(fact.value).length))
}

function factStrings(facts: LeadResearchProfileFact[], ...keys: string[]) {
  return unique(facts.filter((fact) => keys.includes(fact.factKey)).flatMap((fact) => strings(fact.value)))
}

export function isLeadResearchProfileFactKey(value: unknown): boolean {
  const key = text(value)
  return /^(?:paper\.|research\.|artifact\.|license\.|patent\.|ip\.|technology\.transfer_status$|news\.)/.test(key)
    || /^(?:profile\.(?:project_introduction|user_problem|solution|application_scenario)|team\.(?:member|role|institution|department_lab))$/.test(key)
}

export function leadResearchTopicGaps(topicKey: LeadEnrichmentTopicKey, radarProfileValue: unknown): string[] {
  const radarProfile = object(radarProfileValue)
  const paperMeta = object(radarProfile.paperMeta)
  const rights = object(paperMeta.rights)
  const has = (value: unknown) => Boolean(text(value) || list(value).length || Object.keys(object(value)).length)
  const gaps: Partial<Record<LeadEnrichmentTopicKey, Array<[string, boolean]>>> = {
    basic_profile: [['论文稳定身份', has(paperMeta.doi || paperMeta.arxivId || paperMeta.openAlexId || radarProfile.sourceId)], ['摘要', has(paperMeta.abstract || paperMeta.abstractZh)], ['研究分类', has(paperMeta.categories)]],
    team: [['作者', has(paperMeta.authors)], ['作者机构', has(paperMeta.affiliations)], ['作者与机构逐一绑定', has(paperMeta.authorAffiliations)]],
    products: [['代码、数据集、模型、工具或原型链接', has(object(rights.code).url || object(rights.dataset).url || object(rights.model).url)]],
    technology_ip: [['文章/代码/数据集许可', has(object(rights.articleLicense).code || object(rights.code).license || object(rights.dataset).license)], ['专利或知识产权归属', object(rights.intellectualProperty).status === 'confirmed']],
    industrialization: [['技术成熟度、复现性、验证或应用阶段', false]],
    latest_developments: [['论文版本、录用、奖项、开源、合作或转化最新动态', false]],
  }
  return (gaps[topicKey] ?? []).filter(([, present]) => !present).map(([label]) => label)
}

export function leadResearchTopicGapsByTopic(radarProfileValue: unknown) {
  return Object.fromEntries(
    LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS
      .filter((topicKey) => leadDetailEnrichmentTopicApplies({ topicKey, entityType: 'research' }))
      .map((topicKey) => [topicKey, leadResearchTopicGaps(topicKey, radarProfileValue)]),
  ) as Partial<Record<LeadEnrichmentTopicKey, string[]>>
}

export function buildLeadResearchProfile(input: {
  leadId: string
  name: string
  radarProfile?: unknown
  facts?: LeadResearchProfileFact[]
  conflicts?: unknown[]
  updatedAt?: string | Date | null
}): LeadResearchProfileSummary {
  const radarProfile = object(input.radarProfile)
  const paperMeta = object(radarProfile.paperMeta)
  const facts = (input.facts ?? []).filter((fact) => isLeadResearchProfileFactKey(fact.factKey))
  const rights = object(paperMeta.rights)
  const articleLicense = object(rights.articleLicense)
  const datasetRights = object(rights.dataset)
  const codeRights = object(rights.code)
  const ipRights = object(rights.intellectualProperty)
  const providerIds = Object.fromEntries([
    ['sourceId', text(radarProfile.sourceId)], ['arxivId', text(paperMeta.arxivId)],
    ['openAlexId', text(paperMeta.openAlexId)], ['doi', text(paperMeta.doi)],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])))
  const paperAuthors = list(paperMeta.paperAuthors).map(object)
  const contributions = new Map<string, string>(list(paperMeta.authorContributions).map((item): [string, string] => {
    const row = object(item)
    return [text(row.author), text(row.label || row.role)]
  }).filter(([name]) => Boolean(name)))
  const authors = unique(strings(paperMeta.authors)).map((name) => {
    const identity = paperAuthors.find((row) => text(row.name) === name) ?? {}
    return {
      name,
      role: contributions.get(name) || text(identity.role) || undefined,
      openAlexAuthorId: text(identity.openAlexAuthorId) || undefined,
      orcid: text(identity.orcid) || undefined,
    }
  })
  const affiliations = unique([
    ...list(paperMeta.affiliations).map((item) => text(object(item).name)),
    ...list(paperMeta.authorAffiliations).map((item) => text(object(item).affiliation)),
    ...factStrings(facts, 'team.institution', 'team.department_lab'),
  ])
  const methods = factStrings(facts, 'research.method', 'technology.route', 'profile.solution')
  const applicationScenarios = factStrings(facts, 'research.application_scenario', 'profile.application_scenario', 'product.use_case')
  const latestDevelopments: LeadResearchProfileSummary['latestDevelopments'] = facts.filter((fact) => fact.factKey === 'news.event').slice(0, 3).map((fact) => ({
    title: text(fact.value),
    occurredAt: text(facts.find((candidate) => candidate.factKey === 'news.event_date')?.value) || undefined,
  })).filter((item) => Boolean(item.title))
  const publicationDate = text(paperMeta.publishedAt || paperMeta.declaredPublishedAt || radarProfile.publishedAt)
  if (!latestDevelopments.length && publicationDate) {
    latestDevelopments.push({ title: text(paperMeta.venue) ? `发表于 ${text(paperMeta.venue)}` : '论文公开', occurredAt: publicationDate, sourceUrl: text(object(paperMeta.metadataSource).url || radarProfile.link) || undefined })
  }
  const direction = unique(strings(paperMeta.categories))
  const researchProblem = text(firstFact(facts, 'research.problem', 'profile.user_problem', 'profile.project_introduction')?.value)
    || text(paperMeta.abstractZh || paperMeta.abstract)
  const codeUrl = text(codeRights.url || firstFact(facts, 'artifact.code_url')?.value)
  const datasetUrl = text(datasetRights.url || firstFact(facts, 'artifact.dataset_url')?.value)
  const modelUrl = text(firstFact(facts, 'artifact.model_url')?.value)
  const values = {
    applicationScenarios,
    trl: text(firstFact(facts, 'research.trl')?.value) || undefined,
    prototype: text(firstFact(facts, 'research.prototype')?.value) || undefined,
    validation: text(firstFact(facts, 'research.validation')?.value) || undefined,
    commercialization: text(firstFact(facts, 'research.commercialization')?.value) || undefined,
    transferStatus: text(firstFact(facts, 'technology.transfer_status')?.value) || undefined,
    spinOff: text(firstFact(facts, 'research.spin_off')?.value) || undefined,
    partners: factStrings(facts, 'research.partner', 'customer.research_partner'),
  }
  const dimensionPresence = [
    Boolean(direction.length || researchProblem || methods.length), Boolean(authors.length || affiliations.length),
    Boolean(publicationDate || paperMeta.venue || codeUrl || datasetUrl || modelUrl),
    Boolean(applicationScenarios.length || values.trl || values.prototype || values.validation || values.transferStatus),
    Boolean(articleLicense.code || codeRights.license || datasetRights.license || ipRights.status === 'confirmed'),
    Boolean(latestDevelopments.length),
  ]
  const verifiedDimensions = dimensionPresence.filter(Boolean).length
  const conflictCount = (input.conflicts ?? []).filter((conflict) => isLeadResearchProfileFactKey(object(conflict).factKey)).length
  const sourceFactIds = unique(facts.map((fact) => fact.id))
  const source = sourceFactIds.length ? Object.keys(paperMeta).length ? 'paper_metadata+snapshot' : 'snapshot' : 'paper_metadata'
  const updatedAt = input.updatedAt ? new Date(input.updatedAt).toISOString() : undefined
  return {
    schemaVersion: LEAD_RESEARCH_PROFILE_SCHEMA_VERSION,
    projectionVersion: LEAD_RESEARCH_PROFILE_PROJECTION_VERSION,
    subject: { leadId: input.leadId, type: 'research', name: input.name, title: text(paperMeta.titleZh || paperMeta.title || paperMeta.titleOriginal) || undefined, provider: text(object(paperMeta.metadataSource).provider || radarProfile.sourceName) || undefined, providerIds },
    direction: { categories: direction.slice(0, 8), researchProblem: researchProblem ? researchProblem.slice(0, 500) : undefined, methods: methods.slice(0, 5) },
    team: { authors: authors.slice(0, 12), affiliations: affiliations.slice(0, 8) },
    progress: { venue: text(paperMeta.venue) || undefined, publishedAt: publicationDate || undefined, resourceType: text(paperMeta.resourceType) || undefined, codeUrl: codeUrl || undefined, datasetUrl: datasetUrl || undefined, modelUrl: modelUrl || undefined, reproducibility: text(firstFact(facts, 'research.reproducibility')?.value) || undefined },
    valueAndTransfer: values,
    rights: { articleLicense: text(articleLicense.code || articleLicense.label) || undefined, datasetLicense: text(datasetRights.license) || undefined, codeLicense: text(codeRights.license) || undefined, modelLicense: text(firstFact(facts, 'license.model')?.value) || undefined, patents: factStrings(facts, 'patent.number', 'patent.status'), intellectualProperty: ipRights.status === 'confirmed' ? text(ipRights.label || ipRights.owner) || '已披露' : text(firstFact(facts, 'ip.owner')?.value) || undefined },
    latestDevelopments,
    dataStatus: { status: conflictCount ? 'conflicted' : verifiedDimensions === 6 ? 'verified' : verifiedDimensions ? 'partial' : 'missing', verifiedDimensions, applicableDimensions: 6, conflictCount, source, updatedAt },
    sourceFactIds,
  }
}

function fingerprint(profile: LeadResearchProfileSummary) {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex')
}

export async function refreshLeadResearchProfileProjection(input: { leadId: string; snapshotId?: string }) {
  const [leadRows] = await pool.query<Array<RowDataPacket & { id: string; name: string; radar_profile: unknown; updated_at: Date }>>(
    `SELECT id,name,radar_profile,created_at updated_at FROM ${leadsTable} WHERE id=? AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(radar_profile,'$.channel')),'')='论文' LIMIT 1`,
    [input.leadId],
  )
  const lead = leadRows[0]
  if (!lead) return null
  const [snapshotRows] = await pool.query<Array<RowDataPacket & { id: string; snapshot_hash: string; facts: unknown; conflicts: unknown; frozen_at: Date }>>(
    `SELECT id,snapshot_hash,facts,conflicts,frozen_at FROM ${snapshotsTable} WHERE lead_id=?${input.snapshotId ? ' AND id=?' : ''} AND schema_version=? AND status IN ('ready','review') ORDER BY created_at DESC,id DESC LIMIT 1`,
    input.snapshotId ? [input.leadId, input.snapshotId, LEAD_ENRICHMENT_SCHEMA_VERSION] : [input.leadId, LEAD_ENRICHMENT_SCHEMA_VERSION],
  )
  const snapshot = snapshotRows[0]
  const facts = list(snapshot?.facts).map(object).flatMap((fact) => fact.verificationStatus === 'verified' && list(fact.evidenceIds).length && text(fact.id) ? [{ id: text(fact.id), factKey: text(fact.factKey), value: fact.value, createdAt: snapshot?.frozen_at }] : [])
  const profile = buildLeadResearchProfile({ leadId: lead.id, name: lead.name, radarProfile: lead.radar_profile, facts, conflicts: list(snapshot?.conflicts), updatedAt: snapshot?.frozen_at ?? lead.updated_at })
  const nextFingerprint = fingerprint(profile)
  const [currentRows] = await pool.query<Array<RowDataPacket & { source_hash: string }>>(`SELECT source_hash FROM ${projectionsTable} WHERE lead_id=?`, [lead.id])
  const changed = currentRows[0]?.source_hash !== nextFingerprint
  if (changed) await pool.query(
    `INSERT INTO ${projectionsTable} (lead_id,schema_version,projection_version,snapshot_id,snapshot_hash,source_hash,profile_payload,profile_status,source_fact_ids,facts_updated_at,projected_at,updated_at)
     VALUES (?,?,?,?,?,?,CAST(? AS JSON),?,CAST(? AS JSON),?,NOW(3),NOW(3))
     ON DUPLICATE KEY UPDATE schema_version=VALUES(schema_version),projection_version=VALUES(projection_version),snapshot_id=VALUES(snapshot_id),snapshot_hash=VALUES(snapshot_hash),source_hash=VALUES(source_hash),profile_payload=VALUES(profile_payload),profile_status=VALUES(profile_status),source_fact_ids=VALUES(source_fact_ids),facts_updated_at=VALUES(facts_updated_at),projected_at=NOW(3),updated_at=NOW(3)`,
    [lead.id, LEAD_RESEARCH_PROFILE_SCHEMA_VERSION, LEAD_RESEARCH_PROFILE_PROJECTION_VERSION, snapshot?.id ?? null, snapshot?.snapshot_hash ?? null, nextFingerprint, JSON.stringify(profile), profile.dataStatus.status, JSON.stringify(profile.sourceFactIds), profile.dataStatus.updatedAt ? new Date(profile.dataStatus.updatedAt) : null],
  )
  return { profile, write: { changed, beforeFingerprint: currentRows[0]?.source_hash ?? null, afterFingerprint: nextFingerprint } }
}

export function publicLeadResearchProfile(profile: LeadResearchProfileSummary): Omit<LeadResearchProfileSummary, 'sourceFactIds'> {
  const { sourceFactIds: _sourceFactIds, ...publicProfile } = profile
  return publicProfile
}
