import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { db } from '../db/client.js'
import {
  auditLogs, fdeTypeExecutionNotices, fdeTypeExecutionReviews,
  oaApprovalNodes, oaApprovalRecords, oaApprovalRequests, oaOfficeExecutions,
  oaOfficeNotices, oaOfficePolicyVersions, projects, todos,
} from '../db/schema.js'
import { officeBlocksProjectDeletion, projectApprovalBusinessTypes, projectApprovalCanClose, unresolvedProjectApprovalStatuses } from '../contracts/oaProjectLifecycleContract.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// Correlated to the approval row, so inbox rows, counters and notice reads all
// use one rule. Office approvals have their own independent lifecycle rules.
export function projectApprovalOperableCondition() {
  return sql<boolean>`(${oaApprovalRequests.businessType}='office' OR EXISTS (
    SELECT 1 FROM ${projects} approval_project WHERE approval_project.id=${oaApprovalRequests.projectId}
      AND approval_project.lifecycle='active'
      AND (${oaApprovalRequests.businessType}<>'project_stage' OR approval_project.stage=CASE
        WHEN ${oaApprovalRequests.status}='已退回' AND approval_project.workflow_model='fde-v1' AND ${oaApprovalRequests.type}='尽调计划审核'
        THEN '尽调计划制定' ELSE ${oaApprovalRequests.fromStage} END)))`
}

// Caller already holds the project lock. Do not implicitly abandon payment or
// contract obligations when deleting a project; require their normal workflow.
export async function assertProjectOfficeCanClose(tx: Tx, projectId: string) {
  const officeRows = await tx.select({ status: oaApprovalRequests.status,
    executionEnabled: sql<boolean>`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${oaOfficePolicyVersions.configuration},'$.execution.enabled'))='true',FALSE)`.mapWith(Boolean),
    latestExecutionOutcome: sql<string | null>`(SELECT execution_row.outcome FROM ${oaOfficeExecutions} execution_row
      WHERE execution_row.request_id=${oaApprovalRequests.id} ORDER BY execution_row.request_version DESC LIMIT 1)`,
  }).from(oaApprovalRequests).leftJoin(oaOfficePolicyVersions, eq(oaOfficePolicyVersions.id, oaApprovalRequests.officePolicyVersionId))
    .where(and(eq(oaApprovalRequests.projectId, projectId), eq(oaApprovalRequests.businessType, 'office'), inArray(oaApprovalRequests.status, ['审批中', '已退回', '已通过'])))
  if (officeRows.some(officeBlocksProjectDeletion)) {
    throw Object.assign(new Error('项目仍有待处理的办公申请或执行事项，请先办理或撤回后再删除'), { status: 409, code: 'PROJECT_OFFICE_OBLIGATIONS_OPEN' })
  }
}

// Only runs on an explicit future project deletion, in the same transaction.
// No startup repair/backfill; historical rows retain their original decisions.
export async function closeDeletedProjectApprovals(tx: Tx, projectId: string, actor: { id: string; name: string }) {
  await assertProjectOfficeCanClose(tx, projectId)
  const now = new Date(), reason = '所属项目已删除，未决审批关闭；已作出的审批意见保留'
  const unresolved = await tx.select().from(oaApprovalRequests).where(and(eq(oaApprovalRequests.projectId, projectId),
    inArray(oaApprovalRequests.businessType, [...projectApprovalBusinessTypes]), inArray(oaApprovalRequests.status, [...unresolvedProjectApprovalStatuses])))
    .orderBy(asc(oaApprovalRequests.id)).for('update')
  for (const request of unresolved) {
    if (!projectApprovalCanClose(request)) continue
    const nodes = await tx.select().from(oaApprovalNodes).where(eq(oaApprovalNodes.requestId, request.id)).orderBy(asc(oaApprovalNodes.sequence))
    const recordNode = nodes.find(node => node.id === request.currentNodeId) ?? nodes[0]
    await tx.update(oaApprovalRequests).set({ status: '已撤回', activeKey: null, currentNodeId: null,
      currentNodeName: '项目删除，流程关闭', completedAt: now, lockVersion: request.lockVersion + 1, updatedAt: now }).where(eq(oaApprovalRequests.id, request.id))
    await tx.update(oaApprovalNodes).set({ status: '已撤回', comment: reason, completedAt: now, updatedAt: now })
      .where(and(eq(oaApprovalNodes.requestId, request.id), inArray(oaApprovalNodes.status, ['未开始', '待审批', '会签中'])))
    if (recordNode) await tx.insert(oaApprovalRecords).values({ requestId: request.id, nodeId: recordNode.id,
      nodeName: '项目删除关闭', operatorUserId: actor.id, operatorName: actor.name, action: '撤回', comment: reason })
    await tx.update(todos).set({ status: '已关闭', closureReason: reason, version: sql`${todos.version} + 1` })
      .where(and(eq(todos.approvalRequestId, request.id), sql`${todos.status} NOT IN ('已完成','已关闭','已取消','已归档')`))
    await tx.update(oaOfficeNotices).set({ status: 'closed', closedAt: now }).where(and(eq(oaOfficeNotices.requestId, request.id), isNull(oaOfficeNotices.closedAt)))
    await tx.insert(auditLogs).values({ userId: actor.id, userName: actor.name, module: 'OA 流程', action: '项目删除关闭审批', target: `${request.requestNo} · ${reason}` })
  }
  const typeReviews = await tx.select().from(fdeTypeExecutionReviews).where(and(eq(fdeTypeExecutionReviews.projectId, projectId), eq(fdeTypeExecutionReviews.status, 'reviewing'))).for('update')
  for (const review of typeReviews) {
    await tx.update(fdeTypeExecutionReviews).set({ status: 'withdrawn', activeKey: null,
      snapshot: { ...review.snapshot, status: 'withdrawn' }, version: review.version + 1, updatedAt: now }).where(eq(fdeTypeExecutionReviews.id, review.id))
    await tx.update(fdeTypeExecutionNotices).set({ closedAt: now }).where(and(eq(fdeTypeExecutionNotices.reviewId, review.id), isNull(fdeTypeExecutionNotices.closedAt)))
    await tx.insert(auditLogs).values({ userId: actor.id, userName: actor.name, module: '非投资项目执行', action: '项目删除关闭审批', target: `${review.id} · ${reason}` })
  }
}
