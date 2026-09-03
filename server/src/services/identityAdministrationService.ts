import bcrypt from 'bcryptjs'
import { isRepositoryError } from '../repositories/contracts.js'
import type { IdentityRepositoryProvider, SafeUserRecord, UserRecord, UserRepository } from '../repositories/identityRepository.js'
import { identityRepositories } from '../repositories/index.js'
import { emitAuthInvalidation } from '../runtime/authSessionEvents.js'
import { hashNewPassword, validateNewPassword } from '../security/passwordPolicy.js'
import { isAiPlatformAdminRole, isImAdminRole, isSystemAdminRole } from '../contracts/adminRoleContract.js'

export const MANAGED_USER_ROLES = [
  '投资经理', '投资总监', '风控与法务', '投委会秘书', '投后管理组',
  'AI 平台管理员', '系统管理员',
] as const

export type ManagedUserRole = string
export type IdentityAdministrator = { userId: string; userName: string }
export type RegistrationRequest = {
  email: string
  name: string
  role: string
  department: string
  password: string
}

type UserMutation = {
  name?: string
  role?: ManagedUserRole
  department?: string
  status?: '启用' | '禁用'
}

function identityError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code })
}

function publicUser(row: UserRecord): SafeUserRecord {
  const { passwordHash: _passwordHash, ...safe } = row
  return safe
}

async function requireCurrentAdministrator(
  userRepository: UserRepository,
  actor: IdentityAdministrator,
) {
  const administrator = await userRepository.lockById(actor.userId)
  if (
    !administrator
    || administrator.status !== '启用'
    || !(await userRepository.listPermissionCodes(administrator.id)).includes('system.manage')
  ) {
    throw identityError(403, 'ROLE_FORBIDDEN', '仅启用的系统管理员可管理身份与项目成员')
  }
  return administrator
}

export async function createManagedUser(input: {
  email: string
  name: string
  role: ManagedUserRole
  department: string
  password: string
}, actor: IdentityAdministrator) {
  const email = input.email.trim().toLowerCase()
  const name = input.name.trim()
  const department = input.department.trim()
  if (!email || !name || !department) {
    throw identityError(400, 'INVALID_USER_IDENTITY', '邮箱、姓名、部门或角色不符合账号管理契约')
  }
  const violations = validateNewPassword(input.password, { email, name })
  if (violations.length) {
    throw identityError(400, 'PASSWORD_POLICY_VIOLATION', `初始密码不符合安全要求：${violations.join('；')}`)
  }
  const passwordHash = await hashNewPassword(input.password)
  try {
    const created = await identityRepositories.transaction(async ({ users, audits }) => {
      const administrator = await requireCurrentAdministrator(users, actor)
      if (!await users.isActiveRoleName(input.role)) {
        throw identityError(400, 'INVALID_USER_IDENTITY', '邮箱、姓名、部门或角色不符合账号管理契约')
      }
      const existing = await users.findByEmail(email)
      if (existing) throw identityError(409, 'USER_EMAIL_EXISTS', '该邮箱已存在')
      const created = await users.create({
        email, name, role: input.role, department, passwordHash, status: '启用',
      })
      await users.synchronizeAdministrationBindings(created.id, created.role, created.department)
      await audits.append({
        userId: administrator.id,
        userName: administrator.name,
        module: '身份与访问',
        action: '创建用户',
        target: JSON.stringify({ userId: created.id, email: created.email, role: created.role, department: created.department }),
      })
      return publicUser(created)
    })
    return created
  } catch (error) {
    if (isRepositoryError(error) && error.code === 'CONFLICT') {
      throw identityError(409, 'USER_EMAIL_EXISTS', '该邮箱已存在')
    }
    throw error
  }
}

