import assert from 'node:assert/strict'
import {
  LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS,
  leadDetailEnrichmentTopicApplies,
  type LeadEntityType,
  type LeadEnrichmentTopicKey,
} from '../services/leadEnrichmentContract.js'
import { fetchLeadSourceDocument, sourceDocumentContainsQuote } from '../services/leadSourceDocumentService.js'
import { researchLeadTopicWithWeb } from '../services/leadTopicWebResearchService.js'
import { pool } from '../db/client.js'

const args = new Set(process.argv.slice(2))

function option(name: string, fallback = '') {
  const prefix = `--${name}=`
  return [...args].find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback
}

async function main() {
  assert.equal(process.env.ALLOW_REAL_WEB_ACCEPTANCE, '1', 'requires ALLOW_REAL_WEB_ACCEPTANCE=1 because this calls a paid model and the public web')
  const subjectName = option('subject').normalize('NFKC').trim()
  const entityType = option('entity-type', 'company').normalize('NFKC').trim()
  assert(['company', 'project', 'team', 'research', 'unknown'].includes(entityType), '--entity-type must be company, project, team, research or unknown')
  assert(subjectName.length >= 2, '--subject=<public subject> is required')
  const requested = option('topics').split(',').map((value) => value.trim()).filter(Boolean)
  assert(requested.length > 0, '--topics=<topic[,topic]> is required; no paid topic runs by default')
  const allowedTopics = LEAD_DETAIL_ENRICHMENT_TOPIC_KEYS.filter((topicKey) => leadDetailEnrichmentTopicApplies({
    topicKey,
    entityType: entityType as LeadEntityType,
  }))
  const allowed = new Set<string>(allowedTopics)
  assert(requested.every((topic) => allowed.has(topic)), `unknown or excluded topic; allowed: ${allowedTopics.join(',')}`)
  if (requested.length > 3) {
    assert.equal(process.env.ALLOW_HIGH_COST_REAL_WEB_ACCEPTANCE, '1', 'more than three topics requires ALLOW_HIGH_COST_REAL_WEB_ACCEPTANCE=1')
  }
  const reports = []
  for (const topicKey of requested as LeadEnrichmentTopicKey[]) {
    const startedAt = Date.now()
    const research = await researchLeadTopicWithWeb({ topicKey, subjectName, entityType })
    const documents = new Map<string, Awaited<ReturnType<typeof fetchLeadSourceDocument>>>()
    let fetchFailures = 0
    for (const sourceUrl of [...new Set(research.facts.flatMap((fact) => fact.sourceUrls))].slice(0, 10)) {
      try {
        documents.set(sourceUrl, await fetchLeadSourceDocument({ url: sourceUrl, persist: false }))
      } catch { fetchFailures += 1 }
    }
    const webHitFacts = research.facts.map((fact) => ({
      factKey: fact.factKey,
      value: fact.value,
      sourceUrls: fact.sourceUrls,
    }))
    const exactQuoteValidatedFacts = research.facts.filter((fact) => {
      if (!fact.quote) return false
      return fact.sourceUrls.some((url) => {
        const document = documents.get(url)
        return Boolean(document && sourceDocumentContainsQuote(document.text, fact.quote))
      })
    })
    reports.push({
      topicKey, promptVersion: research.promptVersion, model: research.model,
      candidateFacts: research.candidateFactCount,
      contractRejectedFacts: research.contractRejectedFactCount,
      modelAcceptedFacts: research.facts.length,
      webHitFacts: webHitFacts.length,
      exactQuoteValidatedFacts: exactQuoteValidatedFacts.length,
      gaps: research.gaps.length, conflicts: research.conflicts.length,
      searchSources: research.sources.length, fetchedDocuments: documents.size, fetchFailures,
      usage: research.usage, durationMs: Date.now() - startedAt,
      facts: webHitFacts,
    })
  }
  console.log(JSON.stringify({
    ok: true, mode: 'real-web-read-only', subjectName, entityType,
    topics: reports, databaseWrites: 0,
    note: 'Paid real-web evidence acceptance only; it does not prove database writeback, snapshot scoring, browser E2E or production deployment.',
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}).finally(async () => await pool.end())
