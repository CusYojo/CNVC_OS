import type { Server as HttpServer } from 'node:http'
import { Server as SocketServer, type Socket } from 'socket.io'
import { z } from 'zod'
import {
  authenticateSessionToken,
  authenticateToken,
  auditLegacyBearerUse,
  legacyBearerAllowed,
} from '../services/authService.js'
import {
  authenticateCookieHeader,
  requestOriginAllowed,
} from '../services/sessionAuthService.js'
import {
  getJwAgentSnapshot,
  getJwAgentSubscription,
} from './jwAgentRuntime.js'
import { subscribeJwAgentChanges } from './jwAgentEvents.js'
import { subscribeAuthInvalidations } from './authSessionEvents.js'

type Ack = (result: Record<string, unknown>) => void

const subscriptionSchema = z.object({ agentId: z.string().min(1).max(128) })
const authRevalidateMs = (() => {
  const value = Number(process.env.SOCKET_AUTH_REVALIDATE_MS || 60_000)
  if (!Number.isSafeInteger(value) || value < 1_000) {
    throw new Error('SOCKET_AUTH_REVALIDATE_MS must be an integer >= 1000')
  }
  return value
})()
const socketDbConcurrency = (() => {
  const value = Number(process.env.SOCKET_DB_CONCURRENCY || 8)
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error('SOCKET_DB_CONCURRENCY must be an integer between 1 and 32')
  }
  return value
})()
const socketReconnectWindowMs = (() => {
  const value = Number(process.env.SOCKET_RECONNECT_WINDOW_MS || 300_000)
  if (!Number.isSafeInteger(value) || value < 10_000 || value > 3_600_000) {
    throw new Error('SOCKET_RECONNECT_WINDOW_MS must be an integer between 10000 and 3600000')
  }
  return value
})()
let io: SocketServer | undefined
let unsubscribeChanges: (() => void) | undefined
let unsubscribeAuthInvalidations: (() => void) | undefined
let authTimer: NodeJS.Timeout | undefined
const broadcasting = new Set<string>()
const broadcastAgain = new Set<string>()
let activeSocketDbOperations = 0
const socketDbWaiters: Array<() => void> = []
const socketMetrics = {
  acceptedTotal: 0,
  disconnectedTotal: 0,
  authenticationFailuresTotal: 0,
  subscriptionFailuresTotal: 0,
  authorizationInvalidationsTotal: 0,
  reconnectedTotal: 0,
}
const reconnectCandidates = new Map<string, { pending: number; lastDisconnectedAt: number }>()
const reconnectCandidateLimit = 10_000

function pruneReconnectCandidates(now: number) {
  for (const [userId, candidate] of reconnectCandidates) {
    if (candidate.lastDisconnectedAt + socketReconnectWindowMs < now) reconnectCandidates.delete(userId)
  }
  while (reconnectCandidates.size > reconnectCandidateLimit) {
    const oldest = reconnectCandidates.keys().next().value
    if (typeof oldest !== 'string') break
    reconnectCandidates.delete(oldest)
  }
}

function recordSocketDisconnect(userId: string, now = Date.now()) {
  if (!userId) return
  pruneReconnectCandidates(now)
  const current = reconnectCandidates.get(userId)
  reconnectCandidates.delete(userId)
  reconnectCandidates.set(userId, {
    pending: Math.min(1_000, (current?.pending || 0) + 1),
    lastDisconnectedAt: now,
  })
  pruneReconnectCandidates(now)
}

function recordSocketConnection(userId: string, now = Date.now()) {
  if (!userId) return
  pruneReconnectCandidates(now)
  const current = reconnectCandidates.get(userId)
  if (!current || current.pending <= 0) return
  socketMetrics.reconnectedTotal += 1
  if (current.pending === 1) reconnectCandidates.delete(userId)
  else reconnectCandidates.set(userId, { ...current, pending: current.pending - 1 })
}

async function withSocketDbPermit<T>(operation: () => Promise<T>): Promise<T> {
  if (activeSocketDbOperations >= socketDbConcurrency) {
    await new Promise<void>((resolve) => socketDbWaiters.push(resolve))
  } else {
    activeSocketDbOperations += 1
  }
  try {
    return await operation()
  } finally {
    const next = socketDbWaiters.shift()
    if (next) next()
    else activeSocketDbOperations -= 1
  }
}

