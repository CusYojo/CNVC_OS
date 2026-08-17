import { createHash, randomBytes } from 'node:crypto'
import { agentConversationRepository, identityRepositories, imIntegrationRepository } from '../repositories/index.js'
import { decryptIntegrationCredential } from '../security/integrationCredentialCrypto.js'
import { getJwAgentSnapshot, respondJwAgentInteraction, sendJwAgentMessage } from '../runtime/jwAgentRuntime.js'
import { createConversation } from './conversationService.js'
import { createImBinding, routeImInboundMessage, type ImActor } from './imIntegrationService.js'

const CHANNEL_VERSION = '2.1.7'
const APP_CLIENT_VERSION = String((2 << 16) | (1 << 8) | 7)
const POLL_INTERVAL_MS = 1_500
const POLL_TIMEOUT_MS = 45_000
const REPLY_TIMEOUT_MS = 5 * 60_000

type WeixinMessage = {
  msg_id?: string
  msgid?: string
  message_id?: string
  id?: string
  from_user_id?: string
  create_time_ms?: number
  context_token?: string
  item_list?: Array<{ type?: number; text_item?: { text?: string } }>
}

type WeixinCredentials = {
  transport: string
  accountId: string
  botToken: string
  baseUrl: string
  inboundSecret: string
}

type ActiveBot = {
  id: string
  accountId: string
  createdBy: string
  credentials: WeixinCredentials
}

const cursors = new Map<string, string>()
const botPolls = new Map<string, Promise<void>>()
const pollControllers = new Map<string, AbortController>()
let bridgeTimer: NodeJS.Timeout | null = null
let bridgeStopped = true

function ensureWeixinUrl(value: string) {
  const parsed = new URL(value)
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'https:' || (host !== 'weixin.qq.com' && !host.endsWith('.weixin.qq.com'))) {
    throw new Error('微信服务地址不在允许列表')
  }
  return parsed.origin
}

function headers(token: string, body: string) {
  return {
    'Content-Type': 'application/json',
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': APP_CLIENT_VERSION,
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
  }
}

