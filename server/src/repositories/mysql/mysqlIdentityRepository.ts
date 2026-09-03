import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import {
  auditLogs,
  authSessions,
  departments,
  permissions,
  projectMembers,
  projects,
  roles,
  rolePermissions,
  userDepartments,
  userRoles,
  users,
} from '../../db/schema.js'
import { isMySqlDriverError, isRepositoryError, mapMySqlRepositoryError } from '../contracts.js'
import type {
  AuditRecord,
  AuditRepository,
  CreateUserRecord,
  IdentityRepositoryContext,
  IdentityRepositoryProvider,
  PermissionRepository,
  ProjectIdentityRecord,
  ProjectMemberBinding,
  ProjectMemberView,
  ReplaceProjectMemberBindings,
  UpdateUserRecord,
  UserRecord,
  UserRepository,
} from '../identityRepository.js'

export type MySqlIdentityExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function mapped<T>(operation: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (isRepositoryError(error)) throw error
    if (isMySqlDriverError(error)) {
      throw mapMySqlRepositoryError(error, operation)
    }
    throw error
  }
}

class MySqlUserRepository implements UserRepository {
  constructor(private readonly executor: MySqlIdentityExecutor) {}

  async findById(userId: string): Promise<UserRecord | null> {
    return mapped('user.findById', async () => {
      const [row] = await this.executor.select().from(users).where(eq(users.id, userId)).limit(1)
      return row ?? null
    })
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return mapped('user.findByEmail', async () => {
      const [row] = await this.executor.select().from(users).where(eq(users.email, email)).limit(1)
      return row ?? null
    })
  }

  async findManyByIds(userIds: string[]): Promise<UserRecord[]> {
    if (!userIds.length) return []
    return mapped('user.findManyByIds', () => this.executor.select().from(users).where(inArray(users.id, userIds)))
  }

  async findByTrimmedName(name: string, limit = 3): Promise<UserRecord[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
    return mapped('user.findByTrimmedName', () => this.executor.select().from(users)
      .where(sql<boolean>`TRIM(${users.name}) = ${name}`)
      .orderBy(asc(users.id))
      .limit(boundedLimit))
  }

  async findEnabledByRoles(roles: string[]): Promise<UserRecord[]> {
    if (!roles.length) return []
    return mapped('user.findEnabledByRoles', () => this.executor.select().from(users).where(and(
      eq(users.status, '启用'),
      inArray(users.role, roles),
    )).orderBy(asc(users.name), asc(users.id)))
  }

  async isActiveRoleName(name: string): Promise<boolean> {
    return mapped('user.isActiveRoleName', async () => {
      const [row] = await this.executor.select({ id: roles.id }).from(roles).where(and(
        eq(roles.name, name.trim()),
        eq(roles.status, '启用'),
      )).limit(1)
      return !!row
    })
  }

  async isActiveDepartmentName(name: string): Promise<boolean> {
    return mapped('user.isActiveDepartmentName', async () => {
      const [row] = await this.executor.select({ id: departments.id }).from(departments).where(and(
        eq(departments.name, name.trim()),
        eq(departments.status, '启用'),
      )).limit(1)
      return !!row
    })
  }

  async listPermissionCodes(userId: string): Promise<string[]> {
    return mapped('user.listPermissionCodes', async () => {
      const rows = await this.executor.select({ code: permissions.code })
        .from(userRoles)
        .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.status, '启用')))
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(eq(userRoles.userId, userId))
        .orderBy(asc(permissions.code))
      return [...new Set(rows.map((row) => row.code))]
    })
  }

  async roleHasPermission(roleName: string, permissionCode: string): Promise<boolean> {
    return mapped('user.roleHasPermission', async () => {
      const [row] = await this.executor.select({ id: roles.id })
        .from(roles)
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(and(
          eq(roles.name, roleName.trim()),
          eq(roles.status, '启用'),
          eq(permissions.code, permissionCode),
        ))
        .limit(1)
      return !!row
    })
  }

  async listSafe() {
    return mapped('user.listSafe', () => this.executor.select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      department: users.department,
      status: users.status,
      lastLogin: users.lastLogin,
      createdAt: users.createdAt,
    }).from(users).orderBy(asc(users.email), asc(users.id)))
  }

  async lockById(userId: string): Promise<UserRecord | null> {
    return mapped('user.lockById', async () => {
      await this.executor.execute(sql`SELECT ${users.id} FROM ${users} WHERE ${users.id}=${userId} FOR UPDATE`)
      return this.findById(userId)
    })
  }

  async create(input: CreateUserRecord): Promise<UserRecord> {
    return mapped('user.create', async () => {
      const [inserted] = await this.executor.insert(users).values(input).$returningId()
      const created = await this.findById(inserted.id)
      if (!created) throw new Error('created user cannot be reloaded')
      return created
    })
  }

  async update(userId: string, patch: UpdateUserRecord): Promise<UserRecord | null> {
    return mapped('user.update', async () => {
      await this.executor.update(users).set(patch).where(eq(users.id, userId))
      return this.findById(userId)
    })
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<boolean> {
    return mapped('user.updatePasswordHash', async () => {
      const [updated] = await this.executor.update(users).set({ passwordHash }).where(eq(users.id, userId))
      return updated.affectedRows === 1
    })
  }

  async touchLastLogin(userId: string, at: Date): Promise<void> {
    await mapped('user.touchLastLogin', async () => {
      await this.executor.update(users).set({ lastLogin: at }).where(eq(users.id, userId))
    })
  }

  async revokeActiveSessions(userId: string, at: Date): Promise<number> {
    return mapped('user.revokeActiveSessions', async () => {
      const [revoked] = await this.executor.update(authSessions).set({ revokedAt: at, updatedAt: at })
        .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
      return revoked.affectedRows
    })
  }

  async synchronizeAdministrationBindings(userId: string, roleName: string, departmentName: string): Promise<void> {
    await mapped('user.synchronizeAdministrationBindings', async () => {
      let [role] = await this.executor.select({ id: roles.id }).from(roles).where(eq(roles.name, roleName)).limit(1)
      if (!role) {
        const [created] = await this.executor.insert(roles).values({
          code: `LEGACY_${Buffer.from(roleName).toString('hex').slice(0, 48).toUpperCase()}`,
          name: roleName,
          description: '由身份管理接口自动建立的兼容角色',
          builtIn: true,
        }).$returningId()
        role = created
      }
      let [department] = await this.executor.select({ id: departments.id }).from(departments)
        .where(eq(departments.name, departmentName)).limit(1)
      if (!department) {
        const [created] = await this.executor.insert(departments).values({
          code: `LEGACY_${Buffer.from(departmentName).toString('hex').slice(0, 48).toUpperCase()}`,
          name: departmentName,
        }).$returningId()
        department = created
      }
      // 旧主角色字段的编辑不能清除 FDE 明确授予的附加业务角色。
      await this.executor.delete(userRoles).where(and(eq(userRoles.userId, userId), eq(userRoles.isPrimary, true)))
      await this.executor.insert(userRoles).values({ userId, roleId: role.id, isPrimary: true }).onDuplicateKeyUpdate({ set: { isPrimary: true } })
      await this.executor.delete(userDepartments).where(eq(userDepartments.userId, userId))
      await this.executor.insert(userDepartments).values({ userId, departmentId: department.id, isPrimary: true })
    })
  }
}