export async function requestUserRegistration(
  input: RegistrationRequest,
  repositories: IdentityRepositoryProvider = identityRepositories,
) {
  const email = input.email.trim().toLowerCase()
  const name = input.name.trim()
  const role = input.role.trim()
  const department = input.department.trim()
  const violations = validateNewPassword(input.password, { email, name })
  if (violations.length) {
    throw identityError(400, 'PASSWORD_POLICY_VIOLATION', `密码不符合安全要求：${violations.join('；')}`)
  }
  if (isSystemAdminRole(role) || isAiPlatformAdminRole(role) || isImAdminRole(role)) {
    throw identityError(400, 'REGISTRATION_ROLE_FORBIDDEN', '请选择业务岗位')
  }
  if (!await repositories.users.isActiveRoleName(role) || await repositories.users.roleHasPermission(role, 'system.manage')) {
    throw identityError(400, 'REGISTRATION_ROLE_FORBIDDEN', '请选择有效的业务岗位')
  }
  if (!await repositories.users.isActiveDepartmentName(department)) {
    throw identityError(400, 'REGISTRATION_DEPARTMENT_INVALID', '请选择有效的所属部门')
  }
  if (await repositories.users.findByEmail(email)) throw identityError(409, 'USER_EMAIL_EXISTS', '该邮箱已提交注册或已存在')
  if ((await repositories.users.findByTrimmedName(name, 1)).length) throw identityError(409, 'USER_NAME_EXISTS', '该姓名账号已存在')
  const passwordHash = await hashNewPassword(input.password)
  try {
    return await repositories.transaction(async ({ users, audits }) => {
      if (!await users.isActiveRoleName(role) || await users.roleHasPermission(role, 'system.manage')) {
        throw identityError(400, 'REGISTRATION_ROLE_FORBIDDEN', '请选择有效的业务岗位')
      }
      if (!await users.isActiveDepartmentName(department)) {
        throw identityError(400, 'REGISTRATION_DEPARTMENT_INVALID', '请选择有效的所属部门')
      }
      if (await users.findByEmail(email)) throw identityError(409, 'USER_EMAIL_EXISTS', '该邮箱已提交注册或已存在')
      if ((await users.findByTrimmedName(name, 1)).length) throw identityError(409, 'USER_NAME_EXISTS', '该姓名账号已存在')
      const created = await users.create({ email, name, role, department, passwordHash, status: '待审核' })
      await audits.append({
        userId: created.id,
        userName: created.name,
        module: '身份与访问',
        action: '提交账号注册申请',
        target: JSON.stringify({ userId: created.id, role: created.role, department: created.department }),
      })
      return { id: created.id, status: '待审核' as const }
    })
  } catch (error) {
    if (isRepositoryError(error) && error.code === 'CONFLICT') {
      throw identityError(409, 'USER_EMAIL_EXISTS', '该邮箱已提交注册或已存在')
    }
    throw error
  }
}

export async function updateManagedUser(
  userId: string,
  patch: UserMutation,
  actor: IdentityAdministrator,
  repositories: IdentityRepositoryProvider = identityRepositories,
) {
  const result = await repositories.transaction(async ({ users, audits }) => {
    const administrator = await requireCurrentAdministrator(users, actor)
    const current = await users.lockById(userId)
    if (!current) throw identityError(404, 'USER_NOT_FOUND', '用户不存在')
    if (current.id === administrator.id && (
      patch.status === '禁用'
      || (patch.role !== undefined && !(await users.roleHasPermission(patch.role, 'system.manage')))
    )) {
      throw identityError(409, 'ADMIN_SELF_LOCKOUT', '不能禁用当前管理员或移除其系统管理员角色')
    }
    const next = {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.department !== undefined ? { department: patch.department.trim() } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    }
    if (patch.role !== undefined && !await users.isActiveRoleName(patch.role)) {
      throw identityError(400, 'INVALID_USER_ROLE', '用户角色不符合账号管理契约')
    }
    if (!Object.keys(next).length) throw identityError(400, 'EMPTY_USER_PATCH', '至少提供一个需要修改的用户字段')
    const updated = await users.update(current.id, next)
    if (!updated) throw identityError(404, 'USER_NOT_FOUND', '用户不存在')
    if (
      current.role !== updated.role
      || current.department !== updated.department
      || (current.status !== '启用' && updated.status === '启用')
    ) {
      await users.synchronizeAdministrationBindings(updated.id, updated.role, updated.department)
    }
    const identityChanged = current.name !== updated.name
      || current.role !== updated.role
      || current.department !== updated.department
      || current.status !== updated.status
    let revokedSessions = 0
    if (identityChanged) {
      revokedSessions = await users.revokeActiveSessions(current.id, new Date())
    }
    await audits.append({
      userId: administrator.id,
      userName: administrator.name,
      module: '身份与访问',
      action: current.status === '待审核' && updated.status === '启用'
        ? '通过账号注册'
        : current.status === '待审核' && updated.status === '禁用'
          ? '拒绝账号注册'
          : current.status === '启用' && updated.status === '禁用'
            ? '注销账号'
            : current.status === '禁用' && updated.status === '启用'
              ? '重新启用账号'
              : '更新用户身份',
      target: JSON.stringify({
        userId: current.id,
        before: { name: current.name, role: current.role, department: current.department, status: current.status },
        after: { name: updated.name, role: updated.role, department: updated.department, status: updated.status },
        revokedSessions,
      }),
    })
    return { user: publicUser(updated), identityChanged }
  })
  if (result.identityChanged) emitAuthInvalidation({ type: 'user', userId })
  return result.user
}

