import { and, eq } from 'drizzle-orm'
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
import { identityRepositories } from '../repositories/index.js'

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

async function resolveUserName(value: unknown): Promise<Resolution> {
  const sourceName = normalizeName(value)
  if (!sourceName) return { sourceName, userId: null, reason: null }
  const matches = await identityRepositories.users.findByTrimmedName(sourceName, 3)
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
): Promise<string | null> {
  const [resolved] = await db.select({ userId: identityResolutionIssues.resolvedUserId })
    .from(identityResolutionIssues)
    .where(and(
      eq(identityResolutionIssues.entityType, entityType),
      eq(identityResolutionIssues.entityId, entityId),
      eq(identityResolutionIssues.fieldName, fieldName),
      eq(identityResolutionIssues.sourceValue, sourceName),
      eq(identityResolutionIssues.status, 'resolved'),
    )).limit(1)
  if (!resolved?.userId) return null
  const user = await identityRepositories.users.findById(resolved.userId)
  return user?.status === '启用' ? user.id : null
}

async function resolveField(
  entityType: EntityType,
  entityId: string,
  fieldName: string,
  values: unknown[],
): Promise<Resolution[]> {
  await db.update(identityResolutionIssues)
    .set({ status: 'superseded', updatedAt: new Date() })
    .where(and(
      eq(identityResolutionIssues.entityType, entityType),
      eq(identityResolutionIssues.entityId, entityId),
      eq(identityResolutionIssues.fieldName, fieldName),
      eq(identityResolutionIssues.status, 'open'),
    ))

  const uniqueNames = [...new Set(values.map(normalizeName).filter(Boolean))]
  const resolutions = await Promise.all(uniqueNames.map(async (sourceName) => {
    const override = await resolvedUserOverride(entityType, entityId, fieldName, sourceName)
    return override ? { sourceName, userId: override, reason: null } : resolveUserName(sourceName)
  }))
  for (const resolution of resolutions) {
    if (!resolution.reason) continue
    await db.insert(identityResolutionIssues).values({
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
) {
  const hostResolution = (await resolveField('meeting', meetingId, 'host', [host]))[0]
  const attendeeNames = Array.isArray(attendees) ? attendees : []
  const attendeeResolutions = await resolveField('meeting', meetingId, 'attendees', attendeeNames)
  await db.update(meetings)
    .set({ hostUserId: hostResolution?.userId ?? null })
    .where(eq(meetings.id, meetingId))
  await db.delete(meetingParticipants).where(eq(meetingParticipants.meetingId, meetingId))
  const participants = new Map<string, string>()
  for (const resolution of attendeeResolutions) {
    if (resolution.userId) participants.set(resolution.userId, resolution.sourceName)
  }
  if (participants.size) {
    await db.insert(meetingParticipants).values([...participants].map(([userId, sourceName]) => ({
      meetingId,
      userId,
      sourceName,
    })))
  }
}

export async function syncTodoOwnerIdentity(todoId: string, owner: unknown) {
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
