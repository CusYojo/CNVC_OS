import { createHash, randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { agentConversationRepository, identityRepositories, imIntegrationRepository } from '../repositories/index.js'
import { decryptIntegrationCredential } from '../security/integrationCredentialCrypto.js'
import {
  getJwAgentSnapshot,
  isMissingSdkConversationError,
  respondJwAgentInteraction,
  resetJwAgentSdkSession,
  sendJwAgentMessage,
  sendJwAgentMessageWithMedia,
} from '../runtime/jwAgentRuntime.js'
import { createConversation } from './conversationService.js'
import { createImBinding, routeImInboundMessage, type ImActor } from './imIntegrationService.js'
import { getArtifactDownload } from './aiTaskService.js'
import { weixinArticleUrl, weixinIntakeCommand, weixinIntakeBindingAuthorized } from '../contracts/weixinLinkIntakeContract.js'
import { processWeixinLinkIntake } from './weixinLinkIntakeService.js'
import { uploadAndSendWeixinFile, weixinArtifactIdsFromMessages } from './weixinFileDelivery.js'
import {
  downloadWeixinInboundImages,
  weixinInboundImageCount,
  weixinInboundImageReferenceHash,
  type WeixinImageMessage,
} from './weixinInboundImage.js'
import {
  downloadWeixinInboundFiles,
  WeixinInboundFileError,
  weixinInboundFileCount,
  weixinInboundFileReferenceHash,
  type WeixinFileMessage,
} from './weixinInboundFile.js'

const CHANNEL_VERSION = '2.1.7'
const APP_CLIENT_VERSION = String((2 << 16) | (1 << 8) | 7)
const POLL_INTERVAL_MS = 1_500
const POLL_TIMEOUT_MS = 45_000
const REPLY_TIMEOUT_MS = 5 * 60_000
const DEFAULT_MAX_FILE_BYTES = 80 * 1024 * 1024
const MAX_REPLY_FILES = 5
const BRIDGE_LOCK_PATH = path.join(process.cwd(), '.runtime', 'weixin-message-bridge.lock')
const BRIDGE_LOCK_OWNER = `${process.pid}:${randomBytes(12).toString('hex')}`

type WeixinMessageItem = NonNullable<WeixinImageMessage['item_list']>[number]
  & NonNullable<WeixinFileMessage['item_list']>[number] & {
  text_item?: { text?: string }
}

type WeixinMessage = Omit<WeixinImageMessage, 'item_list'> & {
  msg_id?: string
  msgid?: string
  message_id?: string
  id?: string
  from_user_id?: string
  create_time_ms?: number
  context_token?: string
  item_list?: WeixinMessageItem[]
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
  accountUserId: string
  credentials: WeixinCredentials
}

const cursors = new Map<string, string>()
const botPolls = new Map<string, Promise<void>>()
const pollControllers = new Map<string, AbortController>()
let bridgeTimer: NodeJS.Timeout | null = null
let bridgeStopped = true
let bridgeRequested = false
let bridgeLockOwned = false

type BridgeLockRecord = { pid?: number; owner?: string; startedAt?: string }

function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

function readBridgeLock(): BridgeLockRecord {
  try { return JSON.parse(readFileSync(BRIDGE_LOCK_PATH, 'utf8')) as BridgeLockRecord }
  catch { return {} }
}

function tryAcquireBridgeLock() {
  if (bridgeLockOwned) return true
  mkdirSync(path.dirname(BRIDGE_LOCK_PATH), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(BRIDGE_LOCK_PATH, 'wx', 0o600)
      try {
        writeFileSync(descriptor, JSON.stringify({
          pid: process.pid, owner: BRIDGE_LOCK_OWNER, startedAt: new Date().toISOString(),
        }))
      } finally { closeSync(descriptor) }
      bridgeLockOwned = true
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const current = readBridgeLock()
      if (current.owner === BRIDGE_LOCK_OWNER) {
        bridgeLockOwned = true
        return true
      }
      if (typeof current.pid === 'number' && processIsAlive(current.pid)) return false
      try { unlinkSync(BRIDGE_LOCK_PATH) }
      catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') return false
      }
    }
  }
  return false
}