async function postWeixin<T>(credentials: WeixinCredentials, endpoint: string, payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const body = JSON.stringify(payload)
  const response = await fetch(new URL(endpoint, `${ensureWeixinUrl(credentials.baseUrl)}/`), {
    method: 'POST', headers: headers(credentials.botToken, body), body,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`微信接口 ${endpoint} 请求失败：${response.status}`)
  const result = text ? JSON.parse(text) as Record<string, unknown> : {}
  const ret = Number(result.ret ?? 0)
  const errcode = Number(result.errcode ?? 0)
  if (ret !== 0 || errcode !== 0) {
    throw new Error(`微信接口 ${endpoint} 失败：ret=${ret} errcode=${errcode}`)
  }
  return result as T
}

export function weixinMessageText(message: WeixinMessage) {
  return (message.item_list || [])
    .filter((item) => item.type === 1 && item.text_item?.text)
    .map((item) => String(item.text_item!.text).trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function weixinExternalMessageId(accountId: string, message: WeixinMessage) {
  const explicit = message.msg_id || message.msgid || message.message_id || message.id
  if (explicit) return String(explicit).slice(0, 191)
  return createHash('sha256').update(JSON.stringify({
    accountId, from: message.from_user_id || '', createdAt: message.create_time_ms || 0,
    text: weixinMessageText(message), contextToken: message.context_token || '',
  })).digest('hex')
}

function textFromSnapshotMessage(message: { role: string; parts: Record<string, unknown>[] }) {
  if (message.role !== 'assistant') return ''
  return message.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => String(part.text).trim()).filter(Boolean).join('\n\n').trim()
}

async function waitForAgentReply(userId: string, agentId: string, baselineIds: Set<string>) {
  const deadline = Date.now() + REPLY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const snapshot = await getJwAgentSnapshot(userId, agentId)
    if (!snapshot) throw new Error('微信绑定的 Agent 会话不存在')
    const reply = [...snapshot.messages].reverse().find((message) => (
      message.role === 'assistant' && !message.metadata.transient && !baselineIds.has(message.id)
    ))
    if (reply && snapshot.status !== 'streaming') {
      const text = textFromSnapshotMessage(reply)
      if (text) return text
    }
    if (snapshot.status === 'error') throw new Error(snapshot.error || 'Agent 回答失败')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Agent 回答超时')
}

async function sendText(credentials: WeixinCredentials, targetUserId: string, contextToken: string, text: string) {
  const chunks = text.match(/[\s\S]{1,3500}/g) || []
  for (const chunk of chunks) {
    await postWeixin(credentials, 'ilink/bot/sendmessage', {
      msg: {
        from_user_id: '', to_user_id: targetUserId,
        client_id: `sbl-weixin-${Date.now()}-${randomBytes(4).toString('hex')}`,
        message_type: 2, message_state: 2, context_token: contextToken,
        item_list: [{ type: 1, text_item: { text: chunk } }],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }, 15_000)
  }
}

async function ensureInboundBinding(bot: ActiveBot, targetUserId: string) {
  const externalConversationId = `${bot.accountId}:${targetUserId}`.slice(0, 191)
  const existing = await imIntegrationRepository.findEnabledInboundBinding(bot.id, externalConversationId)
  if (existing) return existing
  const owner = await identityRepositories.users.findById(bot.createdBy)
  if (!owner || owner.status !== '启用') throw new Error('微信机器人的授权管理员不可用')
  const actor: ImActor = {
    userId: owner.id, userName: owner.name, role: owner.role, department: owner.department,
  }
  const conversation = await createConversation(owner.id, {
    title: `微信 · ${targetUserId.slice(0, 18)}`,
    scope: 'global', userRole: owner.role,
  })
  try {
    return await createImBinding({
      botId: bot.id, externalConversationId, userId: owner.id,
      conversationId: conversation.id, enabled: true,
    }, actor)
  } catch (error) {
    const raced = await imIntegrationRepository.findEnabledInboundBinding(bot.id, externalConversationId)
    if (raced) return raced
    throw error
  }
}

async function dispatchInbound(bot: ActiveBot, message: WeixinMessage) {
  const targetUserId = String(message.from_user_id || '').trim()
  const contextToken = String(message.context_token || '').trim()
  const text = weixinMessageText(message)
  if (!targetUserId || !contextToken || !text) return
  console.log(JSON.stringify({ event: 'weixin_inbound_received', botId: bot.id, textLength: text.length }))
  const binding = await ensureInboundBinding(bot, targetUserId)
  const conversation = binding.conversationId
    ? await agentConversationRepository.findAgentById(binding.conversationId)
    : null
  if (!conversation?.externalSessionId) throw new Error('微信绑定的 Agent 会话未就绪')
  const owner = await identityRepositories.users.findById(binding.userId)
  if (!owner) throw new Error('微信绑定用户不存在')
  const before = await getJwAgentSnapshot(owner.id, conversation.externalSessionId)
  const baselineIds = new Set((before?.messages || []).map((item) => item.id))
  let dispatchedAgentId = conversation.externalSessionId
  const routed = await routeImInboundMessage({
    botId: bot.id,
    inboundSecret: bot.credentials.inboundSecret,
    externalMessageId: weixinExternalMessageId(bot.accountId, message),
    externalConversationId: `${bot.accountId}:${targetUserId}`.slice(0, 191),
    externalUserId: targetUserId,
    message: text,
    payload: { source: 'weixin-ilink', createTimeMs: message.create_time_ms || null },
  }, async (route) => {
    dispatchedAgentId = route.agentId
    const snapshot = await getJwAgentSnapshot(route.userId, route.agentId)
    if (snapshot?.interaction) {
      const first = snapshot.interaction.questions[0]
      await respondJwAgentInteraction({
        userId: route.userId, agentId: route.agentId, interactionId: snapshot.interaction.id,
        action: 'answer', answers: first ? { [first.id]: route.message } : {},
      })
      return { accepted: true }
    }
    return await sendJwAgentMessage(route.userId, route.userRole, route.agentId, route.message)
  })
  if (routed.duplicate) return
  if (!routed.id) throw new Error('微信入站消息记录未成功创建')
  const inboundId = routed.id
  try {
    const reply = await waitForAgentReply(owner.id, dispatchedAgentId, baselineIds)
    await sendText(bot.credentials, targetUserId, contextToken, reply)
    await imIntegrationRepository.updateInboundStatus(inboundId, 'responded')
    console.log(JSON.stringify({ event: 'weixin_reply_sent', botId: bot.id, replyLength: reply.length }))
  } catch (error) {
    await imIntegrationRepository.updateInboundStatus(
      inboundId, 'failed', (error instanceof Error ? error.message : String(error)).slice(0, 64),
    )
    throw error
  }
}

async function activeBots(): Promise<ActiveBot[]> {
  const data = await imIntegrationRepository.listSettingsData()
  return data.bots.flatMap((bot) => {
    if (bot.platform !== 'wechat' || !bot.enabled || bot.connectionStatus !== 'connected' || !bot.createdBy) return []
    let raw: Record<string, string>
    try { raw = decryptIntegrationCredential(bot.credentialCiphertext, bot.id) }
    catch { return [] }
    if (raw.transport !== 'ilink' || !raw.botToken || !raw.accountId || !raw.baseUrl || !raw.inboundSecret) return []
    return [{ id: bot.id, accountId: raw.accountId, createdBy: bot.createdBy, credentials: raw as WeixinCredentials }]
  })
}

async function pollBot(bot: ActiveBot) {
  const previousCursor = cursors.get(bot.id) || ''
  const controller = new AbortController()
  pollControllers.set(bot.id, controller)
  let response: { get_updates_buf?: string; msgs?: WeixinMessage[] }
  try {
    response = await postWeixin(
      bot.credentials, 'ilink/bot/getupdates', {
        get_updates_buf: previousCursor,
        base_info: { channel_version: CHANNEL_VERSION },
      }, POLL_TIMEOUT_MS, controller.signal,
    )
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError' || (error as { name?: string }).name === 'TimeoutError') return
    throw error
  } finally {
    if (pollControllers.get(bot.id) === controller) pollControllers.delete(bot.id)
  }
  if (response.get_updates_buf) {
    cursors.set(bot.id, response.get_updates_buf)
    if (!previousCursor) console.log(JSON.stringify({ event: 'weixin_poll_ready', botId: bot.id }))
  }
  for (const message of response.msgs || []) {
    try { await dispatchInbound(bot, message) }
    catch (error) {
      console.error(JSON.stringify({
        event: 'weixin_inbound_failed', botId: bot.id,
        error: error instanceof Error ? error.message : String(error),
      }))
      if (message.from_user_id && message.context_token) {
        await sendText(bot.credentials, message.from_user_id, message.context_token,
          '消息已收到，但机器人处理失败，请稍后重试。').catch(() => undefined)
      }
    }
  }
}

async function bridgeTick() {
  if (bridgeStopped) return
  try {
    const bots = await activeBots()
    await Promise.all(bots.map(async (bot) => {
      if (botPolls.has(bot.id)) return
      const running = pollBot(bot).finally(() => botPolls.delete(bot.id))
      botPolls.set(bot.id, running)
      await running
    }))
  } catch (error) {
    console.error(JSON.stringify({ event: 'weixin_poll_failed', error: error instanceof Error ? error.message : String(error) }))
  } finally {
    if (!bridgeStopped) {
      bridgeTimer = setTimeout(() => void bridgeTick(), POLL_INTERVAL_MS)
      bridgeTimer.unref()
    }
  }
}

export function startWeixinMessageBridge() {
  if (!bridgeStopped) return
  bridgeStopped = false
  void bridgeTick()
}

export async function stopWeixinMessageBridge() {
  bridgeStopped = true
  if (bridgeTimer) clearTimeout(bridgeTimer)
  bridgeTimer = null
  for (const controller of pollControllers.values()) controller.abort()
  await Promise.allSettled([...botPolls.values()])
  botPolls.clear()
  pollControllers.clear()
}
