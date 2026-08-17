import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  auditLogs,
  departments,
  dictionaryGroups,
  dictionaryItems,
  permissions,
  rolePermissions,
  roles,
  userDepartments,
  userRoles,
  users,
} from '../db/schema.js'
import { hashPassword } from '../services/authService.js'
import { identityRepositories } from '../repositories/index.js'
import { createManagedUser, updateManagedUser } from '../services/identityAdministrationService.js'
import {
  createDepartment,
  createDictionaryGroup,
  createDictionaryItem,
  createRole,
  listSystemAdministration,
  updateDepartment,
  updateDictionaryItem,
  updateRole,
} from '../services/systemAdministrationService.js'

async function expectCode(operation: Promise<unknown>, code: string) {
  const error = await operation.then(() => null, (caught: unknown) => caught as { code?: string })
  if (error?.code !== code) throw new Error(`expected ${code}, got ${error?.code || 'success'}`)
}

async function main() {
  const marker = randomUUID()
  const suffix = marker.replaceAll('-', '').slice(0, 12).toUpperCase()
  const passwordHash = await hashPassword(`System-Accept-A9!-${marker}`)
  const [administrator] = await db.insert(users).values({
    email: `system-admin-${marker}@example.invalid`,
    name: `系统管理验收-${suffix}`,
    role: '系统管理员',
    department: '投资部',
    passwordHash,
  }).$returningId()
  const [ordinary] = await db.insert(users).values({
    email: `system-user-${marker}@example.invalid`,
    name: `普通验收-${suffix}`,
    role: '投资经理',
    department: '投资部',
    passwordHash,
  }).$returningId()
  const actor = { userId: administrator.id, userName: `系统管理验收-${suffix}` }
  const createdUserIds = [administrator.id, ordinary.id]
  const departmentIds: string[] = []
  const roleIds: string[] = []
  const dictionaryGroupIds: string[] = []
  let report: { ok: true; checks: string[] } | null = null

  try {
    await identityRepositories.transaction(async ({ users: userRepository }) => {
      await userRepository.synchronizeAdministrationBindings(administrator.id, '系统管理员', '投资部')
      await userRepository.synchronizeAdministrationBindings(ordinary.id, '投资经理', '投资部')
    })
    await expectCode(createRole({
      code: `DENIED_${suffix}`, name: `越权角色-${suffix}`, dataScope: 'self',
    }, { userId: ordinary.id, userName: `普通验收-${suffix}` }), 'ROLE_FORBIDDEN')

    const departmentA = await createDepartment({
      code: `DEPT_A_${suffix}`, name: `验收甲部-${suffix}`, sortOrder: 901,
    }, actor)
    departmentIds.push(departmentA.id)
    const departmentB = await createDepartment({
      code: `DEPT_B_${suffix}`, name: `验收乙部-${suffix}`, parentId: departmentA.id, sortOrder: 902,
    }, actor)
    departmentIds.push(departmentB.id)
    await expectCode(updateDepartment(departmentA.id, {
      parentId: departmentB.id, expectedVersion: departmentA.version,
    }, actor), 'DEPARTMENT_CYCLE')
    await expectCode(updateDepartment(departmentA.id, {
      name: `过期更新-${suffix}`, expectedVersion: departmentA.version + 1,
    }, actor), 'VERSION_CONFLICT')

    const [permission] = await db.select({ id: permissions.id }).from(permissions)
      .where(eq(permissions.code, 'system.manage')).limit(1)
    if (!permission) throw new Error('seeded permission catalog is empty')
    const roleA = await createRole({
      code: `ROLE_A_${suffix}`, name: `验收角色甲-${suffix}`, dataScope: 'self', permissionIds: [permission.id],
    }, actor)
    roleIds.push(roleA.id)
    const roleB = await createRole({
      code: `ROLE_B_${suffix}`, name: `验收角色乙-${suffix}`, dataScope: 'department', permissionIds: [],
    }, actor)
    roleIds.push(roleB.id)
    const updatedRole = await updateRole(roleA.id, {
      description: '事务与乐观锁验收', dataScope: 'all', permissionIds: [permission.id], expectedVersion: roleA.version,
    }, actor)
    if (updatedRole.version !== roleA.version + 1 || updatedRole.permissionIds.length !== 1) {
      throw new Error('role version or permission binding did not persist')
    }

    const createdUser = await createManagedUser({
      email: `bound-user-${marker}@example.invalid`,
      name: `绑定用户-${suffix}`,
      role: roleA.name,
      department: departmentA.name,
      password: `Created-System-A9!-${marker}`,
    }, actor)
    createdUserIds.push(createdUser.id)
    const initialRoleBindings = await db.select().from(userRoles).where(eq(userRoles.userId, createdUser.id))
    const initialDepartmentBindings = await db.select().from(userDepartments).where(eq(userDepartments.userId, createdUser.id))
    if (
      initialRoleBindings.length !== 1 || initialRoleBindings[0]?.roleId !== roleA.id || !initialRoleBindings[0].isPrimary
      || initialDepartmentBindings.length !== 1 || initialDepartmentBindings[0]?.departmentId !== departmentA.id
      || !initialDepartmentBindings[0].isPrimary
    ) throw new Error('new user and administration bindings were not committed together')

    const delegatedActor = { userId: createdUser.id, userName: createdUser.name }
    const delegatedDepartment = await createDepartment({
      code: `DEPT_C_${suffix}`, name: `验收授权部-${suffix}`, sortOrder: 904,
    }, delegatedActor)
    departmentIds.push(delegatedDepartment.id)

    await updateManagedUser(createdUser.id, { role: roleB.name, department: departmentB.name }, actor)
    const updatedRoleBindings = await db.select().from(userRoles).where(eq(userRoles.userId, createdUser.id))
    const updatedDepartmentBindings = await db.select().from(userDepartments).where(eq(userDepartments.userId, createdUser.id))
    if (
      updatedRoleBindings.length !== 1 || updatedRoleBindings[0]?.roleId !== roleB.id
      || updatedDepartmentBindings.length !== 1 || updatedDepartmentBindings[0]?.departmentId !== departmentB.id
    ) throw new Error('user update and administration binding replacement diverged')
    await expectCode(createDepartment({
      code: `DEPT_REVOKED_${suffix}`, name: `权限已撤销-${suffix}`,
    }, delegatedActor), 'ROLE_FORBIDDEN')

    const group = await createDictionaryGroup({
      code: `DICT_${suffix}`, name: `验收字典-${suffix}`,
    }, actor)
    dictionaryGroupIds.push(group.id)
    const item = await createDictionaryItem(group.id, {
      value: `VALUE_${suffix}`, label: `验收值-${suffix}`, sortOrder: 903,
    }, actor)
    const updatedItem = await updateDictionaryItem(item.id, {
      label: `验收值已更新-${suffix}`, status: '禁用', expectedVersion: item.version,
    }, actor)
    if (updatedItem.version !== item.version + 1 || updatedItem.status !== '禁用') {
      throw new Error('dictionary item optimistic update did not persist')
    }

    const snapshot = await listSystemAdministration()
    if (
      !snapshot.departments.some((row) => row.id === departmentB.id && row.memberCount === 1)
      || !snapshot.roles.some((row) => row.id === roleB.id && row.memberCount === 1)
      || !snapshot.dictionaries.some((row) => row.id === group.id && row.items.some((entry) => entry.id === item.id))
    ) throw new Error('system administration list does not reflect authoritative bindings')

    const logs = await db.select().from(auditLogs).where(and(
      eq(auditLogs.userId, administrator.id),
      inArray(auditLogs.module, ['系统管理', '身份与访问']),
    ))
    const requiredActions = new Set([
      '创建部门', '创建角色', '更新角色权限', '创建用户', '更新用户身份', '创建数据字典', '新增字典项', '更新字典项',
    ])
    for (const action of requiredActions) {
      if (!logs.some((row) => row.action === action)) throw new Error(`missing audit action: ${action}`)
    }
    const serializedLogs = JSON.stringify(logs)
    if (serializedLogs.includes(`Created-System-A9!-${marker}`) || logs.some((row) => !row.requestId)) {
      throw new Error('system administration audit contains a secret or lacks request correlation')
    }

    report = {
      ok: true,
      checks: [
        'non-admin-write-denied',
        'department-cycle-and-version-conflict-rejected',
        'role-permissions-and-version-persisted',
        'user-create-and-primary-bindings-atomic',
        'database-system-permission-grant-authorizes-admin-write',
        'user-update-replaces-primary-bindings-atomically',
        'database-permission-revocation-denies-admin-write',
        'dictionary-write-and-optimistic-version-persisted',
        'authoritative-administration-list-reflects-memberships',
        'request-correlated-secret-free-audit-trail',
      ],
    }
  } finally {
    await db.delete(auditLogs).where(inArray(auditLogs.userId, createdUserIds))
    await db.delete(users).where(inArray(users.id, createdUserIds))
    if (dictionaryGroupIds.length) {
      await db.delete(dictionaryItems).where(inArray(dictionaryItems.groupId, dictionaryGroupIds))
      await db.delete(dictionaryGroups).where(inArray(dictionaryGroups.id, dictionaryGroupIds))
    }
    if (roleIds.length) {
      await db.delete(rolePermissions).where(inArray(rolePermissions.roleId, roleIds))
      await db.delete(roles).where(inArray(roles.id, roleIds))
    }
    for (const departmentId of [...departmentIds].reverse()) {
      await db.delete(departments).where(eq(departments.id, departmentId))
    }
  }
  const [remainingUsers, remainingDepartments, remainingRoles, remainingGroups] = await Promise.all([
    db.select({ id: users.id }).from(users).where(inArray(users.id, createdUserIds)),
    departmentIds.length ? db.select({ id: departments.id }).from(departments).where(inArray(departments.id, departmentIds)) : [],
    roleIds.length ? db.select({ id: roles.id }).from(roles).where(inArray(roles.id, roleIds)) : [],
    dictionaryGroupIds.length
      ? db.select({ id: dictionaryGroups.id }).from(dictionaryGroups).where(inArray(dictionaryGroups.id, dictionaryGroupIds))
      : [],
  ])
  if (remainingUsers.length || remainingDepartments.length || remainingRoles.length || remainingGroups.length) {
    throw new Error('system administration acceptance fixtures were not fully removed')
  }
  if (!report) throw new Error('system administration acceptance did not produce a result')
  report.checks.push('fixture-cleanup-verified')
  console.log(JSON.stringify(report))
}

await main().finally(async () => pool.end())
