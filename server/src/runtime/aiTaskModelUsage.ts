import { AsyncLocalStorage } from 'node:async_hooks'

export type AiTaskModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  reasoningTokens: number
  totalTokens: number
}

type AiTaskModelUsageContext = {
  taskId: string
  onModelCall: (usage: AiTaskModelUsage | null) => void | Promise<void>
}

const taskUsageContext = new AsyncLocalStorage<AiTaskModelUsageContext>()

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function token(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null
}

/**
 * Normalizes OpenAI Responses, Chat Completions and Anthropic-compatible usage.
 * Cached/reasoning tokens are retained as detail fields; provider total_tokens
 * remains authoritative when present because cached/reasoning counts can be
 * subsets of input/output on OpenAI-compatible gateways.
 */
export function normalizeAiTaskModelUsage(payload: unknown): AiTaskModelUsage | null {
  const root = record(payload)
  const usage = record(root.usage ?? root)
  const inputDetails = record(usage.input_tokens_details ?? usage.prompt_tokens_details)
  const outputDetails = record(usage.output_tokens_details ?? usage.completion_tokens_details)
  const inputTokens = token(
    usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens,
  )
  const outputTokens = token(
    usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens,
  )
  if (inputTokens === null || outputTokens === null) return null

  const standaloneCacheCreation = token(
    usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
  ) ?? 0
  const standaloneCacheRead = token(
    usage.cache_read_input_tokens ?? usage.cacheReadInputTokens,
  ) ?? 0
  const cachedSubset = token(inputDetails.cached_tokens ?? inputDetails.cachedTokens) ?? 0
  const cacheReadInputTokens = standaloneCacheRead || cachedSubset
  const reasoningTokens = token(
    outputDetails.reasoning_tokens
      ?? outputDetails.reasoningTokens
      ?? usage.reasoning_tokens
      ?? usage.reasoningTokens,
  ) ?? 0
  const reportedTotal = token(usage.total_tokens ?? usage.totalTokens)
  const totalTokens = reportedTotal ?? (
    inputTokens
    + outputTokens
    + standaloneCacheCreation
    + standaloneCacheRead
  )
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: standaloneCacheCreation,
    cacheReadInputTokens,
    reasoningTokens,
    totalTokens,
  }
}

export function runWithAiTaskModelUsage<T>(
  context: AiTaskModelUsageContext,
  work: () => Promise<T>,
): Promise<T> {
  return taskUsageContext.run(context, work)
}

export async function recordAiTaskModelCall(payload: unknown): Promise<void> {
  const context = taskUsageContext.getStore()
  if (!context) return
  await context.onModelCall(normalizeAiTaskModelUsage(payload))
}

export function currentAiTaskModelUsageTaskId(): string | null {
  return taskUsageContext.getStore()?.taskId ?? null
}
