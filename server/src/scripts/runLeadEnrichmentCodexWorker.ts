import { leadEnrichmentWorkerHealth, startLeadEnrichmentWorker, stopLeadEnrichmentWorker } from '../services/leadEnrichmentWorkerService.js'

const workerLabel = process.env.LEAD_ENRICHMENT_WORKER_LABEL?.trim() || `codex-worker-${process.pid}`
let stopping = false

async function stop(signal: string) {
  if (stopping) return
  stopping = true
  console.log(JSON.stringify({ event: 'lead_enrichment_codex_worker_stopping', workerLabel, signal }))
  await stopLeadEnrichmentWorker()
  process.exit(0)
}

process.on('SIGINT', () => { void stop('SIGINT') })
process.on('SIGTERM', () => { void stop('SIGTERM') })

if (process.env.LEAD_ENRICHMENT_RESEARCH_BACKEND !== 'codex-cli') {
  throw new Error('LEAD_ENRICHMENT_RESEARCH_BACKEND=codex-cli is required')
}
await startLeadEnrichmentWorker()
console.log(JSON.stringify({
  event: 'lead_enrichment_codex_worker_started',
  workerLabel,
  health: await leadEnrichmentWorkerHealth(),
}))
