import { randomUUID } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { io, type Socket } from 'socket.io-client'
import { and, eq, inArray, like } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { agentMessages, auditLogs, authSessions, projects, users } from '../db/schema.js'
import { createAuthSession, hashPassword } from '../services/authService.js'
import { createConversation, deleteConversation } from '../services/conversationService.js'

const baseUrl = process.env.SOCKET_ACCEPTANCE_URL || 'http://127.0.0.1:3100'
let transientConnectFailures = 0
let transientSubscriptionFailures = 0

type AcceptanceSession = Awaited<ReturnType<typeof createAuthSession>>

type CleanupState = {
  sockets: Socket[]
  sessionIds: string[]
  conversationIds: string[]
  ownerId: string
  projectId?: string
  userIds: string[]
}

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[socket acceptance] ${message}`)
}

function boundedEnvInt(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}

function cookieFor(session: AcceptanceSession): string {
  return `cybernaut_session=${encodeURIComponent(session.sessionToken)}; cybernaut_csrf=${encodeURIComponent(session.csrfToken)}`
}

function connect(session: AcceptanceSession): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      path: '/socket.io',
      extraHeaders: { Cookie: cookieFor(session) },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5_000,
    })
    const timer = setTimeout(() => {
      socket.disconnect()
      reject(new Error('Socket connect timeout'))
    }, 6_000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('connect_error', (error) => {
      clearTimeout(timer)
      socket.disconnect()
      reject(error)
    })
  })
}

async function connectWithRetry(session: AcceptanceSession, maxAttempts: number): Promise<Socket> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await connect(session)
    } catch (error) {
      lastError = error
      const code = (error as Error & { data?: { code?: string } }).data?.code
      if (code !== 'SOCKET_ERROR' || attempt === maxAttempts) throw error
      transientConnectFailures += 1
      await new Promise((resolve) => setTimeout(resolve, 50 * (2 ** (attempt - 1))))
    }
  }
  throw lastError
}

function subscribe(socket: Socket, agentId: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket subscribe timeout')), 5_000)
    socket.emit('agent:subscribe', { agentId }, (result: Record<string, unknown>) => {
      clearTimeout(timer)
      resolve(result)
    })
  })
}

async function subscribeWithRetry(socket: Socket, agentId: string, maxAttempts: number) {
  let lastResult: Record<string, unknown> | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await subscribe(socket, agentId)
    lastResult = result
    const code = (result.error as { code?: string } | undefined)?.code
    if (result.ok === true || code !== 'SOCKET_ERROR' || attempt === maxAttempts) return result
    transientSubscriptionFailures += 1
    await new Promise((resolve) => setTimeout(resolve, 50 * (2 ** (attempt - 1))))
  }
  return lastResult || { ok: false, error: { code: 'SOCKET_ERROR', message: '订阅未返回结果' } }
}

function waitForSnapshot(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket snapshot timeout')), 5_000)
    socket.once('agent:snapshot', (snapshot: Record<string, unknown>) => {
      clearTimeout(timer)
      resolve(snapshot)
    })
  })
}

function waitForDisconnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket was not disconnected')), 5_000)
    socket.once('disconnect', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function invalidSessionRejected(): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = io(baseUrl, {
      path: '/socket.io',
      extraHeaders: { Cookie: 'cybernaut_session=invalid-session' },
      transports: ['websocket'],
      reconnection: false,
      timeout: 3_000,
    })
    const timer = setTimeout(() => { socket.disconnect(); resolve(false) }, 4_000)
    socket.once('connect', () => { clearTimeout(timer); socket.disconnect(); resolve(false) })
    socket.once('connect_error', () => { clearTimeout(timer); socket.disconnect(); resolve(true) })
  })
}

type SocketLifecycleMetrics = {
  acceptedTotal: number
  disconnectedTotal: number
  reconnectedTotal: number
  pendingReconnects: number
  disconnectRecoveryRate: number
  identitiesExcluded: boolean
}

async function socketLifecycle(session: AcceptanceSession): Promise<SocketLifecycleMetrics> {
  const response = await fetch(`${baseUrl}/api/operations/metrics`, {
    headers: { Cookie: cookieFor(session) },
  })
  assertContract(response.ok, `operations metrics returned HTTP ${response.status}`)
  const snapshot = await response.json() as { components?: Array<Record<string, unknown>> }
  const component = snapshot.components?.find((entry) => entry.name === 'agent-socket')
  assertContract(component && typeof component.lifecycle === 'object', 'agent Socket lifecycle metrics are missing')
  return component.lifecycle as SocketLifecycleMetrics
}

async function waitForDisconnectedTotal(session: AcceptanceSession, minimum: number) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const lifecycle = await socketLifecycle(session)
    if (lifecycle.disconnectedTotal >= minimum) return lifecycle
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`[socket acceptance] server did not observe ${minimum} disconnects in time`)
}

async function persistEvidence(report: Record<string, unknown>) {
  const evidenceDir = path.resolve('.runtime/migration-evidence/socket-pressure')
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const reportPath = path.join(evidenceDir, 'report.json')
  const summaryPath = path.join(evidenceDir, 'summary.md')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(summaryPath, [
    '# Socket 并发与恢复验收',
    '',
    `- 结果：${report.ok ? '通过' : '未通过'}`,
    `- 并发连接：${report.connections}`,
    `- 并发 Agent 会话：${report.conversations}`,
    `- 全量重连轮次：${report.reconnectRounds}`,
    `- 断线窗口确认消息：${report.disconnectedConfirmedMessages}`,
    `- 重连快照丢失/重复：${report.reconnectSnapshotsWithLostMessages}/${report.reconnectSnapshotsWithDuplicateMessages}`,
    `- 瞬时过载退避重试：${report.transientConnectFailures}`,
    `- 瞬时订阅退避重试：${report.transientSubscriptionFailures}`,
    '- 测试只使用随机保留域身份，结束后按用户、会话、项目和认证会话精确清零',
    '- 报告不保存用户、项目、会话、Socket、Cookie、CSRF 或请求标识',
    '',
  ].join('\n'), { mode: 0o600 })
  await Promise.all([chmod(reportPath, 0o600), chmod(summaryPath, 0o600)])
}

async function cleanupAcceptanceState(state: CleanupState) {
  for (const socket of state.sockets) socket.disconnect()
  if (state.sessionIds.length) await db.delete(authSessions).where(inArray(authSessions.id, state.sessionIds))
  for (const conversationId of [...state.conversationIds].reverse()) {
    await deleteConversation(state.ownerId, conversationId)
  }
  if (state.projectId) await db.delete(projects).where(inArray(projects.id, [state.projectId]))
  await db.delete(auditLogs).where(inArray(auditLogs.userId, state.userIds))
  await db.delete(users).where(inArray(users.id, state.userIds))
  const residualUsers = await db.select({ id: users.id }).from(users).where(inArray(users.id, state.userIds))
  const residualSessions = state.sessionIds.length
    ? await db.select({ id: authSessions.id }).from(authSessions).where(inArray(authSessions.id, state.sessionIds))
    : []
  assertContract(residualUsers.length === 0 && residualSessions.length === 0, 'synthetic identities or sessions remain after cleanup')
  const residualSocketUsers = await db.select({ id: users.id }).from(users).where(and(
    like(users.email, 'socket-%@example.invalid'),
    eq(users.department, '迁移验收'),
  ))
  assertContract(residualSocketUsers.length === 0, 'stale Socket acceptance identities remain in the synthetic namespace')
}

async function main() {
  const connectionCount = boundedEnvInt('SOCKET_ACCEPTANCE_CONNECTIONS', 12, 4, 64)
  const conversationCount = boundedEnvInt('SOCKET_ACCEPTANCE_CONVERSATIONS', 6, 2, 16)
  const reconnectRounds = boundedEnvInt('SOCKET_ACCEPTANCE_RECONNECT_ROUNDS', 3, 2, 8)
  const connectRetryAttempts = boundedEnvInt('SOCKET_ACCEPTANCE_CONNECT_ATTEMPTS', 5, 2, 8)
  const suffix = randomUUID()
  const ownerId = randomUUID()
  const otherId = randomUUID()
  const state: CleanupState = {
    sockets: [],
    sessionIds: [],
    conversationIds: [],
    ownerId,
    userIds: [ownerId, otherId],
  }
  let report: Record<string, unknown> | undefined

  try {
    const [ownerPasswordHash, otherPasswordHash] = await Promise.all([
      hashPassword(`${randomUUID()}-Aa1!`),
      hashPassword(`${randomUUID()}-Bb2!`),
    ])
    await db.insert(users).values([
      {
        id: ownerId,
        email: `socket-owner-${suffix}@example.invalid`,
        name: `socket-owner-${suffix.slice(0, 8)}`,
        role: '系统管理员',
        department: '迁移验收',
        passwordHash: ownerPasswordHash,
        status: '启用',
      },
      {
        id: otherId,
        email: `socket-other-${suffix}@example.invalid`,
        name: `socket-other-${suffix.slice(0, 8)}`,
        role: '投资经理',
        department: '迁移验收',
        passwordHash: otherPasswordHash,
        status: '启用',
      },
    ])

    const [project] = await db.insert(projects).values({
      name: `socket-isolation-${suffix}`,
      owner: `socket-owner-${suffix.slice(0, 8)}`,
      ownerUserId: ownerId,
      createdBy: ownerId,
    }).$returningId()
    state.projectId = project.id

    const conversations = []
    for (let index = 0; index < conversationCount; index += 1) {
      const conversation = await createConversation(ownerId, {
        title: `socket-acceptance-${index}-${suffix}`,
        scope: 'project',
        projectId: project.id,
      })
      assertContract(conversation.agentId, `conversation ${index} has no Agent ID`)
      conversations.push(conversation)
      state.conversationIds.push(conversation.id)
    }
    const agentIds = conversations.map((conversation) => conversation.agentId as string)

    const ownerSession = await createAuthSession({ userId: ownerId })
    const otherSession = await createAuthSession({ userId: otherId })
    state.sessionIds.push(ownerSession.id, otherSession.id)

    const ownerSockets = await Promise.all(Array.from({ length: connectionCount }, () => connectWithRetry(ownerSession, connectRetryAttempts)))
    state.sockets.push(...ownerSockets)
    const initialSubscriptions = await Promise.all(ownerSockets.map((socket, index) => subscribeWithRetry(
      socket,
      agentIds[index % agentIds.length]!,
      connectRetryAttempts,
    )))
    assertContract(initialSubscriptions.every((result) => result.ok === true), 'one or more concurrent owner subscriptions failed')

    const otherSocket = await connectWithRetry(otherSession, connectRetryAttempts)
    state.sockets.push(otherSocket)
    const crossUser = await subscribe(otherSocket, agentIds[0]!)
    assertContract(
      crossUser.ok === false && (crossUser.error as { code?: string } | undefined)?.code === 'NOT_FOUND',
      `cross-user subscription was not rejected: ${JSON.stringify(crossUser)}`,
    )
    const crossProjectCreate = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor(otherSession),
        'X-CSRF-Token': otherSession.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scope: 'project', projectId: project.id, title: 'unauthorized' }),
    })
    assertContract(crossProjectCreate.status === 403, `cross-project conversation creation returned HTTP ${crossProjectCreate.status}`)

    const disabledDisconnect = waitForDisconnect(otherSocket)
    await db.update(users).set({ status: '禁用' }).where(inArray(users.id, [otherId]))
    const disabledRestResponse = await fetch(`${baseUrl}/api/users`, {
      headers: { Cookie: cookieFor(otherSession) },
    })
    assertContract(disabledRestResponse.status === 401, `disabled REST session returned HTTP ${disabledRestResponse.status}`)
    await disabledDisconnect
    await db.update(users).set({ status: '启用' }).where(inArray(users.id, [otherId]))

    const snapshotPromises = ownerSockets.map((socket) => waitForSnapshot(socket))
    const abortResponses = await Promise.all(agentIds.map((agentId) => fetch(
      `${baseUrl}/api/agent/conversations/${encodeURIComponent(agentId)}/abort`,
      {
        method: 'POST',
        headers: {
          Cookie: cookieFor(ownerSession),
          'X-CSRF-Token': ownerSession.csrfToken,
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    )))
    assertContract(abortResponses.every((response) => response.ok), 'one or more concurrent abort requests failed')
    const snapshots = await Promise.all(snapshotPromises)
    assertContract(
      snapshots.every((snapshot, index) => snapshot.id === agentIds[index % agentIds.length]),
      'broadcast snapshot was missing or delivered to the wrong conversation room',
    )

    let activeSockets = ownerSockets
    const disconnectedConfirmedMessageIds: string[] = []
    const reconnectBaseline = await socketLifecycle(ownerSession)
    let expectedDisconnectedTotal = reconnectBaseline.disconnectedTotal
    for (let round = 0; round < reconnectRounds; round += 1) {
      for (const socket of activeSockets) socket.disconnect()
      expectedDisconnectedTotal += connectionCount
      await waitForDisconnectedTotal(ownerSession, expectedDisconnectedTotal)
      const confirmedMessageId = randomUUID()
      disconnectedConfirmedMessageIds.push(confirmedMessageId)
      await db.insert(agentMessages).values({
        id: confirmedMessageId,
        conversationId: conversations[0]!.id,
        externalMessageId: `socket-reconnect-${round}-${suffix}`,
        role: 'assistant',
        sequence: round,
        content: `socket reconnect confirmed message ${round + 1}`,
        status: 'complete',
      })
      activeSockets = await Promise.all(Array.from({ length: connectionCount }, () => connectWithRetry(ownerSession, connectRetryAttempts)))
      state.sockets.push(...activeSockets)
      const subscriptions = await Promise.all(activeSockets.map((socket, index) => subscribeWithRetry(
        socket,
        agentIds[index % agentIds.length]!,
        connectRetryAttempts,
      )))
      assertContract(subscriptions.every((result) => result.ok === true), `reconnect round ${round + 1} subscription failed`)
      const firstConversationSnapshots = subscriptions
        .filter((_result, index) => agentIds[index % agentIds.length] === agentIds[0])
        .map((result) => result.snapshot as { messages?: Array<{ id?: string }> } | undefined)
      assertContract(firstConversationSnapshots.length > 0, `reconnect round ${round + 1} did not subscribe the confirmed-message conversation`)
      for (const snapshot of firstConversationSnapshots) {
        const ids = (snapshot?.messages || []).flatMap((message) => typeof message.id === 'string' ? [message.id] : [])
        assertContract(ids.length === new Set(ids).size, `reconnect round ${round + 1} returned duplicate message IDs`)
        assertContract(
          disconnectedConfirmedMessageIds.every((id) => ids.filter((candidate) => candidate === id).length === 1),
          `reconnect round ${round + 1} lost or duplicated a confirmed message`,
        )
      }
    }

    const persistedConfirmedMessages = await db.select({ id: agentMessages.id }).from(agentMessages)
      .where(inArray(agentMessages.id, disconnectedConfirmedMessageIds))
    assertContract(
      persistedConfirmedMessages.length === disconnectedConfirmedMessageIds.length,
      'confirmed messages were not persisted exactly once after reconnect rounds',
    )
    const reconnectLifecycle = await socketLifecycle(ownerSession)
    const expectedReconnects = connectionCount * reconnectRounds
    assertContract(
      reconnectLifecycle.reconnectedTotal - reconnectBaseline.reconnectedTotal === expectedReconnects,
      `server reconnect counter mismatch: ${JSON.stringify({
        expectedReconnects,
        observedReconnects: reconnectLifecycle.reconnectedTotal - reconnectBaseline.reconnectedTotal,
      })}`,
    )
    assertContract(
      reconnectLifecycle.identitiesExcluded === true
        && reconnectLifecycle.disconnectRecoveryRate >= 0
        && reconnectLifecycle.disconnectRecoveryRate <= 1,
      'Socket reconnect telemetry exposes identities or an invalid recovery rate',
    )

    assertContract(await invalidSessionRejected(), 'invalid session unexpectedly connected')
    const logoutDisconnects = activeSockets.map((socket) => waitForDisconnect(socket))
    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookieFor(ownerSession), 'X-CSRF-Token': ownerSession.csrfToken },
    })
    assertContract(logout.ok, `logout returned HTTP ${logout.status}`)
    await Promise.all(logoutDisconnects)

    report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      connections: connectionCount,
      conversations: conversationCount,
      reconnectRounds,
      connectRetryAttempts,
      totalSuccessfulConnections: connectionCount * (reconnectRounds + 1) + 1,
      transientConnectFailures,
      transientSubscriptionFailures,
      broadcastSnapshots: connectionCount,
      disconnectedConfirmedMessages: disconnectedConfirmedMessageIds.length,
      reconnectSnapshotsWithLostMessages: 0,
      reconnectSnapshotsWithDuplicateMessages: 0,
      observedReconnects: reconnectLifecycle.reconnectedTotal - reconnectBaseline.reconnectedTotal,
      disconnectRecoveryRate: reconnectLifecycle.disconnectRecoveryRate,
      crossUserSubscriptionsAccepted: 0,
      residualSyntheticUsers: 0,
      checks: [
        'cookie-handshake-auth',
        'concurrent-multi-connection-subscriptions',
        'concurrent-multi-conversation-room-isolation',
        'cross-user-isolation',
        'cross-project-create-rejection',
        'disabled-rest-rejection',
        'disabled-session-disconnect',
        'concurrent-snapshot-broadcast',
        'multi-round-full-reconnect',
        'server-reconnect-counter-and-recovery-rate',
        'reconnect-telemetry-excludes-identities',
        'disconnect-window-confirmed-messages-restored-exactly-once',
        'bounded-connect-retry-after-overload',
        'bounded-subscription-retry-after-overload',
        'invalid-session-rejection',
        'logout-all-session-sockets-disconnect',
        'synthetic-identity-exact-cleanup',
      ],
    }
  } finally {
    await cleanupAcceptanceState(state)
  }
  assertContract(report, 'acceptance report was not produced')
  await persistEvidence(report)
  console.log(JSON.stringify(report))
}

await main().finally(async () => pool.end())
