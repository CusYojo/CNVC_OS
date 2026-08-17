import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  auditLogs,
  identityResolutionIssues,
  meetingParticipants,
  meetings,
  projectMembers,
  projects,
  risks,
  todos,
  users,
} from '../db/schema.js'
import { getMeeting, getTodo, createMeeting, createTodo } from '../services/meetingService.js'
import { getAccessibleProject } from '../services/projectAccessService.js'
import { createProject, updateProject } from '../services/projectService.js'
import { createRisk, getRisk } from '../services/riskService.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main() {
  const marker = randomUUID()
  const short = marker.slice(0, 8)
  const names = {
    creator: `身份创建者-${short}`,
    owner: `身份负责人-${short}`,
    collaborator: `身份协作人-${short}`,
    duplicate: `身份重名-${short}`,
    disabled: `身份禁用-${short}`,
    missing: `身份缺失-${short}`,
  }
  const createUser = async (suffix: string, name: string, status = '启用') => {
    const [inserted] = await db.insert(users).values({
      email: `identity-${suffix}-${marker}@example.invalid`,
      name,
      role: '投资经理',
      department: '身份验收部',
      passwordHash: 'identity-acceptance-not-for-login',
      status,
    }).$returningId()
    return inserted.id
  }

  const userIds = [
    await createUser('creator', names.creator),
    await createUser('owner', names.owner),
    await createUser('collaborator', names.collaborator),
    await createUser('duplicate-a', names.duplicate),
    await createUser('duplicate-b', names.duplicate),
    await createUser('disabled', names.disabled, '禁用'),
  ]
  const [creatorId, ownerId, collaboratorId, duplicateAId, duplicateBId, disabledId] = userIds
  const entityIds: string[] = []

  try {
    const project = await createProject({
      name: `稳定身份验收-${marker}`,
      owner: names.owner,
      collaborators: [names.collaborator, names.duplicate, names.disabled, names.missing],
    }, creatorId)
    entityIds.push(project.id)
    assert(project.ownerUserId === ownerId, 'unique enabled project owner was not mapped')

    const members = await db.select().from(projectMembers).where(eq(projectMembers.projectId, project.id))
    assert(members.some((row) => row.userId === ownerId && row.memberRole === 'owner'), 'owner membership is missing')
    assert(members.some((row) => row.userId === collaboratorId && row.memberRole === 'collaborator'), 'collaborator membership is missing')
    assert(!members.some((row) => row.userId === duplicateAId || row.userId === duplicateBId || row.userId === disabledId), 'unsafe project member was mapped')

    assert(await getAccessibleProject(ownerId, project.id), 'stable owner cannot access project')
    assert(await getAccessibleProject(collaboratorId, project.id), 'stable collaborator cannot access project')
    assert(!await getAccessibleProject(duplicateAId, project.id), 'duplicate-name user obtained project access')
    assert(!await getAccessibleProject(duplicateBId, project.id), 'second duplicate-name user obtained project access')
    assert(!await getAccessibleProject(disabledId, project.id), 'disabled user obtained project access')

    const unresolvedOwnerProject = await createProject({
      name: `显式身份裁决验收-${marker}`,
      owner: names.missing,
      collaborators: [],
    }, creatorId)
    entityIds.push(unresolvedOwnerProject.id)
    assert(unresolvedOwnerProject.ownerUserId === null, 'missing owner unexpectedly auto-mapped')
    await db.update(identityResolutionIssues).set({
      status: 'resolved', resolvedUserId: ownerId, resolvedAt: new Date(), updatedAt: new Date(),
    }).where(and(
      eq(identityResolutionIssues.entityType, 'project'),
      eq(identityResolutionIssues.entityId, unresolvedOwnerProject.id),
      eq(identityResolutionIssues.fieldName, 'owner'),
      eq(identityResolutionIssues.sourceValue, names.missing),
    ))
    const explicitlyResolved = await updateProject(unresolvedOwnerProject.id, { summary: '触发正常绑定同步' }, creatorId)
    assert(explicitlyResolved.ownerUserId === ownerId, 'explicit source resolution did not survive normal binding synchronization')
    assert(await getAccessibleProject(ownerId, unresolvedOwnerProject.id), 'explicitly resolved owner cannot access project')

    await updateProject(project.id, { ownerUserId: duplicateAId } as never, creatorId)
    const [tamperChecked] = await db.select().from(projects).where(eq(projects.id, project.id)).limit(1)
    assert(tamperChecked.ownerUserId === ownerId, 'derived owner_user_id accepted direct tampering')

    const meeting = await createMeeting({
      projectId: null,
      projectName: '全局身份验收',
      title: `身份会议-${marker}`,
      host: names.owner,
      attendees: [names.collaborator, names.duplicate, names.disabled, names.missing],
    }, [], creatorId)
    entityIds.push(meeting.id)
    assert(meeting.hostUserId === ownerId, 'unique enabled meeting host was not mapped')
    const participants = await db.select().from(meetingParticipants)
      .where(eq(meetingParticipants.meetingId, meeting.id))
    assert(participants.length === 1 && participants[0].userId === collaboratorId, 'meeting participant mapping is unsafe')
    assert(await getMeeting(meeting.id, { uid: ownerId, name: names.owner, role: '投资经理' }), 'stable host cannot access global meeting')
    assert(await getMeeting(meeting.id, { uid: collaboratorId, name: names.collaborator, role: '投资经理' }), 'stable participant cannot access global meeting')
    assert(!await getMeeting(meeting.id, { uid: duplicateAId, name: names.duplicate, role: '投资经理' }), 'duplicate-name user obtained meeting access')

    const todo = await createTodo({
      projectId: null,
      title: `身份待办-${marker}`,
      owner: names.duplicate,
    }, creatorId)
    entityIds.push(todo.id)
    assert(todo.ownerUserId === null, 'duplicate todo owner should remain unresolved')
    assert(!await getTodo(todo.id, { uid: duplicateAId, name: names.duplicate, role: '投资经理' }), 'duplicate-name user obtained todo access')

    const risk = await createRisk({
      projectId: null,
      projectName: '全局身份验收',
      type: '合规',
      title: `身份风险-${marker}`,
      assignee: names.owner,
    }, creatorId)
    entityIds.push(risk.id)
    assert(risk.assigneeUserId === ownerId, 'unique enabled risk assignee was not mapped')
    assert(await getRisk(risk.id, { uid: ownerId, name: names.owner, role: '投资经理' }), 'stable risk assignee cannot access global risk')
    assert(!await getRisk(risk.id, { uid: duplicateAId, name: names.duplicate, role: '投资经理' }), 'unassigned duplicate-name user obtained risk access')

    const issues = await db.select().from(identityResolutionIssues).where(and(
      inArray(identityResolutionIssues.entityId, entityIds),
      eq(identityResolutionIssues.status, 'open'),
    ))
    const reasons = new Set(issues.map((row) => row.reason))
    assert(reasons.has('duplicate_name'), 'duplicate-name conflict was not persisted')
    assert(reasons.has('disabled_user'), 'disabled-user conflict was not persisted')
    assert(reasons.has('missing_user'), 'missing-user conflict was not persisted')

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'unique-enabled-owner-binding', 'stable-project-member-access',
        'duplicate-name-default-deny', 'disabled-user-default-deny',
        'derived-id-tamper-rejection', 'stable-meeting-host-and-participant-access',
        'stable-todo-owner-access', 'stable-risk-assignee-access',
        'persistent-conflict-ledger', 'explicit-source-resolution-persists-through-resync',
      ],
      openIssueCount: issues.length,
    }))
  } finally {
    await db.delete(auditLogs).where(inArray(auditLogs.userId, userIds)).catch(() => {})
    await db.delete(todos).where(inArray(todos.createdBy, userIds)).catch(() => {})
    await db.delete(meetings).where(inArray(meetings.createdBy, userIds)).catch(() => {})
    await db.delete(risks).where(inArray(risks.createdBy, userIds)).catch(() => {})
    await db.delete(projects).where(inArray(projects.createdBy, userIds)).catch(() => {})
    if (entityIds.length) {
      await db.delete(identityResolutionIssues).where(inArray(identityResolutionIssues.entityId, entityIds)).catch(() => {})
    }
    await db.delete(users).where(inArray(users.id, userIds)).catch(() => {})
  }
}

await main().finally(async () => pool.end())
