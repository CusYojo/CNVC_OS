/** Only platform-owned messages reach durable events/UI; provider and process text may contain secrets. */
const messages: Record<string, string> = {
  EVOLUTION_CANCEL_REQUESTED: '已收到取消请求，执行结果不会被采纳',
  EVOLUTION_DURATION_EXCEEDED: '任务累计执行时间已用完，已停止执行并保留检查点',
  EVOLUTION_BUDGET_EXCEEDED: '模型调用预算不足，已停止新的调用并保留检查点',
  EVOLUTION_CONTEXT_BUDGET: '源码和反馈超出模型上下文预算，请缩小参考范围或调整预算',
  EVOLUTION_REPAIR_BUDGET_EXHAUSTED: '候选验收未通过，修复轮次已用完，请查看验收证据',
  EVOLUTION_REPEATED_FAILURE: '候选没有有效变化且重复验收失败，已停止修复',
  EVOLUTION_BUILD_FAILED: '候选构建失败，请查看本轮构建日志',
  EVOLUTION_EVALUATION_INCOMPLETE: '候选验收尚未完成或证据不足，不能进入批准流程',
  EVOLUTION_NEEDS_INPUT: '提案还有未回答的问题，请补充后再执行',
  EVOLUTION_SOURCE_FORBIDDEN: '提案来源的访问权限已失效，执行已停止',
  EVOLUTION_REPOSITORY_FORBIDDEN: '目标仓库的开发授权已失效，执行已停止',
  EVOLUTION_SCOPE_FORBIDDEN: '缺少当前作用域的授权，执行已停止',
  EVOLUTION_PROJECT_FORBIDDEN: '关联项目的访问权限已失效，执行已停止',
  EVOLUTION_CAPABILITY_FORBIDDEN: '缺少目标技能的管理授权，执行已停止',
  EVOLUTION_PATCH_SCOPE: '候选修改超出批准范围，已拒绝该修改',
  EVOLUTION_PATCH_BASELINE: '候选修改与源码基线不一致，需要重新核对差异',
  EVOLUTION_DEVELOPER_BASELINE: '开发规格与冻结的源码版本不一致，执行已停止',
  EVOLUTION_MODEL_CHANGED: '模型配置与冻结版本不一致，需要重新核对后执行',
  EVOLUTION_MODEL_CALL_PENDING: '上次模型调用尚未确认，已停止重复调用',
  EVOLUTION_MODEL_CALL_UNCERTAIN: '上次模型调用结果尚不确定，已保留预算预留并停止重复调用',
  EVOLUTION_ENVIRONMENT_UNAVAILABLE: '隔离执行环境不可用，请恢复环境后再执行',
  EVOLUTION_ENVIRONMENT_CREATE_FAILED: '隔离执行环境创建失败，请检查运行环境',
  EVOLUTION_ENVIRONMENT_START_FAILED: '隔离执行环境启动失败，请检查运行环境',
  EVOLUTION_DOCKER_TIMEOUT: '隔离环境操作超时，正在核对进程终止状态',
  EVOLUTION_SHUTDOWN: '服务关闭导致执行中断，检查点已保留',
  EVOLUTION_STALE_EXECUTOR: '执行租约已失效，旧执行器的结果不会被采纳',
}

export function evolutionRunError(error: unknown): { code: string; message: string } {
  const rawCode = (error as { code?: unknown } | null)?.code
  const code = typeof rawCode === 'string' && /^EVOLUTION_[A-Z_]{1,80}$/.test(rawCode) ? rawCode : 'EVOLUTION_EXECUTION_FAILED'
  return { code, message: Object.hasOwn(messages, code) ? messages[code] : '执行失败，请查看授权范围内的验收证据' }
}