function releaseBridgeLock() {
  if (!bridgeLockOwned) return
  try {
    if (readBridgeLock().owner === BRIDGE_LOCK_OWNER) unlinkSync(BRIDGE_LOCK_PATH)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(JSON.stringify({
        event: 'weixin_bridge_lock_release_failed',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  } finally { bridgeLockOwned = false }
}

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
    text: weixinMessageText(message), imageReferenceHash: weixinInboundImageReferenceHash(message),
    fileReferenceHash: weixinInboundFileReferenceHash(message),
    contextToken: message.context_token || '',
  })).digest('hex')
}

function textFromSnapshotMessage(message: { role: string; parts: Record<string, unknown>[] }) {
  if (message.role !== 'assistant') return ''
  return message.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => String(part.text).trim()).filter(Boolean).join('\n\n').trim()
}

function maxWeixinFileBytes() {
  const configured = Number(process.env.WEIXIN_MAX_FILE_BYTES || DEFAULT_MAX_FILE_BYTES)
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_FILE_BYTES
  return Math.min(Math.floor(configured), DEFAULT_MAX_FILE_BYTES)
}

async function artifactContent(userId: string, artifactId: string) {
  const download = await getArtifactDownload(userId, artifactId)
  if (!download) throw new Error('文件不存在、未通过质检或当前用户无权访问')
  const limit = maxWeixinFileBytes()
  if (download.size <= 0) throw new Error('文件内容为空')
  if (download.size > limit) throw new Error(`文件超过微信发送上限 ${limit} bytes`)
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of download.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > limit) throw new Error(`文件超过微信发送上限 ${limit} bytes`)
      chunks.push(buffer)
    }
  } catch (error) {
    download.stream.destroy()
    throw error
  }
  if (total !== download.size) throw new Error('文件读取长度与登记长度不一致')
  return { fileName: download.artifact.fileName, content: Buffer.concat(chunks, total) }
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
      if (text) return {
        text,
        artifactIds: weixinArtifactIdsFromMessages(snapshot.messages, baselineIds),
      }
    }
    if (snapshot.status === 'error') throw new Error(snapshot.error || 'Agent 回答失败')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Agent 回答超时')
}

