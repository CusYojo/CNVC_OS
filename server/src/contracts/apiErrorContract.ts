export class ApiError extends Error {
  code: string
  status: number
  baseMessage: string
  requestId?: string

  constructor(message: string, code: string, status: number, requestId?: string) {
    super(requestId ? `${message}（请求编号：${requestId}）` : message)
    this.code = code
    this.status = status
    this.baseMessage = message
    this.requestId = requestId
  }

  withContext(message: string) {
    return this.requestId ? `${message}（请求编号：${this.requestId}）` : message
  }
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
  return new ApiError(baseMessage, code, status, requestId)
}
