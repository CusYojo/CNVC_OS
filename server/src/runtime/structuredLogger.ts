import { AsyncLocalStorage } from 'node:async_hooks'
import { redactSensitiveText, safeErrorLog } from '../security/redactSecrets.js'

export type LogLevel = 'info' | 'warn' | 'error'

type LogContext = { requestId: string }
type LogRecord = Record<string, unknown> & {
  time: string
  level: LogLevel
  service: string
  requestId: string | null
}

const context = new AsyncLocalStorage<LogContext>()
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
}
let installed = false

function safeJsonValue(value: unknown): unknown {
  if (value instanceof Error) return safeErrorLog(value)
  if (typeof value === 'string') return redactSensitiveText(value)
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  try {
    const serialized = JSON.stringify(value, (_key, item) => {
      if (item instanceof Error) return safeErrorLog(item)
      if (typeof item === 'bigint') return item.toString()
      if (Buffer.isBuffer(item)) return `[Buffer ${item.length} bytes]`
      return item
    })
    return serialized == null ? String(value) : JSON.parse(redactSensitiveText(serialized))
  } catch {
    return redactSensitiveText(value)
  }
}

function payloadFromArgs(args: unknown[]): Record<string, unknown> {
  if (args.length === 1 && typeof args[0] === 'string') {
    const text = redactSensitiveText(args[0])
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return safeJsonValue(parsed) as Record<string, unknown>
    } catch {
      // Non-JSON console output becomes the structured message field.
    }
    return { message: text }
  }
  return {
    message: args.map((value) => {
      const safe = safeJsonValue(value)
      return typeof safe === 'string' ? safe : JSON.stringify(safe)
    }).join(' '),
  }
}

export function createStructuredLogRecord(
  level: LogLevel,
  args: unknown[],
  now = new Date(),
): LogRecord {
  const payload = payloadFromArgs(args)
  const contextualRequestId = context.getStore()?.requestId || null
  const payloadRequestId = typeof payload.requestId === 'string' && payload.requestId ? payload.requestId : null
  delete payload.time
  delete payload.level
  delete payload.service
  delete payload.requestId
  return {
    time: now.toISOString(),
    level,
    service: process.env.SERVICE_NAME?.trim() || 'cybernaut-app',
    requestId: contextualRequestId || payloadRequestId,
    ...payload,
  }
}

function emit(level: LogLevel, args: unknown[]) {
  const line = JSON.stringify(createStructuredLogRecord(level, args))
  if (level === 'error') originalConsole.error(line)
  else if (level === 'warn') originalConsole.warn(line)
  else originalConsole.log(line)
}

export function installStructuredLogging(): void {
  if (installed) return
  installed = true
  console.log = (...args: unknown[]) => emit('info', args)
  console.warn = (...args: unknown[]) => emit('warn', args)
  console.error = (...args: unknown[]) => emit('error', args)
}

export function runWithRequestLogContext<T>(requestId: string, callback: () => T): T {
  return context.run({ requestId }, callback)
}

export function currentRequestId(): string | null {
  return context.getStore()?.requestId || null
}
