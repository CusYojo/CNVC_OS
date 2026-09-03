import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import {
  LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS,
  type LeadEnrichmentTopicKey,
  leadDetailEnrichmentTopicApplies,
} from '../services/leadEnrichmentContract.js'
import { fetchLeadSourceDocument, sourceDocumentContainsQuote } from '../services/leadSourceDocumentService.js'
import { leadTopicResearchContract, researchLeadTopicWithWeb } from '../services/leadTopicWebResearchService.js'
import { readLeadTopicSearchCache, writeLeadTopicSearchCache } from '../services/leadTopicSearchCacheService.js'
import { redactSensitiveText } from '../security/redactSecrets.js'

type LeadRow = RowDataPacket & {
  id: string
  name: string
  company_name: string | null
  industry: string | null
  summary: string | null
  radar_profile: unknown
  sources: unknown
  pool_status: string
}

type JobEntityRow = RowDataPacket & {
  lead_id: string
  entity_type: string
  entity_status: string
  canonical_name: string | null
  created_at: Date
}

const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const jobsTable = quoteMysqlIdentifier(mysqlTableName('lead_enrichment_jobs'))
const entitiesTable = quoteMysqlIdentifier(mysqlTableName('lead_entities'))
const args = process.argv.slice(2)

function option(name: string, fallback = '') {
  const prefix = `--${name}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback
}

function listOption(name: string, fallback: readonly string[] = []) {
  const raw = option(name)
  return raw ? raw.split(',').map((value) => value.normalize('NFKC').trim()).filter(Boolean) : [...fallback]
}

function object(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)) } catch { return {} }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try { return array(JSON.parse(value)) } catch { return [] }
  }
  return []
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

async function main() {
  assert.equal(process.env.ALLOW_REAL_WEB_ACCEPTANCE, '1', 'requires ALLOW_REAL_WEB_ACCEPTANCE=1 because this calls a paid model and the public web')
  assert.equal(process.env.ALLOW_LEAD_RESEARCH_PREFETCH, '1', 'requires ALLOW_LEAD_RESEARCH_PREFETCH=1 because this writes runtime permits and confirmed-subject search cache rows')
  assert.equal(process.env.LEAD_ENRICHMENT_RESEARCH_BACKEND, 'codex-cli', 'prefetch requires LEAD_ENRICHMENT_RESEARCH_BACKEND=codex-cli')

  const leadIds = [...new Set(listOption('lead-ids'))]
  assert(leadIds.length >= 1 && leadIds.length <= 10, '--lead-ids requires 1-10 explicit unique lead IDs')
  assert(leadIds.every((id) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)), '--lead-ids contains an invalid UUID')
  const allowedTopics = new Set<string>(LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS)
  const topics = listOption('topics', LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS) as LeadEnrichmentTopicKey[]
  assert(topics.length >= 1 && topics.length <= LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS.length, 'topics must stay within the detail-visible bounded topic set')
  assert(topics.every((topic) => allowedTopics.has(topic)), `unknown or non-detail topic; allowed: ${LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS.join(',')}`)
  const concurrency = Math.max(1, Math.min(10, Math.round(Number(option('concurrency', '10')) || 10)))
  const model = option('model', 'gpt-5.6-sol')
  const batchId = option('batch-id', `lead-prefetch-${safeTimestamp()}-${randomUUID().slice(0, 8)}`)
  assert(/^[a-zA-Z0-9._-]{8,128}$/.test(batchId), '--batch-id must be 8-128 safe characters')

  const [leadRows] = await pool.query<LeadRow[]>(
    `SELECT id,name,company_name,industry,summary,radar_profile,sources,pool_status
     FROM ${leadsTable} WHERE id IN (${leadIds.map(() => '?').join(',')})`,
    leadIds,
  )
  const leadById = new Map(leadRows.map((lead) => [lead.id, lead]))
  assert.equal(leadRows.length, leadIds.length, 'one or more requested leads do not exist')
  const inactive = leadRows.filter((lead) => ['已删除', '已合并', '已注销', '已转专属项目'].includes(lead.pool_status))
  assert.equal(inactive.length, 0, `inactive leads cannot be prefetched: ${inactive.map((lead) => lead.id).join(',')}`)

  const [jobRows] = await pool.query<JobEntityRow[]>(
    `SELECT j.lead_id,j.entity_type,j.entity_status,e.canonical_name,j.created_at
     FROM ${jobsTable} j LEFT JOIN ${entitiesTable} e ON e.id=j.entity_id
     WHERE j.lead_id IN (${leadIds.map(() => '?').join(',')})
     ORDER BY j.lead_id,j.created_at DESC,j.id DESC`,
    leadIds,
  )
  const entityByLead = new Map<string, JobEntityRow>()
  for (const row of jobRows) if (!entityByLead.has(row.lead_id)) entityByLead.set(row.lead_id, row)
  const unconfirmed = leadIds.filter((leadId) => entityByLead.get(leadId)?.entity_status !== 'confirmed')
  assert.equal(unconfirmed.length, 0, `prefetch fails closed for non-confirmed subjects: ${unconfirmed.join(',')}`)

  const outputDir = path.resolve('outputs/lead-enrichment-prefetch')
  await mkdir(outputDir, { recursive: true })
  const receiptPath = path.join(outputDir, `${batchId}.ndjson`)
  const receipt = await open(receiptPath, 'wx')
  let appendChain = Promise.resolve()
  const append = (event: Record<string, unknown>) => {
    appendChain = appendChain.then(async () => {
      await receipt.appendFile(`${JSON.stringify({ at: new Date().toISOString(), batchId, ...event })}\n`, 'utf8')
      await receipt.sync()
    })
    return appendChain
  }

  const startedAt = Date.now()
  let nextLead = 0
  const topicReceipts: Array<Record<string, unknown>> = []
  await append({
    event: 'batch-started', mode: 'codex-web-prefetch', model, concurrency, leadIds, topics,
    businessDataWrites: 0, transientSearchCacheWrites: 'only-on-cache-miss', runtimePermitAuditWrites: 'only-on-model-call',
  })

  const runLead = async (leadId: string) => {
    const lead = leadById.get(leadId)!
    const entity = entityByLead.get(leadId)!
    const paperMeta = object(object(lead.radar_profile).paperMeta)
    const researchIdentityTitle = entity.entity_type === 'research'
      ? String(paperMeta.titleOriginal || paperMeta.title || paperMeta.titleZh || '').trim()
      : ''
    const subjectName = researchIdentityTitle || entity.canonical_name || lead.company_name || lead.name
    const applicableTopics = topics.filter((topicKey) => leadDetailEnrichmentTopicApplies({
      topicKey, entityType: entity.entity_type as Parameters<typeof leadDetailEnrichmentTopicApplies>[0]['entityType'],
    }))
    await append({ event: 'lead-started', leadId, subjectName, entityType: entity.entity_type, topics: applicableTopics })
    for (const topicKey of applicableTopics) {
      const topicStartedAt = Date.now()
      const contract = leadTopicResearchContract(topicKey, entity.entity_type)
      try {
        const cached = await readLeadTopicSearchCache<Awaited<ReturnType<typeof researchLeadTopicWithWeb>>>({
          topicKey, subjectName, entityType: entity.entity_type,
          promptVersion: contract.promptVersion, queryPlan: contract.queries,
        })
        const research = cached ?? await researchLeadTopicWithWeb({
          topicKey, subjectName, entityType: entity.entity_type, model,
          existingContext: {
            name: lead.name, companyName: lead.company_name, industry: lead.industry, summary: lead.summary,
            radarProfile: object(lead.radar_profile), sources: array(lead.sources).slice(0, 20),
          },
        })
        if (!cached) {
          await writeLeadTopicSearchCache({
            topicKey, subjectName, entityType: entity.entity_type,
            promptVersion: contract.promptVersion, queryPlan: contract.queries,
            model: research.model, result: research,
          })
        }
        const documents = new Map<string, Awaited<ReturnType<typeof fetchLeadSourceDocument>>>()
        let sourceFetchFailures = 0
        for (const url of [...new Set(research.facts.flatMap((fact) => fact.sourceUrls))].slice(0, 15)) {
          try { documents.set(url, await fetchLeadSourceDocument({ url, persist: false })) } catch { sourceFetchFailures += 1 }
        }
        const validatedFacts = research.facts.flatMap((fact) => {
          const evidenceUrls = fact.sourceUrls.filter((url) => {
            const document = documents.get(url)
            return Boolean(document && sourceDocumentContainsQuote(document.text, fact.quote))
          })
          return evidenceUrls.length ? [{ factKey: fact.factKey, instanceKey: fact.instanceKey, value: fact.value, evidenceUrls }] : []
        })
        const topicReceipt = {
          event: 'topic-finished', leadId, subjectName, entityType: entity.entity_type, topicKey,
          cacheHit: Boolean(cached), cacheWritten: !cached, promptVersion: research.promptVersion, model: research.model,
          candidateFactCount: research.candidateFactCount, contractRejectedFactCount: research.contractRejectedFactCount,
          modelAcceptedFactCount: research.facts.length, exactQuoteValidatedFactCount: validatedFacts.length,
          gapCount: research.gaps.length, conflictCount: research.conflicts.length,
          sourceCount: research.sources.length, fetchedDocumentCount: documents.size, sourceFetchFailures,
          usage: research.usage, durationMs: Date.now() - topicStartedAt,
          facts: research.facts, gaps: research.gaps, conflicts: research.conflicts, sources: research.sources,
          exactQuoteValidatedFacts: validatedFacts,
        }
        topicReceipts.push(topicReceipt)
        await append(topicReceipt)
      } catch (error) {
        const failure = {
          event: 'topic-failed', leadId, subjectName, entityType: entity.entity_type, topicKey,
          error: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 2_000),
          durationMs: Date.now() - topicStartedAt,
        }
        topicReceipts.push(failure)
        await append(failure)
      }
    }
    await append({ event: 'lead-finished', leadId, subjectName })
  }

  const workers = Array.from({ length: Math.min(concurrency, leadIds.length) }, async () => {
    while (nextLead < leadIds.length) {
      const index = nextLead
      nextLead += 1
      await runLead(leadIds[index])
    }
  })
  await Promise.all(workers)
  const failures = topicReceipts.filter((entry) => entry.event === 'topic-failed')
  const finished = topicReceipts.filter((entry) => entry.event === 'topic-finished')
  const summary = {
    event: 'batch-finished', ok: failures.length === 0, receiptPath,
    leads: leadIds.length, requestedTopics: topics.length, finishedTopics: finished.length, failedTopics: failures.length,
    cacheHits: finished.filter((entry) => entry.cacheHit === true).length,
    cacheWrites: finished.filter((entry) => entry.cacheWritten === true).length,
    candidateFacts: finished.reduce((sum, entry) => sum + Number(entry.candidateFactCount || 0), 0),
    modelAcceptedFacts: finished.reduce((sum, entry) => sum + Number(entry.modelAcceptedFactCount || 0), 0),
    exactQuoteValidatedFacts: finished.reduce((sum, entry) => sum + Number(entry.exactQuoteValidatedFactCount || 0), 0),
    durationMs: Date.now() - startedAt,
    businessDataWrites: 0,
    transientSearchCacheWrites: finished.some((entry) => entry.cacheWritten === true),
    runtimePermitAuditWrites: finished.some((entry) => entry.cacheHit !== true),
  }
  await append(summary)
  await appendChain
  await receipt.close()
  console.log(JSON.stringify(summary, null, 2))
  if (failures.length) process.exitCode = 2
}

main().catch((error) => {
  console.error(redactSensitiveText(error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
}).finally(async () => await pool.end())
