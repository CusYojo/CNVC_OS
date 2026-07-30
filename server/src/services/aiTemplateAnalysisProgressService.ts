export type AiTemplateAnalysisProgressStatus = 'running' | 'succeeded' | 'failed'

export type AiTemplateAnalysisProgress = {
  id: string
  userId: string
  fileName: string
  status: AiTemplateAnalysisProgressStatus
  stage: string
  progress: number
  startedAt: string
  updatedAt: string
  errorMessage?: string
  result?: unknown
}

const progressById = new Map<string, AiTemplateAnalysisProgress>()
const COMPLETED_TTL_MS = 10 * 60_000
const RUNNING_TTL_MS = 40 * 60_000

function clampProgress(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function cleanupExpiredProgress() {
  const now = Date.now()
  for (const [id, item] of progressById) {
    const updatedAt = Date.parse(item.updatedAt)
    const ttl = item.status === 'running' ? RUNNING_TTL_MS : COMPLETED_TTL_MS
    if (!Number.isFinite(updatedAt) || now - updatedAt > ttl) {
      progressById.delete(id)
    }
  }
}

export function startAiTemplateAnalysisProgress(input: {
  id: string
  userId: string
  fileName: string
}) {
  cleanupExpiredProgress()
  const now = new Date().toISOString()
  const item: AiTemplateAnalysisProgress = {
    ...input,
    status: 'running',
    stage: '已接收模板，正在准备分析',
    progress: 5,
    startedAt: now,
    updatedAt: now,
  }
  progressById.set(input.id, item)
  return item
}

export function updateAiTemplateAnalysisProgress(
  id: string,
  update: { stage: string; progress: number },
) {
  const current = progressById.get(id)
  if (!current || current.status !== 'running') return
  progressById.set(id, {
    ...current,
    stage: update.stage,
    progress: Math.max(current.progress, clampProgress(update.progress)),
    updatedAt: new Date().toISOString(),
  })
}

export function completeAiTemplateAnalysisProgress(id: string, result: unknown) {
  const current = progressById.get(id)
  if (!current) return
  progressById.set(id, {
    ...current,
    status: 'succeeded',
    stage: '模板分析完成',
    progress: 100,
    updatedAt: new Date().toISOString(),
    result,
  })
}

export function failAiTemplateAnalysisProgress(id: string, message: string) {
  const current = progressById.get(id)
  if (!current) return
  progressById.set(id, {
    ...current,
    status: 'failed',
    stage: '模板分析失败',
    errorMessage: message,
    updatedAt: new Date().toISOString(),
  })
}

export function getAiTemplateAnalysisProgress(userId: string, id: string) {
  cleanupExpiredProgress()
  const item = progressById.get(id)
  if (!item || item.userId !== userId) return undefined
  return {
    id: item.id,
    fileName: item.fileName,
    status: item.status,
    stage: item.stage,
    progress: item.progress,
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
    elapsedSeconds: Math.max(
      0,
      Math.floor((Date.now() - Date.parse(item.startedAt)) / 1000),
    ),
    ...(item.errorMessage ? { errorMessage: item.errorMessage } : {}),
    ...(item.status === 'succeeded' ? { result: item.result } : {}),
  }
}
