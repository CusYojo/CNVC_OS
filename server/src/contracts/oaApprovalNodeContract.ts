export function requireOaApprovalNodes<T>(nodes: T[]): [T, ...T[]] {
  if (nodes.length === 0) {
    throw Object.assign(new Error('当前阶段未配置审批节点，请联系管理员检查已发布流程策略'), {
      status: 409,
      code: 'OA_APPROVAL_NODES_REQUIRED',
    })
  }
  return nodes as [T, ...T[]]
}
