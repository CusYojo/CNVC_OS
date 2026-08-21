type DirectAgentMessageLike = {
  type?: string
  usage?: unknown
  modelUsage?: unknown
  message?: {
    usage?: unknown
  }
}

function usageRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function token(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0
}

function usageParts(value: unknown) {
  const usage = usageRecord(value) ?? {}
  const inputTokens = token(usage.input_tokens ?? usage.inputTokens)
  const outputTokens = token(usage.output_tokens ?? usage.outputTokens)
  const cacheCreationInputTokens = token(
    usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
  )
  const cacheReadInputTokens = token(
    usage.cache_read_input_tokens ?? usage.cacheReadInputTokens,
  )
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
  }
}

/**
 * Claude Agent SDK emits one assistant message per model turn. Each completed
 * assistant message contains that turn's usage, while the final result contains
 * an aggregate for the whole session. Recording assistant messages makes token
 * totals visible while a long-running Skill task is still in progress.
 */
export function directAgentTurnUsage(message: DirectAgentMessageLike): Record<string, unknown> | null {
  if (message.type !== 'assistant') return null
  const usage = usageRecord(message.message?.usage)
  return usage && usageParts(usage).totalTokens > 0 ? usage : null
}

/**
 * Some Anthropic-compatible gateways leave aggregate `usage` at zero while the
 * Agent SDK still has per-model totals in `modelUsage`. Build one normalized
 * payload from the best non-zero source for each dimension.
 */
export function directAgentResultUsage(message: DirectAgentMessageLike): Record<string, unknown> | null {
  const aggregate = usageParts(message.usage)
  const modelRecords = Object.values(usageRecord(message.modelUsage) ?? {})
  const model = modelRecords.reduce<ReturnType<typeof usageParts>>((sum, value) => {
    const part = usageParts(value)
    sum.inputTokens += part.inputTokens
    sum.outputTokens += part.outputTokens
    sum.cacheCreationInputTokens += part.cacheCreationInputTokens
    sum.cacheReadInputTokens += part.cacheReadInputTokens
    sum.totalTokens += part.totalTokens
    return sum
  }, {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  })
  const aggregateInput = aggregate.inputTokens
    + aggregate.cacheCreationInputTokens
    + aggregate.cacheReadInputTokens
  const input = aggregateInput > 0 ? aggregate : model
  const outputTokens = aggregate.outputTokens > 0 ? aggregate.outputTokens : model.outputTokens
  const totalTokens = input.inputTokens
    + input.cacheCreationInputTokens
    + input.cacheReadInputTokens
    + outputTokens
  if (totalTokens <= 0) return null
  return {
    input_tokens: input.inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: input.cacheCreationInputTokens,
    cache_read_input_tokens: input.cacheReadInputTokens,
    total_tokens: totalTokens,
  }
}
