type AiTaskFailurePresentationInput = {
  type: string
  status: string
  stage?: string | null
  errorMessage?: string | null
}

/**
 * 投资建议书正文门禁属于系统内部的可恢复生成检查。用户只需要保留
 * “继续生成”入口，具体检查项、停止阶段和错误编号仍留在服务端审计记录中。
 */
export function shouldHideAiTaskFailureDiagnostics(
  task: AiTaskFailurePresentationInput,
) {
  if (task.type !== 'investment_recommendation_ppt' || task.status !== 'failed') return false
  return task.stage === '投资建议书正文专业性检查未通过'
    || String(task.errorMessage ?? '').startsWith('投资建议书正文未达到交付标准')
}
