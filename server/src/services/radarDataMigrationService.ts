import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { count, eq, inArray, sql } from 'drizzle-orm'
import ExcelJS from 'exceljs'
import { db } from '../db/client.js'
import {
  radarCandidates,
  radarCollectorStates,
  radarRawEvents,
  radarSourceRegistry,
} from '../db/schema.js'
import { DEFAULT_RADAR_PUBLIC_SOURCES } from './radarSourceCatalog.js'

type JsonObject = Record<string, unknown>
type RadarSnapshot = {
  states?: Record<string, { source_path?: string; value?: JsonObject }>
  source_registry?: JsonObject[]
  accounts?: JsonObject[]
  public_sources?: JsonObject[]
}

const LEGACY_CANDIDATE_FILES = [
  'arxiv_candidates.jsonl',
  // The legacy HTTP projection omitted OpenAlex even though the collector
  // persisted it. Preserve those dormant candidates before retiring the
  // retired standalone collector so the source asset is not stranded on disk.
  'openalex_candidates.jsonl',
  'wechat_985_candidates.jsonl',
  'wechat_api_candidates.jsonl',
  'wechat_chat_candidates.jsonl',
  'investment_candidates.jsonl',
]

const LEGACY_STATE_FILES: Record<string, string> = {
  auto: 'auto_crawler_status.json',
  paper_daily: 'paper_crawler_status.json',
  wechat_daily: 'wechat_daily_status.json',
  wechat_sources: 'wechat_source_status.json',
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as JsonObject)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stableValue(entry)]))
  }
  return value
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function meaningful(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function pythonSourceKey(item: JsonObject): string {
  for (const field of ['source_id', 'fingerprint', 'link', 'title']) {
    const value = meaningful(item[field])
    if (value) return value
  }
  return ''
}

function radarSourceKey(item: JsonObject): string {
  const key = pythonSourceKey(item)
  const source = meaningful(item.source) || 'unknown'
  return key ? `${source}:${key}` : ''
}

function parseRadarDate(value: unknown): Date | null {
  const text = meaningful(value)
  if (!text) return null
  let normalized = text
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) normalized = `${text}T00:00:00+08:00`
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) {
    normalized = `${text.replace(' ', 'T')}+08:00`
  }
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function cursorIdentity(item: JsonObject): { timestamp: number; digest: string } {
  const date = parseRadarDate(item.collected_at)
    ?? parseRadarDate(item.published_at)
    ?? parseRadarDate(item.updated_at)
  const sourceKey = radarSourceKey(item)
  const identity = sourceKey || stableJson(item)
  return {
    timestamp: date ? date.getTime() * 1_000 : 0,
    digest: sha256(identity),
  }
}

function normalizedCandidate(raw: JsonObject) {
  const sourceFile = meaningful(raw._file) || null
  const sourceLine = Number(raw._line) || null
  const payload = Object.fromEntries(Object.entries(raw).filter(([key]) => !['_file', '_line'].includes(key)))
  const sourceKey = radarSourceKey(payload)
  if (!sourceKey) return null
  const sourceKeyHash = sha256(sourceKey)
  const contentHash = sha256(stableJson(payload))
  const cursor = cursorIdentity(payload)
  const source = meaningful(payload.source) || 'unknown'
  const sourceGroup = meaningful(payload.source_group) || null
  const collectedAt = parseRadarDate(payload.collected_at)
  const publishedAt = parseRadarDate(payload.published_at)
  return {
    raw: {
      id: sha256(`${sourceKeyHash}:${contentHash}`),
      sourceKey,
      sourceKeyHash,
      contentHash,
      source,
      sourceGroup,
      collectedAt,
      publishedAt,
      cursorTimestamp: cursor.timestamp,
      cursorDigest: cursor.digest,
      payload,
      sourceFile,
      sourceLine,
    },
    current: {
      sourceKeyHash,
      sourceKey,
      contentHash,
      source,
      sourceGroup,
      attentionScore: Number(payload.attention_score) || 0,
      worthAttention: Boolean(payload.worth_attention),
      collectedAt,
      publishedAt,
      cursorTimestamp: cursor.timestamp,
      cursorDigest: cursor.digest,
      payload,
      updatedAt: new Date(),
    },
  }
}

