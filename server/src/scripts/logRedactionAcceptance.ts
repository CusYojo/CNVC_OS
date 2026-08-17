import { redactSensitiveText, safeErrorLog } from '../security/redactSecrets.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const secret = `acceptance-secret-${Date.now()}`
process.env.ACCEPTANCE_API_KEY = secret
const raw = [
  `Authorization: Bearer ${secret}`,
  `api_key=${secret}`,
  `password=${secret}`,
  `cookie=${secret}`,
  `https://runtime:${secret}@mysql.invalid/database`,
].join(' ')
const redacted = redactSensitiveText(raw)
assert(!redacted.includes(secret), 'configured secret remained in redacted text')
assert(!/Bearer\s+(?!\[REDACTED\])/.test(redacted), 'Bearer credential remained in redacted text')
assert(!/runtime:[^@]+@/.test(redacted), 'URL credential remained in redacted text')

const error = Object.assign(new Error(`gateway rejected token=${secret}`), {
  code: `AUTH_${secret}`,
  status: 502,
  cause: new Error(`upstream Authorization: Bearer ${secret}`),
})
const safe = JSON.stringify(safeErrorLog(error))
assert(!safe.includes(secret), 'secret remained in structured error log')
assert(safe.includes('[REDACTED]'), 'structured error log has no redaction marker')

delete process.env.ACCEPTANCE_API_KEY
console.log(JSON.stringify({
  ok: true,
  checks: [
    'configured-secret-redaction',
    'bearer-redaction',
    'named-field-redaction',
    'url-credential-redaction',
    'error-message-stack-code-cause-redaction',
  ],
}))
