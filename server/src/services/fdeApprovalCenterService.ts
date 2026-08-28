import { and, asc, count, desc, eq, inArray, isNull, ne, not, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { oaApprovalRequests as requests, oaApprovalNodes as nodes, oaApprovalRecords as records, oaOfficeNotices as notices, fdeTypeExecutionReviews as typeReviews, fdeTypeExecutionNotices as typeNotices, projects, users } from '../db/schema.js'
import { approvalCenterQuery, approvalCenterViews, type ApprovalCenterResult, type ApprovalCenterView } from '../contracts/fdeApprovalCenterContract.js'
import { officeAccessCondition, officeBusinessRoleCondition, officeCurrentNodeCondition, officeFail, officeReadable } from './fdeOfficeAccessService.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import { legacyApprovalAccessCondition } from './oaRequestAccessService.js'
import { projectAccessCondition } from './projectAccessService.js'
import { typeApprovalAccessCondition, typeApprovalPendingCondition, typeReviewApplicant, typeReviewNodeKey, typeReviewNodeName, typeReviewStageName } from './fdeTypeApprovalService.js'

// The inbox, counts and notice acknowledgements use the same current-action
// predicate. Partial countersignature is still pending for the remaining users.
export function approvalPendingCondition(userId: string) {
  const pendingNode = sql<boolean>`EXISTS (SELECT 1 FROM ${nodes} current_node
    WHERE current_node.id=${requests.currentNodeId} AND current_node.request_id=${requests.id}
    AND current_node.status IN ('待审批','会签中')
    AND (${requests.businessType}<>'office' OR current_node.office_revision=${requests.officeRevision})
    AND JSON_CONTAINS(current_node.approver_user_ids,JSON_QUOTE(${userId}))
    AND NOT JSON_CONTAINS(current_node.approved_by_user_ids,JSON_QUOTE(${userId})))`
  return and(eq(requests.status, '审批中'), ne(requests.applicantUserId, userId), pendingNode,
    or(ne(requests.businessType, 'office'), officeCurrentNodeCondition(userId)))!
}

export async function readOfficeNotice(noticeId: string, userId: string) {
  return db.transaction(async tx => {
    const [initial] = await tx.select().from(notices).where(and(eq(notices.id, noticeId), eq(notices.recipientId, userId)))
    if (!initial) return officeFail('OFFICE_NOTICE_FORBIDDEN', '通知不存在或无权访问', 403)
    const [request] = await tx.select().from(requests).where(eq(requests.id, initial.requestId))
    if (!request) return officeFail('OFFICE_NOTICE_FORBIDDEN', '通知不存在或无权访问', 403)
    // Same project -> request -> notice order as business actions. Never lock
    // the notice first while an approval is closing it under a request lock.
    if (request.projectId) await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, request.projectId)).for('update')
    await tx.select({ id: requests.id }).from(requests).where(eq(requests.id, request.id)).for('update')
    await officeReadable(tx, request.id, userId)
    const [current] = await tx.select({ id: notices.id, readAt: notices.readAt }).from(notices)
      .innerJoin(requests, eq(requests.id, notices.requestId))
      .where(and(eq(notices.id, noticeId), eq(notices.recipientId, userId), isNull(notices.closedAt),
        eq(notices.nodeId, requests.currentNodeId), approvalPendingCondition(userId)))
    if (!current) return officeFail('OFFICE_NOTICE_STALE', '该通知已失效，请刷新当前待审批事项')
    const readAt = current.readAt ?? new Date()
    if (!current.readAt) {
      await tx.update(notices).set({ readAt, status: 'read' }).where(eq(notices.id, noticeId))
      const identity = createMySqlIdentityRepositoryContext(tx), actor = await identity.users.findById(userId)
      await identity.audits.append({ userId, userName: actor?.name ?? '', module: '通用OA', action: '阅读待审批通知', target: `${request.id} / ${noticeId}` })
    }
    return { id: noticeId, readAt: readAt.toISOString() }
  }, { isolationLevel: 'read committed' })
}

