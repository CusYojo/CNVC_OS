export function presentFdePlanReadiness(input: {
  stage: string
  loaded: boolean
  validForReview: boolean
  reason: string
}): { required: boolean; blocked: boolean; label: string; action: 'configure' | null } {
  const required = ['尽调计划制定', '尽调计划审核'].includes(input.stage)
  if (!required) return { required: false, blocked: false, label: '无需确认计划', action: null }
  if (!input.loaded) return { required: true, blocked: true, label: '计划状态加载失败', action: 'configure' }
  if (!input.validForReview) return { required: true, blocked: true, label: input.reason || '倒排计划尚未完整保存', action: 'configure' }
  return { required: true, blocked: false, label: input.reason || '计划已配置，可提交审核', action: null }
}