function radarDataDirectory(): string {
  return path.resolve(process.env.RADAR_DATA_DIR?.trim() || '.runtime/radar-legacy/data')
}

async function readJsonFile(filePath: string): Promise<JsonObject | null> {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function readAllFileCandidates(signal?: AbortSignal): Promise<{ items: JsonObject[]; reportedTotal: number }> {
  const items: JsonObject[] = []
  const directory = radarDataDirectory()
  for (const fileName of LEGACY_CANDIDATE_FILES) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Radar migration aborted')
    try {
      const text = await readFile(path.join(directory, fileName), 'utf8')
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!line.trim()) continue
        try {
          const item = JSON.parse(line)
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            items.push({ ...(item as JsonObject), _file: fileName, _line: index + 1 })
          }
        } catch {
          // A malformed historical line must not prevent the remaining legacy
          // evidence from being migrated.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return { items, reportedTotal: items.length }
}

export async function readLegacyRadarCandidates(signal?: AbortSignal): Promise<JsonObject[]> {
  const { items } = await readAllFileCandidates(signal)
  return items
    .map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => !['_file', '_line'].includes(key))))
    .sort((a, b) => {
      const aCursor = cursorIdentity(a)
      const bCursor = cursorIdentity(b)
      return bCursor.timestamp - aCursor.timestamp || bCursor.digest.localeCompare(aCursor.digest)
    })
}

