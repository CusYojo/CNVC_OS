import { and, eq, inArray, isNull, ne, not, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { auditLogs, fdeTypeExecutionReviews as reviews, fdeTypeExecutionFiles as files, fdeTypeExecutionNotices as notices, projectDutyAssignments, projectFiles, projects, roles, userRoles, users } from '../db/schema.js'
import { FDE_PROJECT_DUTIES } from '../contracts/fdeGovernanceContract.js'
import type { TypeRuntimeReview } from '../contracts/fdeTypeRuntimeContract.js'
import { projectAccessCondition, type ProjectAccessActor } from './projectAccessService.js'
import { projectFileAccessCondition } from './projectFileAccessService.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export const typeReviewApplicant = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${reviews.snapshot},'$.requesterUserId'))`
export const typeReviewNode = sql`JSON_EXTRACT(${reviews.snapshot},CONCAT('$.nodes[',JSON_UNQUOTE(JSON_EXTRACT(${reviews.snapshot},'$.currentNodeIndex')),']'))`
export const typeReviewNodeKey = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${typeReviewNode},'$.key'))`
export const typeReviewNodeName = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${typeReviewNode},'$.name'))`
export const typeReviewStageName = sql<string>`COALESCE((SELECT stage_catalog.stage_name FROM JSON_TABLE(${reviews.planSnapshot},'$.configuration.stages[*]' COLUMNS(stage_key varchar(48) PATH '$.key',stage_name varchar(16) PATH '$.name')) stage_catalog WHERE stage_catalog.stage_key=JSON_UNQUOTE(JSON_EXTRACT(${reviews.snapshot},'$.stageKey')) LIMIT 1),'阶段')`
const nodeDuty = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${typeReviewNode},'$.duty'))`

// Same current project and original-file scope for lists, counts and read receipts.
// This is an independent source, never a shadow OA request or a grant to old files.
export function typeApprovalAccessCondition(actor: ProjectAccessActor) {
  const visibleProjects = db.select({ id: projects.id }).from(projects).where(and(projectAccessCondition(actor), eq(projects.workflowModel, 'fde-v1'), ne(projects.projectType, '投资项目'), ne(projects.classification, 'pool')))
  const visibleFiles = db.select({ id: projectFiles.id }).from(projectFiles).where(projectFileAccessCondition(actor.uid))
  const hidden = db.select({ id: files.reviewId }).from(files).where(not(inArray(files.fileId, visibleFiles)))
  return and(inArray(reviews.projectId, visibleProjects), not(inArray(reviews.id, hidden)))!
}

export function typeApprovalPendingCondition(uid: string) {
  const duties = [{ code: 'owner', eligible: ['institution_leader', 'project_lead', 'member'] }, ...FDE_PROJECT_DUTIES]
  const qualified = or(...duties.map(d => and(eq(nodeDuty, d.code),
    d.code === 'owner' ? eq(projects.ownerUserId, uid) : sql`EXISTS (SELECT 1 FROM ${projectDutyAssignments} duty_row WHERE duty_row.project_id=${projects.id} AND duty_row.user_id=${uid} AND duty_row.duty=${d.code})`,
    sql`EXISTS (SELECT 1 FROM ${userRoles} current_ur JOIN ${roles} current_role ON current_role.id=current_ur.role_id
      WHERE current_ur.user_id=${uid} AND current_role.status='启用' AND current_role.fde_category IN (${sql.join(d.eligible.map(c => sql`${c}`), sql`,`)}))`,
    d.code === 'chairman' || d.code === 'president' ? sql`EXISTS (SELECT 1 FROM ${userRoles} exec_ur JOIN ${roles} exec_role ON exec_role.id=exec_ur.role_id WHERE exec_ur.user_id=${uid} AND exec_role.status='启用' AND exec_role.code=${d.code === 'chairman' ? 'FDE_CHAIRMAN' : 'FDE_PRESIDENT'})` : undefined,
  )))!
  const currentProject = db.select({ id: projects.id }).from(projects).where(and(eq(projects.lifecycle, 'active'), qualified))
  return and(eq(reviews.status, 'reviewing'), eq(reviews.activeKey, reviews.projectId), ne(typeReviewApplicant, uid),
    inArray(reviews.projectId, currentProject),
    sql`JSON_CONTAINS(JSON_EXTRACT(${typeReviewNode},'$.approverUserIds'),JSON_QUOTE(${uid}))`,
    sql`NOT JSON_CONTAINS(JSON_EXTRACT(${typeReviewNode},'$.approvedByUserIds'),JSON_QUOTE(${uid}))`)!
}

// Called under the runtime's project lock and in its business transaction.
// Remaining co-signers keep their own read receipt; moving node closes old notices.
export async function syncTypeApprovalNotices(tx: Tx, reviewId: string, snapshot: TypeRuntimeReview) {
  const node = snapshot.nodes[snapshot.currentNodeIndex]
  const recipients = snapshot.status === 'reviewing' ? node.approverUserIds.filter(uid => uid !== snapshot.requesterUserId && !node.approvedByUserIds.includes(uid)) : []
  await tx.update(notices).set({ closedAt: new Date() }).where(and(eq(notices.reviewId, reviewId), isNull(notices.closedAt),
    recipients.length ? or(ne(notices.nodeKey, node.key), not(inArray(notices.recipientId, recipients))) : undefined))
  for (const recipientId of recipients) await tx.insert(notices).values({ reviewId, nodeKey: node.key, recipientId })
    .onDuplicateKeyUpdate({ set: { id: sql`${notices.id}` } })
}

export async function readTypeApprovalNotice(noticeId: string, uid: string) {
  z.string().uuid().parse(noticeId)
  return db.transaction(async tx => {
    const [initial] = await tx.select({ projectId: reviews.projectId, reviewId: reviews.id }).from(notices).innerJoin(reviews, eq(reviews.id, notices.reviewId)).where(and(eq(notices.id, noticeId), eq(notices.recipientId, uid)))
    const deny = (): never => { throw Object.assign(new Error('当前通知不存在、已失效或无权处理，请刷新待办'), { status: 403, code: 'TYPE_NOTICE_FORBIDDEN' }) }
    if (!initial) return deny()
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, initial.projectId)).for('update')
    await tx.select({ id: reviews.id }).from(reviews).where(eq(reviews.id, initial.reviewId)).for('update')
    const [actor] = await tx.select().from(users).where(and(eq(users.id, uid), eq(users.status, '启用')))
    if (!actor) return deny()
    const [current] = await tx.select({ id: notices.id, readAt: notices.readAt }).from(notices).innerJoin(reviews, eq(reviews.id, notices.reviewId))
      .where(and(eq(notices.id, noticeId), eq(notices.recipientId, uid), isNull(notices.closedAt), eq(notices.nodeKey, typeReviewNodeKey),
        typeApprovalAccessCondition({ uid, name: actor.name, role: actor.role }), typeApprovalPendingCondition(uid)))
    if (!current) return deny()
    const readAt = current.readAt ?? new Date()
    if (!current.readAt) {
      await tx.update(notices).set({ readAt }).where(eq(notices.id, noticeId))
      await tx.insert(auditLogs).values({ userId: uid, userName: actor.name, module: '非投资项目执行', action: '阅读待审批通知', target: `${initial.reviewId} / ${noticeId}` })
    }
    return { id: noticeId, readAt: readAt.toISOString() }
  }, { isolationLevel: 'read committed' })
}
