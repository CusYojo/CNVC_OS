import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { ensureSchema } from '../db/migrate.js'

type CountRow = RowDataPacket & { count: number | string }
type AssetKind = 'radar-jsonl' | 'wechat-chat-originals' | 'collector-state' | 'wechat-accounts-xlsx'
type ProductionAssetManifest = {
  schemaVersion?: unknown
  approved?: unknown
  restoredAt?: unknown
  ownerApprovedAt?: unknown
  assets?: unknown
}

const evidenceDirectory = path.resolve('.runtime/migration-evidence/radar-lead-source-reconciliation')
const requiredProductionKinds = new Set<AssetKind>([
  'radar-jsonl',
  'wechat-chat-originals',
  'collector-state',
  'wechat-accounts-xlsx',
])

function table(baseName: string): string {
  return quoteMysqlIdentifier(mysqlTableName(baseName))
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const [rows] = await pool.query<CountRow[]>(sql, params)
  return Number(rows[0]?.count ?? 0)
}

async function writePrivate(file: string, value: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await chmod(path.dirname(file), 0o700)
  const temporary = `${file}.${process.pid}-${Date.now()}.tmp`
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rename(temporary, file)
  await chmod(file, 0o600)
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function localAdapterInventory() {
  const definitions = [
    { category: 'collector-state', file: 'project-discovery/data/auto_crawler_status.json', format: 'json' },
    { category: 'collector-state', file: 'project-discovery/data/wechat_daily_status.json', format: 'json' },
    { category: 'collector-state', file: 'project-discovery/data/wechat_source_status.json', format: 'json' },
    { category: 'source-registry', file: 'project-discovery/data/wechat_985_sources.json', format: 'json' },
    { category: 'candidate-working-set', file: 'project-discovery/data/wechat_api_candidates.jsonl', format: 'jsonl' },
  ] as const
  const assets = []
  for (const definition of definitions) {
    const absolute = path.resolve(definition.file)
    const metadata = await lstat(absolute)
    assert(metadata.isFile() && !metadata.isSymbolicLink(), `${definition.category} adapter asset must be a regular file`)
    const bytes = await readFile(absolute)
    let records = 0
    if (definition.format === 'json') {
      const parsed = JSON.parse(bytes.toString('utf8')) as unknown
      assert(parsed && typeof parsed === 'object', `${definition.category} JSON must contain an object or array`)
      records = Array.isArray(parsed) ? parsed.length : Object.keys(parsed as object).length
    } else {
      const lines = bytes.toString('utf8').split(/\r?\n/).filter((line) => line.trim())
      for (const line of lines) JSON.parse(line)
      records = lines.length
    }
    assets.push({
      category: definition.category,
      bytes: bytes.length,
      records,
      sha256: sha256(bytes),
      structurallyReadable: true,
    })
  }
  return assets
}

async function productionAssetStatus(): Promise<{
  manifestConfigured: boolean
  manifestAccepted: boolean
  productionAssetReady: boolean
  acceptedKinds: string[]
}> {
  const configured = process.env.RADAR_PRODUCTION_ASSET_MANIFEST?.trim()
  if (!configured) return {
    manifestConfigured: false,
    manifestAccepted: false,
    productionAssetReady: false,
    acceptedKinds: [],
  }
  const manifestPath = path.resolve(configured)
  const metadata = await lstat(manifestPath)
  assert(metadata.isFile() && !metadata.isSymbolicLink(), 'production asset manifest must be a regular file')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ProductionAssetManifest
  const assets = Array.isArray(manifest.assets) ? manifest.assets : []
  const acceptedKinds = [...new Set(assets.flatMap((asset) => {
    if (!asset || typeof asset !== 'object') return []
    const item = asset as Record<string, unknown>
    const kind = String(item.kind ?? '')
    const rows = Number(item.records)
    const digest = String(item.sha256 ?? '')
    const restoredAt = String(item.restoredAt ?? '')
    return requiredProductionKinds.has(kind as AssetKind)
      && Number.isSafeInteger(rows) && rows >= 0
      && /^[a-f0-9]{64}$/.test(digest)
      && !Number.isNaN(Date.parse(restoredAt))
      ? [kind]
      : []
  }))].sort()
  const manifestAccepted = manifest.schemaVersion === '1.0'
    && manifest.approved === true
    && !Number.isNaN(Date.parse(String(manifest.restoredAt ?? '')))
    && !Number.isNaN(Date.parse(String(manifest.ownerApprovedAt ?? '')))
    && [...requiredProductionKinds].every((kind) => acceptedKinds.includes(kind))
  return {
    manifestConfigured: true,
    manifestAccepted,
    productionAssetReady: manifestAccepted,
    acceptedKinds,
  }
}

async function main(): Promise<void> {
  await ensureSchema()

  const reserve = {
    total: await count(`SELECT COUNT(*) count FROM ${table('lead_reserve')}`),
    withDetail: await count(`SELECT COUNT(*) count FROM ${table('lead_reserve')} WHERE detail_json IS NOT NULL`),
    sourceMissing: await count(`SELECT COUNT(*) count FROM ${table('lead_reserve')} WHERE detail_json IS NULL`),
    quarantinedSourceMissing: await count(`SELECT COUNT(*) count FROM ${table('lead_reserve')} WHERE detail_json IS NULL AND score_status='source_missing'`),
    imported: await count(`SELECT COUNT(*) count FROM ${table('lead_reserve')} WHERE imported=1`),
    importedTimestampMissing: await count(`SELECT COUNT(*) count FROM ${table('lead_reserve')} WHERE imported=1 AND imported_at IS NULL`),
    awaitingProcessing: await count(`SELECT COUNT(*) count FROM ${table('lead_reserve')} WHERE imported=0 AND detail_json IS NOT NULL`),
  }
  const reserveViolations = {
    duplicateSequence: await count(`SELECT COUNT(*) count FROM (SELECT seq FROM ${table('lead_reserve')} WHERE seq IS NOT NULL GROUP BY seq HAVING COUNT(*)>1) d`),
    importedState: await count(`SELECT COUNT(*) count FROM ${table('lead_reserve')} WHERE (imported=1 AND imported_lead_id IS NULL) OR (imported=0 AND imported_lead_id IS NOT NULL)`),
    importedLeadOrphan: await count(`SELECT COUNT(*) count FROM ${table('lead_reserve')} r LEFT JOIN ${table('leads')} l ON l.id=r.imported_lead_id WHERE r.imported_lead_id IS NOT NULL AND l.id IS NULL`),
    importedLeadDuplicate: await count(`SELECT COUNT(*) count FROM (SELECT imported_lead_id FROM ${table('lead_reserve')} WHERE imported_lead_id IS NOT NULL GROUP BY imported_lead_id HAVING COUNT(*)>1) d`),
    rawEventMissing: await count(`SELECT COUNT(*) count FROM ${table('lead_reserve')} r WHERE r.detail_json IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${table('lead_pipeline_raw_events')} e WHERE e.source_type='lead_reserve' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.reserveId')) AS UNSIGNED)=r.id)`),
    rawEventDuplicate: await count(`SELECT COUNT(*) count FROM (SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.reserveId')) AS UNSIGNED) reserve_id FROM ${table('lead_pipeline_raw_events')} WHERE source_type='lead_reserve' GROUP BY reserve_id HAVING COUNT(*)>1) d`),
  }

  const radar = {
    rawEvents: await count(`SELECT COUNT(*) count FROM ${table('radar_raw_events')}`),
    candidates: await count(`SELECT COUNT(*) count FROM ${table('radar_candidates')}`),
    collectorStates: await count(`SELECT COUNT(*) count FROM ${table('radar_collector_states')}`),
    sourceRegistry: await count(`SELECT COUNT(*) count FROM ${table('radar_source_registry')}`),
    syncStates: await count(`SELECT COUNT(*) count FROM ${table('radar_sync_state')}`),
    runtimeJobs: await count(`SELECT COUNT(*) count FROM ${table('runtime_jobs')} WHERE id IN ('radar-collect-sync','radar-paper-daily','radar-wechat-daily','radar-wechat-retry','radar-wechat-institution')`),
  }
  const radarViolations = {
    rawSourceIdentity: await count(`SELECT COUNT(*) count FROM ${table('radar_raw_events')} WHERE source_key_hash<>SHA2(source_key,256) OR content_hash NOT REGEXP '^[a-f0-9]{64}$' OR cursor_digest NOT REGEXP '^[a-f0-9]{64}$' OR cursor_timestamp<0`),
    candidateSourceIdentity: await count(`SELECT COUNT(*) count FROM ${table('radar_candidates')} WHERE source_key_hash<>SHA2(source_key,256) OR content_hash NOT REGEXP '^[a-f0-9]{64}$' OR cursor_digest NOT REGEXP '^[a-f0-9]{64}$' OR cursor_timestamp<0`),
    candidateWithoutRawEvent: await count(`SELECT COUNT(*) count FROM ${table('radar_candidates')} c LEFT JOIN ${table('radar_raw_events')} e ON e.source_key_hash=c.source_key_hash AND e.content_hash=c.content_hash WHERE e.id IS NULL`),
    duplicateRawIdentity: await count(`SELECT COUNT(*) count FROM (SELECT source_key_hash,content_hash FROM ${table('radar_raw_events')} GROUP BY source_key_hash,content_hash HAVING COUNT(*)>1) d`),
    duplicateSourceRegistryKey: await count(`SELECT COUNT(*) count FROM (SELECT source_kind,external_key FROM ${table('radar_source_registry')} WHERE external_key IS NOT NULL GROUP BY source_kind,external_key HAVING COUNT(*)>1) d`),
    malformedCollectorState: await count(`SELECT COUNT(*) count FROM ${table('radar_collector_states')} WHERE content_hash NOT REGEXP '^[a-f0-9]{64}$' OR NOT JSON_VALID(state)`),
    malformedSourceRegistry: await count(`SELECT COUNT(*) count FROM ${table('radar_source_registry')} WHERE content_hash NOT REGEXP '^[a-f0-9]{64}$' OR NOT JSON_VALID(config)`),
    runtimeJobDefinitionMissing: Math.max(0, 5 - await count(`SELECT COUNT(DISTINCT id) count FROM ${table('runtime_jobs')} WHERE id IN ('radar-collect-sync','radar-paper-daily','radar-wechat-daily','radar-wechat-retry','radar-wechat-institution')`)),
  }

  const localAssets = await localAdapterInventory()
  const productionAssets = await productionAssetStatus()
  const checks = {
    reservePartitionIsComplete: reserve.total > 0 && reserve.withDetail + reserve.sourceMissing === reserve.total,
    reserveSourceMissingIsExplicitlyQuarantined: reserve.sourceMissing === reserve.quarantinedSourceMissing,
    reserveImportedAndAwaitingCountsAreCoherent: reserve.imported + reserve.awaitingProcessing + reserve.sourceMissing === reserve.total,
    reserveSourceKeysAndFormalMappingsAreUnique: reserveViolations.duplicateSequence === 0
      && reserveViolations.importedState === 0
      && reserveViolations.importedLeadOrphan === 0
      && reserveViolations.importedLeadDuplicate === 0,
    reserveRawEventCoverageIsComplete: reserveViolations.rawEventMissing === 0 && reserveViolations.rawEventDuplicate === 0,
    radarProjectionIsRebuildableFromRawEvents: radarViolations.candidateWithoutRawEvent === 0
      && radarViolations.duplicateRawIdentity === 0,
    radarSourceKeysAndCursorsAreValid: radarViolations.rawSourceIdentity === 0
      && radarViolations.candidateSourceIdentity === 0
      && radarViolations.duplicateSourceRegistryKey === 0,
    radarStatesAndSourcesAreRecoverable: radar.collectorStates > 0
      && radar.sourceRegistry > 0
      && radarViolations.malformedCollectorState === 0
      && radarViolations.malformedSourceRegistry === 0,
    radarSchedulesMovedIntoMySqlRuntimeJobs: radar.runtimeJobs === 4
      && radarViolations.runtimeJobDefinitionMissing === 0,
    localAdapterAssetsAreReadableAndContentHashed: localAssets.length === 5
      && localAssets.every((asset) => asset.structurallyReadable && /^[a-f0-9]{64}$/.test(asset.sha256)),
  }
  assert(Object.values(checks).every(Boolean), `Radar/lead source reconciliation failed: ${JSON.stringify({ reserveViolations, radarViolations, checks })}`)

  const localTechnicalReady = true
  const fullSourceAssetReady = localTechnicalReady && productionAssets.productionAssetReady
  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ok: true,
    localTechnicalReady,
    productionAssetReady: productionAssets.productionAssetReady,
    fullSourceAssetReady,
    reportContainsBusinessPayload: false,
    pathsAndFileNamesExcluded: true,
    reserve,
    reserveViolations,
    radar,
    radarViolations,
    localAdapterAssets: localAssets,
    productionAssets,
    checks,
    remainingBlockers: productionAssets.productionAssetReady ? [] : [
      'production Radar JSONL inventory/restore evidence',
      'production WeChat chat-original inventory/restore evidence',
      'production collector-state inventory/restore evidence',
      'production WeChat account workbook inventory/restore evidence',
      'asset owner approval and restore timestamps',
    ],
  }
  await writePrivate(path.join(evidenceDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writePrivate(path.join(evidenceDirectory, 'summary.md'), [
    '# Radar and lead-source reconciliation',
    '',
    `- Local technical reconciliation: ${localTechnicalReady ? 'accepted' : 'blocked'}`,
    `- Production source-asset evidence: ${productionAssets.productionAssetReady ? 'accepted' : 'not supplied'}`,
    `- Full source-asset readiness: ${fullSourceAssetReady ? 'accepted' : 'blocked'}`,
    '- Business payload, source paths, file names and credentials: excluded',
    '- Missing production evidence does not invalidate MySQL consistency, but remains a cutover blocker.',
    '',
  ].join('\n'))
  console.log(JSON.stringify({
    ok: true,
    localTechnicalReady,
    productionAssetReady: productionAssets.productionAssetReady,
    fullSourceAssetReady,
    reserve,
    radar,
    checks: Object.keys(checks),
    businessPayloadExcluded: true,
  }))
}

try {
  await main()
} finally {
  await pool.end()
}
