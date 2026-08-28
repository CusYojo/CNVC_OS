import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  identityResolutionIssues,
  meetingParticipants,
  meetings,
  projectMembers,
  projects,
  risks,
  todos,
} from '../db/schema.js'
import { createMySqlIdentityRepositoryContext, identityRepositories } from '../repositories/index.js'
import { lockSchedulePeople, requireMeetingSlot, type ScheduleTx } from './fdeScheduleService.js'
import { scheduleTransaction } from './fdeScheduleTransactionService.js'

type EntityType = 'project' | 'meeting' | 'todo' | 'risk'
type IssueReason = 'missing_user' | 'duplicate_name' | 'disabled_user'

type Resolution = {
  sourceName: string
  userId: string | null
  reason: IssueReason | null
}

function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 64) : ''
}

async function resolveUserName(value: unknown, tx?: ScheduleTx): Promise<Resolution> {
  const sourceName = normalizeName(value)
  if (!sourceName) return { sourceName, userId: null, reason: null }
  const matches = await (tx ? createMySqlIdentityRepositoryContext(tx).users : identityRepositories.users).findByTrimmedName(sourceName, 3)
  if (matches.length === 0) return { sourceName, userId: null, reason: 'missing_user' }
  if (matches.length > 1) return { sourceName, userId: null, reason: 'duplicate_name' }
  if (matches[0].status !== '启用') return { sourceName, userId: null, reason: 'disabled_user' }
  return { sourceName, userId: matches[0].id, reason: null }
}

async function resolvedUserOverride(
  entityType: EntityType,
  entityId: string,
  fieldName: string,
  sourceName: string,
  tx?: ScheduleTx,
): Promise<string | null> {
  const [resolved] = await (tx ?? db).select({ userId: identityResolutionIssues.resolvedUserId })
    .from(identityResolutionIssues)
    .where(and(
      eq(identityResolutionIssues.entityType, entityType),
      eq(identityResolutionIssues.entityId, entityId),
      eq(identityResolutionIssues.fieldName, fieldName),
      eq(identityResolutionIssues.sourceValue, sourceName),
      eq(identityResolutionIssues.status, 'resolved'),
    )).limit(1)
  if (!resolved?.userId) return null
  const user = await (tx ? createMySqlIdentityRepositoryContext(tx).users : identityRepositories.users).findById(resolved.userId)
  return user?.status === '启用' ? user.id : null
}

async function resolveField(
  entityType: EntityType,
  entityId: string,
  fieldName: string,
  values: unknown[],
  tx?: ScheduleTx,
): Promise<Resolution[]> {
  await (tx ?? db).update(identityResolutionIssues)
    .set({ status: 'superseded', updatedAt: new Date() })
    .where(and(
      eq(identityResolutionIssues.entityType, entityType),
      eq(identityResolutionIssues.entityId, entityId),
      eq(identityResolutionIssues.fieldName, fieldName),
      eq(identityResolutionIssues.status, 'open'),
    ))

  const uniqueNames = [...new Set(values.map(normalizeName).filter(Boolean))]
  const resolutions = await Promise.all(uniqueNames.map(async (sourceName) => {
    const override = await resolvedUserOverride(entityType, entityId, fieldName, sourceName, tx)
    return override ? { sourceName, userId: override, reason: null } : resolveUserName(sourceName, tx)
  }))
  for (const resolution of resolutions) {
    if (!resolution.reason) continue
    await (tx ?? db).insert(identityResolutionIssues).values({
      entityType,
      entityId,
      fieldName,
      sourceValue: resolution.sourceName,
      reason: resolution.reason,
      status: 'open',
    }).onDuplicateKeyUpdate({
      set: {
        reason: resolution.reason,
        status: 'open',
        resolvedUserId: null,
        resolvedAt: null,
        updatedAt: new Date(),
      },
    })
  }
  return resolutions
}

