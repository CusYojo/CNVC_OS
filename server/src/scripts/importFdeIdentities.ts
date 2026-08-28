import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { asc } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { mysqlConfig } from '../db/config.js'
import { auditLogs, departments, iamUserMappings, permissions, rolePermissions, roles, userDepartments, userRoles, users } from '../db/schema.js'
import type { MySqlIdentityExecutor } from '../repositories/mysql/mysqlIdentityRepository.js'
import { buildFdeIdentityImportPlan, FDE_IDENTITY_SOURCE } from '../contracts/fdeIdentityImportContract.js'
import { hashNewPassword, validateNewPassword } from '../security/passwordPolicy.js'
import { safeErrorLog } from '../security/redactSecrets.js'
import { readFdeIdentitySource } from './lib/fdeIdentitySource.js'

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function selected<T>(query: PromiseLike<T> & { for(strength: 'update'): PromiseLike<T> }, lock: boolean) {
  return lock ? await query.for('update') : await query
}

async function snapshot(tx: MySqlIdentityExecutor, lock = false) {
  return {
    users: await selected(tx.select().from(users).orderBy(asc(users.id)), lock),
    roles: await selected(tx.select().from(roles).orderBy(asc(roles.id)), lock),
    departments: await selected(tx.select().from(departments).orderBy(asc(departments.id)), lock),
    permissions: await selected(tx.select().from(permissions).orderBy(asc(permissions.id)), lock),
    rolePermissions: await selected(tx.select().from(rolePermissions).orderBy(asc(rolePermissions.roleId), asc(rolePermissions.permissionId)), lock),
    userRoles: await selected(tx.select().from(userRoles).orderBy(asc(userRoles.userId), asc(userRoles.roleId)), lock),
    userDepartments: await selected(tx.select().from(userDepartments).orderBy(asc(userDepartments.userId), asc(userDepartments.departmentId)), lock),
    mappings: await selected(tx.select().from(iamUserMappings).orderBy(asc(iamUserMappings.id)), lock),
  }
}

async function writePrivate(file: string, data: unknown) {
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
}

