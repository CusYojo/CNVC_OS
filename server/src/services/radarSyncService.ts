import { eq } from 'drizzle-orm'
import type { RowDataPacket } from 'mysql2'
import { db, pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { radarSyncState } from '../db/schema.js'
import { readLegacyRadarCandidates } from './radarDataMigrationService.js'

export interface RadarCandidate {
  [key: string]: unknown
}

interface RadarPagePayload {
  items?: RadarCandidate[]
  total?: number
  has_more?: boolean
  next_cursor?: string
}

type RadarCandidateRow = RowDataPacket & {
  payload: Record<string, unknown> | string
  cursor_timestamp: number
  cursor_digest: string
}

const radarCandidatesTable = quoteMysqlIdentifier(mysqlTableName('radar_candidates'))

function decodeCursor(value: string): { timestamp: number; digest: string } {
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { v?: unknown; t?: unknown; k?: unknown }
    const timestamp = Number(payload.t)
    const digest = String(payload.k ?? '')
    if (payload.v !== 1 || !Number.isSafeInteger(timestamp) || timestamp < 0 || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error('invalid fields')
    }
    return { timestamp, digest }
  } catch {
    throw new Error('无效的 Radar 候选游标')
  }
}

function encodeCursor(timestamp: number, digest: string): string {
  return Buffer.from(JSON.stringify({ v: 1, t: timestamp, k: digest })).toString('base64url')
}

async function fetchRadarMySqlPage(options: {
  limit: number
  cursor?: string
  source?: string
  group?: string
}): Promise<RadarPagePayload> {
  const where: string[] = []
  const params: unknown[] = []
  if (options.source && options.source !== 'all') {
    where.push('source=?')
    params.push(options.source)
  }
  if (options.group) {
    where.push('source_group=?')
    params.push(options.group)
  }
  const countClause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const countParams = [...params]
  if (options.cursor) {
    const cursor = decodeCursor(options.cursor)
    where.push('(cursor_timestamp < ? OR (cursor_timestamp = ? AND cursor_digest < ?))')
    params.push(cursor.timestamp, cursor.timestamp, cursor.digest)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [countRows] = await pool.query<Array<RowDataPacket & { total: number }>>(
    `SELECT COUNT(*) AS total FROM ${radarCandidatesTable} ${countClause}`,
    countParams,
  )
  const [rows] = await pool.query<RadarCandidateRow[]>(
    `SELECT payload, cursor_timestamp, cursor_digest FROM ${radarCandidatesTable} ${clause}
     ORDER BY cursor_timestamp DESC, cursor_digest DESC LIMIT ?`,
    [...params, options.limit + 1],
  )
  const hasMore = rows.length > options.limit
  const page = rows.slice(0, options.limit)
  const last = page.at(-1)
  return {
    items: page.map((row) => typeof row.payload === 'string' ? JSON.parse(row.payload) as RadarCandidate : row.payload),
    total: Number(countRows[0]?.total) || 0,
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor(Number(last.cursor_timestamp), String(last.cursor_digest)) : '',
  }
}

export interface RadarWindow {
  items: RadarCandidate[]
  total: number
  pages: number
  nextCursor: string
  hasMore: boolean
}

export async function fetchRadarWindow(options: {
  baseUrl?: string
  pageSize: number
  maxPages: number
  cursor?: string
  source?: string
  group?: string
  readMode?: 'mysql' | 'files'
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
    let payload: RadarPagePayload
    if (options.baseUrl) {
      const resp = await fetch(`${options.baseUrl}/api/candidates?${params.toString()}`, {
        signal: AbortSignal.timeout(20_000),
      })
      if (!resp.ok) throw new Error(`雷达服务 ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
      payload = await resp.json() as RadarPagePayload
    } else if (options.readMode === 'files') {
      let rows = await readLegacyRadarCandidates()
      if (options.source && options.source !== 'all') rows = rows.filter((item) => item.source === options.source)
      if (options.group) rows = rows.filter((item) => item.source_group === options.group)
      const offset = cursor.startsWith('legacy:') ? Number(cursor.slice('legacy:'.length)) || 0 : 0
      const pageItems = rows.slice(offset, offset + options.pageSize)
      const nextOffset = offset + pageItems.length
      payload = {
        items: pageItems,
        total: rows.length,
        has_more: nextOffset < rows.length,
        next_cursor: nextOffset < rows.length ? `legacy:${nextOffset}` : '',
      }
    } else {
      payload = await fetchRadarMySqlPage({
        limit: options.pageSize,
        cursor,
        source: options.source,
        group: options.group,
      })
    }
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
  await db.insert(radarSyncState).values({
    id,
    backfillCursor: input.backfillCursor,
    backfillComplete: input.backfillComplete,
    updatedAt: new Date(),
  }).onDuplicateKeyUpdate({
    set: {
      backfillCursor: input.backfillCursor,
      backfillComplete: input.backfillComplete,
      updatedAt: new Date(),
    },
  })
  const [row] = await db.select().from(radarSyncState).where(eq(radarSyncState.id, id)).limit(1)
  return row
}
