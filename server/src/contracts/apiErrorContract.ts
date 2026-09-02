export class ApiError extends Error {
  code: string
  status: number
  baseMessage: string
  requestId?: string

  constructor(message: string, code: string, status: number, requestId?: string) {
    super(message)
    this.code = code
    this.status = status
    this.baseMessage = message
    this.requestId = requestId
  }

  withContext(message: string) {
    return message
  }
}

const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi
const shaPattern = /\b(?:sha-?256[:：]?\s*)?[0-9a-f]{64}\b/gi

export function publicApiErrorMessage(status: number, code: string, message: string) {
  if (code === 'TIMEOUT') return '请求超时，请重试'
  if (code === 'BAD_RESPONSE' || code === 'BAD_JSON' || status >= 500) return '服务暂时不可用，请稍后重试'
  if (/VERSION_CONFLICT|OPTIMISTIC_LOCK|STALE/i.test(code)) return '内容已被其他人更新，请刷新后重试'
  const cleaned = message
    .replace(uuidPattern, '')
    .replace(shaPattern, '')
    .replace(/（?请求编号[:：][^)）\s]+）?/g, '')
    .replace(/\bHTTP\s*\d{3}\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .trim()
  if (status === 403 && !cleaned) return '当前账号没有操作权限'
  return cleaned || '操作未完成，请重试'
}

export function apiErrorFromResponse(status: number, body: unknown, responseRequestId: string | null) {
  const errorBody = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const baseMessage = typeof errorBody.message === 'string' && errorBody.message.trim()
    ? errorBody.message.trim()
    : `HTTP ${status}`
  const code = typeof errorBody.code === 'string' && errorBody.code.trim()
    ? errorBody.code.trim()
    : 'HTTP_ERROR'
  const bodyRequestId = typeof errorBody.requestId === 'string' ? errorBody.requestId.trim() : ''
  const headerRequestId = responseRequestId?.trim() || ''
  const requestId = bodyRequestId
    && bodyRequestId === headerRequestId
    && /^[A-Za-z0-9._:-]{8,64}$/.test(bodyRequestId)
    ? bodyRequestId
    : undefined
  const error = new ApiError(publicApiErrorMessage(status, code, baseMessage), code, status, requestId)
  error.baseMessage = baseMessage
  return error
}
