export const PROJECT_DISCOVERY_SOURCE_PREFIXES = ['vc-hunter:', 'bp-upload:'] as const

export function isProjectDiscoverySourceKey(sourceKey: string): boolean {
  return PROJECT_DISCOVERY_SOURCE_PREFIXES.some((prefix) => sourceKey.startsWith(prefix))
}
