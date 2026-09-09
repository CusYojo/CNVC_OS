export type RadarSyncHandoffSource = Record<string, unknown>

export type RadarPipelineReviewItem = {
  status: unknown
  processingAttempts?: unknown
  ingestedAt?: unknown
}

function radarPipelineMaxAttempts(env: Record<string, string | undefined>) {
  const configured = Number(env.RADAR_PIPELINE_MAX_ATTEMPTS)
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(20, configured)
    : 3
}

function radarPipelineRetryAfter(env: Record<string, string | undefined>) {
  const configured = String(env.RADAR_PIPELINE_RETRY_AFTER ?? '').trim()
  if (!configured) return null
  const timestamp = Date.parse(configured)
  if (!Number.isFinite(timestamp)) throw new Error('RADAR_PIPELINE_RETRY_AFTER must be a valid date')
  return timestamp
}

export function radarPipelineItemReviewable(
  item: RadarPipelineReviewItem,
  env: Record<string, string | undefined> = process.env,
) {
  const status = String(item.status ?? '')
  if (!['discovered', 'failed'].includes(status)) return false
  const attempts = Math.max(0, Math.floor(Number(item.processingAttempts) || 0))
  if (attempts >= radarPipelineMaxAttempts(env)) return false
  const retryAfter = radarPipelineRetryAfter(env)
  if (retryAfter == null) return true
  const ingestedAt = item.ingestedAt instanceof Date
    ? item.ingestedAt.getTime()
    : Date.parse(String(item.ingestedAt ?? ''))
  return Number.isFinite(ingestedAt) && ingestedAt >= retryAfter
}

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
