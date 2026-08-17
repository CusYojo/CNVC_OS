import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, statfs } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

const cacheTtlMs = 5 * 60_000
let cached: { expiresAt: number; value: FileStorageCapacityHealth } | null = null
const auditTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))
export const fileStorageCapacityModule = '文件存储容量'
export const fileStorageCapacitySnapshotAction = '记录容量快照'

export type CapacitySnapshotValues = {
  accessibleRoots: number
  missingRequired: number
  minimumFreeBytes: number
  maximumUsedRatio: number
}

type CapacityHistoryRow = RowDataPacket & {
  created_at: Date | string
  minimum_free_bytes: number | string
  maximum_used_ratio: number | string
}

export type FileStorageCapacityHealth = {
  ok: boolean
  kind: 'file-storage-capacity'
  monitoredRoots: number
  requiredRoots: number
  accessibleRoots: number
  missingRequired: number
  minimumFreeBytes: number
  maximumUsedRatio: number
  historyObservationAvailable: boolean
  baselineAvailable: boolean
  baselineAgeHours: number
  freeBytesDecline24h: number
  usedRatioIncrease24h: number
  pathsExcluded: true
}

function roots() {
  return [
    { required: true, value: path.resolve(process.env.PROJECT_FILE_ROOT || 'server/project-files') },
    { required: true, value: path.resolve(process.env.AI_ARTIFACT_ROOT || 'server/ai-artifacts') },
    { required: false, value: path.resolve(process.env.AGENT_WORKSPACE || 'server/agent-workspace') },
    { required: false, value: path.resolve(process.env.GENERATED_DIR || 'server/generated') },
  ]
}

export function fileStorageCapacitySeriesHash() {
  return createHash('sha256').update(roots().map((root) => root.value).sort().join('\0')).digest('hex')
}

function stableUuid(value: string) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

function hourBucket(date: Date) {
  return `${date.toISOString().slice(0, 13)}:00:00.000Z`
}

function snapshotTarget(series: string, bucket: string, values: CapacitySnapshotValues) {
  return JSON.stringify({
    schema: 'file-capacity-v1',
    series,
    bucket,
    accessibleRoots: values.accessibleRoots,
    missingRequired: values.missingRequired,
    minimumFreeBytes: Math.max(0, Math.round(values.minimumFreeBytes)),
    maximumUsedRatio: Math.min(1, Math.max(0, values.maximumUsedRatio)),
    pathsExcluded: true,
  })
}

