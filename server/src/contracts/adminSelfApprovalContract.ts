export const ADMIN_SELF_APPROVAL_NODE_NAME = '系统管理员确认'

export function isAdminSelfApprovalSubmission(input: { role: string; workflowModel: string; businessType: string }) {
  return input.role === '系统管理员'
    && input.workflowModel === 'fde-v1'
    && input.businessType === 'project_stage'
}

export function isAdminSelfApprovalNode(input: {
  actorRole: string
  actorId: string
  applicantUserId: string
  nodeName: string
  approverUserIds: string[]
}) {
  return input.actorRole === '系统管理员'
    && input.actorId === input.applicantUserId
    && input.nodeName === ADMIN_SELF_APPROVAL_NODE_NAME
    && input.approverUserIds.length === 1
    && input.approverUserIds[0] === input.actorId
}

export function adminSelfApprovalActions(enabled: boolean) {
  return enabled
    ? { approve: true, withdraw: true, return: false, reject: false }
    : { approve: true, withdraw: false, return: true, reject: true }
}