class MySqlPermissionRepository implements PermissionRepository {
  constructor(private readonly executor: MySqlIdentityExecutor) {}

  async findProjectById(projectId: string): Promise<ProjectIdentityRecord | null> {
    return mapped('permission.findProjectById', async () => {
      const [row] = await this.executor.select({
        id: projects.id,
        name: projects.name,
        owner: projects.owner,
        ownerUserId: projects.ownerUserId,
        collaborators: projects.collaborators,
        createdBy: projects.createdBy,
        workflowModel: projects.workflowModel,
      }).from(projects).where(eq(projects.id, projectId)).limit(1)
      return row ?? null
    })
  }

  async lockProjectById(projectId: string): Promise<ProjectIdentityRecord | null> {
    return mapped('permission.lockProjectById', async () => {
      await this.executor.execute(sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id}=${projectId} FOR UPDATE`)
      return this.findProjectById(projectId)
    })
  }

  async listProjectMembers(projectId: string): Promise<ProjectMemberView[]> {
    return mapped('permission.listProjectMembers', () => this.executor.select({
      userId: projectMembers.userId,
      name: users.name,
      email: users.email,
      role: users.role,
      memberRole: projectMembers.memberRole,
      status: users.status,
    }).from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId)))
  }

  async listProjectMemberBindings(projectId: string): Promise<ProjectMemberBinding[]> {
    return mapped('permission.listProjectMemberBindings', () => this.executor.select({
      userId: projectMembers.userId,
      memberRole: projectMembers.memberRole,
    }).from(projectMembers).where(eq(projectMembers.projectId, projectId)))
  }

  async replaceProjectMembers(input: ReplaceProjectMemberBindings, at: Date): Promise<void> {
    await mapped('permission.replaceProjectMembers', async () => {
      await this.executor.update(projects).set({
        owner: input.owner.name,
        ownerUserId: input.owner.id,
        collaborators: input.collaborators.map((member) => member.name),
        updatedAt: at,
      }).where(eq(projects.id, input.projectId))
      await this.executor.delete(projectMembers).where(eq(projectMembers.projectId, input.projectId))
      await this.executor.insert(projectMembers).values([
        { projectId: input.projectId, userId: input.owner.id, memberRole: 'owner', sourceName: input.owner.name },
        ...input.collaborators.map((member) => ({
          projectId: input.projectId,
          userId: member.id,
          memberRole: 'collaborator',
          sourceName: member.name,
        })),
      ])
    })
  }
}

class MySqlAuditRepository implements AuditRepository {
  constructor(private readonly executor: MySqlIdentityExecutor) {}

  async append(record: AuditRecord): Promise<void> {
    await mapped('audit.append', async () => {
      await this.executor.insert(auditLogs).values(record)
    })
  }
}

export function createMySqlIdentityRepositoryContext(
  executor: MySqlIdentityExecutor,
): IdentityRepositoryContext {
  return {
    users: new MySqlUserRepository(executor),
    permissions: new MySqlPermissionRepository(executor),
    audits: new MySqlAuditRepository(executor),
  }
}

const rootContext = createMySqlIdentityRepositoryContext(db as unknown as MySqlIdentityExecutor)

export const mysqlIdentityRepositories: IdentityRepositoryProvider = {
  ...rootContext,
  async transaction<T>(work: (repositories: IdentityRepositoryContext) => Promise<T>): Promise<T> {
    return mapped('identity.transaction', () => db.transaction((tx) => work(createMySqlIdentityRepositoryContext(tx))))
  },
}