export async function syncProjectIdentityBindings(
  projectId: string,
  owner: unknown,
  collaborators: unknown,
) {
  const ownerResolution = (await resolveField('project', projectId, 'owner', [owner]))[0]
  const collaboratorNames = Array.isArray(collaborators) ? collaborators : []
  const collaboratorResolutions = await resolveField('project', projectId, 'collaborators', collaboratorNames)

  await db.update(projects)
    .set({ ownerUserId: ownerResolution?.userId ?? null })
    .where(eq(projects.id, projectId))
  await db.delete(projectMembers).where(eq(projectMembers.projectId, projectId))

  const bindings = new Map<string, { memberRole: string; sourceName: string }>()
  if (ownerResolution?.userId) {
    bindings.set(ownerResolution.userId, { memberRole: 'owner', sourceName: ownerResolution.sourceName })
  }
  for (const resolution of collaboratorResolutions) {
    if (resolution.userId && !bindings.has(resolution.userId)) {
      bindings.set(resolution.userId, { memberRole: 'collaborator', sourceName: resolution.sourceName })
    }
  }
  if (bindings.size) {
    await db.insert(projectMembers).values([...bindings].map(([userId, binding]) => ({
      projectId,
      userId,
      ...binding,
    })))
  }
}

export async function syncMeetingIdentityBindings(
  meetingId: string,
  host: unknown,
  attendees: unknown,
  tx?: ScheduleTx,
): Promise<void> {
  if (!tx) return scheduleTransaction(transaction => syncMeetingIdentityBindings(meetingId, host, attendees, transaction), { isolationLevel: 'read committed' })
  const [initial] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1)
  if (!initial || initial.workflowKind !== 'legacy') return // 专用会议只接受显式稳定账号，不能被姓名回填重绑。
  if (initial.projectId) await tx.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${initial.projectId} FOR UPDATE`)
  const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for('update')
  if (meeting.projectId !== initial.projectId || meeting.version !== initial.version) throw Object.assign(new Error('会议已变更，请重新绑定'), { code: 'VERSION_CONFLICT', status: 409 })
  const hostResolution = (await resolveField('meeting', meetingId, 'host', [host], tx))[0]
  const attendeeNames = Array.isArray(attendees) ? attendees : []
  const attendeeResolutions = await resolveField('meeting', meetingId, 'attendees', attendeeNames, tx)
  const oldPeople = await tx.select({ id: meetingParticipants.userId }).from(meetingParticipants).where(eq(meetingParticipants.meetingId, meetingId))
  const newPeople = [hostResolution?.userId, ...attendeeResolutions.map(row => row.userId)].filter((id): id is string => Boolean(id))
  await lockSchedulePeople(tx, [...newPeople, ...oldPeople.map(row => row.id), ...(meeting.hostUserId ? [meeting.hostUserId] : [])])
  await requireMeetingSlot(tx, meetingId, newPeople, meeting.startedAt, meeting.endsAt)
  await tx.update(meetings)
    .set({ hostUserId: hostResolution?.userId ?? null })
    .where(eq(meetings.id, meetingId))
  await tx.delete(meetingParticipants).where(eq(meetingParticipants.meetingId, meetingId))
  const participants = new Map<string, string>()
  for (const resolution of attendeeResolutions) {
    if (resolution.userId) participants.set(resolution.userId, resolution.sourceName)
  }
  if (participants.size) {
    await tx.insert(meetingParticipants).values([...participants].map(([userId, sourceName]) => ({
      meetingId,
      userId,
      sourceName,
    })))
  }
}

export async function syncTodoOwnerIdentity(todoId: string, owner: unknown) {
  const [task] = await db.select({ executionModel: todos.executionModel }).from(todos).where(eq(todos.id, todoId)).limit(1)
  if (task?.executionModel === 'fde-v1') return // 正式 FDE 任务只接受显式稳定 ID，不按姓名重新绑定。
  const resolution = (await resolveField('todo', todoId, 'owner', [owner]))[0]
  await db.update(todos)
    .set({ ownerUserId: resolution?.userId ?? null })
    .where(eq(todos.id, todoId))
}

export async function syncRiskAssigneeIdentity(riskId: string, assignee: unknown) {
  const resolution = (await resolveField('risk', riskId, 'assignee', [assignee]))[0]
  await db.update(risks)
    .set({ assigneeUserId: resolution?.userId ?? null })
    .where(eq(risks.id, riskId))
}
