/**
 * Radar 增量同步的纯合并规则。
 *
 * 约束：
 * - 空值、占位值永不覆盖已有有效值；
 * - score / scoring 不属于可合并字段，调用方即使误传也不会进入 patch；
 * - Radar 创建的记录可接受新的非空 Radar 标量；非 Radar（人工/BP/情报采集）记录只补空；
 * - 已有 Flue 评分时保护其回填的 team，新的 Radar 团队信息仍保存在 radarProfile；
 * - 来源、融资、标签、亮点和风险做去重合并，不整体清空。
 */

const EMPTY_RADAR_TEXT = new Set([
  '',
  '待核验',
  '待核实',
  '未披露',
  '未披露/待核实',
  '未披露/待验证',
  '未识别/待核实',
  '融资轮次待核实',
  '不适用',
  '无',
  '-',
  'N/A',
  'null',
])

export interface RadarLeadSyncFields {
  name: string
  companyName?: string | null
  industry?: string | null
  source?: string | null
  poolStatus?: string
  summary?: string | null
  highlights?: unknown[]
  risks?: unknown[]
  team?: string | null
  fundingRounds?: unknown[]
  riskTags?: unknown[]
  sources?: unknown[]
  radarProfile?: unknown
}

export interface RadarMergeExistingLead extends RadarLeadSyncFields {
  id?: string
  score?: number
  scoring?: unknown
}

export type RadarLeadMergePatch = Partial<Omit<RadarLeadSyncFields, 'name' | 'poolStatus'>>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isMeaningfulRadarValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return !EMPTY_RADAR_TEXT.has(value.trim())
  if (Array.isArray(value)) return value.some(isMeaningfulRadarValue)
  if (isPlainObject(value)) return Object.values(value).some(isMeaningfulRadarValue)
  return true
}

export function shouldBackfillCompanyName(
  existing: { name?: unknown; companyName?: unknown; source?: unknown } | null | undefined,
  candidate: unknown,
): boolean {
  if (!isMeaningfulRadarValue(candidate)) return false
  if (!isMeaningfulRadarValue(existing?.companyName)) return true

  const currentName = typeof existing?.companyName === 'string' ? existing.companyName.trim() : ''
  const leadName = typeof existing?.name === 'string' ? existing.name.trim() : ''
  const source = typeof existing?.source === 'string' ? existing.source.trim() : ''
  const nextName = typeof candidate === 'string' ? candidate.trim() : ''
  const isRadarRecord = /^项目发现雷达(?:\s|·|$)/.test(source)
  const isExplicitLegalEntity = /(?:股份有限公司|有限责任公司|有限公司)$/.test(nextName)

  // Radar 入池时常用项目简称同时填充 name/companyName。只有这种可识别的
  // 机器兜底值，才允许被后续工商研究取得的明确法定主体升级。
  return isRadarRecord && currentName === leadName && isExplicitLegalEntity
}

function mergeNonEmptyValue(existing: unknown, incoming: unknown): unknown {
  if (!isMeaningfulRadarValue(incoming)) return existing
  if (isPlainObject(existing) && isPlainObject(incoming)) {
    const merged: Record<string, unknown> = { ...existing }
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = mergeNonEmptyValue(existing[key], value)
    }
    return merged
  }
  // radarProfile 内部数组（signals、nextActions 等）有新有效值时整体采用最新版本；
  // 顶层来源/融资数组由专用去重函数处理。
  return incoming
}

function normalizedKeyPart(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase() : ''
}

