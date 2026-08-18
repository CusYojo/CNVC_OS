import { createHash } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import XLSX from 'xlsx'
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

export async function updateManagedRadarSourceMetadata(id: string, input: {
  group?: string
  frequency?: string
}) {
  const [current] = await db.select().from(radarSourceRegistry)
    .where(eq(radarSourceRegistry.id, id)).limit(1)
  if (!current) {
    const error = new Error('Radar 来源不存在') as Error & { status?: number; code?: string }
    error.status = 404
    error.code = 'RADAR_SOURCE_NOT_FOUND'
    throw error
  }
  const config = {
    ...current.config,
    ...(input.frequency === undefined ? {} : { frequency: input.frequency.trim() }),
  }
  await db.update(radarSourceRegistry).set({
    sourceGroup: input.group === undefined ? current.sourceGroup : input.group.trim() || null,
    contentHash: digest(stableJson(config)),
    config,
    updatedAt: new Date(),
  }).where(eq(radarSourceRegistry.id, id))
  return (await listManagedRadarSources()).find((item) => item.id === id)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
  return JSON.stringify(value)
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export async function replaceManagedUniversitySources(sources: Array<{
  school: string
  province?: string
  accounts?: Array<{ name?: string; rss_url?: string }>
}>) {
  const normalized = sources.map((source) => ({
    school: source.school.trim(), province: source.province?.trim() || '',
    accounts: (source.accounts ?? []).map((account) => ({
      name: account.name?.trim() || '', rss_url: account.rss_url?.trim() || '',
    })),
  })).filter((source) => source.school)
  const ids = normalized.map((source) => digest(`university-source:${source.school}`))
  await db.transaction(async (tx) => {
    await tx.update(radarSourceRegistry).set({ enabled: false, updatedAt: new Date() })
      .where(eq(radarSourceRegistry.sourceKind, 'university-source'))
    for (let index = 0; index < normalized.length; index += 1) {
      const source = normalized[index]
      const config = source as Record<string, unknown>
      await tx.insert(radarSourceRegistry).values({
        id: ids[index], sourceKind: 'university-source', sourceGroup: '高校',
        displayName: source.school, externalKey: source.school, contentHash: digest(stableJson(config)),
        config, enabled: true, updatedAt: new Date(),
      }).onDuplicateKeyUpdate({ set: {
        sourceGroup: '高校', displayName: source.school, externalKey: source.school,
        contentHash: digest(stableJson(config)), config, enabled: true, updatedAt: new Date(),
      } })
    }
  })
  return await listUniversityWechatSources()
}

export async function listUniversityWechatSources() {
  const rows = await db.select().from(radarSourceRegistry)
    .where(eq(radarSourceRegistry.sourceKind, 'university-source'))
    .orderBy(radarSourceRegistry.displayName)
  const sources = rows.filter((row) => row.enabled).map((row) => ({
    school: String(row.config.school || row.displayName), province: String(row.config.province || ''),
    accounts: Array.isArray(row.config.accounts) ? row.config.accounts : [],
  }))
  const configuredFeeds = sources.reduce((total, source) => total + source.accounts.filter((account) => {
    return Boolean(account && typeof account === 'object' && String((account as Record<string, unknown>).rss_url || '').trim())
  }).length, 0)
  return { sources, total: sources.length, configured_feeds: configuredFeeds }
}

export async function radarWechatOperationalStatus() {
  const [daily, sourceState, accounts] = await Promise.all([
    db.select().from(radarCollectorStates).where(eq(radarCollectorStates.id, 'wechat_daily')).limit(1),
    db.select().from(radarCollectorStates).where(eq(radarCollectorStates.id, 'wechat_sources')).limit(1),
    db.select().from(radarSourceRegistry).where(eq(radarSourceRegistry.sourceKind, 'wechat-account')),
  ])
  const state = daily[0]?.state ?? {}
  const sourceValues = sourceState[0]?.state?.sources
  const sourceRows = sourceValues && typeof sourceValues === 'object' && !Array.isArray(sourceValues)
    ? Object.values(sourceValues as Record<string, unknown>).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : []
  const pending = Array.isArray(state.pending_retry_accounts) ? state.pending_retry_accounts : []
  return {
    state, pending, sourceRows,
    accounts: accounts.map((row) => row.config),
  }
}

function workbookText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export async function importManagedWechatAccounts(input: {
  name: string
  dataBase64: string
  replace?: boolean
}) {
  const buffer = Buffer.from(input.dataBase64, 'base64')
  if (!buffer.length || buffer.length > 20 * 1024 * 1024) {
    throw Object.assign(new Error('公众号账号文件为空或超过 20MB'), { status: 413, code: 'RADAR_ACCOUNT_FILE_SIZE' })
  }
  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false })
  } catch {
    throw Object.assign(new Error('无法读取公众号账号工作簿'), { status: 400, code: 'RADAR_ACCOUNT_WORKBOOK_INVALID' })
  }
  const records: Array<{ group: string; sheet: string; account_name: string; wx_name: string }> = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: false })
    if (!matrix.length) continue
    const headers = matrix[0].map((value) => workbookText(value))
    const accountIndex = headers.findIndex((value) => ['公众号', '公众号名称', '账号名称'].includes(value))
    const wxIndex = headers.findIndex((value) => ['帐号名', '账号名', '微信号', 'wx_name'].includes(value))
    const groupIndex = headers.findIndex((value) => ['分组', '类型', '来源分组'].includes(value))
    if (accountIndex < 0 || wxIndex < 0) continue
    for (const row of matrix.slice(1)) {
      const accountName = workbookText(row[accountIndex])
      const wxName = workbookText(row[wxIndex])
      if (!accountName && !wxName) continue
      if ([accountName, wxName].some((value) => /^[=+@]/.test(value))) {
        throw Object.assign(new Error('公众号账号文件包含不安全的公式前缀'), { status: 400, code: 'RADAR_ACCOUNT_FORMULA' })
      }
      if (!accountName || !wxName) continue
      const explicitGroup = groupIndex >= 0 ? workbookText(row[groupIndex]) : ''
      records.push({
        group: explicitGroup || (sheetName.includes('机构') ? '机构' : '高校'),
        sheet: sheetName,
        account_name: accountName.slice(0, 255),
        wx_name: wxName.slice(0, 255),
      })
      if (records.length > 5_000) {
        throw Object.assign(new Error('公众号账号文件最多包含 5000 条记录'), { status: 413, code: 'RADAR_ACCOUNT_ROWS_LIMIT' })
      }
    }
  }
  const unique = [...new Map(records.map((record) => [record.wx_name.toLocaleLowerCase(), record])).values()]
  if (!unique.length) {
    throw Object.assign(new Error('工作簿中没有“公众号/帐号名”有效记录'), { status: 400, code: 'RADAR_ACCOUNT_ROWS_EMPTY' })
  }
  await db.transaction(async (tx) => {
    if (input.replace) {
      await tx.update(radarSourceRegistry).set({ enabled: false, updatedAt: new Date() })
        .where(eq(radarSourceRegistry.sourceKind, 'wechat-account'))
    }
    for (const record of unique) {
      const config = record as Record<string, unknown>
      await tx.insert(radarSourceRegistry).values({
        id: digest(`wechat-account:${record.wx_name}`),
        sourceKind: 'wechat-account', sourceGroup: record.group,
        displayName: record.account_name, externalKey: record.wx_name,
        contentHash: digest(stableJson(config)), config, enabled: true, updatedAt: new Date(),
      }).onDuplicateKeyUpdate({ set: {
        sourceGroup: record.group, displayName: record.account_name, externalKey: record.wx_name,
        contentHash: digest(stableJson(config)), config, enabled: true, updatedAt: new Date(),
      } })
    }
  })
  return {
    imported: unique.length,
    duplicatesRemoved: records.length - unique.length,
    replace: input.replace === true,
    total: (await listManagedRadarSources()).filter((source) => source.kind === 'wechat-account' && source.enabled).length,
  }
}
