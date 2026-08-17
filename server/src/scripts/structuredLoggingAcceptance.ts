import { createStructuredLogRecord, runWithRequestLogContext } from '../runtime/structuredLogger.js'

const previousSecret = process.env.LOG_ACCEPTANCE_PASSWORD
const previousService = process.env.SERVICE_NAME
process.env.LOG_ACCEPTANCE_PASSWORD = 'structured-log-secret-123456789'
delete process.env.SERVICE_NAME

try {
  const fixedTime = new Date('2026-08-09T00:00:00.000Z')
  const base = createStructuredLogRecord('info', ['service ready'], fixedTime)
  if (base.time !== fixedTime.toISOString() || base.level !== 'info' || base.service !== 'cybernaut-app' || base.requestId !== null) {
    throw new Error('structured log base contract failed')
  }

  const request = await runWithRequestLogContext('request-acceptance-0001', async () => {
    await Promise.resolve()
    return createStructuredLogRecord('warn', [JSON.stringify({ event: 'denied', status: 403 })], fixedTime)
  })
  if (request.requestId !== 'request-acceptance-0001' || request.event !== 'denied' || request.status !== 403) {
    throw new Error('async request log context was not preserved')
  }

  const secret = createStructuredLogRecord('error', [new Error(`failed password=${process.env.LOG_ACCEPTANCE_PASSWORD}`)], fixedTime)
  const serialized = JSON.stringify(secret)
  if (serialized.includes('structured-log-secret-123456789') || !serialized.includes('[REDACTED]')) {
    throw new Error('structured log secret redaction failed')
  }

  const override = createStructuredLogRecord('info', [JSON.stringify({
    time: 'forged', level: 'error', service: 'forged', requestId: 'payload-request', event: 'payload',
  })], fixedTime)
  if (override.time !== fixedTime.toISOString() || override.level !== 'info' || override.service !== 'cybernaut-app'
    || override.requestId !== 'payload-request' || override.event !== 'payload') {
    throw new Error('structured log reserved-field protection failed')
  }

  console.log(JSON.stringify({
    ok: true,
    checks: ['base-fields', 'async-request-context', 'secret-redaction', 'reserved-field-protection'],
  }))
} finally {
  if (previousSecret == null) delete process.env.LOG_ACCEPTANCE_PASSWORD
  else process.env.LOG_ACCEPTANCE_PASSWORD = previousSecret
  if (previousService == null) delete process.env.SERVICE_NAME
  else process.env.SERVICE_NAME = previousService
}