export async function fileStorageCapacityHistory(now: number, current: CapacitySnapshotValues) {
  const series = fileStorageCapacitySeriesHash()
  try {
    const [rows] = await pool.query<CapacityHistoryRow[]>(
      `SELECT created_at,
         CAST(JSON_UNQUOTE(JSON_EXTRACT(target,'$.minimumFreeBytes')) AS UNSIGNED) AS minimum_free_bytes,
         CAST(JSON_UNQUOTE(JSON_EXTRACT(target,'$.maximumUsedRatio')) AS DECIMAL(12,9)) AS maximum_used_ratio
       FROM ${auditTable}
       WHERE module=? AND action=? AND result='success' AND JSON_VALID(target)
         AND JSON_UNQUOTE(JSON_EXTRACT(target,'$.schema'))='file-capacity-v1'
         AND JSON_UNQUOTE(JSON_EXTRACT(target,'$.series'))=?
         AND created_at <= ? AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
      [
        fileStorageCapacityModule,
        fileStorageCapacitySnapshotAction,
        series,
        new Date(now - 24 * 60 * 60_000),
        new Date(now - 72 * 60 * 60_000),
      ],
    )
    const baseline = rows[0]
    if (!baseline) return {
      historyObservationAvailable: true,
      baselineAvailable: false,
      baselineAgeHours: 0,
      freeBytesDecline24h: 0,
      usedRatioIncrease24h: 0,
    }
    const createdAt = new Date(baseline.created_at).getTime()
    const baselineFreeBytes = Number(baseline.minimum_free_bytes)
    const baselineUsedRatio = Number(baseline.maximum_used_ratio)
    return {
      historyObservationAvailable: true,
      baselineAvailable: true,
      baselineAgeHours: Number(((now - createdAt) / 3_600_000).toFixed(3)),
      freeBytesDecline24h: Math.max(0, Math.round(baselineFreeBytes - current.minimumFreeBytes)),
      usedRatioIncrease24h: Number(Math.max(0, current.maximumUsedRatio - baselineUsedRatio).toFixed(9)),
    }
  } catch {
    return {
      historyObservationAvailable: false,
      baselineAvailable: false,
      baselineAgeHours: 0,
      freeBytesDecline24h: 0,
      usedRatioIncrease24h: 0,
    }
  }
}

async function inspectRoot(root: { required: boolean; value: string }) {
  try {
    await access(root.value, constants.R_OK | constants.W_OK)
    const fileSystem = await statfs(root.value)
    const blockSize = Number(fileSystem.bsize)
    const totalBytes = Number(fileSystem.blocks) * blockSize
    const freeBytes = Number(fileSystem.bavail) * blockSize
    const usedRatio = totalBytes > 0 ? Math.min(1, Math.max(0, (totalBytes - freeBytes) / totalBytes)) : 1
    return { required: root.required, accessible: true, freeBytes, usedRatio }
  } catch {
    return { required: root.required, accessible: false, freeBytes: 0, usedRatio: 1 }
  }
}

async function collect(now: number): Promise<FileStorageCapacityHealth> {
  const inspected = await Promise.all(roots().map(inspectRoot))
  const accessible = inspected.filter((item) => item.accessible)
  const requiredRoots = inspected.filter((item) => item.required).length
  const accessibleRequired = inspected.filter((item) => item.required && item.accessible).length
  const current = {
    accessibleRoots: accessible.length,
    missingRequired: requiredRoots - accessibleRequired,
    minimumFreeBytes: accessible.length ? Math.min(...accessible.map((item) => item.freeBytes)) : 0,
    maximumUsedRatio: accessible.length ? Math.max(...accessible.map((item) => item.usedRatio)) : 1,
  }
  return {
    ok: accessibleRequired === requiredRoots,
    kind: 'file-storage-capacity',
    monitoredRoots: inspected.length,
    requiredRoots,
    ...current,
    ...(await fileStorageCapacityHistory(now, current)),
    pathsExcluded: true,
  }
}

export async function recordFileStorageCapacitySnapshot(input?: {
  now?: Date
  observedCapacity?: CapacitySnapshotValues
}) {
  const now = input?.now ?? new Date()
  const observed = input?.observedCapacity ?? await fileStorageCapacityHealth(now.getTime())
  const series = fileStorageCapacitySeriesHash()
  const bucket = hourBucket(now)
  const identity = `${series}:${bucket}`
  const target = snapshotTarget(series, bucket, observed)
  const [result] = await pool.query(
    `INSERT IGNORE INTO ${auditTable}
      (id,user_id,user_name,module,action,target,result,request_id,created_at)
     VALUES (?,NULL,'（系统）',?,?,?,'success',?,?)`,
    [
      stableUuid(`file-capacity:${identity}`),
      fileStorageCapacityModule,
      fileStorageCapacitySnapshotAction,
      target,
      stableUuid(`file-capacity-request:${identity}`),
      now,
    ],
  )
  const affectedRows = Number((result as { affectedRows?: number }).affectedRows || 0)
  return { recorded: affectedRows === 1, series, bucket, pathsExcluded: true as const }
}

export async function fileStorageCapacityHealth(now = Date.now()) {
  if (cached && cached.expiresAt > now) return cached.value
  const value = await collect(now)
  cached = { expiresAt: now + cacheTtlMs, value }
  return value
}

export function resetFileStorageCapacityHealthCacheForAcceptance() {
  cached = null
}
