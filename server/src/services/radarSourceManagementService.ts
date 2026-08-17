import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { radarCollectorStates, radarSourceRegistry } from '../db/schema.js'

function publicConfig(config: Record<string, unknown>) {
  return {
    type: String(config.type || ''),
    url: String(config.url || ''),
    frequency: String(config.frequency || ''),
    note: String(config.note || ''),
  }
}

export async function listManagedRadarSources() {
  const [rows, collectorStates] = await Promise.all([
    db.select().from(radarSourceRegistry)
      .orderBy(radarSourceRegistry.sourceKind, radarSourceRegistry.sourceGroup, radarSourceRegistry.displayName),
    db.select().from(radarCollectorStates)
      .where(inArray(radarCollectorStates.id, ['auto', 'paper_daily'])),
  ])
  const resultObjects = collectorStates.map((state) => state.state?.last_result)
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
  const sourceResults = resultObjects.flatMap((value) => Array.isArray(value.source_results) ? value.source_results : [])
  const errorSamples = resultObjects.flatMap((value) => Array.isArray(value.error_samples) ? value.error_samples : [])
  const fetchedByKey = new Map(sourceResults.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const item = value as Record<string, unknown>
    return [[String(item.key || ''), Number(item.fetched) || 0] as const]
  }))
  const errorByName = new Map(errorSamples.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const item = value as Record<string, unknown>
    return [[String(item.source || ''), String(item.error || '').slice(0, 500)] as const]
  }))
  return rows.map((row) => ({
    id: row.id,
    kind: row.sourceKind,
    group: row.sourceGroup || '',
    name: row.displayName,
    externalKey: row.externalKey || '',
    enabled: row.enabled,
    config: publicConfig(row.config),
    lastFetched: fetchedByKey.get(row.externalKey || '') ?? null,
    lastError: errorByName.get(row.displayName) || '',
    importedAt: row.importedAt,
    updatedAt: row.updatedAt,
  }))
}

export async function setManagedRadarSourceEnabled(id: string, enabled: boolean) {
  const [current] = await db.select().from(radarSourceRegistry)
    .where(eq(radarSourceRegistry.id, id)).limit(1)
  if (!current) {
    const error = new Error('Radar 来源不存在') as Error & { status?: number; code?: string }
    error.status = 404
    error.code = 'RADAR_SOURCE_NOT_FOUND'
    throw error
  }
  await db.update(radarSourceRegistry).set({ enabled, updatedAt: new Date() })
    .where(eq(radarSourceRegistry.id, id))
  return (await listManagedRadarSources()).find((item) => item.id === id)
}
