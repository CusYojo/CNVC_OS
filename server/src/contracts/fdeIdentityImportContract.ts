export const FDE_IDENTITY_SOURCE = 'saizhi_fde'

export type FdeSourceAccount = {
  id: string; username: string; displayName: string; displayRole: string; department: string
  policyKey: string; specialty: string; status: 'active' | 'disabled'
}
export type FdeImportRole = {
  id: string; code: string; name: string; fdeCategory: string | null; dataScope: string; status: string
}
export type FdeIdentitySnapshot = {
  users: { id: string; email: string; name: string; role: string; department: string; status: string }[]
  roles: FdeImportRole[]
  permissions: { id: string; code: string }[]
  rolePermissions: { roleId: string; permissionId: string }[]
  userRoles: { userId: string; roleId: string; isPrimary: boolean }[]
  departments: { id: string; code: string; name: string; status: string }[]
  userDepartments: { userId: string; departmentId: string; isPrimary: boolean }[]
  mappings: { sourceSystem: string; sourceUserId: string; targetUserId: string }[]
}

const roleDefinitions: Record<string, { name: string; category: string; scope: string; template?: string }> = {
  FDE_CHAIRMAN: { name: '董事长', category: 'institution_leader', scope: 'all' },
  FDE_PRESIDENT: { name: '总裁', category: 'institution_leader', scope: 'all' },
  FDE_PROJECT_LEAD: { name: '项目负责人', category: 'project_lead', scope: 'self' },
  FDE_SECRETARY: { name: '推进秘书', category: 'secretary', scope: 'self' },
  FDE_COORDINATOR: { name: '时间协调人', category: 'coordinator', scope: 'self' },
  FDE_FINANCE: { name: '财务', category: 'specialist', scope: 'self' },
  FDE_LEGAL: { name: '法务', category: 'specialist', scope: 'self' },
  INVESTMENT_MANAGER: { name: '投资经理', category: 'member', scope: 'self' },
  RISK_LEGAL: { name: '风控与法务', category: 'specialist', scope: 'self' },
  FDE_PARTNER: { name: '合伙人', category: 'project_lead', scope: 'self', template: 'FDE_PROJECT_LEAD' },
  FDE_RISK: { name: '风控', category: 'specialist', scope: 'self', template: 'RISK_LEGAL' },
  FDE_BOARD_SECRETARY: { name: '董秘', category: 'coordinator', scope: 'self', template: 'FDE_COORDINATOR' },
}

function accountRoleCodes(account: FdeSourceAccount): string[] {
  const key = `${account.displayRole}/${account.policyKey}/${account.specialty}`
  const mappings: Record<string, string[]> = {
    '董事长/leader/chairman': ['FDE_CHAIRMAN'],
    '总裁/leader/president': ['FDE_PRESIDENT'],
    '合伙人/lead/partner': ['FDE_PARTNER', 'FDE_PROJECT_LEAD'],
    '投资经理/member/investment_manager': ['INVESTMENT_MANAGER'],
    '投资经理/secretary/investment_manager': ['INVESTMENT_MANAGER', 'FDE_SECRETARY'],
    '财务/finance/finance': ['FDE_FINANCE'],
    '法务/finance/legal': ['FDE_LEGAL'],
    '风控/finance/risk': ['FDE_RISK', 'RISK_LEGAL'],
    '董秘/coordinator/board_secretary': ['FDE_BOARD_SECRETARY', 'FDE_COORDINATOR'],
  }
  if (!mappings[key]) throw new Error(`未确认的源岗位权限组合：${account.displayName} (${key})`)
  return mappings[key]
}

