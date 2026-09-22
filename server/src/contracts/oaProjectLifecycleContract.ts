type ProjectApproval = { businessType: string; type: string; status: string; fromStage: string }
type ApprovalProject = { lifecycle: string; stage: string; workflowModel: string }

export const projectApprovalBusinessTypes = ['project_stage', 'task_extension', 'agent_schedule', 'project_replan'] as const
export const unresolvedProjectApprovalStatuses = ['审批中', '已退回'] as const

// Shared by detail presentation and the locked write path. A historical approval
// remains readable, but cannot move a deleted/advanced project backwards.
export function projectApprovalActionBlockedReason(request: ProjectApproval, project: ApprovalProject | undefined) {
  if (request.businessType === 'office') return undefined
  if (!project) return '所属项目不存在，此审批仅供查阅'
  if (project.lifecycle === 'deleted') return '所属项目已删除，此审批仅供查阅'
  if (project.lifecycle !== 'active') return '所属项目已结束，此审批仅供查阅'
  if (request.businessType !== 'project_stage' || !unresolvedProjectApprovalStatuses.includes(request.status as typeof unresolvedProjectApprovalStatuses[number])) return undefined
  const expectedStage = request.status === '已退回' && project.workflowModel === 'fde-v1' && request.type === '尽调计划审核'
    ? '尽调计划制定' : request.fromStage
  if (project.stage !== expectedStage) return '项目已进入其他阶段，此审批仅供查阅'
  return undefined
}

export function projectApprovalCanClose(request: { businessType: string; status: string }) {
  return (projectApprovalBusinessTypes as readonly string[]).includes(request.businessType)
    && (unresolvedProjectApprovalStatuses as readonly string[]).includes(request.status)
}

export function officeBlocksProjectDeletion(request: { status: string; executionEnabled?: boolean; latestExecutionOutcome?: string | null }) {
  return ['审批中', '已退回'].includes(request.status)
    || request.status === '已通过' && Boolean(request.executionEnabled) && request.latestExecutionOutcome !== 'succeeded'
}
