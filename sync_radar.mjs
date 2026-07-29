const base = (process.env.EXPRESS_BASE_URL || 'http://127.0.0.1:3100').replace(/\/$/, '')
const secret = process.env.INTERNAL_SECRET || 'cybernaut-internal-2026'
const numberInRange = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback
}

const payload = {
  limit: numberInRange(process.env.RADAR_SYNC_PAGE_SIZE, 50, 1, 200),
  incrementalPages: numberInRange(process.env.RADAR_SYNC_INCREMENTAL_PAGES, 4, 1, 10),
  backfillPages: numberInRange(process.env.RADAR_SYNC_BACKFILL_PAGES, 1, 0, 10),
  source: 'all',
}

const response = await fetch(`${base}/api/leads/sync-radar`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-internal-secret': secret,
  },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(10 * 60_000),
})

if (!response.ok) {
  throw new Error(`Radar sync failed with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
}

const result = await response.json()
console.log(new Date().toISOString(), JSON.stringify({
  fetched: result.fetched ?? 0,
  pagesFetched: result.pagesFetched ?? 0,
  candidateTotal: result.candidateTotal ?? 0,
  created: result.created ?? 0,
  updated: result.updated ?? 0,
  unchanged: result.unchanged ?? 0,
  filtered: result.filtered ?? 0,
  invalid: result.invalid ?? 0,
  backfillComplete: result.backfillComplete ?? null,
}))