async function sendReplyArtifacts(input: {
  bot: ActiveBot
  userId: string
  targetUserId: string
  contextToken: string
  artifactIds: string[]
}) {
  let sent = 0
  let failed = Math.max(0, input.artifactIds.length - MAX_REPLY_FILES)
  for (const artifactId of input.artifactIds.slice(0, MAX_REPLY_FILES)) {
    try {
      const file = await artifactContent(input.userId, artifactId)
      await uploadAndSendWeixinFile({
        postWeixin: async <T>(endpoint: string, payload: unknown, timeoutMs: number) => (
          await postWeixin<T>(input.bot.credentials, endpoint, payload, timeoutMs)
        ),
        targetUserId: input.targetUserId,
        contextToken: input.contextToken,
        fileName: file.fileName,
        content: file.content,
        channelVersion: CHANNEL_VERSION,
      })
      sent += 1
      console.log(JSON.stringify({
        event: 'weixin_file_sent', botId: input.bot.id, artifactId, byteSize: file.content.length,
      }))
    } catch (error) {
      failed += 1
      console.error(JSON.stringify({
        event: 'weixin_file_failed', botId: input.bot.id, artifactId,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }
  return { sent, failed }
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
  const imageCount = weixinInboundImageCount(message)
  const fileCount = weixinInboundFileCount(message)
  if (!targetUserId || !contextToken || (!text && !imageCount && !fileCount)) return
  if (text && !imageCount && !fileCount && (weixinArticleUrl(text) || weixinIntakeCommand(text))) {
    const externalConversationId = `${bot.accountId}:${targetUserId}`.slice(0, 191)
    let intakeBinding = await imIntegrationRepository.findEnabledInboundBinding(bot.id, externalConversationId)
    if (!intakeBinding && bot.accountUserId === targetUserId) intakeBinding = await ensureInboundBinding(bot, targetUserId)
    if (!intakeBinding || !weixinIntakeBindingAuthorized({ senderId: targetUserId, accountUserId: bot.accountUserId, botOwnerId: bot.createdBy, bindingUserId: intakeBinding.userId, bindingVersion: intakeBinding.version })) {
      await sendText(bot.credentials, targetUserId, contextToken, '请先由管理员在平台的 IM 机器人“授权绑定”中绑定你的平台账号。旧的默认聊天绑定需要管理员重新确认（停用后再启用），才能使用微信收录。')
      return
    }
    const intakeUser = await identityRepositories.users.findById(intakeBinding.userId)
    if (!intakeUser || intakeUser.status !== '启用') {
      await sendText(bot.credentials, targetUserId, contextToken, '绑定的平台账号不可用，请联系管理员。')
      return
    }
    try {
      const reply = await processWeixinLinkIntake({
        bindingId: intakeBinding.id,
        userId: intakeUser.id,
        messageId: weixinExternalMessageId(bot.accountId, message),
        message: text,
        onBackgroundComplete: async backgroundReply => {
          await sendText(bot.credentials, targetUserId, contextToken, backgroundReply)
        },
      })
      if (reply !== null) {
        if (reply) await sendText(bot.credentials, targetUserId, contextToken, reply)
        return
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'WEIXIN_INTAKE_BUSY') {
        await sendText(bot.credentials, targetUserId, contextToken, '当前收录任务正在处理，请稍后回复“收录状态”。')
        return
      }
      throw error
    }
  }
  const routeMessage = text || (fileCount
    ? '请阅读并分析这个微信文件。'
    : '请查看并分析这张微信图片。')
  console.log(JSON.stringify({
    event: 'weixin_inbound_received', botId: bot.id, textLength: text.length, imageCount, fileCount,
  }))
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
  let cachedImages: Awaited<ReturnType<typeof downloadWeixinInboundImages>> | null = null
  let cachedDocuments: Awaited<ReturnType<typeof downloadWeixinInboundFiles>> | null = null
  let mediaLogged = false
  const submitToAgent = async (userId: string, userRole: string, agentId: string, body: string) => {
    if (!imageCount && !fileCount) return await sendJwAgentMessage(userId, userRole, agentId, body)
    if (!cachedImages || !cachedDocuments) {
      [cachedImages, cachedDocuments] = await Promise.all([
        imageCount ? downloadWeixinInboundImages(message) : Promise.resolve([]),
        fileCount ? downloadWeixinInboundFiles(message) : Promise.resolve([]),
      ])
    }
    if (imageCount && !cachedImages.length) throw new Error('微信图片未能下载或解密')
    if (fileCount && !cachedDocuments.length) throw new WeixinInboundFileError('微信文件未能下载或解密')
    if (!mediaLogged && cachedImages.length) console.log(JSON.stringify({
      event: 'weixin_images_received', botId: bot.id, imageCount: cachedImages.length,
      totalBytes: cachedImages.reduce((sum, image) => sum + image.byteSize, 0),
    }))
    if (!mediaLogged && cachedDocuments.length) console.log(JSON.stringify({
      event: 'weixin_files_received', botId: bot.id, fileCount: cachedDocuments.length,
      totalBytes: cachedDocuments.reduce((sum, document) => sum + document.byteSize, 0),
      pdfCount: cachedDocuments.filter((document) => document.kind === 'pdf').length,
      textDocumentCount: cachedDocuments.filter((document) => document.kind === 'text').length,
    }))
    mediaLogged = true
    return await sendJwAgentMessageWithMedia(
      userId, userRole, agentId, body, { images: cachedImages, documents: cachedDocuments },
    )
  }
  const routed = await routeImInboundMessage({
    botId: bot.id,
    inboundSecret: bot.credentials.inboundSecret,
    externalMessageId: weixinExternalMessageId(bot.accountId, message),
    externalConversationId: `${bot.accountId}:${targetUserId}`.slice(0, 191),
    externalUserId: targetUserId,
    message: routeMessage,
    payload: { source: 'weixin-ilink', createTimeMs: message.create_time_ms || null, imageCount, fileCount },
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
    return await submitToAgent(route.userId, route.userRole, route.agentId, route.message)
  })
  if (routed.duplicate) return
  if (!routed.id) throw new Error('微信入站消息记录未成功创建')
  const inboundId = routed.id
  try {
    let reply
    try {
      reply = await waitForAgentReply(owner.id, dispatchedAgentId, baselineIds)
    } catch (error) {
      if (!isMissingSdkConversationError(error)) throw error
      console.warn(JSON.stringify({
        event: 'weixin_sdk_session_reset', botId: bot.id, agentId: dispatchedAgentId,
      }))
      const reset = await resetJwAgentSdkSession(owner.id, dispatchedAgentId)
      if (!reset) throw error
      await submitToAgent(owner.id, owner.role, dispatchedAgentId, routeMessage)
      reply = await waitForAgentReply(owner.id, dispatchedAgentId, baselineIds)
    }
    await sendText(bot.credentials, targetUserId, contextToken, reply.text)
    const files = await sendReplyArtifacts({
      bot, userId: owner.id, targetUserId, contextToken, artifactIds: reply.artifactIds,
    })
    if (files.failed) {
      await sendText(
        bot.credentials, targetUserId, contextToken,
        `有 ${files.failed} 个文件未能通过微信发送，请在投资中台的产物中心下载。`,
      )
    }
    await imIntegrationRepository.updateInboundStatus(inboundId, 'responded')
    console.log(JSON.stringify({
      event: 'weixin_reply_sent', botId: bot.id, replyLength: reply.text.length,
      filesDetected: reply.artifactIds.length, filesSent: files.sent, filesFailed: files.failed,
    }))
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
    return [{ id: bot.id, accountId: raw.accountId, createdBy: bot.createdBy, accountUserId: String(bot.config.accountUserId || ''), credentials: raw as WeixinCredentials }]
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
        const failureMessage = error instanceof WeixinInboundFileError
          ? error.publicMessage
          : '消息已收到，但机器人处理失败，请稍后重试。'
        await sendText(bot.credentials, message.from_user_id, message.context_token,
          failureMessage).catch(() => undefined)
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

function attemptStartWeixinMessageBridge() {
  if (!bridgeRequested || !bridgeStopped) return
  if (!tryAcquireBridgeLock()) {
    const current = readBridgeLock()
    console.warn(JSON.stringify({
      event: 'weixin_bridge_standby', leaderPid: current.pid || null,
    }))
    bridgeTimer = setTimeout(attemptStartWeixinMessageBridge, 5_000)
    bridgeTimer.unref()
    return
  }
  bridgeStopped = false
  console.log(JSON.stringify({ event: 'weixin_bridge_leader', pid: process.pid }))
  void bridgeTick()
}

export function startWeixinMessageBridge() {
  if (bridgeRequested) return
  if (!isWeixinMessageBridgeEnabled(process.env.WEIXIN_BRIDGE_ENABLED)) {
    console.log(JSON.stringify({ event: 'weixin_bridge_disabled' }))
    return
  }
  bridgeRequested = true
  attemptStartWeixinMessageBridge()
}

export function isWeixinMessageBridgeEnabled(value: string | undefined) {
  if (value === undefined || value.trim() === '') return true
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase())
}

export async function stopWeixinMessageBridge() {
  bridgeRequested = false
  bridgeStopped = true
  if (bridgeTimer) clearTimeout(bridgeTimer)
  bridgeTimer = null
  for (const controller of pollControllers.values()) controller.abort()
  await Promise.allSettled([...botPolls.values()])
  botPolls.clear()
  pollControllers.clear()
  releaseBridgeLock()
}
