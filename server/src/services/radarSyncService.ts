import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { radarSyncState } from '../db/schema.js'

export interface RadarCandidate {
  [key: string]: unknown
}

interface RadarPagePayload {
  items?: RadarCandidate[]
  total?: number
  has_more?: boolean
  next_cursor?: string
}

export interface RadarWindow {
  items: RadarCandidate[]
  total: number
  pages: number
  nextCursor: string
  hasMore: boolean
}

export async function fetchRadarWindow(options: {
  baseUrl: string
  pageSize: number
  maxPages: number
  cursor?: string
  source?: string
  group?: string
}): Promise<RadarWindow> {
  const items: RadarCandidate[] = []
  let cursor = options.cursor?.trim() ?? ''
  let total = 0
  let hasMore = false
  let pages = 0
  const seenCursors = new Set<string>()

  for (let page = 0; page < options.maxPages; page++) {
    const params = new URLSearchParams({
      limit: String(options.pageSize),
      attention_only: 'false',
      sort: 'collected',
    })
    if (cursor) params.set('cursor', cursor)
    if (options.source && options.source !== 'all') params.set('source', options.source)
    if (options.group) params.set('group', options.group)
    const resp = await fetch(`${options.baseUrl}/api/candidates?${params.toString()}`, {
      signal: AbortSignal.timeout(20_000),
    })
    if (!resp.ok) throw new Error(`雷达服务 ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    const payload = await resp.json() as RadarPagePayload
    const pageItems = Array.isArray(payload.items) ? payload.items : []
    if (pages === 0) total = Number(payload.total) || 0
    items.push(...pageItems)
    pages += 1
    hasMore = Boolean(payload.has_more)
    const nextCursor = typeof payload.next_cursor === 'string' ? payload.next_cursor : ''
    if (!hasMore || !nextCursor || pageItems.length === 0) {
      cursor = ''
      hasMore = false
      break
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error('雷达游标未前进，已停止同步以避免死循环')
    }
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }

  return {
    items,
    total,
    pages,
    nextCursor: hasMore ? cursor : '',
    hasMore,
  }
}

export async function readRadarSyncState(id = 'main') {
  const [row] = await db.select().from(radarSyncState).where(eq(radarSyncState.id, id)).limit(1)
  return row ?? {
    id,
    backfillCursor: null,
    backfillComplete: false,
    updatedAt: new Date(0),
  }
}

export async function saveRadarSyncState(input: {
  id?: string
  backfillCursor: string | null
  backfillComplete: boolean
}) {
  const id = input.id ?? 'main'
  const [row] = await db.insert(radarSyncState).values({
    id,
    backfillCursor: input.backfillCursor,
    backfillComplete: input.backfillComplete,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: radarSyncState.id,
    set: {
      backfillCursor: input.backfillCursor,
      backfillComplete: input.backfillComplete,
      updatedAt: new Date(),
    },
  }).returning()
  return row
}