async function main() {
  const args = process.argv.slice(2)
  const options: Record<string, string> = {}
  const switches = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (['--apply', '--allow-requested-initial-password'].includes(arg)) switches.add(arg)
    else if (['--source-root', '--expect-preview'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[arg] = args[++i]
    else throw new Error(`未知或缺少参数：${arg}`)
  }
  assert(options['--source-root'], '必须指定 --source-root；不猜测来源系统')
  const apply = switches.has('--apply')
  assert(!apply || options['--expect-preview'], '写入必须通过 --expect-preview 指定已核对的预览文件')
  assert(!['true', '1'].includes(process.env.ALLOW_MYSQL_INTEGRATION_TESTS || '') && !['true', '1'].includes(process.env.ALLOW_MYSQL_ACCEPTANCE_WRITES || ''), '不允许启用业务库测试写入开关')
  const source = await readFdeIdentitySource(path.resolve(options['--source-root']))
  const sourceDigest = digest(source.accounts)
  const targetFingerprint = digest({ host: mysqlConfig.host, port: mysqlConfig.port, database: mysqlConfig.database, prefix: mysqlConfig.tablePrefix })
  const parent = path.resolve('.runtime/migration-evidence')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const evidenceDir = await mkdtemp(path.join(parent, 'fde-identity-'))
  const sourceEvidence = { sourceRoot: source.sourceRoot, sqliteVersion: source.sqliteVersion, sqliteUpdatedAt: source.sqliteUpdatedAt }
  if (!apply) {
    const before = await db.transaction(tx => snapshot(tx), { accessMode: 'read only', isolationLevel: 'repeatable read' })
    const plan = buildFdeIdentityImportPlan(source.accounts, before)
    const report = { mode: 'preview', generatedAt: new Date().toISOString(), sourceDigest, targetFingerprint, targetSnapshotDigest: digest(before), planDigest: digest(plan), source: sourceEvidence, plan,
      notes: ['导入标识使用 accounts.invalid 保留域，不是真实邮箱；使用姓名登录', '保留原有用户、密码、角色和部门；不导入会话或项目职责', '新用户密码只在明确 apply 时从环境读取并独立加盐散列；不写入报告', '业务领导不自动获得 system.manage 系统管理权限'] }
    const reportFile = path.join(evidenceDir, 'preview.json')
    await writePrivate(reportFile, report)
    console.log(JSON.stringify({ ok: !plan.conflicts.length, mode: 'preview', reportFile, sourceUsers: source.accounts.length, existingUsers: before.users.length, usersToCreate: plan.users.filter(u => u.action === 'create').length, usersToSkip: plan.users.filter(u => u.action === 'skip').length, rolesToCreate: plan.rolesToCreate.map(r => r.name), departmentsToCreate: plan.departmentsToCreate.map(d => d.name), conflicts: plan.conflicts }))
    if (plan.conflicts.length) process.exitCode = 1
    return
  }
  const preview = JSON.parse(await readFile(path.resolve(options['--expect-preview']), 'utf8'))
  assert(preview.mode === 'preview' && preview.sourceDigest === sourceDigest && preview.targetFingerprint === targetFingerprint, '来源或目标与预览不同，禁止写入')
  const password = process.env.FDE_IMPORT_INITIAL_PASSWORD || ''
  assert(password.length > 0 && password.length <= 128 && !/\s/.test(password), '必须通过 FDE_IMPORT_INITIAL_PASSWORD 提供有效初始密码')
  const weakInitialPasswordAllowed = switches.has('--allow-requested-initial-password')
  const passwordHashes = new Map<string, string>()
  for (const account of source.accounts) {
    const violations = validateNewPassword(password, { email: `fde.${account.id}@accounts.invalid`, name: account.displayName })
    assert(!violations.length || weakInitialPasswordAllowed, '初始密码不符合日常安全策略；仅用户明确要求时可指定 --allow-requested-initial-password')
    passwordHashes.set(account.id, await hashNewPassword(password))
  }
  const result = await db.transaction(async tx => {
    // Serialize the small identity catalog to avoid a name/role collision
    // between preview and write. No DDL or project records are touched.
    const before = await snapshot(tx, true)
    assert(digest(before) === preview.targetSnapshotDigest, '目标身份数据已变化，请重新预览')
    const plan = buildFdeIdentityImportPlan(source.accounts, before)
    assert(!plan.conflicts.length && digest(plan) === preview.planDigest, '导入计划存在冲突或与预览不同')
    // Owner-only recovery evidence is persisted before the first DB mutation.
    await writePrivate(path.join(evidenceDir, 'before.json'), { sourceDigest, targetFingerprint, snapshot: before })
    const roleIds = new Map(before.roles.map(r => [r.code, r.id]))
    const permissionIds = new Map(before.permissions.map(p => [p.code, p.id]))
    const departmentIds = new Map(before.departments.map(d => [d.name, d.id]))
    const createdRoles: { id: string; code: string }[] = []
    const createdDepartments: { id: string; name: string }[] = []
    const createdUsers: { id: string; sourceId: string; name: string; roleCodes: string[] }[] = []
    for (const role of plan.rolesToCreate) {
      const id = randomUUID()
      await tx.insert(roles).values({ id, code: role.code, name: role.name, fdeCategory: role.fdeCategory, dataScope: role.dataScope, description: `FDE 岗位导入，沿用 ${role.template} 业务权限`, builtIn: false, status: '启用' })
      if (role.permissionCodes.length) await tx.insert(rolePermissions).values(role.permissionCodes.map(code => {
        const permissionId = permissionIds.get(code)
        assert(permissionId, '预览角色权限已失效')
        return { roleId: id, permissionId }
      }))
      roleIds.set(role.code, id); createdRoles.push({ id, code: role.code })
    }
    for (const department of plan.departmentsToCreate) {
      const id = randomUUID()
      await tx.insert(departments).values({ id, ...department, description: '从赛智伯乐 FDE 导入' })
      departmentIds.set(department.name, id); createdDepartments.push({ id, name: department.name })
    }
    for (const account of plan.users.filter(u => u.action === 'create')) {
      const id = randomUUID()
      await tx.insert(users).values({ id, email: account.email, name: account.name, role: account.role, department: account.department, status: account.status, passwordHash: passwordHashes.get(account.sourceId)! })
      await tx.insert(userRoles).values(account.roleCodes.map((code, index) => ({ userId: id, roleId: roleIds.get(code)!, isPrimary: index === 0 })))
      await tx.insert(userDepartments).values({ userId: id, departmentId: departmentIds.get(account.department)!, isPrimary: true })
      await tx.insert(iamUserMappings).values({ sourceSystem: FDE_IDENTITY_SOURCE, sourceUserId: account.sourceId, sourceEmail: '', targetUserId: id })
      createdUsers.push({ id, sourceId: account.sourceId, name: account.name, roleCodes: account.roleCodes })
    }
    const after = await snapshot(tx)
    const originalUserIds = new Set(before.users.map(u => u.id))
    const originalRoleIds = new Set(before.roles.map(r => r.id))
    const originalDepartmentIds = new Set(before.departments.map(d => d.id))
    assert(digest(after.users.filter(u => originalUserIds.has(u.id))) === digest(before.users), '原有用户被意外改变')
    assert.deepEqual(after.roles.filter(r => originalRoleIds.has(r.id)), before.roles, '原有角色被意外改变')
    assert.deepEqual(after.departments.filter(d => originalDepartmentIds.has(d.id)), before.departments, '原有部门被意外改变')
    assert.deepEqual(after.rolePermissions.filter(r => originalRoleIds.has(r.roleId)), before.rolePermissions, '原有角色权限被意外改变')
    assert.deepEqual(after.userRoles.filter(r => originalUserIds.has(r.userId)), before.userRoles, '原有用户角色被意外改变')
    assert.deepEqual(after.userDepartments.filter(r => originalUserIds.has(r.userId)), before.userDepartments, '原有用户部门被意外改变')
    assert.equal(after.users.length, before.users.length + createdUsers.length)
    const repeatPlan = buildFdeIdentityImportPlan(source.accounts, after)
    assert.equal(repeatPlan.conflicts.length, 0)
    assert.equal(repeatPlan.users.filter(u => u.action === 'create').length, 0)
    assert.equal(repeatPlan.rolesToCreate.length + repeatPlan.departmentsToCreate.length, 0)
    const details = { sourceDigest, targetFingerprint, createdUsers, createdRoles, createdDepartments, weakInitialPasswordAllowed, preservedExistingUsers: before.users.length, totalUsers: after.users.length, skippedUsers: plan.users.filter(u => u.action === 'skip').length, idempotentPreview: true }
    if (createdUsers.length || createdRoles.length || createdDepartments.length) await tx.insert(auditLogs).values({ userId: null, userName: '用户授权的 FDE 离线导入', module: '身份与访问', action: '导入 FDE 用户与角色权限', target: JSON.stringify(details) })
    return details
  }, { isolationLevel: 'serializable' })
  const reportFile = path.join(evidenceDir, 'result.json')
  await writePrivate(reportFile, { ok: true, mode: 'apply', appliedAt: new Date().toISOString(), source: sourceEvidence, ...result })
  console.log(JSON.stringify({ ok: true, mode: 'apply', reportFile, createdUsers: result.createdUsers.length, createdRoles: result.createdRoles.length, createdDepartments: result.createdDepartments.length, preservedExistingUsers: result.preservedExistingUsers, totalUsers: result.totalUsers, idempotentPreview: result.idempotentPreview }))
}

try { await main() }
catch (error) { console.error(JSON.stringify({ ok: false, error: safeErrorLog(error) })); process.exitCode = 1 }
finally { await pool.end() }
