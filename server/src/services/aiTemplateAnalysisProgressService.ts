import type { AiTemplateAnalysisProgressRecord } from '../repositories/aiTaskRepository.js'
import { aiTaskRepository } from '../repositories/index.js'
import { redactSensitiveText } from '../security/redactSecrets.js'

export type AiTemplateAnalysisProgressStatus = AiTemplateAnalysisProgressRecord['status']
const COMPLETED_TTL_MINUTES = 10
const RUNNING_TTL_MINUTES = 40
const interruptedMessage = '服务重启或分析进程中断，模板分析未完成，请重新提交。'

function clampProgress(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function publicProgress(row: AiTemplateAnalysisProgressRecord) {
  const startedAt = row.startedAt.toISOString()
  const updatedAt = row.updatedAt.toISOString()
  return {
    id: row.id,
    fileName: row.fileName,
    status: row.status,
    stage: row.stage,
    progress: Number(row.progress),
    startedAt,
    updatedAt,
    elapsedSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1_000)),
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
    ...(row.status === 'succeeded' ? { result: row.result } : {}),
  }
}

export async function recoverInterruptedAiTemplateAnalysisProgress(): Promise<number> {
  return aiTaskRepository.recoverInterruptedTemplateAnalysisProgress({
    interruptedMessage,
    completedTtlMinutes: COMPLETED_TTL_MINUTES,
  })
}

export async function startAiTemplateAnalysisProgress(input: {
  id: string
  userId: string
  projectId: string
  taskId?: string
  fileName: string
  purpose: string
}) {
  const result = await aiTaskRepository.startTemplateAnalysisProgress({
    ...input,
    runningTtlMinutes: RUNNING_TTL_MINUTES,
  })
  return { created: result.created, progress: publicProgress(result.progress) }
}

export async function updateAiTemplateAnalysisProgress(
  id: string,
  update: { stage: string; progress: number },
) {
  await aiTaskRepository.updateTemplateAnalysisProgress({
    id,
    stage: update.stage.slice(0, 255),
    progress: clampProgress(update.progress),
    runningTtlMinutes: RUNNING_TTL_MINUTES,
  })
}

export async function completeAiTemplateAnalysisProgress(id: string, result: unknown) {
  await aiTaskRepository.completeTemplateAnalysisProgress({
    id,
    result,
    completedTtlMinutes: COMPLETED_TTL_MINUTES,
  })
}

export async function failAiTemplateAnalysisProgress(id: string, message: string) {
  await aiTaskRepository.failTemplateAnalysisProgress({
    id,
    message: redactSensitiveText(message).slice(0, 8_000),
    completedTtlMinutes: COMPLETED_TTL_MINUTES,
  })
}

export async function getAiTemplateAnalysisProgress(userId: string, id: string) {
  const row = await aiTaskRepository.getTemplateAnalysisProgress({
    userId,
    id,
    interruptedMessage,
    completedTtlMinutes: COMPLETED_TTL_MINUTES,
  })
  return row ? publicProgress(row) : undefined
}
