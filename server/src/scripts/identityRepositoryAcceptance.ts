import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, authSessions, projectMembers, projects, users } from '../db/schema.js'
import { isRepositoryError } from '../repositories/contracts.js'
import { mysqlIdentityRepositories } from '../repositories/mysql/mysqlIdentityRepository.js'
import { createAuthSession, hashPassword } from '../services/authService.js'

async function main() {
  const marker = randomUUID()
  const passwordHash = await hashPassword(`Repository-A9!-${marker}`)
  const fixtureUserIds: string[] = []
  let projectId: string | undefined

  const createFixtureUser = async (label: string, role = '投资经理') => {
    const [row] = await db.insert(users).values({
      email: `repository-${label}-${marker}@example.invalid`,
      name: `${label}-${marker.slice(0, 8)}`,
      role,
      department: 'Repository验收部',
      passwordHash,
    }).$returningId()
    fixtureUserIds.push(row.id)
    return row.id
  }

  try {
    const adminId = await createFixtureUser('admin', '系统管理员')
    const ownerId = await createFixtureUser('owner', '投资总监')
    const collaboratorId = await createFixtureUser('collaborator')

    const committed = await mysqlIdentityRepositories.transaction(async ({ users: userRepository, audits }) => {
      const created = await userRepository.create({
        email: `repository-committed-${marker}@example.invalid`,
        name: `提交用户-${marker.slice(0, 8)}`,
        role: '投资经理',
        department: 'Repository验收部',
        passwordHash,
      })
      await audits.append({
        userId: adminId,
        userName: `admin-${marker.slice(0, 8)}`,
        module: 'Repository验收',
        action: '提交用户事务',
        target: created.id,
      })
      return created
    })
    fixtureUserIds.push(committed.id)
    const committedReload = await mysqlIdentityRepositories.users.findById(committed.id)
    if (!committedReload || committedReload.email !== committed.email) {
      throw new Error('repository transaction did not commit the user')
    }

    const duplicateEmail = `repository-concurrent-${marker}@example.invalid`
    const concurrent = await Promise.allSettled([1, 2].map((attempt) => mysqlIdentityRepositories.users.create({
      email: duplicateEmail,
      name: `并发用户${attempt}-${marker.slice(0, 8)}`,
      role: '投资经理',
      department: 'Repository验收部',
      passwordHash,
    })))
    const successes = concurrent.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof mysqlIdentityRepositories.users.create>>> => result.status === 'fulfilled')
    const failures = concurrent.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (
      successes.length !== 1
      || failures.length !== 1
      || !isRepositoryError(failures[0].reason)
      || failures[0].reason.code !== 'CONFLICT'
    ) throw new Error(`concurrent duplicate user creation did not produce one stable CONFLICT: ${JSON.stringify({
      fulfilled: successes.length,
      rejected: failures.length,
      errorName: failures[0]?.reason?.name,
      errorCode: failures[0]?.reason?.code,
      errorErrno: failures[0]?.reason?.errno,
    })}`)
    fixtureUserIds.push(successes[0].value.id)
    const duplicateRows = await db.select({ id: users.id }).from(users).where(eq(users.email, duplicateEmail))
    if (duplicateRows.length !== 1) throw new Error('concurrent unique-key protection left an invalid row count')

    const rollbackEmail = `repository-rollback-${marker}@example.invalid`
    const rollbackError = await mysqlIdentityRepositories.transaction(async ({ users: userRepository }) => {
      await userRepository.create({
        email: rollbackEmail,
        name: `回滚用户-${marker.slice(0, 8)}`,
        role: '投资经理',
        department: 'Repository验收部',
        passwordHash,
      })
      throw new Error('forced-user-rollback')
    }).then(() => null, (error: unknown) => error as Error)
    if (!rollbackError || !String(rollbackError.message).includes('forced-user-rollback')) {
      throw new Error('forced repository rollback did not surface its cause')
    }
    const rollbackRows = await db.select({ id: users.id }).from(users).where(eq(users.email, rollbackEmail))
    if (rollbackRows.length) throw new Error('failed repository transaction left a partial user row')

    const [project] = await db.insert(projects).values({
      name: `Repository成员项目-${marker}`,
      owner: `admin-${marker.slice(0, 8)}`,
      ownerUserId: adminId,
      collaborators: [],
      createdBy: adminId,
    }).$returningId()
    projectId = project.id
    await db.insert(projectMembers).values({
      projectId: project.id,
      userId: adminId,
      memberRole: 'owner',
      sourceName: `admin-${marker.slice(0, 8)}`,
    })

    await mysqlIdentityRepositories.transaction(async ({ users: userRepository, permissions, audits }) => {
      const locked = await permissions.lockProjectById(project.id)
      const owner = await userRepository.findById(ownerId)
      const collaborator = await userRepository.findById(collaboratorId)
      if (!locked || !owner || !collaborator) throw new Error('permission fixtures cannot be loaded')
      await permissions.replaceProjectMembers({
        projectId: locked.id,
        owner,
        collaborators: [collaborator],
      }, new Date())
      await audits.append({
        userId: adminId,
        userName: `admin-${marker.slice(0, 8)}`,
        module: 'Repository验收',
        action: '提交成员事务',
        target: project.id,
      })
    })
    const committedProject = await mysqlIdentityRepositories.permissions.findProjectById(project.id)
    const committedMembers = await mysqlIdentityRepositories.permissions.listProjectMemberBindings(project.id)
    if (
      committedProject?.ownerUserId !== ownerId
      || committedMembers.length !== 2
      || !committedMembers.some((member) => member.userId === ownerId && member.memberRole === 'owner')
      || !committedMembers.some((member) => member.userId === collaboratorId && member.memberRole === 'collaborator')
    ) throw new Error('permission repository did not atomically replace project membership')

    const memberRollback = await mysqlIdentityRepositories.transaction(async ({ users: userRepository, permissions }) => {
      const originalAdmin = await userRepository.findById(adminId)
      if (!originalAdmin) throw new Error('rollback owner fixture cannot be loaded')
      await permissions.lockProjectById(project.id)
      await permissions.replaceProjectMembers({ projectId: project.id, owner: originalAdmin, collaborators: [] }, new Date())
      throw new Error('forced-membership-rollback')
    }).then(() => null, (error: unknown) => error as Error)
    if (!memberRollback || !String(memberRollback.message).includes('forced-membership-rollback')) {
      throw new Error('forced membership rollback did not surface its cause')
    }
    const afterRollbackProject = await mysqlIdentityRepositories.permissions.findProjectById(project.id)
    const afterRollbackMembers = await mysqlIdentityRepositories.permissions.listProjectMemberBindings(project.id)
    if (
      afterRollbackProject?.ownerUserId !== ownerId
      || afterRollbackMembers.length !== 2
      || !afterRollbackMembers.some((member) => member.userId === collaboratorId)
    ) throw new Error('failed permission transaction changed committed membership')

    await createAuthSession({ userId: committed.id })
    const revokedSessions = await mysqlIdentityRepositories.users.revokeActiveSessions(committed.id, new Date())
    const [activeSession] = await db.select({ id: authSessions.id }).from(authSessions).where(and(
      eq(authSessions.userId, committed.id),
      isNull(authSessions.revokedAt),
    )).limit(1)
    if (revokedSessions !== 1 || activeSession) throw new Error('user repository did not revoke active sessions')

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'repository-contract-commit',
        'concurrent-user-unique-conflict',
        'user-transaction-rollback',
        'permission-atomic-replacement',
        'permission-transaction-rollback',
        'repository-session-revocation',
      ],
    }))
  } finally {
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId))
    if (fixtureUserIds.length) {
      await db.delete(auditLogs).where(inArray(auditLogs.userId, fixtureUserIds))
      await db.delete(authSessions).where(inArray(authSessions.userId, fixtureUserIds))
      await db.delete(users).where(inArray(users.id, fixtureUserIds))
    }
  }
}

await main().finally(async () => pool.end())
