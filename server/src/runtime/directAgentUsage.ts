type DirectAgentMessageLike = {
  type?: string
  message?: {
    usage?: unknown
  }
}

function usageRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Claude Agent SDK emits one assistant message per model turn. Each completed
 * assistant message contains that turn's usage, while the final result contains
 * an aggregate for the whole session. Recording assistant messages makes token
 * totals visible while a long-running Skill task is still in progress.
 */
export function directAgentTurnUsage(message: DirectAgentMessageLike): Record<string, unknown> | null {
  if (message.type !== 'assistant') return null
  return usageRecord(message.message?.usage)
}
