import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import type { AuditRepository, UserRepository } from '../repositories/identityRepository.js'
import {
  departments,
  dictionaryGroups,
  dictionaryItems,
  permissions,
  rolePermissions,
  roles,
  userDepartments,
  userRoles,
} from '../db/schema.js'

export type SystemAdministrator = { userId: string; userName: string }

function adminError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code })
}

async function requireCurrentAdministrator(users: UserRepository, actor: SystemAdministrator) {
  const administrator = await users.lockById(actor.userId)
  if (
    !administrator
    || administrator.status !== '启用'
    || !(await users.listPermissionCodes(administrator.id)).includes('system.manage')
  ) {
    throw adminError(403, 'ROLE_FORBIDDEN', '仅启用的系统管理员可修改系统配置')
  }
  return { id: administrator.id, name: administrator.name }
}

async function appendAudit(
  audits: AuditRepository,
  actor: { id: string; name: string },
  action: string,
  target: unknown,
) {
  await audits.append({
    userId: actor.id,
    userName: actor.name,
    module: '系统管理',
    action,
    target: JSON.stringify(target),
  })
}

export async function listSystemAdministration() {
  const [departmentRows, roleRows, permissionRows, rolePermissionRows, userRoleRows, userDepartmentRows, groupRows, itemRows] = await Promise.all([
    db.select().from(departments).orderBy(asc(departments.sortOrder), asc(departments.name)),
    db.select().from(roles).orderBy(asc(roles.builtIn), asc(roles.name)),
    db.select().from(permissions).orderBy(asc(permissions.module), asc(permissions.code)),
    db.select().from(rolePermissions),
    db.select().from(userRoles),
    db.select().from(userDepartments),
    db.select().from(dictionaryGroups).orderBy(asc(dictionaryGroups.code)),
    db.select().from(dictionaryItems).orderBy(asc(dictionaryItems.groupId), asc(dictionaryItems.sortOrder), asc(dictionaryItems.label)),
  ])
  const roleMemberCounts = new Map<string, number>()
  const departmentMemberCounts = new Map<string, number>()
  for (const row of userRoleRows) roleMemberCounts.set(row.roleId, (roleMemberCounts.get(row.roleId) || 0) + 1)
  for (const row of userDepartmentRows) departmentMemberCounts.set(row.departmentId, (departmentMemberCounts.get(row.departmentId) || 0) + 1)
  const permissionIdsByRole = new Map<string, string[]>()
  for (const row of rolePermissionRows) permissionIdsByRole.set(row.roleId, [...(permissionIdsByRole.get(row.roleId) || []), row.permissionId])
  return {
    departments: departmentRows.map((row) => ({ ...row, memberCount: departmentMemberCounts.get(row.id) || 0 })),
    roles: roleRows.map((row) => ({ ...row, memberCount: roleMemberCounts.get(row.id) || 0, permissionIds: permissionIdsByRole.get(row.id) || [] })),
    permissions: permissionRows,
    dictionaries: groupRows.map((group) => ({ ...group, items: itemRows.filter((item) => item.groupId === group.id) })),
  }
}

export async function createDepartment(input: {
  code: string; name: string; parentId?: string | null; managerUserId?: string | null
  description?: string | null; sortOrder?: number
}, actor: SystemAdministrator) {
  return db.transaction(async (tx) => {
    const identity = createMySqlIdentityRepositoryContext(tx)
    const administrator = await requireCurrentAdministrator(identity.users, actor)
    if (input.parentId) {
      const [parent] = await tx.select({ id: departments.id }).from(departments).where(eq(departments.id, input.parentId)).limit(1)
      if (!parent) throw adminError(400, 'DEPARTMENT_PARENT_INVALID', '上级部门不存在')
    }
    const [created] = await tx.insert(departments).values({
      code: input.code.trim().toUpperCase(), name: input.name.trim(), parentId: input.parentId || null,
      managerUserId: input.managerUserId || null, description: input.description?.trim() || null,
      sortOrder: input.sortOrder ?? 0,
    }).$returningId()
    await appendAudit(identity.audits, administrator, '创建部门', { departmentId: created.id, code: input.code, name: input.name })
    const [row] = await tx.select().from(departments).where(eq(departments.id, created.id)).limit(1)
    return { ...row!, memberCount: 0 }
  })
}

