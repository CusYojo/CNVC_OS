import type { Request } from 'express'

export function requestOriginAllowed(headers: Request['headers'], env: NodeJS.ProcessEnv = process.env): boolean {
  const origin = typeof headers.origin === 'string' ? headers.origin : ''
  if (!origin) return true
  const forwardedProto = typeof headers['x-forwarded-proto'] === 'string'
    ? headers['x-forwarded-proto'].split(',')[0].trim()
    : ''
  const protocol = forwardedProto || (env.NODE_ENV === 'production' ? 'https' : 'http')
  const forwardedHost = typeof headers['x-forwarded-host'] === 'string'
    ? headers['x-forwarded-host'].split(',')[0].trim()
    : ''
  const host = forwardedHost || (typeof headers.host === 'string' ? headers.host : '')
  const sameOrigin = host ? `${protocol}://${host}` : ''
  const allowed = (env.AUTH_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean)
  if (origin === sameOrigin || allowed.includes(origin)) return true
  if (env.NODE_ENV !== 'production') {
    try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname) }
    catch { return false }
  }
  return false
}
