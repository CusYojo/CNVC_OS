type RuntimeEnvironment = Record<string, string | undefined>

export const MIGRATION_WRITE_FREEZE_MODE = 'rollback-window' as const

function strictBoolean(env: RuntimeEnvironment, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase()
  if (!value) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`[runtime config] ${name} must be true or false`)
}

export function resolveMigrationWriteFreezePolicy(env: RuntimeEnvironment = process.env) {
  const enabled = strictBoolean(env, 'MIGRATION_WRITE_FREEZE', false)
  const configuredMode = env.MIGRATION_WRITE_FREEZE_MODE?.trim() || ''
  if (enabled && configuredMode !== MIGRATION_WRITE_FREEZE_MODE) {
    throw new Error(`[runtime config] MIGRATION_WRITE_FREEZE_MODE must be ${MIGRATION_WRITE_FREEZE_MODE} when MIGRATION_WRITE_FREEZE=true`)
  }
  if (!enabled && configuredMode) {
    throw new Error('[runtime config] MIGRATION_WRITE_FREEZE_MODE must be empty when MIGRATION_WRITE_FREEZE=false')
  }
  return Object.freeze({
    enabled,
    mode: enabled ? MIGRATION_WRITE_FREEZE_MODE : 'normal',
    httpMutationMethods: Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE'] as const),
  })
}

export const migrationWriteFreezePolicy = resolveMigrationWriteFreezePolicy(process.env)
