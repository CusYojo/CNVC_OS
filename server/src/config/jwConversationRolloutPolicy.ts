export type JwConversationScope = 'global' | 'project'
type RuntimeEnvironment = Record<string, string | undefined>

function booleanFlag(env: RuntimeEnvironment, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase()
  if (!value) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`[runtime config] ${name} must be true or false`)
}

export function resolveJwConversationRolloutPolicy(env: RuntimeEnvironment = process.env) {
  return Object.freeze({
    globalNewConversationsEnabled: booleanFlag(env, 'JW_GLOBAL_NEW_CONVERSATIONS_ENABLED', true),
    projectNewConversationsEnabled: booleanFlag(env, 'JW_PROJECT_NEW_CONVERSATIONS_ENABLED', true),
    fallbackRuntime: null,
  })
}

export function assertNewJwConversationAllowed(
  scope: JwConversationScope,
  env: RuntimeEnvironment = process.env,
): void {
  const policy = resolveJwConversationRolloutPolicy(env)
  const enabled = scope === 'global'
    ? policy.globalNewConversationsEnabled
    : policy.projectNewConversationsEnabled
  if (enabled) return
  throw Object.assign(new Error(scope === 'global' ? '全局 AI 新会话暂未开放' : '项目 AI 新会话暂未开放'), {
    status: 503,
    code: scope === 'global'
      ? 'JW_GLOBAL_NEW_CONVERSATIONS_DISABLED'
      : 'JW_PROJECT_NEW_CONVERSATIONS_DISABLED',
  })
}
