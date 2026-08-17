import { lstat, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { resolveJwAgentWorkspace } from '../runtime/jwAgentRuntime.js'

export function configuredAgentWorkspaceRoot(): string {
  return path.resolve(process.env.AGENT_WORKSPACE || path.join(process.cwd(), 'server', 'agent-workspace'))
}

export async function removeAgentConversationWorkspace(
  conversationId: string,
  options: { workspaceRoot?: string } = {},
): Promise<boolean> {
  const workspaceRoot = path.resolve(options.workspaceRoot || configuredAgentWorkspaceRoot())
  const rootMetadata = await lstat(workspaceRoot).catch(() => null)
  if (!rootMetadata) return false
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw Object.assign(new Error('Agent workspace 根目录不安全'), { code: 'AGENT_WORKSPACE_ROOT_UNSAFE' })
  }
  const workspace = resolveJwAgentWorkspace(workspaceRoot, conversationId)
  const workspaceMetadata = await lstat(workspace).catch(() => null)
  if (!workspaceMetadata) return false
  if (!workspaceMetadata.isDirectory() || workspaceMetadata.isSymbolicLink()) {
    throw Object.assign(new Error('Agent 会话 workspace 不是安全目录'), { code: 'AGENT_WORKSPACE_UNSAFE' })
  }
  const [resolvedRoot, resolvedWorkspace] = await Promise.all([realpath(workspaceRoot), realpath(workspace)])
  const relative = path.relative(resolvedRoot, resolvedWorkspace)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Agent 会话 workspace 越界'), { code: 'AGENT_WORKSPACE_UNSAFE' })
  }
  await rm(workspace, { recursive: true, force: false, maxRetries: 2, retryDelay: 50 })
  return true
}
