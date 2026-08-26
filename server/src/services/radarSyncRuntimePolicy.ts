export type RadarSyncHandoffSource = Record<string, unknown>

export function radarCandidateWriteCount(result: RadarSyncHandoffSource): number {
  for (const value of [result.written, result.imported, result.retained]) {
    const count = Number(value)
    if (Number.isFinite(count) && count > 0) return Math.floor(count)
  }
  return 0
}

export function isRadarSyncContentionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown }
  return candidate.name === 'RadarSyncAlreadyRunningError'
    || candidate.code === 'RADAR_SYNC_ALREADY_RUNNING'
    || String(candidate.message ?? '').includes('上一轮雷达同步仍在运行')
}
