import assert from 'node:assert/strict'
import { LEAD_ENRICHMENT_TOPIC_KEYS, type LeadEnrichmentTopicKey } from '../services/leadEnrichmentContract.js'
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
  assert(subjectName.length >= 2, '--subject=<public subject> is required')
  const requested = option('topics').split(',').map((value) => value.trim()).filter(Boolean)
  assert(requested.length > 0, '--topics=<topic[,topic]> is required; no paid topic runs by default')
  const allowed = new Set<string>(LEAD_ENRICHMENT_TOPIC_KEYS)
  assert(requested.every((topic) => allowed.has(topic)), `unknown topic; allowed: ${LEAD_ENRICHMENT_TOPIC_KEYS.join(',')}`)
  if (requested.length > 3) {
    assert.equal(process.env.ALLOW_HIGH_COST_REAL_WEB_ACCEPTANCE, '1', 'more than three topics requires ALLOW_HIGH_COST_REAL_WEB_ACCEPTANCE=1')
  }
  if (requested.length === LEAD_ENRICHMENT_TOPIC_KEYS.length) {
    assert.equal(process.env.ALLOW_13_TOPIC_REAL_WEB_ACCEPTANCE, '1', 'all 13 topics require ALLOW_13_TOPIC_REAL_WEB_ACCEPTANCE=1')
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
    const validatedFacts = research.facts.flatMap((fact) => {
      const evidenceUrls = fact.sourceUrls.filter((url) => {
        const document = documents.get(url)
        return Boolean(document && sourceDocumentContainsQuote(document.text, fact.quote))
      })
      return evidenceUrls.length ? [{ factKey: fact.factKey, value: fact.value, evidenceUrls }] : []
    })
    reports.push({
      topicKey, promptVersion: research.promptVersion, model: research.model,
      candidateFacts: research.candidateFactCount,
      contractRejectedFacts: research.contractRejectedFactCount,
      modelAcceptedFacts: research.facts.length,
      exactQuoteValidatedFacts: validatedFacts.length,
      gaps: research.gaps.length, conflicts: research.conflicts.length,
      searchSources: research.sources.length, fetchedDocuments: documents.size, fetchFailures,
      usage: research.usage, durationMs: Date.now() - startedAt,
      facts: validatedFacts,
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
