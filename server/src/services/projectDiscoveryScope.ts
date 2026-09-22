export const PROJECT_DISCOVERY_SOURCE_PREFIXES = ['vc-hunter:', 'bp-upload:'] as const
export const PROJECT_DISCOVERY_KEYWORD_KINDS = ['institution', 'academic', 'industry', 'technology'] as const

export type ProjectDiscoveryKeywordKind = typeof PROJECT_DISCOVERY_KEYWORD_KINDS[number]
export type ProjectDiscoveryKeyword = {
  kind: ProjectDiscoveryKeywordKind
  label: string
  value: string
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

export function canAssignProjectDiscoveryOwner(
  actorUserId: string,
  ownerUserId: string,
  permissionCodes: readonly string[],
): boolean {
  return actorUserId === ownerUserId
    || permissionCodes.includes('project.classify')
    || permissionCodes.includes('system.manage')
}