function readHandshakeToken(socket: Socket): string {
  const authToken = socket.handshake.auth?.token
  if (typeof authToken === 'string' && authToken.trim()) return authToken.trim()
  const header = socket.handshake.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7)
  throw Object.assign(new Error('未提供访问令牌'), { code: 'AUTH_REQUIRED' })
}

async function reauthenticateSocket(socket: Pick<Socket, 'data'>) {
  if (socket.data.authMode === 'session') {
    const authenticated = await authenticateSessionToken(String(socket.data.sessionToken || ''))
    socket.data.user = authenticated.user
    socket.data.sessionId = authenticated.session.id
    return
  }
  if (!legacyBearerAllowed()) throw Object.assign(new Error('Bearer 迁移窗口已关闭'), { code: 'AUTH_INVALID' })
  socket.data.user = await authenticateToken(String(socket.data.token || ''))
}

function publicSocketError(error: unknown) {
  const value = error as Error & { code?: string }
  const knownCode = value.code && /^(AUTH_|NOT_FOUND|INVALID_ARGUMENT)/.test(value.code)
  return {
    code: knownCode ? value.code : 'SOCKET_ERROR',
    message: knownCode ? value.message : '实时连接处理失败，请稍后重试',
  }
}

async function broadcastSnapshot(conversationId: string): Promise<void> {
  if (!io) return
  if (broadcasting.has(conversationId)) {
    broadcastAgain.add(conversationId)
    return
  }
  broadcasting.add(conversationId)
  try {
    const sockets = await io.in(`jw-agent:${conversationId}`).fetchSockets()
    await Promise.all(sockets.map(async (socket) => {
      const agentId = socket.data.subscriptions?.[conversationId]
      if (!agentId) return
      const snapshot = await withSocketDbPermit(() => getJwAgentSnapshot(socket.data.user.uid, agentId))
      if (!snapshot) {
        await socket.leave(`jw-agent:${conversationId}`)
        delete socket.data.subscriptions[conversationId]
        socket.emit('agent:error', { code: 'NOT_FOUND', message: '会话不存在或无权访问' })
        return
      }
      socket.emit('agent:snapshot', snapshot)
    }))
  } catch {
    console.error('[agent-socket] broadcast failed with an internal database or snapshot error')
  } finally {
    broadcasting.delete(conversationId)
    if (broadcastAgain.delete(conversationId)) void broadcastSnapshot(conversationId)
  }
}

