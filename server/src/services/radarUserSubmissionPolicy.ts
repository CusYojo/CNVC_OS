export function radarUnavailableReviewTransition(input: {
  source: unknown
  reviewStatus: 'review' | 'failed' | 'missing'
  reason?: string
}) {
  const userSubmitted = input.source === 'weixin_link'
  if (input.reviewStatus === 'review' || userSubmitted) {
    return {
      status: 'review' as const,
      reason: input.reason || (userSubmitted
        ? '用户提交材料已保留，AI 主体审查暂不可用，等待人工复核'
        : 'radar subject requires manual review'),
      error: null,
    }
  }
  return {
    status: 'failed' as const,
    reason: 'radar subject review failed',
    error: input.reason || 'subject review failed',
  }
}
