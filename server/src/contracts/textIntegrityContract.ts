const REPLACEMENT_CHARACTER = /\uFFFD/u
const SUSPICIOUS_UTF8_MOJIBAKE = /(?:Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]|ï»¿|â(?:€|™|œ|ž|“|”|–|—))/u
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u
const OPAQUE_VALUE_KEY = /(?:base64|password|passwd|secret|token|api[_-]?key|credential|signature|sha256|cipher|private[_-]?key)$/i

export type TextIntegrityIssue = {
  path: string
  reason: 'replacement-character' | 'mojibake' | 'control-character'
}

export function normalizeBusinessText(value: string): string {
  return value
    .replace(/^\uFEFF/u, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')
    .normalize('NFC')
}

export function inspectBusinessText(value: unknown): {
  text: string
  corrupted: boolean
  reason?: TextIntegrityIssue['reason']
} {
  const raw = String(value ?? '')
  const reason = REPLACEMENT_CHARACTER.test(raw)
    ? 'replacement-character'
    : SUSPICIOUS_UTF8_MOJIBAKE.test(raw)
      ? 'mojibake'
      : DISALLOWED_CONTROL.test(raw)
        ? 'control-character'
        : undefined
  return { text: normalizeBusinessText(raw), corrupted: Boolean(reason), reason }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Normalize user-facing JSON text and report the first damaged value. Opaque
 * payloads are deliberately skipped: Base64, credentials and hashes must stay
 * byte-for-byte identical and are not user-facing prose.
 */
export function normalizeTextPayload<T>(value: T, path = '$'): { value: T; issue?: TextIntegrityIssue } {
  if (typeof value === 'string') {
    const quality = inspectBusinessText(value)
    return {
      value: quality.text as T,
      issue: quality.corrupted ? { path, reason: quality.reason! } : undefined,
    }
  }
  if (Array.isArray(value)) {
    const normalized: unknown[] = []
    let firstIssue: TextIntegrityIssue | undefined
    value.forEach((item, index) => {
      const result = normalizeTextPayload(item, `${path}[${index}]`)
      normalized.push(result.value)
      firstIssue ||= result.issue
    })
    return { value: normalized as T, issue: firstIssue }
  }
  if (!isPlainRecord(value)) return { value }
  const normalized: Record<string, unknown> = {}
  let firstIssue: TextIntegrityIssue | undefined
  for (const [key, child] of Object.entries(value)) {
    if (OPAQUE_VALUE_KEY.test(key)) {
      normalized[key] = child
      continue
    }
    const result = normalizeTextPayload(child, `${path}.${key}`)
    normalized[key] = result.value
    firstIssue ||= result.issue
  }
  return { value: normalized as T, issue: firstIssue }
}

export function safeVisibleText(value: unknown, fallback = ''): string {
  const quality = inspectBusinessText(value)
  return quality.corrupted ? fallback : quality.text
}
