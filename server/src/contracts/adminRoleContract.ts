export const SYSTEM_ADMIN_ROLES = ['系统管理员'] as const
export const AI_PLATFORM_ADMIN_ROLES = ['系统管理员', 'AI平台管理员', 'AI 平台管理员'] as const
export const IM_ADMIN_ROLES = ['系统管理员', '运营管理员'] as const

export function isSystemAdminRole(role: string) {
  return (SYSTEM_ADMIN_ROLES as readonly string[]).includes(role)
}

export function isAiPlatformAdminRole(role: string) {
  return (AI_PLATFORM_ADMIN_ROLES as readonly string[]).includes(role)
}

export function isImAdminRole(role: string) {
  return (IM_ADMIN_ROLES as readonly string[]).includes(role)
}

/**
 * Project deletion is a business-leadership capability, not a general project
 * membership capability. `project.classify` is the existing revocable
 * permission assigned to authorized institution/project leaders. System
 * administrators retain an explicit recovery path even though their
 * configuration-only role does not inherit that business permission.
 */
export function canDirectlyDeleteProject(role: string, permissionCodes: readonly string[] = []) {
  return isSystemAdminRole(role) || permissionCodes.includes('project.classify')
}
