import { and, eq, inArray, ne, not, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { committeeAgendas, committeeFiles, meetings, permissions, projects, rolePermissions, roles, userRoles, users, projectFiles } from '../db/schema.js'
import { projectAccessCondition } from './projectAccessService.js'
import { projectFileAccessCondition } from './projectFileAccessService.js'

type Reader = Pick<typeof db, 'select'>
// A committee seat is never a project/file grant. Legacy administrator display
// roles do not bypass the current FDE business role or project boundary.
export function committeeProjectScope(uid: string | SQL, manage = false) {
  const business = sql<boolean>`(${projects.ownerUserId}=${uid} OR EXISTS (SELECT 1 FROM ${userRoles} cu JOIN ${roles} cr ON cr.id=cu.role_id WHERE cu.user_id=${uid} AND cr.status='启用' AND cr.fde_category NOT IN ('system_admin','coordinator')))`
  const manager = sql<boolean>`(${projects.ownerUserId}=${uid} OR EXISTS (SELECT 1 FROM ${userRoles} cu JOIN ${roles} cr ON cr.id=cu.role_id JOIN ${rolePermissions} cp ON cp.role_id=cr.id JOIN ${permissions} p ON p.id=cp.permission_id WHERE cu.user_id=${uid} AND cr.status='启用' AND cr.fde_category NOT IN ('system_admin','coordinator') AND p.code='fde.governance.manage'))`
  return and(eq(projects.workflowModel, 'fde-v1'), eq(projects.projectType, '投资项目'), ne(projects.classification, 'pool'),
    projectAccessCondition({ uid, name: '', role: '' }), business, manage ? manager : undefined)!
}

export function committeeAgendaAccess(uid: string, includeInactive = false) {
  const scoped = db.select({ id: projects.id }).from(projects).where(committeeProjectScope(uid))
  const managed = db.select({ id: projects.id }).from(projects).where(committeeProjectScope(uid, true))
  const files = db.select({ id: projectFiles.id }).from(projectFiles).where(projectFileAccessCondition(uid))
  const inaccessible = db.select({ id: committeeFiles.agendaId }).from(committeeFiles)
    .where(and(includeInactive ? undefined : eq(committeeFiles.active, true), not(inArray(committeeFiles.fileId, files))))
  return and(includeInactive ? undefined : eq(committeeAgendas.active, true), inArray(committeeAgendas.projectId, scoped),
    or(inArray(committeeAgendas.projectId, managed), and(sql`JSON_CONTAINS(${committeeAgendas.participantIds},JSON_QUOTE(${uid}))`,
      inArray(committeeAgendas.meetingId, db.select({ id: meetings.id }).from(meetings).where(ne(meetings.workflowStatus, 'draft'))))),
    not(inArray(committeeAgendas.id, inaccessible)))!
}

export function committeeMeetingAccess(uid: string) {
  return and(eq(meetings.workflowKind, 'committee'), inArray(meetings.id,
    db.select({ id: committeeAgendas.meetingId }).from(committeeAgendas).where(committeeAgendaAccess(uid))))!
}

export async function canReadCommitteeMeeting(reader: Reader, meetingId: string, uid: string) {
  const [actor] = await reader.select({ id: users.id }).from(users).where(and(eq(users.id, uid), eq(users.status, '启用')))
  if (!actor) return false
  const [row] = await reader.select({ id: meetings.id }).from(meetings).where(and(eq(meetings.id, meetingId), committeeMeetingAccess(uid))).limit(1)
  return Boolean(row)
}
