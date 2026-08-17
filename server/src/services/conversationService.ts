import { randomUUID } from 'node:crypto'
import { assertNewJwConversationAllowed } from '../config/jwConversationRolloutPolicy.js'
import { agentConversationRepository } from '../repositories/index.js'
import { getAccessibleProject, requireAccessibleProject } from './projectAccessService.js'
import { listAvailableModels } from './aiModelSettingsService.js'
import { removeAgentConversationWorkspace } from './agentWorkspaceLifecycleService.js'

export type ChatMessageRow = {
  id: string
  role: 'user' | 'assistant'
  content: string
  kind?: 'project-qa'
  metadata?: Record<string, unknown>
  sources?: string[]
  confidence?: number
  createdAt?: string
}

// 列出当前用户的会话（不含消息体，列表更轻）
export async function listConversations(userId: string) {
  const rows = await agentConversationRepository.listChatsForUser(userId, 100)
  const accessible = await Promise.all(rows.map(async (row) => (
    !row.projectId || await getAccessibleProject(userId, row.projectId) ? row : null
  )))
  const ids = accessible.flatMap((row) => row ? [row.id] : [])
  const modelRows = await agentConversationRepository.findAgentModels(ids)
  const modelByConversation = new Map(modelRows.map((row) => [row.id, row.modelId]))
  return accessible.filter((row): row is NonNullable<typeof row> => Boolean(row)).map(({ messages, ...rest }) => ({
    ...rest,
    modelId: modelByConversation.get(rest.id) || null,
    messageCount: Array.isArray(messages) ? messages.length : 0,
  }))
}

// 取单个会话（含全部消息）
export async function getConversation(userId: string, id: string) {
  const row = await agentConversationRepository.findChatByIdForUser(userId, id)
  if (!row || (row.projectId && !(await getAccessibleProject(userId, row.projectId)))) return undefined
  return row
}

export async function createConversation(userId: string, input: {
  title?: string; scope?: string; projectId?: string | null; projectName?: string | null; agentId?: string;
  modelId?: string | null; userRole?: string
}) {
  const scope = input.scope === 'global' ? 'global' : 'project'
  // 灰度只控制新建 JW 会话；已有 MySQL 会话仍可读取、续聊、停止和删除。
  // 关闭时失败关闭，绝不回退到已退役的外部会话运行时。
  assertNewJwConversationAllowed(scope)
  const project = input.projectId ? await requireAccessibleProject(userId, input.projectId) : null
  if (scope === 'project' && !project) {
    throw Object.assign(new Error('项目会话必须绑定有权访问的项目'), { status: 400, code: 'PROJECT_REQUIRED' })
  }
  const conversationId = randomUUID()
  const externalSessionId = input.agentId || `conv-${randomUUID()}`
  if (input.modelId) {
    const available = await listAvailableModels(input.userRole || '')
    if (!available.some((model) => model.id === input.modelId)) {
      throw Object.assign(new Error('所选模型不存在、已停用或当前用户无权使用'), {
        status: 403, code: 'MODEL_FORBIDDEN',
      })
    }
  }
  return agentConversationRepository.createConversationPair({
    id: conversationId,
    userId,
    title: input.title || '新会话',
    scope,
    projectId: project?.id || null,
    projectName: project?.name || null,
    externalSessionId,
    modelId: input.modelId || null,
  })
}

// 会话与消息均已落入 MySQL；这里同步更新新旧会话索引的标题。
export async function renameConversation(userId: string, id: string, title: string) {
  if (!(await getConversation(userId, id))) return undefined
  const normalizedTitle = title.slice(0, 40)
  return agentConversationRepository.renameConversationPair(userId, id, normalizedTitle)
}

// 追加一批消息（通常一次追加一条 user + 一条 assistant），并可更新标题
export async function appendMessages(userId: string, id: string, newMessages: ChatMessageRow[], title?: string) {
  const conv = await getConversation(userId, id)
  if (!conv) return undefined
  const merged = [...(conv.messages as ChatMessageRow[]), ...newMessages]
  let nextTitle: string | undefined
  // 首条用户消息自动作为标题（会话仍是默认名时）
  if (title) nextTitle = title.slice(0, 40)
  else if (conv.title === '新会话') {
    const firstUser = merged.find((m) => m.role === 'user')
    if (firstUser) nextTitle = firstUser.content.slice(0, 40)
  }
  return agentConversationRepository.appendChatMessages(userId, id, newMessages, nextTitle)
}

export async function deleteConversation(userId: string, id: string) {
  const existing = await getConversation(userId, id)
  if (!existing) return false
  const deleted = await agentConversationRepository.deleteConversationPair(userId, id)
  if (deleted) {
    await removeAgentConversationWorkspace(id).catch(() => {
      console.warn(JSON.stringify({ event: 'agent_workspace_cleanup_failed', conversationIdentityExcluded: true }))
    })
  }
  return deleted
}
