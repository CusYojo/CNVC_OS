// 后端 API 调用封装（dev 跟 prod 自动适配）
import { authedFetch } from '../store/useAuthStore'
import { ApiError, apiErrorFromResponse } from '../../server/src/contracts/apiErrorContract'

export { ApiError, apiErrorFromResponse } from '../../server/src/contracts/apiErrorContract'

/**
 * Vite dev:  走相对路径 (Vite proxy 或直连同源)
 * Vite prod: 同源 /api（由 nginx 反代到 3100）
 */
const API_PREFIX = '/api'
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

export interface ApiResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string; details?: unknown }
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = path.startsWith('/api/') ? path : `${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`
  // 超时兜底(默认 120s)：兼顾大文件上传和慢接口，避免前端 fetch 无限挂起、UI 一直转圈"卡住"。
  // 调用方可通过 init.signal 传自己的 AbortSignal 覆盖(此时不叠加默认超时)。
  let timer: ReturnType<typeof setTimeout> | undefined
  let finalInit = init
  if (!init.signal) {
    const ctrl = new AbortController()
    timer = setTimeout(() => ctrl.abort(), DEFAULT_REQUEST_TIMEOUT_MS)
    finalInit = { ...init, signal: ctrl.signal }
  }
  let res: Response
  try {
    res = await authedFetch(url, finalInit)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ApiError('请求超时（120s），请重试或检查网络', 'TIMEOUT', 0)
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    const contentType = res.headers.get('content-type') || ''
    const looksLikeHtml = /text\/html/i.test(contentType)
      || /^\s*<!doctype html/i.test(text)
      || /^\s*<html/i.test(text)
    const plainText = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
    body = {
      code: looksLikeHtml ? 'BAD_RESPONSE' : 'BAD_JSON',
      message: looksLikeHtml
        ? (
            res.status === 404
              ? '接口不存在，当前后端可能尚未加载最新版本，请重启后端服务'
              : `服务端返回了异常页面（HTTP ${res.status}），请稍后重试`
          )
        : plainText || `HTTP ${res.status}`,
    }
  }
  if (!res.ok) {
    // 401 = 服务端会话过期/已吊销：清理本地用户状态并返回登录页。
    if (res.status === 401) {
      try {
        const { useAuthStore } = await import('../store/useAuthStore')
        useAuthStore.getState().clearAuth()
      } catch { /* ignore */ }
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login'
      }
    }
    throw apiErrorFromResponse(res.status, body, res.headers.get('x-request-id'))
  }
  return body as T
}

// GET 助手
export const apiGet = <T = unknown>(path: string) => api<T>(path, { method: 'GET' })
// POST 助手
export const apiPost = <T = unknown>(path: string, body?: unknown, init?: RequestInit) =>
  api<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined, ...init })
// PATCH 助手
export const apiPatch = <T = unknown>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PATCH', body: body !== undefined ? JSON.stringify(body) : undefined })
// PUT 助手
export const apiPut = <T = unknown>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined })
// DELETE 助手
export const apiDelete = <T = unknown>(path: string) => api<T>(path, { method: 'DELETE' })