export async function updateDepartment(id: string, input: {
  name?: string; parentId?: string | null; managerUserId?: string | null; description?: string | null
  status?: '启用' | '禁用'; sortOrder?: number; expectedVersion: number
}, actor: SystemAdministrator) {
  return db.transaction(async (tx) => {
    const identity = createMySqlIdentityRepositoryContext(tx)
    const administrator = await requireCurrentAdministrator(identity.users, actor)
    const [current] = await tx.select().from(departments).where(eq(departments.id, id)).limit(1).for('update')
    if (!current) throw adminError(404, 'DEPARTMENT_NOT_FOUND', '部门不存在')
    if (current.version !== input.expectedVersion) throw adminError(409, 'VERSION_CONFLICT', '部门已被其他管理员修改，请刷新后重试')
    if (input.parentId === id) throw adminError(400, 'DEPARTMENT_CYCLE', '部门不能成为自己的上级')
    if (input.parentId) {
      const all = await tx.select({ id: departments.id, parentId: departments.parentId }).from(departments)
      const parents = new Map(all.map((row) => [row.id, row.parentId]))
      let cursor: string | null = input.parentId
      while (cursor) {
        if (cursor === id) throw adminError(400, 'DEPARTMENT_CYCLE', '不能把部门移动到其下级部门')
        cursor = parents.get(cursor) || null
      }
    }
    await tx.update(departments).set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId || null } : {}),
      ...(input.managerUserId !== undefined ? { managerUserId: input.managerUserId || null } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      version: current.version + 1, updatedAt: new Date(),
    }).where(and(eq(departments.id, id), eq(departments.version, input.expectedVersion)))
    await appendAudit(identity.audits, administrator, '更新部门', { departmentId: id, before: current, patch: input })
    const [row] = await tx.select().from(departments).where(eq(departments.id, id)).limit(1)
    const members = await tx.select({ userId: userDepartments.userId }).from(userDepartments).where(eq(userDepartments.departmentId, id))
    return { ...row!, memberCount: members.length }
  })
}

export async function createRole(input: {
  code: string; name: string; description?: string | null; dataScope: 'self' | 'department' | 'all'; permissionIds?: string[]
}, actor: SystemAdministrator) {
  if (input.name.trim().length > 32) throw adminError(400, 'ROLE_NAME_TOO_LONG', '角色名称不能超过 32 个字符')
  return db.transaction(async (tx) => {
    const identity = createMySqlIdentityRepositoryContext(tx)
    const administrator = await requireCurrentAdministrator(identity.users, actor)
    const permissionIds = [...new Set(input.permissionIds || [])]
    if (permissionIds.length) {
      const valid = await tx.select({ id: permissions.id }).from(permissions).where(inArray(permissions.id, permissionIds))
      if (valid.length !== permissionIds.length) throw adminError(400, 'PERMISSION_INVALID', '包含不存在的权限项')
    }
    const [created] = await tx.insert(roles).values({
      code: input.code.trim().toUpperCase(), name: input.name.trim(), description: input.description?.trim() || null,
      dataScope: input.dataScope, builtIn: false,
    }).$returningId()
    if (permissionIds.length) await tx.insert(rolePermissions).values(permissionIds.map((permissionId) => ({ roleId: created.id, permissionId })))
    await appendAudit(identity.audits, administrator, '创建角色', { roleId: created.id, code: input.code, permissionIds })
    const [row] = await tx.select().from(roles).where(eq(roles.id, created.id)).limit(1)
    return { ...row!, memberCount: 0, permissionIds }
  })
}

export async function updateRole(id: string, input: {
  name?: string; description?: string | null; dataScope?: 'self' | 'department' | 'all'; status?: '启用' | '禁用'
  permissionIds?: string[]; expectedVersion: number
}, actor: SystemAdministrator) {
  if (input.name && input.name.trim().length > 32) throw adminError(400, 'ROLE_NAME_TOO_LONG', '角色名称不能超过 32 个字符')
  return db.transaction(async (tx) => {
    const identity = createMySqlIdentityRepositoryContext(tx)
    const administrator = await requireCurrentAdministrator(identity.users, actor)
    const [current] = await tx.select().from(roles).where(eq(roles.id, id)).limit(1).for('update')
    if (!current) throw adminError(404, 'ROLE_NOT_FOUND', '角色不存在')
    if (current.version !== input.expectedVersion) throw adminError(409, 'VERSION_CONFLICT', '角色已被其他管理员修改，请刷新后重试')
    if (current.name === '系统管理员' && input.status === '禁用') throw adminError(409, 'SYSTEM_ADMIN_ROLE_REQUIRED', '系统管理员角色不能停用')
    const permissionIds = input.permissionIds ? [...new Set(input.permissionIds)] : undefined
    if (permissionIds) {
      const valid = permissionIds.length ? await tx.select({ id: permissions.id }).from(permissions).where(inArray(permissions.id, permissionIds)) : []
      if (valid.length !== permissionIds.length) throw adminError(400, 'PERMISSION_INVALID', '包含不存在的权限项')
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id))
      if (permissionIds.length) await tx.insert(rolePermissions).values(permissionIds.map((permissionId) => ({ roleId: id, permissionId })))
    }
    await tx.update(roles).set({
      ...(input.name !== undefined && !current.builtIn ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      ...(input.dataScope !== undefined ? { dataScope: input.dataScope } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      version: current.version + 1, updatedAt: new Date(),
    }).where(and(eq(roles.id, id), eq(roles.version, input.expectedVersion)))
    await appendAudit(identity.audits, administrator, '更新角色权限', { roleId: id, beforeVersion: current.version, patch: input })
    const [row] = await tx.select().from(roles).where(eq(roles.id, id)).limit(1)
    const bindings = await tx.select({ permissionId: rolePermissions.permissionId }).from(rolePermissions).where(eq(rolePermissions.roleId, id))
    const members = await tx.select({ userId: userRoles.userId }).from(userRoles).where(eq(userRoles.roleId, id))
    return { ...row!, memberCount: members.length, permissionIds: bindings.map((item) => item.permissionId) }
  })
}

