import fs from 'node:fs'
import path from 'node:path'

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

const PERSIST_PATH = path.resolve(process.cwd(), '.runtime', 'ai-template-analysis-progress.json')

function loadPersistedProgress() {
  try {
    const raw = fs.readFileSync(PERSIST_PATH, 'utf-8')
    const entries: Array<[string, AiTemplateAnalysisProgress]> = JSON.parse(raw)
    for (const [id, item] of entries) {
      progressById.set(id, item)
    }
  } catch {
    // file missing or corrupted — start fresh
  }
}

function savePersistedProgress() {
  try {
    const dir = path.dirname(PERSIST_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const entries = Array.from(progressById.entries())
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(entries, null, 2), 'utf-8')
  } catch {
    // best-effort persist; ignore write errors
  }
}

let loaded = false
function ensureLoaded() {
  if (!loaded) {
    loadPersistedProgress()
    loaded = true
    cleanupExpiredProgress()
  }
}

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
  ensureLoaded()
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
  savePersistedProgress()
  return item
}

export function updateAiTemplateAnalysisProgress(
  id: string,
  update: { stage: string; progress: number },
) {
  ensureLoaded()
  const current = progressById.get(id)
  if (!current || current.status !== 'running') return
  progressById.set(id, {
    ...current,
    stage: update.stage,
    progress: Math.max(current.progress, clampProgress(update.progress)),
    updatedAt: new Date().toISOString(),
  })
  savePersistedProgress()
}

export function completeAiTemplateAnalysisProgress(id: string, result: unknown) {
  ensureLoaded()
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
  savePersistedProgress()
}

export function failAiTemplateAnalysisProgress(id: string, message: string) {
  ensureLoaded()
  const current = progressById.get(id)
  if (!current) return
  progressById.set(id, {
    ...current,
    status: 'failed',
    stage: '模板分析失败',
    errorMessage: message,
    updatedAt: new Date().toISOString(),
  })
  savePersistedProgress()
}

export function getAiTemplateAnalysisProgress(userId: string, id: string) {
  ensureLoaded()
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