function normalizedSourceUrl(value: unknown): string {
  const raw = normalizedKeyPart(value)
  if (!raw) return ''
  try {
    const url = new URL(raw)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|from$|source$|ref$|refer$|share_|scene$|clicktime$|enterid$)/i.test(key)) {
        url.searchParams.delete(key)
      }
    }
    url.searchParams.sort()
    return url.toString().replace(/\/$/, '').toLocaleLowerCase()
  } catch {
    return raw.replace(/[?#].*$/, '').replace(/\/$/, '')
  }
}

function normalizedSourceTitle(value: unknown): string {
  const title = normalizedKeyPart(value)
    .replace(/^(?:36氪|硬氪)?(?:首发|前线)?\s*[|｜丨:：-]\s*/i, '')
    .replace(/[\s“”"'「」『』|｜丨:：,，。！？!?·\-—_]/g, '')
  return ['公开信息来源', '来源证据', '雷达原文'].includes(title) ? '' : title
}

function objectKeys(value: unknown, kind: 'source' | 'funding'): string[] {
  if (!isPlainObject(value)) return [`value:${JSON.stringify(value)}`]
  if (kind === 'source') {
    const title = normalizedSourceTitle(value.title || value.name)
    const url = normalizedSourceUrl(value.url || value.sourceUrl || value.link)
    return [
      title ? `title:${title}` : '',
      url ? `url:${url}` : '',
    ].filter(Boolean)
  } else {
    const round = normalizedKeyPart(value.round)
    const date = normalizedKeyPart(value.date)
    if (round) return [`round:${round}|${date}`]
    const sourceUrl = normalizedKeyPart(value.sourceUrl || value.url)
    if (sourceUrl) return [`url:${sourceUrl}`]
  }
  return [`object:${JSON.stringify(value)}`]
}

function mergeObjectArray(existing: unknown, incoming: unknown, kind: 'source' | 'funding'): unknown[] {
  const oldItems = Array.isArray(existing) ? existing.filter(isMeaningfulRadarValue) : []
  const newItems = Array.isArray(incoming) ? incoming.filter(isMeaningfulRadarValue) : []
  const merged = [...oldItems]
  const positions = new Map<string, number>()
  merged.forEach((item, index) => {
    for (const key of objectKeys(item, kind)) positions.set(key, index)
  })

  for (const item of newItems) {
    const keys = objectKeys(item, kind)
    const index = keys.map((key) => positions.get(key)).find((position) => position !== undefined)
    if (index === undefined) {
      for (const key of keys) positions.set(key, merged.length)
      merged.push(item)
    } else {
      merged[index] = mergeNonEmptyValue(merged[index], item)
      for (const key of objectKeys(merged[index], kind)) positions.set(key, index)
    }
  }
  return merged
}

export function mergeRadarSources(existing: unknown, incoming: unknown): unknown[] {
  return mergeObjectArray(existing, incoming, 'source')
}

export function mergeRadarFundingRounds(existing: unknown, incoming: unknown): unknown[] {
  return mergeObjectArray(existing, incoming, 'funding')
}

function mergeUniqueValues(existing: unknown, incoming: unknown): unknown[] {
  const oldItems = Array.isArray(existing) ? existing.filter(isMeaningfulRadarValue) : []
  const newItems = Array.isArray(incoming) ? incoming.filter(isMeaningfulRadarValue) : []
  const merged = [...oldItems]
  const seen = new Set(oldItems.map((item) => JSON.stringify(item)))
  for (const item of newItems) {
    const key = JSON.stringify(item)
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(item)
    }
  }
  return merged
}

function hasFlueScoring(scoring: unknown): boolean {
  if (!isPlainObject(scoring)) return false
  return Object.values(scoring).some(isMeaningfulRadarValue)
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function buildRadarLeadMergePatch(
  existing: RadarMergeExistingLead,
  incoming: RadarLeadSyncFields & Record<string, unknown>,
): RadarLeadMergePatch {
  const patch: Record<string, unknown> = {}
  const existingIsRadar = /^项目发现雷达(?:\s|·|$)/.test(String(existing.source ?? '').trim())
  const scoringReady = hasFlueScoring(existing.scoring)

  const mergeScalar = (
    key: 'companyName' | 'industry' | 'source' | 'summary' | 'team',
    allowOverwrite: boolean,
  ) => {
    const next = incoming[key]
    if (!isMeaningfulRadarValue(next)) return
    const current = existing[key]
    if (!isMeaningfulRadarValue(current) || allowOverwrite) {
      if (!sameValue(current, next)) patch[key] = next
    }
  }

  if (
    shouldBackfillCompanyName(existing, incoming.companyName)
    && !sameValue(existing.companyName, incoming.companyName)
  ) {
    patch.companyName = incoming.companyName
  }
  mergeScalar('industry', existingIsRadar)
  mergeScalar('source', existingIsRadar)
  mergeScalar('summary', existingIsRadar)
  mergeScalar('team', existingIsRadar && !scoringReady)

  const mergedFunding = mergeRadarFundingRounds(existing.fundingRounds, incoming.fundingRounds)
  if (!sameValue(existing.fundingRounds ?? [], mergedFunding)) patch.fundingRounds = mergedFunding

  const mergedSources = mergeRadarSources(existing.sources, incoming.sources)
  if (!sameValue(existing.sources ?? [], mergedSources)) patch.sources = mergedSources

  for (const key of ['highlights', 'risks', 'riskTags'] as const) {
    const merged = mergeUniqueValues(existing[key], incoming[key])
    if (!sameValue(existing[key] ?? [], merged)) patch[key] = merged
  }

  const mergedRadarProfile = mergeNonEmptyValue(existing.radarProfile, incoming.radarProfile)
  if (!sameValue(existing.radarProfile ?? null, mergedRadarProfile ?? null)) {
    patch.radarProfile = mergedRadarProfile
  }

  return patch as RadarLeadMergePatch
}
