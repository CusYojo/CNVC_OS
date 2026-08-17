import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

export type LeadAgentUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  source: 'aggregate-usage' | 'model-usage' | 'unavailable'
}

function token(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function usageRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function inputFrom(record: Record<string, unknown>) {
  return token(record.input_tokens ?? record.inputTokens)
    + token(record.cache_creation_input_tokens ?? record.cacheCreationInputTokens)
    + token(record.cache_read_input_tokens ?? record.cacheReadInputTokens)
}

function outputFrom(record: Record<string, unknown>) {
  return token(record.output_tokens ?? record.outputTokens)
}

export function leadAgentUsageMetrics(result: Pick<SDKResultMessage, 'usage' | 'modelUsage'>): LeadAgentUsage {
  const aggregate = usageRecord(result.usage)
  const aggregateInput = inputFrom(aggregate)
  const aggregateOutput = outputFrom(aggregate)
  const modelRecords = Object.values(usageRecord(result.modelUsage)).map(usageRecord)
  const modelInput = modelRecords.reduce((sum, record) => sum + inputFrom(record), 0)
  const modelOutput = modelRecords.reduce((sum, record) => sum + outputFrom(record), 0)
  const inputTokens = aggregateInput > 0 ? aggregateInput : modelInput
  const outputTokens = aggregateOutput > 0 ? aggregateOutput : modelOutput
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: aggregateInput > 0
      ? 'aggregate-usage'
      : modelInput > 0
        ? 'model-usage'
        : 'unavailable',
  }
}