export function buildFdeIdentityImportPlan(accounts: FdeSourceAccount[], snapshot: FdeIdentitySnapshot) {
  const conflicts: string[] = []
  const rolesToCreate: { code: string; name: string; fdeCategory: string; dataScope: 'self'; permissionCodes: string[]; template: string }[] = []
  const departmentsToCreate: { code: string; name: string }[] = []
  const users: { sourceId: string; name: string; email: string; role: string; department: string; status: '启用' | '禁用'; roleCodes: string[]; action: 'create' | 'skip'; targetUserId: string | null }[] = []
  const seenIds = new Set<string>(), seenNames = new Set<string>(), checkedRoles = new Set<string>()
  const permissionCode = new Map(snapshot.permissions.map(p => [p.id, p.code]))
  const codesForRole = (id: string) => snapshot.rolePermissions.filter(p => p.roleId === id).map(p => permissionCode.get(p.permissionId) || '').sort()
  function checkRole(code: string): string[] {
    const definition = roleDefinitions[code]
    const existing = snapshot.roles.find(r => r.code === code)
    if (checkedRoles.has(code)) return existing ? codesForRole(existing.id) : rolesToCreate.find(r => r.code === code)?.permissionCodes || []
    checkedRoles.add(code)
    if (existing) {
      const codes = codesForRole(existing.id)
      if (existing.name !== definition.name || existing.fdeCategory !== definition.category || existing.dataScope !== definition.scope || existing.status !== '启用') conflicts.push(`目标角色定义不匹配或已禁用：${code}`)
      if (!codes.includes('fde.project.read') || codes.some(p => !p || ['system.manage', 'ai.configure', 'im.manage'].includes(p))) conflicts.push(`目标角色权限缺失或含非业务管理权限：${code}`)
      return codes
    }
    if (!definition.template) { conflicts.push(`目标缺少基础角色：${code}，请先完成 FDE 权限迁移`); return [] }
    if (snapshot.roles.some(r => r.name === definition.name)) conflicts.push(`目标存在不同编码的同名角色：${definition.name}`)
    const permissionCodes = checkRole(definition.template)
    rolesToCreate.push({ code, name: definition.name, fdeCategory: definition.category, dataScope: 'self', permissionCodes, template: definition.template })
    return permissionCodes
  }
  for (const account of accounts) {
    if (!/^[a-z0-9_-]{1,64}$/.test(account.id) || !account.displayName.trim() || account.displayName !== account.displayName.trim() || account.displayName.length > 64 || /[@\u0000-\u001f\u007f]/.test(account.displayName) || account.username !== account.displayName || !account.department.trim() || account.department !== account.department.trim() || account.department.length > 64 || !['active', 'disabled'].includes(account.status)) {
      conflicts.push(`源用户字段不满足姓名登录契约：${account.id}`); continue
    }
    const normalizedName = account.displayName.toLowerCase()
    if (seenIds.has(account.id) || seenNames.has(normalizedName)) { conflicts.push(`源身份或姓名重复：${account.displayName}`); continue }
    seenIds.add(account.id); seenNames.add(normalizedName)
    let roleCodes: string[]
    try { roleCodes = accountRoleCodes(account) } catch (error) { conflicts.push((error as Error).message); continue }
    roleCodes.forEach(checkRole)
    const email = `fde.${account.id}@accounts.invalid`
    const mapping = snapshot.mappings.find(m => m.sourceSystem === FDE_IDENTITY_SOURCE && m.sourceUserId === account.id)
    const mapped = mapping && snapshot.users.find(u => u.id === mapping.targetUserId)
    // Never adopt a same-name account, reset an existing password, or rewrite
    // an administrator's subsequent role changes on a repeat import.
    if (mapping && !mapped) conflicts.push(`既有来源映射的目标用户不存在：${account.displayName}`)
    if (mapped && mapped.name !== account.displayName) conflicts.push(`既有来源映射的姓名已变化：${account.displayName}`)
    if (snapshot.users.some(u => (u.name.trim().toLowerCase() === normalizedName || u.email.toLowerCase() === email) && u.id !== mapped?.id)) conflicts.push(`目标姓名或导入标识冲突：${account.displayName}`)
    const department = snapshot.departments.find(d => d.name === account.department)
    if (department?.status !== undefined && department.status !== '启用') conflicts.push(`目标部门已禁用：${account.department}`)
    if (!department && !mapped && !departmentsToCreate.some(d => d.name === account.department)) {
      const code = `FDE_DEPT_${Array.from(account.department).map(c => c.codePointAt(0)!.toString(16)).join('').slice(0, 48).toUpperCase()}`
      if ([...snapshot.departments, ...departmentsToCreate].some(d => d.code === code)) conflicts.push(`目标部门编码冲突：${account.department}`)
      departmentsToCreate.push({ code, name: account.department })
    }
    users.push({ sourceId: account.id, name: account.displayName, email, role: account.displayRole, department: account.department, status: account.status === 'active' ? '启用' : '禁用', roleCodes, action: mapped ? 'skip' : 'create', targetUserId: mapped?.id || null })
  }
  if (!accounts.length) conflicts.push('源账号列表为空')
  return { sourceSystem: FDE_IDENTITY_SOURCE, users, rolesToCreate, departmentsToCreate, conflicts: [...new Set(conflicts)] }
}