export async function createDictionaryGroup(input: { code: string; name: string; description?: string | null }, actor: SystemAdministrator) {
  return db.transaction(async (tx) => {
    const identity = createMySqlIdentityRepositoryContext(tx)
    const administrator = await requireCurrentAdministrator(identity.users, actor)
    const [created] = await tx.insert(dictionaryGroups).values({
      code: input.code.trim().toUpperCase(), name: input.name.trim(), description: input.description?.trim() || null,
    }).$returningId()
    await appendAudit(identity.audits, administrator, '创建数据字典', { groupId: created.id, code: input.code })
    const [row] = await tx.select().from(dictionaryGroups).where(eq(dictionaryGroups.id, created.id)).limit(1)
    return { ...row!, items: [] }
  })
}

export async function updateDictionaryGroup(id: string, input: {
  name?: string; description?: string | null; status?: '启用' | '禁用'; expectedVersion: number
}, actor: SystemAdministrator) {
  return db.transaction(async (tx) => {
    const identity = createMySqlIdentityRepositoryContext(tx)
    const administrator = await requireCurrentAdministrator(identity.users, actor)
    const [current] = await tx.select().from(dictionaryGroups).where(eq(dictionaryGroups.id, id)).limit(1).for('update')
    if (!current) throw adminError(404, 'DICTIONARY_GROUP_NOT_FOUND', '字典分组不存在')
    if (current.version !== input.expectedVersion) throw adminError(409, 'VERSION_CONFLICT', '字典分组已被修改，请刷新后重试')
    await tx.update(dictionaryGroups).set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      version: current.version + 1, updatedAt: new Date(),
    }).where(and(eq(dictionaryGroups.id, id), eq(dictionaryGroups.version, input.expectedVersion)))
    await appendAudit(identity.audits, administrator, '更新数据字典', { groupId: id, beforeVersion: current.version, patch: input })
    const [row] = await tx.select().from(dictionaryGroups).where(eq(dictionaryGroups.id, id)).limit(1)
    const items = await tx.select().from(dictionaryItems).where(eq(dictionaryItems.groupId, id)).orderBy(asc(dictionaryItems.sortOrder))
    return { ...row!, items }
  })
}

export async function createDictionaryItem(groupId: string, input: {
  value: string; label: string; sortOrder?: number
}, actor: SystemAdministrator) {
  return db.transaction(async (tx) => {
    const identity = createMySqlIdentityRepositoryContext(tx)
    const administrator = await requireCurrentAdministrator(identity.users, actor)
    const [group] = await tx.select({ id: dictionaryGroups.id }).from(dictionaryGroups).where(eq(dictionaryGroups.id, groupId)).limit(1).for('update')
    if (!group) throw adminError(404, 'DICTIONARY_GROUP_NOT_FOUND', '字典分组不存在')
    const [created] = await tx.insert(dictionaryItems).values({
      groupId, value: input.value.trim(), label: input.label.trim(), sortOrder: input.sortOrder ?? 0,
    }).$returningId()
    await appendAudit(identity.audits, administrator, '新增字典项', { groupId, itemId: created.id, value: input.value })
    const [row] = await tx.select().from(dictionaryItems).where(eq(dictionaryItems.id, created.id)).limit(1)
    return row!
  })
}

export async function updateDictionaryItem(id: string, input: {
  label?: string; sortOrder?: number; status?: '启用' | '禁用'; expectedVersion: number
}, actor: SystemAdministrator) {
  return db.transaction(async (tx) => {
    const identity = createMySqlIdentityRepositoryContext(tx)
    const administrator = await requireCurrentAdministrator(identity.users, actor)
    const [current] = await tx.select().from(dictionaryItems).where(eq(dictionaryItems.id, id)).limit(1).for('update')
    if (!current) throw adminError(404, 'DICTIONARY_ITEM_NOT_FOUND', '字典项不存在')
    if (current.version !== input.expectedVersion) throw adminError(409, 'VERSION_CONFLICT', '字典项已被修改，请刷新后重试')
    await tx.update(dictionaryItems).set({
      ...(input.label !== undefined ? { label: input.label.trim() } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      version: current.version + 1, updatedAt: new Date(),
    }).where(and(eq(dictionaryItems.id, id), eq(dictionaryItems.version, input.expectedVersion)))
    await appendAudit(identity.audits, administrator, '更新字典项', { itemId: id, beforeVersion: current.version, patch: input })
    const [row] = await tx.select().from(dictionaryItems).where(eq(dictionaryItems.id, id)).limit(1)
    return row!
  })
}
