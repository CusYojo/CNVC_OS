export function directSkillAgentSandboxFailIfUnavailable(platform = process.platform) {
  // The Agent SDK does not implement its sandbox on native Windows. Keep the
  // strict fail-closed policy everywhere sandboxing is supported, and only
  // permit the SDK's documented fallback for native Windows execution.
  return platform !== 'win32'
}

export function directSkillAgentSandboxEnabled(platform = process.platform) {
  // Native Windows has no Agent SDK sandbox implementation. Passing
  // enabled=true still denies individual Bash commands even when fallback is
  // allowed, so Windows relies on the restricted environment and task-owned
  // workspace while supported hosts keep SDK sandboxing enabled.
  return platform !== 'win32'
}
