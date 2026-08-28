import { z } from 'zod'
import { responsibilityStatus, responsibilityEvidence } from './fdeResponsibilityContract.js'
import { responsibilityEventCode, responsibilityPolicySchema } from './fdeResponsibilityPolicyContract.js'

export const responsibilityAssignmentState = z.enum(['not_required', 'unassigned', 'invalid', 'assigned'])
export type ResponsibilityAssignmentState = z.infer<typeof responsibilityAssignmentState>
export const responsibilityAssignmentLabels: Record<ResponsibilityAssignmentState, string> = { not_required: '当前无需分配', unassigned: '待分配独立处理人', invalid: '原处理人已失去资格，待重新分配', assigned: '已分配独立处理人' }
export const responsibilityActionLabels: Record<string, string> = { create: '记录形成', automatic_fact: '正式事实自动记录', scan_candidate: '系统期限扫描形成候选', propose: '提出候选', confirm: '责任确认', appeal: '本人申诉', review: '申诉复核', reroute: '重新核对处理人', deadline_correction: '延期纠正', completion_reversal: '完成撤销' }
export const responsibilityOverview = z.object({ management: z.boolean(), assignmentAccess: z.boolean(), assignment: z.number().int().nonnegative(), mine: z.number().int().nonnegative(), review: z.number().int().nonnegative(), unread: z.number().int().nonnegative() }).strict()
const record = z.object({ id: z.string().uuid(), projectId: z.string().uuid(), taskId: z.string().uuid(), subjectId: z.string().uuid(), reviewerId: z.string().uuid().nullable(), eventCode: responsibilityEventCode, status: responsibilityStatus, originalPoints: z.number(), effectivePoints: z.number(), version: z.number().int().positive(), reason: z.string(), occurredAt: z.string(), policyVersionId: z.string().uuid(), deadlineKey: z.string().nullable(), sourceFeedbackId: z.string().uuid().nullable(), sourceAcceptanceId: z.string().uuid().nullable(), sourceRiskId: z.string().uuid().nullable() })
const labels = { projectName: z.string(), taskTitle: z.string(), subjectName: z.string(), countedPoints: z.number(), assignmentState: responsibilityAssignmentState }
const frozenEvidence = responsibilityEvidence.extend({ fileVersionId: z.string().uuid(), sha256: z.string(), byteSize: z.number() })
export const responsibilityList = z.object({ list: z.array(record.extend(labels)), total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.number().int().positive() })
export const responsibilityDetail = z.object({ record, ...labels, reviewerName: z.string().nullable(), policy: responsibilityPolicySchema,
  evidence: z.array(frozenEvidence.extend({ id: z.string().uuid(), recordId: z.string().uuid(), fileName: z.string(), canDownload: z.boolean() })),
  capabilities: z.object({ appeal: z.boolean(), confirm: z.boolean(), review: z.boolean(), reroute: z.boolean(), readNotice: z.boolean() }).strict(),
  appeal: z.object({ reason: z.string(), createdAt: z.string(), version: z.number(), evidence: z.array(frozenEvidence) }).nullable(),
  events: z.array(z.object({ id: z.string().uuid(), action: z.string(), actorName: z.string(), reason: z.string(), version: z.number(), createdAt: z.string() })), hasMoreEvents: z.boolean(), page: z.number().int().positive(),
})
export const responsibilityEvidenceChoices = z.object({ list: z.array(responsibilityEvidence.extend({ fileName: z.string() })), hasMore: z.boolean(), page: z.number().int().positive() })
export type ResponsibilityOverview = z.infer<typeof responsibilityOverview>
export type ResponsibilityList = z.infer<typeof responsibilityList>
export type ResponsibilityDetail = z.infer<typeof responsibilityDetail>
export type ResponsibilityEvidenceChoices = z.infer<typeof responsibilityEvidenceChoices>