export function initializeAgentSocket(httpServer: HttpServer): void {
  if (io) return
  io = new SocketServer(httpServer, {
    path: '/socket.io',
    serveClient: false,
    cors: { origin: true, credentials: true },
    transports: ['websocket', 'polling'],
  })
  io.use(async (socket, next) => {
    try {
      if (!requestOriginAllowed(socket.handshake.headers)) {
        throw Object.assign(new Error('实时连接来源不受信任'), { code: 'AUTH_ORIGIN' })
      }
      socket.data = await withSocketDbPermit(async () => {
        const cookieAuth = await authenticateCookieHeader(socket.handshake.headers.cookie)
        if (cookieAuth) {
          return {
            authMode: 'session',
            sessionToken: cookieAuth.sessionToken,
            sessionId: cookieAuth.sessionId,
            user: cookieAuth.user,
            subscriptions: {},
          }
        }
        if (!legacyBearerAllowed()) throw Object.assign(new Error('未提供有效登录会话'), { code: 'AUTH_REQUIRED' })
        const token = readHandshakeToken(socket)
        const user = await authenticateToken(token)
        await auditLegacyBearerUse({
          user,
          surface: 'socket',
          ipAddress: socket.handshake.address,
        })
        return {
          authMode: 'legacy-bearer',
          token,
          user,
          subscriptions: {},
        }
      })
      next()
    } catch (error) {
      socketMetrics.authenticationFailuresTotal += 1
      const safe = publicSocketError(error)
      next(Object.assign(new Error(safe.message), { data: safe }))
    }
  })
  io.on('connection', (socket) => {
    socketMetrics.acceptedTotal += 1
    const socketUserId = String(socket.data.user?.uid || '')
    recordSocketConnection(socketUserId)
    socket.on('disconnect', () => {
      socketMetrics.disconnectedTotal += 1
      recordSocketDisconnect(socketUserId)
    })
    socket.emit('agent:ready', { userId: socket.data.user.uid })
    socket.on('agent:subscribe', async (input: unknown, ack?: Ack) => {
      try {
        const { agentId } = subscriptionSchema.parse(input)
        const subscription = await withSocketDbPermit(async () => {
          await reauthenticateSocket(socket)
          return getJwAgentSubscription(socket.data.user.uid, agentId)
        })
        if (!subscription) {
          socketMetrics.subscriptionFailuresTotal += 1
          const notFound = { code: 'NOT_FOUND', message: '会话不存在或无权访问' }
          ack?.({ ok: false, error: notFound })
          return
        }
        socket.data.subscriptions[subscription.conversationId] = agentId
        await socket.join(`jw-agent:${subscription.conversationId}`)
        ack?.({ ok: true, snapshot: subscription.snapshot })
      } catch (error) {
        socketMetrics.subscriptionFailuresTotal += 1
        ack?.({ ok: false, error: publicSocketError(error) })
      }
    })
    socket.on('agent:unsubscribe', async (input: unknown, ack?: Ack) => {
      try {
        const { agentId } = subscriptionSchema.parse(input)
        const entry = Object.entries(socket.data.subscriptions)
          .find(([, subscribedAgentId]) => subscribedAgentId === agentId)
        if (entry) {
          delete socket.data.subscriptions[entry[0]]
          await socket.leave(`jw-agent:${entry[0]}`)
        }
        ack?.({ ok: true })
      } catch (error) {
        ack?.({ ok: false, error: publicSocketError(error) })
      }
    })
  })
  unsubscribeChanges = subscribeJwAgentChanges((conversationId) => {
    void broadcastSnapshot(conversationId)
  })
  unsubscribeAuthInvalidations = subscribeAuthInvalidations((event) => {
    if (!io) return
    for (const socket of io.sockets.sockets.values()) {
      const matches = event.type === 'session'
        ? socket.data.sessionId === event.sessionId
        : socket.data.user?.uid === event.userId
      if (!matches) continue
      socketMetrics.authorizationInvalidationsTotal += 1
      socket.emit('agent:error', { code: 'AUTH_INVALID', message: '登录状态已失效' })
      socket.disconnect(true)
    }
  })
  authTimer = setInterval(() => {
    if (!io) return
    void io.fetchSockets().then(async (sockets) => {
      await Promise.all(sockets.map((socket) => withSocketDbPermit(async () => {
        try {
          await reauthenticateSocket(socket)
          for (const [conversationId, agentId] of Object.entries(socket.data.subscriptions || {})) {
            if (await getJwAgentSnapshot(socket.data.user.uid, String(agentId))) continue
            await socket.leave(`jw-agent:${conversationId}`)
            delete socket.data.subscriptions[conversationId]
            socket.emit('agent:error', { code: 'FORBIDDEN', message: '会话或项目访问权限已失效' })
          }
        } catch {
          socketMetrics.authenticationFailuresTotal += 1
          socket.emit('agent:error', { code: 'AUTH_INVALID', message: '登录状态已失效' })
          socket.disconnect(true)
        }
      })))
    }).catch((error) => console.warn('[agent-socket] auth revalidation failed:', (error as Error).message))
  }, authRevalidateMs)
  authTimer.unref()
  console.log('[agent-socket] attached path=/socket.io')
}

export async function shutdownAgentSocket(): Promise<void> {
  if (authTimer) clearInterval(authTimer)
  authTimer = undefined
  unsubscribeChanges?.()
  unsubscribeChanges = undefined
  unsubscribeAuthInvalidations?.()
  unsubscribeAuthInvalidations = undefined
  broadcasting.clear()
  broadcastAgain.clear()
  if (!io) return
  const current = io
  io = undefined
  current.disconnectSockets(true)
  reconnectCandidates.clear()
  current.engine.close()
  current.removeAllListeners()
}

export function agentSocketHealth() {
  pruneReconnectCandidates(Date.now())
  const pendingReconnects = [...reconnectCandidates.values()]
    .reduce((sum, candidate) => sum + candidate.pending, 0)
  return {
    name: 'agent-socket',
    ok: Boolean(io),
    inProcess: true,
    path: '/socket.io',
    connections: io?.engine.clientsCount ?? 0,
    authRevalidateMs,
    dbOperations: { active: activeSocketDbOperations, waiting: socketDbWaiters.length, limit: socketDbConcurrency },
    lifecycle: {
      ...socketMetrics,
      pendingReconnects,
      reconnectWindowMs: socketReconnectWindowMs,
      disconnectRecoveryRate: socketMetrics.disconnectedTotal > 0
        ? Number((socketMetrics.reconnectedTotal / socketMetrics.disconnectedTotal).toFixed(6))
        : 0,
      identitiesExcluded: true,
    },
  }
}
