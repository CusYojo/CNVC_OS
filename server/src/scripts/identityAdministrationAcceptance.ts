import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { authSessions, auditLogs, projectMembers, projects, users } from '../db/schema.js'
import { createAuthSession, hashPassword } from '../services/authService.js'
import { identityRepositories } from '../repositories/index.js'
import {
  createManagedUser,
  replaceProjectMembers,
  updateManagedUser,
} from '../services/identityAdministrationService.js'

async function expectCode(operation: Promise<unknown>, code: string) {
  const error = await operation.then(() => null, (caught: unknown) => caught as { code?: string })
  if (error?.code !== code) throw new Error(`expected ${code}, got ${error?.code || 'success'}`)
}

async function main() {
  const marker = randomUUID()
  const adminName = `身份管理员-${marker.slice(0, 8)}`
  const passwordHash = await hashPassword(`Fixture-A9!-${marker}`)
  const [admin] = await db.insert(users).values({
    email: `identity-admin-${marker}@example.invalid`, name: adminName,
    role: '系统管理员', department: '投资部', passwordHash,
  }).$returningId()
  const [ordinary] = await db.insert(users).values({
    email: `identity-user-${marker}@example.invalid`, name: `普通用户-${marker.slice(0, 8)}`,
    role: '投资经理', department: '投资部', passwordHash,
  }).$returningId()
  const [owner] = await db.insert(users).values({
    email: `identity-owner-${marker}@example.invalid`, name: `负责人-${marker.slice(0, 8)}`,
    role: '投资总监', department: '投资部', passwordHash,
  }).$returningId()
  const [collaborator] = await db.insert(users).values({
    email: `identity-collaborator-${marker}@example.invalid`, name: `协作成员-${marker.slice(0, 8)}`,
    role: '投资经理', department: '投资部', passwordHash,
  }).$returningId()
  const fixtureUserIds = [admin.id, ordinary.id, owner.id, collaborator.id]
  let createdUserId: string | undefined
  let projectId: string | undefined
  const adminActor = { userId: admin.id, userName: adminName }

  try {
    await identityRepositories.transaction(async ({ users: userRepository }) => {
      await userRepository.synchronizeAdministrationBindings(admin.id, '系统管理员', '投资部')
      await userRepository.synchronizeAdministrationBindings(ordinary.id, '投资经理', '投资部')
      await userRepository.synchronizeAdministrationBindings(owner.id, '投资总监', '投资部')
      await userRepository.synchronizeAdministrationBindings(collaborator.id, '投资经理', '投资部')
    })
    await expectCode(createManagedUser({
      email: `denied-${marker}@example.invalid`, name: '越权创建', role: '投资经理',
      department: '投资部', password: `Denied-A9!-${marker}`,
    }, { userId: ordinary.id, userName: '普通用户' }), 'ROLE_FORBIDDEN')

    const initialPassword = `Created-A9!-${marker}`
    const created = await createManagedUser({
      email: `identity-created-${marker}@example.invalid`, name: `新用户-${marker.slice(0, 8)}`,
      role: '投资经理', department: '投资部', password: initialPassword,
    }, adminActor)
    createdUserId = created.id
    fixtureUserIds.push(created.id)
    await createAuthSession({ userId: created.id })
    const updated = await updateManagedUser(created.id, {
      role: '风控与法务', department: '风险与合规', status: '禁用',
    }, adminActor)
    if (updated.role !== '风控与法务' || updated.department !== '风险与合规' || updated.status !== '禁用') {
      throw new Error('user identity update was not persisted')
    }
    const [session] = await db.select({ revokedAt: authSessions.revokedAt }).from(authSessions)
      .where(eq(authSessions.userId, created.id)).limit(1)
    if (!session?.revokedAt) throw new Error('identity change did not revoke the active session')
    await expectCode(updateManagedUser(admin.id, { status: '禁用' }, adminActor), 'ADMIN_SELF_LOCKOUT')

    const [project] = await db.insert(projects).values({
      name: `成员审计项目-${marker}`, owner: `旧负责人-${marker.slice(0, 8)}`,
      collaborators: [], createdBy: admin.id,
    }).$returningId()
    projectId = project.id
    await expectCode(replaceProjectMembers({
      projectId: project.id, ownerUserId: owner.id, collaboratorUserIds: [collaborator.id],
    }, { userId: ordinary.id, userName: '普通用户' }), 'ROLE_FORBIDDEN')
    const membership = await replaceProjectMembers({
      projectId: project.id,
      ownerUserId: owner.id,
      collaboratorUserIds: [collaborator.id, collaborator.id, owner.id],
    }, adminActor)
    if (membership.owner.userId !== owner.id || membership.collaborators.length !== 1) {
      throw new Error('project membership normalization failed')
    }
    const [persistedProject] = await db.select({
      owner: projects.owner, ownerUserId: projects.ownerUserId, collaborators: projects.collaborators,
    }).from(projects).where(eq(projects.id, project.id)).limit(1)
    const persistedMembers = await db.select({ userId: projectMembers.userId, memberRole: projectMembers.memberRole })
      .from(projectMembers).where(eq(projectMembers.projectId, project.id))
    if (
      persistedProject?.ownerUserId !== owner.id
      || persistedProject.owner !== `负责人-${marker.slice(0, 8)}`
      || persistedMembers.length !== 2
      || !persistedMembers.some((member) => member.userId === owner.id && member.memberRole === 'owner')
      || !persistedMembers.some((member) => member.userId === collaborator.id && member.memberRole === 'collaborator')
    ) throw new Error('project membership authority tables are inconsistent')

    const logs = await db.select().from(auditLogs).where(and(
      eq(auditLogs.userId, admin.id),
      inArray(auditLogs.action, ['创建用户', '更新用户身份', '更新项目成员']),
    ))
    if (logs.length !== 3 || logs.some((log) => log.userName !== adminName || !log.requestId)) {
      throw new Error('identity administration audit trail is incomplete')
    }
    const serializedLogs = JSON.stringify(logs)
    if (serializedLogs.includes(initialPassword) || !serializedLogs.includes(created.id) || !serializedLogs.includes(project.id)) {
      throw new Error('identity audit target is missing identifiers or contains a password')
    }
    console.log(JSON.stringify({
      ok: true,
      checks: [
        'current-admin-revalidation', 'non-admin-user-mutation-denial', 'strong-password-user-creation',
        'role-department-status-update', 'identity-change-session-revocation', 'admin-self-lockout-prevention',
        'non-admin-membership-denial', 'stable-project-member-replacement', 'actor-target-request-audit',
        'audit-secret-exclusion',
      ],
    }))
  } finally {
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId))
    await db.delete(auditLogs).where(inArray(auditLogs.userId, fixtureUserIds))
    await db.delete(authSessions).where(inArray(authSessions.userId, fixtureUserIds))
    await db.delete(users).where(inArray(users.id, fixtureUserIds))
  }
}

await main().finally(async () => pool.end())
