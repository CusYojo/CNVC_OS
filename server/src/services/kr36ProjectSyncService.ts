import { classifyKr36Project } from './kr36ProjectClassifier.js'
import {
  fetchKr36ProjectDetail,
  fetchKr36ProjectListPage,
  kr36ProjectId,
  type Kr36Fetch,
  type Kr36ProjectRecord,
} from './kr36ProjectSourceService.js'

export type Kr36SyncMode = 'incremental' | 'backfill'

function shanghaiYear(): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()))
}

async function concurrentMap<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await task(items[index])
    }
  })
  await Promise.all(workers)
  return output
}

async function collectListItems(input: {
  mode: Kr36SyncMode
  minimumYear: number
  incrementalPages: number
  maximumBackfillPages: number
  fetchImpl?: Kr36Fetch
  signal?: AbortSignal
}) {
  const years = Array.from({ length: Math.max(1, shanghaiYear() - input.minimumYear + 1) }, (_, index) => input.minimumYear + index)
  const sorts: Array<1 | 2> = input.mode === 'backfill' ? [2] : [1, 2]
  const unique = new Map<string, Kr36ProjectRecord>()
  let pages = 0
  for (const year of years) {
    for (const sort of sorts) {
      const limit = input.mode === 'backfill' ? input.maximumBackfillPages : input.incrementalPages
      for (let pageNo = 1; pageNo <= limit; pageNo++) {
        if (input.signal?.aborted) throw input.signal.reason
        const page = await fetchKr36ProjectListPage({ pageNo, year, sort, fetchImpl: input.fetchImpl, signal: input.signal })
        pages += 1
        for (const item of page.items) {
          const id = kr36ProjectId(item)
          if (id) unique.set(id, item)
        }
        if (!page.hasMore) break
      }
    }
  }
  return { items: [...unique.entries()].map(([projectId, listItem]) => ({ projectId, listItem })), pages, years }
}

export async function previewKr36ProjectSupply(input: {
  minimumYear?: number
  pagesPerYear?: number
  mode?: Kr36SyncMode
  fetchImpl?: Kr36Fetch
  signal?: AbortSignal
} = {}) {
  const minimumYear = input.minimumYear ?? 2025
  const mode = input.mode ?? 'incremental'
  const listing = await collectListItems({
    mode, minimumYear,
    incrementalPages: Math.max(1, Math.min(input.pagesPerYear ?? 1, 20)),
    maximumBackfillPages: Math.max(1, Math.min(input.pagesPerYear ?? 500, 500)),
    fetchImpl: input.fetchImpl, signal: input.signal,
  })
  const results = await concurrentMap(listing.items, 3, async ({ projectId, listItem }) => {
    try {
      const detail = await fetchKr36ProjectDetail({ projectId, fetchImpl: input.fetchImpl, signal: input.signal })
      return { projectId, name: String(detail.name ?? listItem.name ?? ''), decision: classifyKr36Project({ detail, listItem, minimumYear }) }
    } catch (error) {
      return { projectId, name: String(listItem.name ?? ''), error: error instanceof Error ? error.message : String(error) }
    }
  })
  const decisions = results.filter((item): item is typeof item & { decision: ReturnType<typeof classifyKr36Project> } => 'decision' in item)
  const byStatus = Object.fromEntries(['eligible', 'founded_before_2025', 'founded_at_pending', 'sector_unmatched', 'registration_ineligible']
    .map((status) => [status, decisions.filter((item) => item.decision.status === status).length]))
  const bySector = Object.fromEntries(['artificial_intelligence', 'embodied_intelligence', 'semiconductor']
    .map((sector) => [sector, decisions.filter((item) => item.decision.sectorLabels.includes(sector as never)).length]))
  return {
    writeMode: 'read_only_preview',
    mode,
    minimumYear,
    years: listing.years,
    pages: listing.pages,
    listed: listing.items.length,
    detailed: decisions.length,
    failed: results.length - decisions.length,
    byStatus,
    bySector,
    examples: results.slice(0, 20),
    records: results,
  }
}

export async function runKr36ProjectSync(input: {
  mode?: Kr36SyncMode
  minimumYear?: number
  incrementalPages?: number
  maximumBackfillPages?: number
  detailConcurrency?: number
  recheckRecentDays?: number
  recheckLimit?: number
  fetchImpl?: Kr36Fetch
  signal?: AbortSignal
} = {}) {
  const [{ upsertKr36ProjectCandidate, listKr36CandidatesDueForRecheck }, { refreshAdmittedKr36Candidate }] = await Promise.all([
    import('./kr36ProjectCandidateService.js'),
    import('./kr36ProjectAdmissionService.js'),
  ])
  const mode = input.mode ?? 'incremental'
  const minimumYear = input.minimumYear ?? 2025
  const listing = await collectListItems({
    mode, minimumYear,
    incrementalPages: Math.max(1, Math.min(input.incrementalPages ?? 4, 20)),
    maximumBackfillPages: Math.max(1, Math.min(input.maximumBackfillPages ?? 500, 500)),
    fetchImpl: input.fetchImpl, signal: input.signal,
  })
  if (mode === 'incremental') {
    const rechecks = await listKr36CandidatesDueForRecheck({
      recentDays: input.recheckRecentDays ?? 90,
      limit: input.recheckLimit ?? 200,
    })
    const seen = new Set(listing.items.map((item) => item.projectId))
    for (const candidate of rechecks) {
      if (!seen.has(candidate.projectId)) listing.items.push(candidate)
    }
  }
  const results = await concurrentMap(listing.items, Math.max(1, Math.min(input.detailConcurrency ?? 3, 8)), async ({ projectId, listItem }) => {
    try {
      const detail = await fetchKr36ProjectDetail({ projectId, fetchImpl: input.fetchImpl, signal: input.signal })
      const candidate = await upsertKr36ProjectCandidate({ projectId, listItem, detail })
      let refresh: unknown = null
      if (candidate.shouldRefreshAdmitted) refresh = await refreshAdmittedKr36Candidate(candidate.id)
      return { ok: true as const, projectId, candidate, refresh }
    } catch (error) {
      const critical = error as Error & { code?: string; status?: number }
      if (critical.code === 'KR36_CONTRACT_DRIFT' || critical.status === 403) throw error
      return { ok: false as const, projectId, error: error instanceof Error ? error.message : String(error) }
    }
  })
  const succeeded = results.filter((item) => item.ok)
  const failures = results.filter((item) => !item.ok)
  if (failures.length) {
    throw Object.assign(new Error(`36氪同步有 ${failures.length} 个详情失败，已保存的候选可幂等重试`), {
      code: 'KR36_SYNC_PARTIAL_FAILURE', retryable: true,
      failures: failures.slice(0, 20),
    })
  }
  return {
    ok: failures.length === 0,
    mode,
    minimumYear,
    years: listing.years,
    pages: listing.pages,
    listed: listing.items.length,
    processed: succeeded.length,
    created: succeeded.filter((item) => item.candidate.created).length,
    changed: succeeded.filter((item) => item.candidate.contentChanged).length,
    eligible: succeeded.filter((item) => item.candidate.decision.eligible).length,
    refreshed: succeeded.filter((item) => item.refresh).length,
    failed: failures.length,
    failures: failures.slice(0, 20),
  }
}