async function readLegacySnapshot(): Promise<RadarSnapshot> {
  const directory = radarDataDirectory()
  const states: NonNullable<RadarSnapshot['states']> = {}
  for (const [id, fileName] of Object.entries(LEGACY_STATE_FILES)) {
    const value = await readJsonFile(path.join(directory, fileName))
    if (value) states[id] = { source_path: fileName, value }
  }
  const publicSourceFile = await readJsonFile(path.join(directory, 'public_sources.json'))
  const universityFile = await readJsonFile(path.join(directory, 'wechat_985_sources.json'))
  const publicSources = Array.isArray(publicSourceFile?.sources)
    ? publicSourceFile.sources.filter((item): item is JsonObject => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : []
  const sourceRegistry = Array.isArray(universityFile?.sources)
    ? universityFile.sources.filter((item): item is JsonObject => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : []
  const accounts: JsonObject[] = []
  const accountsPath = path.resolve(
    process.env.RADAR_WECHAT_ACCOUNTS_XLSX?.trim() || '.runtime/radar-legacy/公众号来源.xlsx',
  )
  try {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(accountsPath)
    for (const sheet of workbook.worksheets) {
      const headers = (sheet.getRow(1).values as unknown[]).map((value) => meaningful(value))
      const accountColumn = Math.max(1, headers.findIndex((value) => value === '公众号'))
      const wxColumn = Math.max(2, headers.findIndex((value) => ['帐号名', '账号名', '微信号'].includes(value)))
      for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
        const accountName = meaningful(sheet.getRow(rowIndex).getCell(accountColumn).value)
        const wxName = meaningful(sheet.getRow(rowIndex).getCell(wxColumn).value)
        if (accountName && wxName) accounts.push({
          group: sheet.name.includes('机构') ? '机构' : '高校',
          sheet: sheet.name,
          account_name: accountName,
          wx_name: wxName,
        })
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { states, public_sources: publicSources, source_registry: sourceRegistry, accounts }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

export async function ingestRadarCandidates(items: JsonObject[]) {
  const normalized = items.map(normalizedCandidate).filter((item): item is NonNullable<typeof item> => Boolean(item))
  for (const batch of chunks(normalized, 100)) {
    const existingRows = await db.select({
      sourceKeyHash: radarCandidates.sourceKeyHash,
      contentHash: radarCandidates.contentHash,
      payload: radarCandidates.payload,
    }).from(radarCandidates).where(inArray(
      radarCandidates.sourceKeyHash,
      batch.map((item) => item.current.sourceKeyHash),
    ))
    const existingByKey = new Map(existingRows.map((row) => [row.sourceKeyHash, row]))
    for (const item of batch) {
      const existing = existingByKey.get(item.current.sourceKeyHash)
      const extraction = existing?.payload?.codex_extraction
      if (existing?.contentHash !== item.current.contentHash
        || !extraction || typeof extraction !== 'object' || Array.isArray(extraction)) continue
      item.current.payload = {
        ...item.current.payload,
        ...(existing.payload.project_profile && typeof existing.payload.project_profile === 'object'
          && !Array.isArray(existing.payload.project_profile)
          ? { project_profile: existing.payload.project_profile }
          : {}),
        codex_extraction: extraction,
      }
    }
    await db.insert(radarRawEvents).values(batch.map((item) => item.raw)).onDuplicateKeyUpdate({
      set: { id: sql`VALUES(id)` },
    })
    await db.insert(radarCandidates).values(batch.map((item) => item.current)).onDuplicateKeyUpdate({
      set: {
        sourceKey: sql.raw('VALUES(`source_key`)'),
        contentHash: sql.raw('VALUES(`content_hash`)'),
        source: sql.raw('VALUES(`source`)'),
        sourceGroup: sql.raw('VALUES(`source_group`)'),
        attentionScore: sql.raw('VALUES(`attention_score`)'),
        worthAttention: sql.raw('VALUES(`worth_attention`)'),
        collectedAt: sql.raw('VALUES(`collected_at`)'),
        publishedAt: sql.raw('VALUES(`published_at`)'),
        cursorTimestamp: sql.raw('VALUES(`cursor_timestamp`)'),
        cursorDigest: sql.raw('VALUES(`cursor_digest`)'),
        payload: sql.raw('VALUES(`payload`)'),
        updatedAt: new Date(),
      },
    })
  }
  return normalized.length
}

export async function saveRadarCollectorState(id: string, state: JsonObject) {
  const contentHash = sha256(stableJson(state))
  await db.insert(radarCollectorStates).values({
    id,
    stateKind: id,
    contentHash,
    state,
    sourcePath: null,
    capturedAt: new Date(),
    updatedAt: new Date(),
  }).onDuplicateKeyUpdate({ set: {
    contentHash,
    state,
    sourcePath: null,
    capturedAt: new Date(),
    updatedAt: new Date(),
  } })
  return state
}

export async function bootstrapRadarPublicSources() {
  let inserted = 0
  for (const item of DEFAULT_RADAR_PUBLIC_SOURCES) {
    const contentHash = sha256(stableJson(item))
    const id = sha256(`public-source:${item.key}`)
    await db.insert(radarSourceRegistry).values({
      id,
      sourceKind: 'public-source',
      sourceGroup: item.group,
      displayName: item.name,
      externalKey: item.key,
      contentHash,
      config: item,
      enabled: item.enabled,
      updatedAt: new Date(),
    }).onDuplicateKeyUpdate({ set: {
      sourceGroup: item.group,
      displayName: item.name,
      externalKey: item.key,
      contentHash,
      config: item,
      updatedAt: new Date(),
    } })
    inserted += 1
  }
  return { sources: DEFAULT_RADAR_PUBLIC_SOURCES.length, touched: inserted }
}

async function importSnapshot(snapshot: RadarSnapshot) {
  let states = 0
  let sources = 0
  for (const [id, entry] of Object.entries(snapshot.states ?? {})) {
    const state = entry?.value && typeof entry.value === 'object' ? entry.value : {}
    const contentHash = sha256(stableJson(state))
    await db.insert(radarCollectorStates).values({
      id,
      stateKind: id,
      contentHash,
      state,
      sourcePath: meaningful(entry?.source_path) || null,
      capturedAt: new Date(),
      updatedAt: new Date(),
    }).onDuplicateKeyUpdate({ set: { contentHash, state, sourcePath: meaningful(entry?.source_path) || null, capturedAt: new Date(), updatedAt: new Date() } })
    states += 1
  }
  const registry: Array<{
    kind: string
    group: string
    name: string
    key: string
    config: JsonObject
    enabled: boolean
  }> = []
  for (const item of snapshot.source_registry ?? []) {
    const school = meaningful(item.school)
    if (!school) continue
    registry.push({ kind: 'university-source', group: '高校', name: school, key: school, config: item, enabled: true })
  }
  for (const item of snapshot.accounts ?? []) {
    const key = meaningful(item.wx_name)
    const name = meaningful(item.account_name) || key
    if (!key || !name) continue
    registry.push({ kind: 'wechat-account', group: meaningful(item.group), name, key, config: item, enabled: true })
  }
  for (const item of snapshot.public_sources ?? []) {
    const key = meaningful(item.key)
    const name = meaningful(item.name) || key
    if (!key || !name || !meaningful(item.type) || !meaningful(item.url)) continue
    registry.push({
      kind: 'public-source',
      group: meaningful(item.group),
      name,
      key,
      config: item,
      enabled: item.enabled !== false,
    })
  }
  for (const item of registry) {
    const contentHash = sha256(stableJson(item.config))
    const id = sha256(`${item.kind}:${item.key}`)
    await db.insert(radarSourceRegistry).values({
      id,
      sourceKind: item.kind,
      sourceGroup: item.group || null,
      displayName: item.name.slice(0, 255),
      externalKey: item.key.slice(0, 255),
      contentHash,
      config: item.config,
      enabled: item.enabled,
      updatedAt: new Date(),
    }).onDuplicateKeyUpdate({ set: {
      sourceGroup: item.group || null,
      displayName: item.name.slice(0, 255),
      externalKey: item.key.slice(0, 255),
      contentHash,
      config: item.config,
      // enabled is intentionally not overwritten: after bootstrap it is an
      // operator-owned MySQL setting, materialized back to Python per run.
      updatedAt: new Date(),
    } })
    sources += 1
  }
  return { states, sources }
}

export async function ingestRadarDataToMySql(
  signal?: AbortSignal,
  options: { includeSnapshot?: boolean } = {},
) {
  const [{ items, reportedTotal }, snapshot] = await Promise.all([
    readAllFileCandidates(signal),
    options.includeSnapshot === false
      ? Promise.resolve({} as RadarSnapshot)
      : readLegacySnapshot(),
  ])
  const candidates = await ingestRadarCandidates(items)
  const importedSnapshot = await importSnapshot(snapshot)
  const [{ value: rawEvents }] = await db.select({ value: count() }).from(radarRawEvents)
  const [{ value: currentCandidates }] = await db.select({ value: count() }).from(radarCandidates)
  return {
    ok: true,
    reportedTotal,
    candidatesRead: items.length,
    candidatesImported: candidates,
    rawEvents: Number(rawEvents),
    currentCandidates: Number(currentCandidates),
    collectorStates: importedSnapshot.states,
    sourceRegistry: importedSnapshot.sources,
  }
}

export async function ensureRadarMySqlSeeded() {
  await bootstrapRadarPublicSources()
  const [[{ value: candidates }], [{ value: states }], [{ value: publicSources }]] = await Promise.all([
    db.select({ value: count() }).from(radarCandidates),
    db.select({ value: count() }).from(radarCollectorStates),
    db.select({ value: count() }).from(radarSourceRegistry)
      .where(eq(radarSourceRegistry.sourceKind, 'public-source')),
  ])
  if ((Number(candidates) > 0 || Number(states) > 0) && Number(publicSources) > 0) {
    return {
      skipped: true,
      currentCandidates: Number(candidates),
      collectorStates: Number(states),
      publicSources: Number(publicSources),
    }
  }
  const migrated = await ingestRadarDataToMySql()
  if (Number(states) === 0 && migrated.collectorStates === 0) {
    await Promise.all([
      saveRadarCollectorState('auto', { enabled: true, running: false, run_count: 0, last_result: null, last_error: '' }),
      saveRadarCollectorState('wechat_daily', { enabled: false, running: false, pending_retry_accounts: [], last_result: null, last_error: '' }),
      saveRadarCollectorState('wechat_sources', { sources: {}, updated_at: new Date().toISOString() }),
    ])
  }
  return { skipped: false, ...migrated }
}

export async function radarMySqlSourceHealth() {
  try {
    const [[{ value: rawEvents }], [{ value: currentCandidates }], [{ value: collectorStates }], [{ value: sourceRegistry }]] = await Promise.all([
      db.select({ value: count() }).from(radarRawEvents),
      db.select({ value: count() }).from(radarCandidates),
      db.select({ value: count() }).from(radarCollectorStates),
      db.select({ value: count() }).from(radarSourceRegistry),
    ])
    return {
      name: 'radar-mysql-source',
      ok: true,
      authoritativeReadSource: true,
      rawEvents: Number(rawEvents),
      currentCandidates: Number(currentCandidates),
      collectorStates: Number(collectorStates),
      sourceRegistry: Number(sourceRegistry),
    }
  } catch (error) {
    return {
      name: 'radar-mysql-source',
      ok: false,
      authoritativeReadSource: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// Compatibility export for rollback/audit tooling. Scheduled collection reads
// and writes MySQL directly; legacy JSONL/JSON/Excel files are no longer a
// runtime dependency.
export async function materializeRadarWorkingStateFromMySql() {
  const dataDir = radarDataDirectory()
  await mkdir(dataDir, { recursive: true })
  const states = await db.select().from(radarCollectorStates)
  const stateFiles: Record<string, string> = {
    auto: 'auto_crawler_status.json',
    wechat_daily: 'wechat_daily_status.json',
    wechat_sources: 'wechat_source_status.json',
  }
  for (const state of states) {
    const fileName = stateFiles[state.id]
    if (!fileName) continue
    await writeFile(path.join(dataDir, fileName), `${JSON.stringify(state.state, null, 2)}\n`, 'utf8')
  }

  const registry = await db.select().from(radarSourceRegistry)
  const publicSources = registry
    .filter((item) => item.sourceKind === 'public-source')
    .map((item) => ({ ...item.config, enabled: item.enabled }))
  if (publicSources.length > 0) {
    await writeFile(
      path.join(dataDir, 'public_sources.json'),
      `${JSON.stringify({ sources: publicSources }, null, 2)}\n`,
      'utf8',
    )
  }
  const universitySources = registry
    .filter((item) => item.sourceKind === 'university-source')
    .map((item) => item.config)
  if (universitySources.length > 0) {
    await writeFile(
      path.join(dataDir, 'wechat_985_sources.json'),
      `${JSON.stringify({ sources: universitySources }, null, 2)}\n`,
      'utf8',
    )
  }

  const accountsPath = path.resolve(
    process.env.RADAR_WECHAT_ACCOUNTS_XLSX?.trim() || '.runtime/radar-legacy/公众号来源.xlsx',
  )
  const accounts = registry.filter((item) => item.sourceKind === 'wechat-account')
  if (accounts.length > 0) {
    await mkdir(path.dirname(accountsPath), { recursive: true })
    const workbook = new ExcelJS.Workbook()
    for (const group of ['高校', '机构']) {
      const sheet = workbook.addWorksheet(group)
      sheet.addRow(['公众号', '帐号名'])
      for (const account of accounts.filter((item) => item.sourceGroup === group)) {
        sheet.addRow([account.displayName, account.externalKey || ''])
      }
    }
    await workbook.xlsx.writeFile(accountsPath)
  }
  return {
    states: states.length,
    publicSources: publicSources.length,
    sources: universitySources.length,
    accounts: accounts.length,
  }
}
