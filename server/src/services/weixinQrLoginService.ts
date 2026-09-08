import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'
import type { ImActor } from './imIntegrationService.js'
import { createWeixinBotFromLogin } from './imIntegrationService.js'
import { connectPersonalWeixinAi } from './personalWeixinAiService.js'
import { assertIntegrationCredentialEncryptionReady } from '../security/integrationCredentialCrypto.js'

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const BOT_TYPE = '3'
const LOGIN_TTL_MS = 5 * 60 * 1000
const POLL_TIMEOUT_MS = 35 * 1000
const APP_CLIENT_VERSION = String((2 << 16) | (1 << 8) | 7)

type LoginSession = {
  sessionKey: string
  qrcode: string
  qrcodeUrl: string
  startedAt: number
  baseUrl: string
  purpose: 'admin-shared' | 'personal'
  ownerUserId: string | null
  completion?: Promise<{ connected: true; bot: unknown }>
}

type StatusResponse = {
  status?: string
  redirect_host?: string
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
}

const activeLogins = new Map<string, LoginSession>()

function serviceError(message: string, code: string, status: number) {
  return Object.assign(new Error(message), { code, status })
}

function allowedBaseUrl(value: string) {
  let parsed: URL
  try { parsed = new URL(value) } catch {
    throw serviceError('微信登录服务返回了无效地址', 'IM_WEIXIN_BASE_URL_INVALID', 502)
  }
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'https:' || (host !== 'weixin.qq.com' && !host.endsWith('.weixin.qq.com'))) {
    throw serviceError('微信登录服务返回地址不在允许列表', 'IM_WEIXIN_BASE_URL_FORBIDDEN', 502)
  }
  return parsed.origin
}

async function getJson<T>(baseUrl: string, endpoint: string, timeoutMs = 15_000): Promise<T> {
  const response = await fetch(new URL(endpoint, `${allowedBaseUrl(baseUrl)}/`), {
    headers: {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': APP_CLIENT_VERSION,
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  })
  const text = await response.text()
  if (!response.ok) throw serviceError(`微信接口请求失败：${response.status}`, 'IM_WEIXIN_UPSTREAM_FAILED', 502)
  try { return JSON.parse(text) as T } catch {
    throw serviceError('微信接口返回格式异常', 'IM_WEIXIN_UPSTREAM_INVALID', 502)
  }
}

function clearExpiredLogins() {
  const now = Date.now()
  for (const [key, login] of activeLogins) {
    if (now - login.startedAt >= LOGIN_TTL_MS) activeLogins.delete(key)
  }
}

async function startQrLogin(purpose: LoginSession['purpose'], ownerUserId: string | null) {
  // Fail before showing a QR code if the confirmed token cannot be encrypted.
  assertIntegrationCredentialEncryptionReady()
  clearExpiredLogins()
  if (purpose === 'personal') {
    for (const [key, login] of activeLogins) {
      if (login.purpose === 'personal' && login.ownerUserId === ownerUserId) activeLogins.delete(key)
    }
  }
  const result = await getJson<{ qrcode?: string; qrcode_img_content?: string }>(
    DEFAULT_BASE_URL,
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
  )
  if (!result.qrcode || !result.qrcode_img_content) {
    throw serviceError('微信二维码响应异常', 'IM_WEIXIN_QR_INVALID', 502)
  }
  const sessionKey = randomUUID()
  const qrcodeUrl = await QRCode.toDataURL(result.qrcode_img_content, {
    errorCorrectionLevel: 'M', margin: 2, scale: 6, type: 'image/png',
  })
  activeLogins.set(sessionKey, {
    sessionKey, qrcode: result.qrcode, qrcodeUrl, startedAt: Date.now(), baseUrl: DEFAULT_BASE_URL,
    purpose, ownerUserId,
  })
  return { sessionKey, qrcodeUrl, expiresInSeconds: LOGIN_TTL_MS / 1000, message: '使用微信扫描二维码并确认授权。' }
}

export async function startWeixinQrLogin() {
  return startQrLogin('admin-shared', null)
}

export async function startPersonalWeixinQrLogin(userId: string) {
  return startQrLogin('personal', userId)
}

async function waitForQrLogin(sessionKey: string, actor: ImActor, purpose: LoginSession['purpose']) {
  const login = activeLogins.get(sessionKey)
  if (!login) throw serviceError('当前没有进行中的微信登录，请重新生成二维码', 'IM_WEIXIN_LOGIN_NOT_FOUND', 404)
  if (login.purpose !== purpose || (purpose === 'personal' && login.ownerUserId !== actor.userId)) {
    throw serviceError('该微信登录不属于当前用户', 'IM_WEIXIN_LOGIN_OWNER_MISMATCH', 403)
  }
  if (login.completion) return login.completion
  if (Date.now() - login.startedAt >= LOGIN_TTL_MS) {
    activeLogins.delete(sessionKey)
    throw serviceError('二维码已过期，请重新生成', 'IM_WEIXIN_QR_EXPIRED', 410)
  }

  const deadline = login.startedAt + LOGIN_TTL_MS
  while (Date.now() < deadline) {
    const status = await getJson<StatusResponse>(
      login.baseUrl,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(login.qrcode)}`,
      POLL_TIMEOUT_MS,
    )
    if (status.status === 'scaned_but_redirect' && status.redirect_host) {
      login.baseUrl = allowedBaseUrl(`https://${status.redirect_host}`)
    }
    if (status.status === 'expired') {
      activeLogins.delete(sessionKey)
      throw serviceError('二维码已过期，请重新生成', 'IM_WEIXIN_QR_EXPIRED', 410)
    }
    if (status.status === 'confirmed') {
      if (!status.bot_token || !status.ilink_bot_id) {
        throw serviceError('微信登录确认但未返回完整凭据', 'IM_WEIXIN_LOGIN_INVALID', 502)
      }
      if (purpose === 'personal' && !status.ilink_user_id) {
        throw serviceError('微信登录未返回用户身份，请重新扫码', 'PERSONAL_WEIXIN_IDENTITY_MISSING', 502)
      }
      login.completion ??= (async () => {
        const credentials = {
          accountId: status.ilink_bot_id!, accountUserId: status.ilink_user_id || '',
          botToken: status.bot_token!, baseUrl: allowedBaseUrl(status.baseurl || login.baseUrl),
        }
        const bot = purpose === 'personal'
          ? await connectPersonalWeixinAi(credentials, actor)
          : await createWeixinBotFromLogin({ ...credentials, accountUserId: credentials.accountUserId || null }, actor)
        return { connected: true as const, bot }
      })()
      const result = await login.completion
      if (purpose === 'admin-shared') activeLogins.delete(sessionKey)
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  activeLogins.delete(sessionKey)
  throw serviceError('微信扫码登录超时，请重新生成二维码', 'IM_WEIXIN_LOGIN_TIMEOUT', 408)
}

export async function waitForWeixinQrLogin(sessionKey: string, actor: ImActor) {
  return waitForQrLogin(sessionKey, actor, 'admin-shared')
}

export async function waitForPersonalWeixinQrLogin(sessionKey: string, actor: ImActor) {
  return waitForQrLogin(sessionKey, actor, 'personal')
}
