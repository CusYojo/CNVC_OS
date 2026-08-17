export type UserStatus = '启用' | '禁用'

export type UserRecord = {
  id: string
  email: string
  name: string
  role: string
  department: string
  passwordHash: string
  status: string
  lastLogin: Date | null
  createdAt: Date
}

export type SafeUserRecord = Omit<UserRecord, 'passwordHash'>

export type CreateUserRecord = {
  email: string
  name: string
  role: string
  department: string
  passwordHash: string
  status?: UserStatus
}

export type UpdateUserRecord = Partial<Pick<UserRecord, 'name' | 'role' | 'department' | 'status'>>

export type ProjectIdentityRecord = {
  id: string
  name: string
  owner: string
  ownerUserId: string | null
  collaborators: string[]
  createdBy: string | null
}

export type ProjectMemberBinding = {
  userId: string
  memberRole: string
}

export type ProjectMemberView = ProjectMemberBinding & {
  name: string
  email: string
  status: string
}

export type ReplaceProjectMemberBindings = {
  projectId: string
  owner: Pick<UserRecord, 'id' | 'name'>
  collaborators: Array<Pick<UserRecord, 'id' | 'name'>>
}

export type AuditRecord = {
  userId?: string | null
  userName: string
  module: string
  action: string
  target?: string | null
  ip?: string | null
  result?: string
}

export interface UserRepository {
  findById(userId: string): Promise<UserRecord | null>
  findByEmail(email: string): Promise<UserRecord | null>
  findManyByIds(userIds: string[]): Promise<UserRecord[]>
  findByTrimmedName(name: string, limit?: number): Promise<UserRecord[]>
  findEnabledByRoles(roles: string[]): Promise<UserRecord[]>
  isActiveRoleName(name: string): Promise<boolean>
  listPermissionCodes(userId: string): Promise<string[]>
  roleHasPermission(roleName: string, permissionCode: string): Promise<boolean>
  listSafe(): Promise<SafeUserRecord[]>
  lockById(userId: string): Promise<UserRecord | null>
  create(input: CreateUserRecord): Promise<UserRecord>
  update(userId: string, patch: UpdateUserRecord): Promise<UserRecord | null>
  updatePasswordHash(userId: string, passwordHash: string): Promise<boolean>
  touchLastLogin(userId: string, at: Date): Promise<void>
  revokeActiveSessions(userId: string, at: Date): Promise<number>
  synchronizeAdministrationBindings(userId: string, roleName: string, departmentName: string): Promise<void>
}

export interface PermissionRepository {
  findProjectById(projectId: string): Promise<ProjectIdentityRecord | null>
  lockProjectById(projectId: string): Promise<ProjectIdentityRecord | null>
  listProjectMembers(projectId: string): Promise<ProjectMemberView[]>
  listProjectMemberBindings(projectId: string): Promise<ProjectMemberBinding[]>
  replaceProjectMembers(input: ReplaceProjectMemberBindings, at: Date): Promise<void>
}

export interface AuditRepository {
  append(record: AuditRecord): Promise<void>
}

export type IdentityRepositoryContext = {
  users: UserRepository
  permissions: PermissionRepository
  audits: AuditRepository
}

export interface IdentityRepositoryProvider extends IdentityRepositoryContext {
  transaction<T>(work: (repositories: IdentityRepositoryContext) => Promise<T>): Promise<T>
}
