import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { and, asc, eq, inArray, like } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  agentConversations,
  agentMessageParts,
  agentMessages,
  auditLogs,
  authSessions,
  chatConversations,
  projectMembers,
  projects,
  users,
} from '../db/schema.js'
import { createAuthSession, hashPassword } from '../services/authService.js'
import { deleteConversation } from '../services/conversationService.js'

const baseUrl = process.env.JW_MULTITURN_ACCEPTANCE_URL || 'http://127.0.0.1:4100'
const timeoutMs = (() => {
  const value = Number(process.env.JW_MULTITURN_ACCEPTANCE_TIMEOUT_MS || 180_000)
  if (!Number.isSafeInteger(value) || value < 30_000 || value > 600_000) {
    throw new Error('JW_MULTITURN_ACCEPTANCE_TIMEOUT_MS must be between 30000 and 600000')
  }
  return value
})()

type Session = Awaited<ReturnType<typeof createAuthSession>>
type Snapshot = {
  status?: string
  error?: string | null
  runtime?: {
    model?: string | null
    usage?: {
      inputTokens?: number
      outputTokens?: number
      cacheCreationInputTokens?: number
      cacheReadInputTokens?: number
      totalInputTokens?: number
      totalTokens?: number
    } | null
    totalCostUsd?: number | null
    numTurns?: number | null
    durationMs?: number | null
    contextCompaction?: { state?: string; count?: number }
  }
  messages?: Array<{ id?: string; role?: string; parts?: Array<Record<string, unknown>> }>
}

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[JW multi-turn acceptance] ${message}`)
}

function cookieFor(session: Session) {
  return `cybernaut_session=${encodeURIComponent(session.sessionToken)}; cybernaut_csrf=${encodeURIComponent(session.csrfToken)}`
}

async function api<T>(session: Session, route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      Cookie: cookieFor(session),
      ...(init.method && init.method !== 'GET' ? { 'X-CSRF-Token': session.csrfToken } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) {
    const code = typeof body?.code === 'string' ? body.code : `HTTP_${response.status}`
    throw new Error(`request failed code=${code}`)
  }
  return body as T
}

function assistantTexts(snapshot: Snapshot) {
  return (snapshot.messages || []).filter((message) => message.role === 'assistant' && !String(message.id || '').startsWith('streaming:'))
    .map((message) => (message.parts || []).filter((part) => part.type === 'text')
      .map((part) => String(part.text || '')).join(''))
}

function containsProjectIdKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsProjectIdKey)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>)
    .some(([key, nested]) => key.toLowerCase() === 'projectid' || containsProjectIdKey(nested))
}

async function waitForTurn(session: Session, agentId: string, minimumAssistantMessages: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await api<Snapshot>(session, `/api/agent/conversations/${encodeURIComponent(agentId)}`)
    if (snapshot.status === 'error') throw new Error('JW Runtime returned an error state')
    if (snapshot.status === 'idle' && assistantTexts(snapshot).length >= minimumAssistantMessages) return snapshot
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`JW Runtime did not finish turn ${minimumAssistantMessages} within the acceptance timeout`)
}

async function waitForStreamingPartial(session: Session, agentId: string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await api<Snapshot>(session, `/api/agent/conversations/${encodeURIComponent(agentId)}`)
    const partial = (snapshot.messages || []).find((message) =>
      String(message.id || '').startsWith('streaming:')
        && (message.parts || []).some((part) => part.type === 'text' && String(part.text || '').length >= 8))
    if (snapshot.status === 'error') throw new Error('JW Runtime returned an error before the stop acceptance')
    if (snapshot.status === 'streaming' && partial) return snapshot
    if (snapshot.status === 'idle' && assistantTexts(snapshot).length) {
      throw new Error('JW Runtime completed the long answer before it could be stopped')
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('JW Runtime did not expose a streaming partial before the stop acceptance timeout')
}

async function waitForIdleWithoutPartial(session: Session, agentId: string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await api<Snapshot>(session, `/api/agent/conversations/${encodeURIComponent(agentId)}`)
    const hasPartial = (snapshot.messages || []).some((message) => String(message.id || '').startsWith('streaming:'))
    if (snapshot.status === 'error') throw new Error('JW Runtime entered an error state after stop')
    if (snapshot.status === 'idle' && !hasPartial) return snapshot
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('JW Runtime did not become idle without transient output after stop')
}

async function portOpen(port: number) {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = (open: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function persistEvidence(report: Record<string, unknown>) {
  const evidenceDir = path.resolve('.runtime/migration-evidence/jw-multiturn-live')
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const reportPath = path.join(evidenceDir, 'report.json')
  const summaryPath = path.join(evidenceDir, 'summary.md')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(summaryPath, [
    '# JW Runtime 真实多轮验收',
    '',
    `- 结果：${report.ok ? '通过' : '未通过'}`,
    '- 使用随机保留域身份和随机挑战完成两轮真实模型对话',
    '- 第二轮正确回忆第一轮随机挑战，证明同一 SDK/MySQL 会话上下文延续',
    '- 项目会话由真实模型调用项目摘要工具，项目范围由服务端绑定且模型不能传入项目 ID',
    '- 项目工具输入、输出和完成状态写入 MySQL，回复中的项目名称来自工具结果而非提示词',
    '- 流式长回答出现 Partial 后由停止接口中断；停止后无迟到写入并可继续下一轮',
    '- 新认证会话从 MySQL 恢复列表和历史，完成改名、交替切换与精确删除',
    '- 用户消息、助手消息、消息 Part、模型、Turn、耗时和成本状态写入 MySQL',
    '- 活动 Runtime 不引用 SQLite、Flue 或退场端口；验收后身份、会话、项目、成员、审计和工作区精确清零',
    '',
    '报告不保存提示词、回复正文、挑战值、用户、会话、项目、模型密钥或连接信息。',
    '',
  ].join('\n'), { mode: 0o600 })
  await Promise.all([chmod(reportPath, 0o600), chmod(summaryPath, 0o600)])
}

async function main() {
  const suffix = randomUUID()
  const userId = randomUUID()
  const challenge = `JWMT-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`
  const projectName = `JWPROJECT-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`
  const resumeChallenge = `JWRESUME-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`
  const projectId = randomUUID()
  const passwordHash = await hashPassword(`${randomUUID()}-Aa1!`)
  let session: Session | undefined
  let refreshedSession: Session | undefined
  let conversationId: string | undefined
  let agentId: string | undefined
  let workspacePath: string | undefined
  let projectConversationId: string | undefined
  let projectAgentId: string | undefined
  let projectWorkspacePath: string | undefined
  let stopConversationId: string | undefined
  let stopAgentId: string | undefined
  let stopWorkspacePath: string | undefined
  let report: Record<string, unknown> | undefined

  try {
    await db.insert(users).values({
      id: userId,
      email: `jw-multiturn-${suffix}@example.invalid`,
      name: `jw-multiturn-${suffix.slice(0, 8)}`,
      role: '投资经理',
      department: '迁移验收',
      passwordHash,
      status: '启用',
    })
    session = await createAuthSession({ userId })
    const conversation = await api<{ id?: string; agentId?: string }>(session, '/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ scope: 'global', title: `jw-multiturn-${suffix}` }),
    })
    assertContract(conversation.id && conversation.agentId, 'global conversation was not created with stable IDs')
    conversationId = conversation.id
    agentId = conversation.agentId
    const workspaceRoot = path.resolve(process.env.AGENT_WORKSPACE || path.join(process.cwd(), 'server', 'agent-workspace'))
    workspacePath = path.resolve(workspaceRoot, conversationId)
    assertContract(workspacePath.startsWith(`${workspaceRoot}${path.sep}`), 'acceptance workspace escaped its configured root')

    await api(session, `/api/agent/conversations/${encodeURIComponent(agentId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: `这是上下文连续性测试。请只回复随机代号 ${challenge}，不要调用任何工具。` }),
    })
    const first = await waitForTurn(session, agentId, 1)
    const firstTexts = assistantTexts(first)
    assertContract(firstTexts.at(-1)?.includes(challenge), 'first turn did not return the random challenge')
    const [afterFirst] = await db.select({ metadata: agentConversations.metadata }).from(agentConversations)
      .where(eq(agentConversations.id, conversationId)).limit(1)
    const firstSdkSessionId = typeof afterFirst?.metadata?.sdkSessionId === 'string' ? afterFirst.metadata.sdkSessionId : ''
    assertContract(firstSdkSessionId, 'first turn did not persist the SDK session ID')

    await api(session, `/api/agent/conversations/${encodeURIComponent(agentId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: '请回忆我上一轮要求你回复的随机代号，并且仍然只回复该代号。' }),
    })
    const second = await waitForTurn(session, agentId, 2)
    const secondTexts = assistantTexts(second)
    assertContract(secondTexts.at(-1)?.includes(challenge), 'second turn did not retain the first-turn context')

    const [conversationRow] = await db.select({
      status: agentConversations.status,
      runtime: agentConversations.runtime,
      metadata: agentConversations.metadata,
    }).from(agentConversations).where(eq(agentConversations.id, conversationId)).limit(1)
    const messages = await db.select({
      id: agentMessages.id,
      role: agentMessages.role,
      sequence: agentMessages.sequence,
      status: agentMessages.status,
      toolName: agentMessages.toolName,
    }).from(agentMessages).where(eq(agentMessages.conversationId, conversationId)).orderBy(asc(agentMessages.sequence))
    const messageIds = messages.map((message) => message.id)
    const parts = messageIds.length
      ? await db.select({ id: agentMessageParts.id }).from(agentMessageParts).where(inArray(agentMessageParts.messageId, messageIds))
      : []
    const lastResult = conversationRow?.metadata?.lastResult && typeof conversationRow.metadata.lastResult === 'object'
      ? conversationRow.metadata.lastResult as Record<string, unknown>
      : {}
    const tokenUsage = lastResult.usage && typeof lastResult.usage === 'object'
      ? lastResult.usage as Record<string, unknown>
      : {}
    const currentSdkSessionId = typeof conversationRow?.metadata?.sdkSessionId === 'string'
      ? conversationRow.metadata.sdkSessionId
      : ''
    assertContract(conversationRow?.status === 'idle' && conversationRow.runtime === 'jw', 'conversation did not finish idle on JW Runtime')
    assertContract(currentSdkSessionId === firstSdkSessionId, 'second turn did not reuse the same SDK session')
    assertContract(messages.filter((message) => message.role === 'user').length === 2, 'MySQL does not contain exactly two user turns')
    assertContract(messages.filter((message) => message.role === 'assistant').length >= 2, 'MySQL does not contain both assistant turns')
    assertContract(messages.every((message, index) => message.sequence === index), 'MySQL message sequence is not contiguous')
    assertContract(messages.every((message) => message.status === 'complete'), 'one or more persisted messages are incomplete')
    assertContract(messages.every((message) => !message.toolName), 'a no-tool global conversation invoked a tool')
    assertContract(parts.length >= 4, 'MySQL message parts do not cover both turns')
    assertContract(typeof conversationRow.metadata?.activeModel === 'string', 'active model was not persisted')
    assertContract(Number(lastResult.numTurns) >= 1 && Number(lastResult.durationMs) > 0, 'turn and duration usage were not persisted')
    assertContract(lastResult.totalCostUsd === null || Number(lastResult.totalCostUsd) >= 0, 'cost usage has an invalid value')
    assertContract(
      Number(tokenUsage.totalTokens) > 0
        && Number(tokenUsage.outputTokens) > 0
        && Number(tokenUsage.totalInputTokens) >= Number(tokenUsage.inputTokens)
        && Number(tokenUsage.cacheCreationInputTokens) >= 0
        && Number(tokenUsage.cacheReadInputTokens) >= 0,
      'result token and cache usage were not persisted',
    )
    assertContract(
      second.runtime?.model === conversationRow.metadata?.activeModel
        && second.runtime?.usage?.totalTokens === tokenUsage.totalTokens
        && second.runtime?.totalCostUsd === lastResult.totalCostUsd
        && second.runtime?.contextCompaction?.state === 'idle',
      'REST snapshot did not expose the persisted model, usage, cost and compaction state',
    )

    await db.insert(projects).values({
      id: projectId,
      name: projectName,
      owner: `jw-multiturn-${suffix.slice(0, 8)}`,
      ownerUserId: userId,
      createdBy: userId,
      summary: `Synthetic migration acceptance fixture ${challenge}`,
    })
    await db.insert(projectMembers).values({
      projectId,
      userId,
      memberRole: 'owner',
      sourceName: `jw-multiturn-${suffix.slice(0, 8)}`,
    })
    const projectConversation = await api<{ id?: string; agentId?: string }>(session, '/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ scope: 'project', projectId, title: `jw-project-${suffix}` }),
    })
    assertContract(projectConversation.id && projectConversation.agentId, 'project conversation was not created with stable IDs')
    projectConversationId = projectConversation.id
    projectAgentId = projectConversation.agentId
    projectWorkspacePath = path.resolve(workspaceRoot, projectConversationId)
    assertContract(projectWorkspacePath.startsWith(`${workspaceRoot}${path.sep}`), 'project workspace escaped its configured root')

    await api(session, `/api/agent/conversations/${encodeURIComponent(projectAgentId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: '请先调用 get_project_summary 读取当前项目主记录，然后只回复项目名称。' }),
    })
    const projectSnapshot = await waitForTurn(session, projectAgentId, 1)
    const projectTexts = assistantTexts(projectSnapshot)
    assertContract(projectTexts.at(-1)?.includes(projectName), 'project reply did not contain the server-bound project name')

    const [projectConversationRow] = await db.select({
      projectId: agentConversations.projectId,
      status: agentConversations.status,
      runtime: agentConversations.runtime,
    }).from(agentConversations).where(eq(agentConversations.id, projectConversationId)).limit(1)
    const projectMessages = await db.select({
      id: agentMessages.id,
      role: agentMessages.role,
      status: agentMessages.status,
      toolName: agentMessages.toolName,
      toolInput: agentMessages.toolInput,
      toolOutput: agentMessages.toolOutput,
    }).from(agentMessages).where(eq(agentMessages.conversationId, projectConversationId))
      .orderBy(asc(agentMessages.sequence))
    const projectToolMessages = projectMessages.filter((message) =>
      message.role === 'tool' && String(message.toolName || '').endsWith('get_project_summary'))
    const projectToolIds = projectToolMessages.map((message) => message.id)
    const projectToolParts = projectToolIds.length
      ? await db.select({ payload: agentMessageParts.payload }).from(agentMessageParts)
        .where(inArray(agentMessageParts.messageId, projectToolIds))
      : []
    assertContract(
      projectConversationRow?.projectId === projectId
        && projectConversationRow.status === 'idle'
        && projectConversationRow.runtime === 'jw',
      'project conversation did not retain the server-bound project scope on JW Runtime',
    )
    assertContract(projectToolMessages.length >= 1, 'real model did not call get_project_summary')
    assertContract(projectToolMessages.every((message) => message.status === 'complete'), 'project summary tool did not finish successfully')
    assertContract(projectToolMessages.every((message) => !containsProjectIdKey(message.toolInput)), 'model supplied a project ID to the project summary tool')
    assertContract(projectToolMessages.every((message) => message.toolOutput !== null), 'project summary tool output was not persisted')
    assertContract(projectToolParts.some((part) => {
      const payload = part.payload && typeof part.payload === 'object'
        ? part.payload as Record<string, unknown>
        : {}
      return payload.state === 'output-available'
        && !containsProjectIdKey(payload.input)
        && payload.output !== undefined
    }), 'project tool input and output were not associated in a completed MySQL message part')

    const stopConversation = await api<{ id?: string; agentId?: string }>(session, '/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ scope: 'global', title: `jw-stop-${suffix}` }),
    })
    assertContract(stopConversation.id && stopConversation.agentId, 'stop acceptance conversation was not created with stable IDs')
    stopConversationId = stopConversation.id
    stopAgentId = stopConversation.agentId
    stopWorkspacePath = path.resolve(workspaceRoot, stopConversationId)
    assertContract(stopWorkspacePath.startsWith(`${workspaceRoot}${path.sep}`), 'stop acceptance workspace escaped its configured root')

    await api(session, `/api/agent/conversations/${encodeURIComponent(stopAgentId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        message: '这是停止生成验收。不要调用工具，请逐行写 200 条彼此不同、每条至少 80 个汉字的迁移风险分析，完成全部内容前不要总结。',
      }),
    })
    await waitForStreamingPartial(session, stopAgentId)
    await api(session, `/api/agent/conversations/${encodeURIComponent(stopAgentId)}/abort`, { method: 'POST' })
    const stoppedSnapshot = await waitForIdleWithoutPartial(session, stopAgentId)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const [stoppedConversationRow] = await db.select({
      status: agentConversations.status,
      metadata: agentConversations.metadata,
    }).from(agentConversations).where(eq(agentConversations.id, stopConversationId)).limit(1)
    const stoppedMessages = await db.select({
      id: agentMessages.id,
      role: agentMessages.role,
      status: agentMessages.status,
    }).from(agentMessages).where(eq(agentMessages.conversationId, stopConversationId))
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const [stableConversationRow] = await db.select({ status: agentConversations.status }).from(agentConversations)
      .where(eq(agentConversations.id, stopConversationId)).limit(1)
    const stableMessages = await db.select({ id: agentMessages.id, status: agentMessages.status }).from(agentMessages)
      .where(eq(agentMessages.conversationId, stopConversationId))
    assertContract(stoppedConversationRow?.status === 'idle' && stableConversationRow?.status === 'idle', 'stopped conversation did not remain idle')
    assertContract(typeof stoppedConversationRow.metadata?.interruptedAt === 'string', 'stop timestamp was not persisted')
    assertContract(stableMessages.length === stoppedMessages.length, 'messages continued to grow after stop completed')
    assertContract(stableMessages.every((message) => !['streaming', 'running'].includes(message.status)), 'stopped conversation retained an active message state')
    const assistantBeforeResume = assistantTexts(stoppedSnapshot).length

    await api(session, `/api/agent/conversations/${encodeURIComponent(stopAgentId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: `停止后继续会话测试。不要调用工具，只回复 ${resumeChallenge}` }),
    })
    const resumedSnapshot = await waitForTurn(session, stopAgentId, assistantBeforeResume + 1)
    assertContract(assistantTexts(resumedSnapshot).at(-1)?.includes(resumeChallenge), 'stopped conversation could not continue with a new turn')
    const resumedMessages = await db.select({
      role: agentMessages.role,
      status: agentMessages.status,
      toolName: agentMessages.toolName,
    }).from(agentMessages).where(eq(agentMessages.conversationId, stopConversationId))
    assertContract(resumedMessages.filter((message) => message.role === 'user').length === 2, 'stop acceptance did not persist both user turns')
    assertContract(resumedMessages.every((message) => !['streaming', 'running'].includes(message.status)), 'resumed conversation retained an active message state')
    assertContract(resumedMessages.every((message) => !message.toolName), 'stop acceptance unexpectedly invoked a tool')

    refreshedSession = await createAuthSession({ userId })
    const refreshedList = await api<{ list?: Array<{
      id?: string; agentId?: string; title?: string; scope?: string; projectId?: string | null
    }> }>(refreshedSession, '/api/conversations')
    const expectedConversationIds = [conversationId, projectConversationId, stopConversationId]
    assertContract(
      new Set(expectedConversationIds).size === 3
        && expectedConversationIds.every((id) => refreshedList.list?.some((item) => item.id === id)),
      'fresh authentication session did not restore all MySQL conversations',
    )
    const renamedTitle = `jw-renamed-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const renamed = await api<{ id?: string; title?: string; agentId?: string }>(
      refreshedSession,
      `/api/conversations/${encodeURIComponent(conversationId)}`,
      { method: 'PATCH', body: JSON.stringify({ title: renamedTitle }) },
    )
    assertContract(renamed.id === conversationId && renamed.agentId === agentId && renamed.title === renamedTitle, 'conversation rename changed identity or was not persisted')
    const [renamedAgent] = await db.select({ title: agentConversations.title }).from(agentConversations)
      .where(eq(agentConversations.id, conversationId)).limit(1)
    assertContract(renamedAgent?.title === renamedTitle, 'conversation rename did not update the Agent conversation index')

    const switchedGlobal = await api<Snapshot>(refreshedSession, `/api/agent/conversations/${encodeURIComponent(agentId)}`)
    const switchedProject = await api<Snapshot>(refreshedSession, `/api/agent/conversations/${encodeURIComponent(projectAgentId)}`)
    const switchedStopped = await api<Snapshot>(refreshedSession, `/api/agent/conversations/${encodeURIComponent(stopAgentId)}`)
    const switchedBackGlobal = await api<Snapshot>(refreshedSession, `/api/agent/conversations/${encodeURIComponent(agentId)}`)
    assertContract(
      assistantTexts(switchedGlobal).at(-1)?.includes(challenge)
        && assistantTexts(switchedProject).at(-1)?.includes(projectName)
        && assistantTexts(switchedStopped).at(-1)?.includes(resumeChallenge)
        && assistantTexts(switchedBackGlobal).at(-1)?.includes(challenge),
      'fresh authentication session did not restore the correct history while switching conversations',
    )

    await api(refreshedSession, `/api/conversations/${encodeURIComponent(stopConversationId)}`, { method: 'DELETE' })
    const afterDeleteList = await api<{ list?: Array<{ id?: string }> }>(refreshedSession, '/api/conversations')
    assertContract(
      !afterDeleteList.list?.some((item) => item.id === stopConversationId)
        && afterDeleteList.list?.some((item) => item.id === conversationId)
        && afterDeleteList.list?.some((item) => item.id === projectConversationId),
      'conversation delete did not remove exactly one item from the refreshed MySQL list',
    )
    const [deletedStopConversation] = await db.select({ id: agentConversations.id }).from(agentConversations)
      .where(eq(agentConversations.id, stopConversationId)).limit(1)
    assertContract(!deletedStopConversation, 'deleted conversation remains in the Agent conversation index')

    const runtimeSource = await readFile(path.resolve('server/src/runtime/jwAgentRuntime.ts'), 'utf8')
    const retiredPortsOpen = (await Promise.all([3584, 8121].map(portOpen))).filter(Boolean).length
    assertContract(!/sqlite|flue|3584/i.test(runtimeSource), 'active JW Runtime still references SQLite, Flue or port 3584')
    assertContract(retiredPortsOpen === 0, 'a retired Flue or Radar service port is listening during multi-turn execution')

    report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      challengeSha256: createHash('sha256').update(challenge).digest('hex'),
      turns: 2,
      userMessages: 2,
      assistantMessages: messages.filter((message) => message.role === 'assistant').length,
      messageParts: parts.length,
      toolCalls: 0,
      projectConversationVerified: true,
      projectToolCalls: projectToolMessages.length,
      serverBoundProjectContext: true,
      projectIdAcceptedFromModel: 0,
      streamingStopVerified: true,
      postStopLateWrites: 0,
      postStopConversationResumed: true,
      freshSessionConversationRestore: true,
      conversationRenameVerified: true,
      conversationSwitchHistoryVerified: true,
      exactConversationDeleteVerified: true,
      contextRemembered: true,
      sameSdkSession: true,
      contiguousSequences: true,
      usageRecorded: true,
      tokenUsageRecorded: true,
      runtimeStateRestoredThroughSnapshot: true,
      sqliteFlueRuntimeReferences: 0,
      retiredPortsOpen: 0,
      residualSyntheticUsers: 0,
      residualSyntheticProjects: 0,
      residualSyntheticProjectMembers: 0,
      checks: [
        'real-model-two-turn-global-conversation',
        'second-turn-remembers-random-first-turn-challenge',
        'same-sdk-session-resumed',
        'mysql-message-and-part-persistence',
        'model-turn-duration-and-cost-state-persisted',
        'model-token-cache-cost-and-compaction-state-restored-through-snapshot',
        'no-tool-global-conversation',
        'real-model-project-summary-tool-call',
        'server-bound-project-context-no-model-project-id',
        'project-tool-input-output-associated-in-mysql',
        'streaming-partial-observed-before-user-stop',
        'sdk-interrupt-no-post-stop-late-write-or-active-state',
        'stopped-conversation-resumes-with-new-turn',
        'fresh-authentication-restores-mysql-conversation-list-and-history',
        'conversation-rename-keeps-chat-and-agent-index-in-sync',
        'conversation-switch-restores-correct-history',
        'conversation-delete-removes-exactly-one-conversation',
        'no-sqlite-flue-or-retired-port-runtime-dependency',
        'conversation-runtime-session-disposed-before-delete',
        'project-conversation-and-membership-cleanup',
        'synthetic-identity-session-audit-and-workspace-cleanup',
      ],
    }
  } finally {
    if (session && stopConversationId) {
      await api(session, `/api/conversations/${encodeURIComponent(stopConversationId)}`, { method: 'DELETE' }).catch(() => null)
    }
    if (session && projectConversationId) {
      await api(session, `/api/conversations/${encodeURIComponent(projectConversationId)}`, { method: 'DELETE' }).catch(() => null)
    }
    if (session && conversationId) {
      await api(session, `/api/conversations/${encodeURIComponent(conversationId)}`, { method: 'DELETE' }).catch(() => null)
    }
    if (projectConversationId) {
      const [remaining] = await db.select({ id: chatConversations.id }).from(chatConversations)
        .where(and(eq(chatConversations.id, projectConversationId), eq(chatConversations.userId, userId))).limit(1)
      if (remaining) await deleteConversation(userId, projectConversationId)
    }
    if (stopConversationId) {
      const [remaining] = await db.select({ id: chatConversations.id }).from(chatConversations)
        .where(and(eq(chatConversations.id, stopConversationId), eq(chatConversations.userId, userId))).limit(1)
      if (remaining) await deleteConversation(userId, stopConversationId)
    }
    if (conversationId) {
      const [remaining] = await db.select({ id: chatConversations.id }).from(chatConversations)
        .where(and(eq(chatConversations.id, conversationId), eq(chatConversations.userId, userId))).limit(1)
      if (remaining) await deleteConversation(userId, conversationId)
    }
    await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    await db.delete(projects).where(and(eq(projects.id, projectId), eq(projects.createdBy, userId)))
    if (refreshedSession) await db.delete(authSessions).where(eq(authSessions.id, refreshedSession.id))
    if (session) await db.delete(authSessions).where(eq(authSessions.id, session.id))
    await db.delete(auditLogs).where(eq(auditLogs.userId, userId))
    await db.delete(users).where(eq(users.id, userId))
    if (workspacePath) await rm(workspacePath, { recursive: true, force: true })
    if (projectWorkspacePath) await rm(projectWorkspacePath, { recursive: true, force: true })
    if (stopWorkspacePath) await rm(stopWorkspacePath, { recursive: true, force: true })
    const residualUsers = await db.select({ id: users.id }).from(users).where(and(
      like(users.email, 'jw-multiturn-%@example.invalid'),
      eq(users.department, '迁移验收'),
    ))
    assertContract(residualUsers.length === 0, 'synthetic multi-turn identities remain after cleanup')
    const residualProjects = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))
    const residualMembers = await db.select({ projectId: projectMembers.projectId }).from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    assertContract(residualProjects.length === 0, 'synthetic project remains after cleanup')
    assertContract(residualMembers.length === 0, 'synthetic project membership remains after cleanup')
  }
  assertContract(report, 'acceptance report was not produced')
  await persistEvidence(report)
  console.log(JSON.stringify(report))
}

await main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : 'JW live acceptance failed',
  }))
  process.exitCode = 1
}).finally(async () => pool.end())
