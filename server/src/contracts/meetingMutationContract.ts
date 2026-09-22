type MeetingState = {
  workflowKind: string
  workflowStatus: string
  confirmedAt: Date | null
  createdBy: string | null
  hostUserId: string | null
  version: number
  startedAt: Date
  endsAt: Date | null
}
export type MeetingMutation = 'edit' | 'contribute' | 'start' | 'end' | 'cancel' | 'finalize' | 'delete'
const fail = (code: string, message: string, status = 409): never => { throw Object.assign(new Error(message), { code, status }) }

export function assertMeetingMutation(meeting: MeetingState, userId: string | undefined, expectedVersion: number | undefined, action: MeetingMutation, now = Date.now()) {
  if (meeting.workflowStatus === 'deleted') return fail('MEETING_NOT_FOUND', '会议不存在或已删除', 404)
  if (meeting.workflowKind !== 'legacy') return fail('FDE_MEETING_WORKFLOW_REQUIRED', '请在对应会议工作区处理')
  if (action !== 'contribute' && (!userId || meeting.createdBy !== userId && meeting.hostUserId !== userId)) return fail('MEETING_MANAGE_FORBIDDEN', '只有会议发起人或主持人可以处理', 403)
  if (meeting.version !== expectedVersion) return fail('VERSION_CONFLICT', '会议已发生变化，请重新读取后再操作')
  if (meeting.workflowStatus === 'cancelled' && action !== 'delete') return fail('MEETING_LIFECYCLE_INVALID', '会议已取消，不能继续操作')
  if (meeting.confirmedAt && action !== 'contribute') return fail('MEETING_MINUTES_IMMUTABLE', '正式会议纪要已确认，不能覆盖或撤销')
  if (['start', 'end', 'cancel', 'delete'].includes(action) && meeting.workflowStatus === 'completed') return fail('MEETING_LIFECYCLE_INVALID', '会议已结束，不能重复改变状态')
  if (action === 'start' && meeting.workflowStatus === 'in_progress') return fail('MEETING_LIFECYCLE_INVALID', '会议已经开始')
  if (action === 'end' && meeting.workflowStatus !== 'in_progress' && meeting.startedAt.getTime() > now) return fail('MEETING_NOT_STARTED', '会议尚未开始')
  if (action === 'finalize' && meeting.workflowStatus !== 'completed' && (!meeting.endsAt || meeting.endsAt.getTime() > now)) return fail('MEETING_NOT_ENDED', '会议结束后才能确认最终纪要')
}
