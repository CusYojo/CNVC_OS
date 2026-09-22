export const PROJECT_DISCOVERY_SOURCE_PREFIXES = ['vc-hunter:', 'bp-upload:'] as const
export const PROJECT_DISCOVERY_KEYWORD_KINDS = ['institution', 'academic', 'industry', 'technology'] as const

export type ProjectDiscoveryKeywordKind = typeof PROJECT_DISCOVERY_KEYWORD_KINDS[number]
export type ProjectDiscoveryKeyword = {
  kind: ProjectDiscoveryKeywordKind
  label: string
  value: string
}

export type ProjectDiscoveryCardEdits = {
  name: string
  primaryDate: string
  summary: string
  region: string
  sourceChannel: string
  briefFacts: Record<string, string>
  profileFacts: Record<string, string>
}

export function isProjectDiscoverySourceKey(sourceKey: string): boolean {
  return PROJECT_DISCOVERY_SOURCE_PREFIXES.some((prefix) => sourceKey.startsWith(prefix))
}

export function isProjectDiscoveryLead(sourceKeys: unknown): boolean {
  return Array.isArray(sourceKeys)
    && sourceKeys.some((sourceKey) => typeof sourceKey === 'string' && isProjectDiscoverySourceKey(sourceKey))
}

export function normalizeProjectDiscoveryKeywords(value: unknown): ProjectDiscoveryKeyword[] {
  if (!Array.isArray(value)) throw new Error('重点关键词必须为数组')
  if (value.length > 8) throw new Error('重点关键词最多保留 8 个')

  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('重点关键词格式不正确')
    const keyword = item as Record<string, unknown>
    const kind = typeof keyword.kind === 'string' ? keyword.kind.trim() : ''
    const label = typeof keyword.label === 'string' ? keyword.label.trim() : ''
    const keywordValue = typeof keyword.value === 'string' ? keyword.value.trim() : ''
    if (!PROJECT_DISCOVERY_KEYWORD_KINDS.includes(kind as ProjectDiscoveryKeywordKind)) throw new Error('重点关键词类型不正确')
    if (!label || label.length > 8) throw new Error('重点关键词标签须为 1 到 8 个字符')
    if (!keywordValue || keywordValue.length > 80) throw new Error('重点关键词内容须为 1 到 80 个字符')
    return { kind: kind as ProjectDiscoveryKeywordKind, label, value: keywordValue }
  })
}

function normalizedTextRecord(value: unknown, label: string, maxEntries: number): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式不正确`)
  const entries = Object.entries(value)
  if (entries.length > maxEntries) throw new Error(`${label}最多保留 ${maxEntries} 项`)
  return Object.fromEntries(entries.map(([rawKey, rawValue]) => {
    const key = rawKey.trim()
    const text = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (!key || key.length > 40 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`${label}名称不正确`)
    if (text.length > 1_000) throw new Error(`${label}内容不能超过 1000 个字符`)
    return [key, text]
  }))
}

export function normalizeProjectDiscoveryCardEdits(value: unknown): ProjectDiscoveryCardEdits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目卡片内容格式不正确')
  const edits = value as Record<string, unknown>
  const text = (key: string, label: string, maxLength: number, required = false) => {
    const result = typeof edits[key] === 'string' ? edits[key].trim() : ''
    if (required && !result) throw new Error(`${label}不能为空`)
    if (result.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`)
    return result
  }
  return {
    name: text('name', '项目名称', 160, true),
    primaryDate: text('primaryDate', '项目日期', 40),
    summary: text('summary', '项目摘要', 2_000),
    region: text('region', '地区', 100),
    sourceChannel: text('sourceChannel', '来源渠道', 100),
    briefFacts: normalizedTextRecord(edits.briefFacts, '速览字段', 12),
    profileFacts: normalizedTextRecord(edits.profileFacts, '画像字段', 16),
  }
}

export function canAssignProjectDiscoveryOwner(
  actorUserId: string,
  ownerUserId: string,
  permissionCodes: readonly string[],
): boolean {
  return actorUserId === ownerUserId
    || permissionCodes.includes('project.classify')
    || permissionCodes.includes('system.manage')
}
