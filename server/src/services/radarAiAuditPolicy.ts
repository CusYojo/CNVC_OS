export function radarAiDecisionAuditKey(input: {
  cacheKey: string
  status: string
  runId: string
}): string {
  return `radar-ai:${input.cacheKey}:${input.status}:run:${input.runId}`
}

export function radarAiReviewAuditKey(input: {
  cacheKey: string
  decisionId: string
}): string {
  return `radar-ai:${input.cacheKey}:review:decision:${input.decisionId}`
}