export async function listApprovalCenter(userId: string, raw: unknown, scope: 'all' | 'office' = 'all'): Promise<ApprovalCenterResult> {
  const query = approvalCenterQuery.parse(raw)
  // Counts, candidates, access scopes and rows come from one consistent read.
  // No full-payload hydration or client-side union of independently paged lists.
  return db.transaction(async tx => {
    const [user] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.status, '启用')))
    if (!user) throw Object.assign(new Error('当前账号不可用'), { status: 403, code: 'OA_ACTOR_UNAVAILABLE' })
    const actor = { uid: user.id, name: user.name, role: user.role }
    const accessibleProjects = tx.select({ id: projects.id }).from(projects).where(projectAccessCondition(actor))
    const officeScope = and(
      officeAccessCondition(userId),
      or(isNull(requests.projectId), inArray(requests.projectId, accessibleProjects)),
    )!
    const access = scope === 'office' ? officeScope : or(legacyApprovalAccessCondition(actor), officeScope)!
    const pending = approvalPendingCondition(userId)
    const terminal = inArray(requests.status, ['已通过', '已拒绝', '已驳回', '已撤回'])
    const views: Record<ApprovalCenterView, SQL> = {
      pending,
      tracking: and(ne(requests.status, '草稿'), not(terminal), not(pending))!,
      processed: sql<boolean>`EXISTS (SELECT 1 FROM ${records} processed WHERE processed.request_id=${requests.id}
        AND processed.operator_user_id=${userId} AND processed.action IN ('同意','退回','拒绝'))`,
      mine: eq(requests.applicantUserId, userId),
      draft: and(eq(requests.status, '草稿'), eq(requests.applicantUserId, userId))!,
      completed: terminal,
    }
    const flags = (conditions: Record<ApprovalCenterView, SQL>) => Object.fromEntries(approvalCenterViews.map(view => [view,
      sql<number>`CASE WHEN ${conditions[view]} THEN 1 ELSE 0 END`.as(`flag_${view}`),
    ])) as Record<ApprovalCenterView, SQL.Aliased<number>>
    const oaRows = tx.select({
      id: requests.id, requestNo: requests.requestNo, title: requests.title, kind: requests.type,
      businessType: requests.businessType, status: requests.status, applicantId: requests.applicantUserId,
      applicantName: requests.applicantName, projectName: requests.projectName,
      currentNodeName: requests.currentNodeName, priority: requests.priority,
      version: requests.lockVersion, revision: requests.officeRevision,
      updatedAt: requests.updatedAt, submittedAt: requests.submittedAt, projectId: requests.projectId,
      ...flags(views),
    }).from(requests).where(and(access, ne(requests.status, '已删除')))
    const typePending = typeApprovalPendingCondition(userId)
    const typeRows = tx.select({
      id: typeReviews.id, requestNo: sql<string>`CONCAT('TYPE-',${typeReviews.id})`.as('request_no'),
      title: sql<string>`CONCAT(${projects.name},' · ',CASE WHEN ${typeReviews.kind}='plan' THEN '计划审核' ELSE CONCAT(${typeReviewStageName},'审核') END)`.as('title'),
      kind: sql<string>`CASE WHEN ${typeReviews.kind}='plan' THEN '非投资计划审核' ELSE '非投资阶段审核' END`.as('kind'),
      businessType: sql<string>`'type_execution'`.as('business_type'),
      status: sql<string>`CASE ${typeReviews.status} WHEN 'reviewing' THEN '审批中' WHEN 'approved' THEN '已通过' WHEN 'returned' THEN '已退回' ELSE '已撤回' END`.as('status'),
      applicantId: typeReviewApplicant.as('applicant_id'), applicantName: users.name, projectName: projects.name,
      currentNodeName: typeReviewNodeName.as('current_node_name'), priority: sql<string>`'普通'`.as('priority'),
      version: typeReviews.version, revision: sql<number>`1`.as('revision'), updatedAt: typeReviews.updatedAt, submittedAt: typeReviews.createdAt,
      projectId: sql<string | null>`${typeReviews.projectId}`.as('project_id'),
      ...flags({ pending: typePending, tracking: and(eq(typeReviews.status, 'reviewing'), not(typePending))!,
        processed: sql`EXISTS (SELECT 1 FROM JSON_TABLE(${typeReviews.snapshot},'$.decisions[*]' COLUMNS(actor_id varchar(36) PATH '$.actorId', action_name varchar(16) PATH '$.action')) decision_row WHERE decision_row.actor_id=${userId} AND decision_row.action_name IN ('approve','return'))`,
        mine: eq(typeReviewApplicant, userId), draft: sql`FALSE`, completed: ne(typeReviews.status, 'reviewing'),
      }),
    }).from(typeReviews).innerJoin(projects, eq(projects.id, typeReviews.projectId)).innerJoin(users, eq(users.id, typeReviewApplicant))
      .where(typeApprovalAccessCondition(actor))
    // One SQL union before filtering, counting and pagination: not two pages
    // merged in memory, and never a second authoritative approval record.
    const center = (scope === 'office' ? oaRows : oaRows.unionAll(typeRows)).as('center_rows')
    const base = and(query.kind ? eq(center.kind, query.kind) : undefined,
      query.q ? sql`(LOCATE(${query.q},${center.title})>0 OR LOCATE(${query.q},${center.applicantName})>0 OR LOCATE(${query.q},${center.projectName})>0 OR LOCATE(${query.q},${center.requestNo})>0)` : undefined)
    const aggregate = Object.fromEntries(approvalCenterViews.map(view => [view, sql<number>`COALESCE(SUM(${center[view]}),0)`.mapWith(Number)])) as Record<ApprovalCenterView, SQL<number>>
    const [counts] = await tx.select(aggregate).from(center).where(base)
    const total = counts[query.view], page = Math.min(query.page, Math.max(1, Math.ceil(total / query.pageSize)))
    const list = await tx.select({ id: center.id, requestNo: center.requestNo, title: center.title, kind: center.kind, businessType: center.businessType,
      status: center.status, applicantId: center.applicantId, applicantName: center.applicantName, projectName: center.projectName,
      currentNodeName: center.currentNodeName, priority: center.priority, version: center.version, revision: center.revision,
      updatedAt: center.updatedAt, submittedAt: center.submittedAt, projectId: center.projectId,
    }).from(center).where(and(base, eq(center[query.view], 1))).orderBy(desc(center.updatedAt), asc(center.id)).limit(query.pageSize).offset((page - 1) * query.pageSize)
    const activeNotices = query.view === 'pending' && list.length ? await tx.select({ id: notices.id, requestId: notices.requestId, readAt: notices.readAt }).from(notices)
      .innerJoin(requests, eq(requests.id, notices.requestId))
      .where(and(inArray(requests.id, list.map(row => row.id)), eq(notices.recipientId, userId),
        eq(notices.nodeId, requests.currentNodeId), isNull(notices.closedAt), pending))
      .orderBy(desc(notices.createdAt), asc(notices.id)) : []
    const activeTypeNotices = query.view === 'pending' && list.some(row => row.businessType === 'type_execution') ? await tx.select({ id: typeNotices.id, requestId: typeNotices.reviewId, readAt: typeNotices.readAt }).from(typeNotices)
      .innerJoin(typeReviews, eq(typeReviews.id, typeNotices.reviewId)).where(and(inArray(typeReviews.id, list.filter(row => row.businessType === 'type_execution').map(row => row.id)),
        eq(typeNotices.recipientId, userId), isNull(typeNotices.closedAt), eq(typeNotices.nodeKey, typeReviewNodeKey), typePending)) : []
    const kinds = await tx.selectDistinct({ kind: center.kind }).from(center).orderBy(asc(center.kind))
    const [officeRole] = await tx.select({ value: count() }).from(users)
      .where(and(eq(users.id, userId), officeBusinessRoleCondition(userId)))
    return { list: list.map(row => {
      const notice = (row.businessType === 'type_execution' ? activeTypeNotices : activeNotices).find(item => item.requestId === row.id)
      return { ...row, updatedAt: row.updatedAt.toISOString(), submittedAt: row.submittedAt.toISOString(), notice: notice ? { id: notice.id, readAt: notice.readAt?.toISOString() ?? null } : null }
    }),
      total, page, pageSize: query.pageSize, counts, kinds: kinds.map(row => row.kind), canCreateOffice: officeRole.value > 0 }
  // Under REPEATABLE READ the first plain SELECT (actor above) establishes
  // the shared snapshot. This installed driver concatenates explicit snapshot
  // and access-mode modifiers without the comma required by MySQL.
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