export async function changeOwnPassword(input: {
  userId: string
  currentPassword: string
  newPassword: string
}, repositories: IdentityRepositoryProvider = identityRepositories) {
  const result = await repositories.transaction(async ({ users, audits }) => {
    const current = await users.lockById(input.userId)
    if (!current || current.status !== '启用') throw identityError(401, 'AUTH_DISABLED', '当前账号不可用')
    if (!await bcrypt.compare(input.currentPassword, current.passwordHash)) {
      throw identityError(400, 'CURRENT_PASSWORD_INVALID', '当前密码不正确')
    }
    if (await bcrypt.compare(input.newPassword, current.passwordHash)) {
      throw identityError(400, 'PASSWORD_UNCHANGED', '新密码不能与当前密码相同')
    }
    const violations = validateNewPassword(input.newPassword, { email: current.email, name: current.name })
    if (violations.length) {
      throw identityError(400, 'PASSWORD_POLICY_VIOLATION', `新密码不符合安全要求：${violations.join('；')}`)
    }
    const passwordHash = await hashNewPassword(input.newPassword)
    if (!await users.updatePasswordHash(current.id, passwordHash)) {
      throw identityError(409, 'PASSWORD_UPDATE_CONFLICT', '密码修改失败，请重试')
    }
    const revokedSessions = await users.revokeActiveSessions(current.id, new Date())
    await audits.append({
      userId: current.id,
      userName: current.name,
      module: '账号安全',
      action: '用户修改登录密码',
      target: JSON.stringify({ userId: current.id, revokedSessions }),
    })
    return { revokedSessions }
  })
  emitAuthInvalidation({ type: 'user', userId: input.userId })
  return result
}

export async function resetManagedUserPassword(userId: string, password: string, actor: IdentityAdministrator) {
  const result = await identityRepositories.transaction(async ({ users, audits }) => {
    const administrator = await requireCurrentAdministrator(users, actor)
    const current = await users.lockById(userId)
    if (!current) throw identityError(404, 'USER_NOT_FOUND', '用户不存在')
    const violations = validateNewPassword(password, { email: current.email, name: current.name })
    if (violations.length) {
      throw identityError(400, 'PASSWORD_POLICY_VIOLATION', `新密码不符合安全要求：${violations.join('；')}`)
    }
    const passwordHash = await hashNewPassword(password)
    if (!await users.updatePasswordHash(current.id, passwordHash)) {
      throw identityError(409, 'PASSWORD_UPDATE_CONFLICT', '密码更新未命中唯一用户')
    }
    const revokedSessions = await users.revokeActiveSessions(current.id, new Date())
    await audits.append({
      userId: administrator.id,
      userName: administrator.name,
      module: '身份与访问',
      action: '管理员重置用户密码',
      target: JSON.stringify({ userId: current.id, revokedSessions }),
    })
    return { user: publicUser(current), revokedSessions }
  })
  emitAuthInvalidation({ type: 'user', userId })
  return { userId: result.user.id, revokedSessions: result.revokedSessions }
}

export async function listProjectMembers(projectId: string) {
  return identityRepositories.permissions.listProjectMembers(projectId)
}

export async function replaceProjectMembers(input: {
  projectId: string
  ownerUserId: string
  collaboratorUserIds: string[]
}, actor: IdentityAdministrator) {
  const collaboratorUserIds = [...new Set(input.collaboratorUserIds)]
    .filter((userId) => userId !== input.ownerUserId)
  const memberIds = [input.ownerUserId, ...collaboratorUserIds]
  const result = await identityRepositories.transaction(async ({ users, permissions, audits }) => {
    const administrator = await requireCurrentAdministrator(users, actor)
    const project = await permissions.lockProjectById(input.projectId)
    if (!project) throw identityError(404, 'PROJECT_NOT_FOUND', '项目不存在')
    if (project.workflowModel === 'fde-v1') throw identityError(409, 'FDE_GOVERNANCE_ENDPOINT_REQUIRED', 'FDE 项目必须通过项目职责变更流程管理成员')
    const memberUsers = await users.findManyByIds(memberIds)
    if (memberUsers.length !== memberIds.length || memberUsers.some((member) => member.status !== '启用')) {
      throw identityError(400, 'PROJECT_MEMBER_INVALID', '项目负责人和协作成员必须是存在且已启用的用户')
    }
    const byId = new Map(memberUsers.map((member) => [member.id, member]))
    const owner = byId.get(input.ownerUserId)!
    const collaborators = collaboratorUserIds.map((userId) => byId.get(userId)!)
    const before = await permissions.listProjectMemberBindings(project.id)
    await permissions.replaceProjectMembers({ projectId: project.id, owner, collaborators }, new Date())
    await audits.append({
      userId: administrator.id,
      userName: administrator.name,
      module: '身份与访问',
      action: '更新项目成员',
      target: JSON.stringify({
        projectId: project.id,
        before,
        after: [
          { userId: owner.id, memberRole: 'owner' },
          ...collaborators.map((member) => ({ userId: member.id, memberRole: 'collaborator' })),
        ],
      }),
    })
    return {
      response: {
        projectId: project.id,
        owner: { userId: owner.id, name: owner.name, email: owner.email, memberRole: 'owner' as const },
        collaborators: collaborators.map((member) => ({
          userId: member.id, name: member.name, email: member.email, memberRole: 'collaborator' as const,
        })),
      },
      affectedUserIds: [...new Set([...before.map((member) => member.userId), ...memberIds])],
    }
  })
  for (const userId of result.affectedUserIds) emitAuthInvalidation({ type: 'user', userId })
  return result.response
}
