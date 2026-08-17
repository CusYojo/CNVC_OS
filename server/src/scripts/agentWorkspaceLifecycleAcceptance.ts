import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { agentConversations, chatConversations, users } from '../db/schema.js'
import { createConversation, deleteConversation } from '../services/conversationService.js'
import { hashPassword } from '../services/authService.js'
import { removeAgentConversationWorkspace } from '../services/agentWorkspaceLifecycleService.js'

async function exists(target: string) {
  return Boolean(await lstat(target).catch(() => null))
}

async function main() {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'agent-workspace-lifecycle-'))
  const workspaceRoot = path.join(runtimeRoot, 'workspace')
  const outsideRoot = path.join(runtimeRoot, 'outside')
  const previousWorkspace = process.env.AGENT_WORKSPACE
  const userId = randomUUID()
  let conversationId = ''
  const checks: string[] = []
  try {
    await Promise.all([mkdir(workspaceRoot), mkdir(outsideRoot)])
    const directConversationId = randomUUID()
    const directWorkspace = path.join(workspaceRoot, directConversationId)
    const sibling = path.join(workspaceRoot, randomUUID())
    const outsideFile = path.join(outsideRoot, 'preserve.txt')
    await Promise.all([
      mkdir(directWorkspace),
      mkdir(sibling),
      writeFile(outsideFile, 'outside-preserved'),
    ])
    await writeFile(path.join(directWorkspace, 'runtime.json'), '{}')
    await symlink(outsideFile, path.join(directWorkspace, 'outside-link'))
    if (!await removeAgentConversationWorkspace(directConversationId, { workspaceRoot })) throw new Error('direct workspace was not removed')
    if (await exists(directWorkspace) || !await exists(sibling) || await readFile(outsideFile, 'utf8') !== 'outside-preserved') {
      throw new Error('workspace deletion crossed its exact conversation boundary')
    }
    checks.push('exact-conversation-workspace-removed-with-sibling-and-symlink-target-preserved')

    if (await removeAgentConversationWorkspace(randomUUID(), { workspaceRoot })) throw new Error('missing workspace reported deletion')
    checks.push('missing-workspace-is-idempotent')

    let invalidRejected = false
    try { await removeAgentConversationWorkspace('../escape', { workspaceRoot }) } catch { invalidRejected = true }
    if (!invalidRejected) throw new Error('invalid conversation workspace id was accepted')
    checks.push('invalid-conversation-id-rejected')

    const symlinkRoot = path.join(runtimeRoot, 'workspace-link')
    await symlink(workspaceRoot, symlinkRoot)
    let symlinkRootRejected = false
    try { await removeAgentConversationWorkspace(randomUUID(), { workspaceRoot: symlinkRoot }) } catch { symlinkRootRejected = true }
    if (!symlinkRootRejected) throw new Error('symlink workspace root was accepted')
    checks.push('symlink-workspace-root-rejected')

    const symlinkConversationId = randomUUID()
    await symlink(outsideRoot, path.join(workspaceRoot, symlinkConversationId))
    let symlinkConversationRejected = false
    try { await removeAgentConversationWorkspace(symlinkConversationId, { workspaceRoot }) } catch { symlinkConversationRejected = true }
    if (!symlinkConversationRejected || !await exists(outsideRoot)) throw new Error('symlink conversation workspace boundary failed')
    checks.push('symlink-conversation-workspace-rejected')

    process.env.AGENT_WORKSPACE = workspaceRoot
    await db.insert(users).values({
      id: userId,
      email: `workspace-lifecycle-${userId}@example.invalid`,
      name: `Workspace 生命周期验收-${userId.slice(0, 8)}`,
      role: '投资经理',
      department: '自动验收',
      passwordHash: await hashPassword(`Aa!${randomUUID()}9`),
      status: '启用',
    })
    const conversation = await createConversation(userId, { title: 'Workspace 生命周期验收', scope: 'global' })
    conversationId = conversation.id
    const serviceWorkspace = path.join(workspaceRoot, conversationId)
    await mkdir(path.join(serviceWorkspace, '.claude'), { recursive: true })
    await writeFile(path.join(serviceWorkspace, '.claude', 'state.json'), '{}')
    if (!await deleteConversation(userId, conversationId)) throw new Error('conversation service deletion failed')
    const [agentRows, chatRows] = await Promise.all([
      db.select({ id: agentConversations.id }).from(agentConversations).where(eq(agentConversations.id, conversationId)),
      db.select({ id: chatConversations.id }).from(chatConversations).where(eq(chatConversations.id, conversationId)),
    ])
    if (agentRows.length || chatRows.length || await exists(serviceWorkspace)) {
      throw new Error('conversation deletion did not remove MySQL rows and exact workspace together')
    }
    conversationId = ''
    checks.push('real-mysql-conversation-delete-removes-exact-workspace')
    checks.push('conversation-delete-leaves-no-chat-or-agent-row')

    console.log(JSON.stringify({ ok: true, checks, databaseRowsRemaining: 0, workspaceArtifactsRemaining: 0 }))
  } finally {
    if (conversationId) await deleteConversation(userId, conversationId).catch(() => false)
    await db.delete(users).where(eq(users.id, userId)).catch(() => undefined)
    if (previousWorkspace === undefined) delete process.env.AGENT_WORKSPACE
    else process.env.AGENT_WORKSPACE = previousWorkspace
    await rm(runtimeRoot, { recursive: true, force: true })
  }
}

await main().finally(async () => pool.end())
