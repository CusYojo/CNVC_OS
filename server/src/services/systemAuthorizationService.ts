import { identityRepositories } from '../repositories/index.js'

export async function listEffectivePermissionCodes(userId: string, _legacyRole?: string): Promise<string[]> {
  return identityRepositories.users.listPermissionCodes(userId)
}

export async function userHasPermission(userId: string, legacyRole: string, permissionCode: string): Promise<boolean> {
  return (await listEffectivePermissionCodes(userId, legacyRole)).includes(permissionCode)
}
