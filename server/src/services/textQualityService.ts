import { safeVisibleText } from '../contracts/textIntegrityContract.js'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16_BE_BOM = Buffer.from([0xfe, 0xff])

const BROKEN_UNICODE = /\uFFFD/
const SUSPICIOUS_MOJIBAKE = /(?:Ã.|Â.|ï»¿|[äåæçèé][\u0080-\u00FF\u2010-\u2030]{1,2})/
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const WINDOWS_1252_BYTES = new Map<string, number>([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85],
  ['†', 0x86], ['‡', 0x87], ['ˆ', 0x88], ['‰', 0x89], ['Š', 0x8a],
  ['‹', 0x8b], ['Œ', 0x8c], ['Ž', 0x8e], ['‘', 0x91], ['’', 0x92],
  ['“', 0x93], ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97],
  ['˜', 0x98], ['™', 0x99], ['š', 0x9a], ['›', 0x9b], ['œ', 0x9c],
  ['ž', 0x9e], ['Ÿ', 0x9f],
])

function decodeUtf16Be(buffer: Buffer) {
  const evenLength = buffer.length - (buffer.length % 2)
  const swapped = Buffer.allocUnsafe(evenLength)
  for (let index = 0; index < evenLength; index += 2) {
    swapped[index] = buffer[index + 1]
    swapped[index + 1] = buffer[index]
  }
  return swapped.toString('utf16le')
}

function decodeWith(label: string, buffer: Buffer) {
  try {
    return new TextDecoder(label, { fatal: true }).decode(buffer)
  } catch {
    return ''
  }
}

function textScore(value: string) {
  if (!value) return Number.NEGATIVE_INFINITY
  const replacements = (value.match(/\uFFFD/g) || []).length
  const controls = (value.match(DISALLOWED_CONTROL) || []).length
  const cjk = (value.match(/[\u3400-\u9FFF]/g) || []).length
  const readable = (value.match(/[\p{L}\p{N}\p{P}\p{Z}\r\n\t]/gu) || []).length
  return readable + cjk * 2 - replacements * 100 - controls * 40
}

function windows1252Bytes(value: string) {
  const bytes: number[] = []
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0xff) {
      bytes.push(codePoint)
      continue
    }
    const mapped = WINDOWS_1252_BYTES.get(character)
    if (mapped === undefined) return undefined
    bytes.push(mapped)
  }
  return Buffer.from(bytes)
}

function repairMojibakeSegment(value: string) {
  if (!SUSPICIOUS_MOJIBAKE.test(value)) return value
  const bytes = windows1252Bytes(value)
  if (!bytes) return value
  const decoded = decodeWith('utf-8', bytes)
  if (!decoded) return value
  const currentCjk = (value.match(/[\u3400-\u9FFF]/g) || []).length
  const decodedCjk = (decoded.match(/[\u3400-\u9FFF]/g) || []).length
  return decodedCjk > currentCjk && textScore(decoded) >= textScore(value) ? decoded : value
}

function repairUtf8Mojibake(value: string) {
  let current = value
  // Some historical strings were decoded through Windows-1252 more than once.
  // Repair only byte-reversible runs that create additional CJK text, so
  // legitimate European-language text and already-correct Chinese stay intact.
  for (let pass = 0; pass < 2 && SUSPICIOUS_MOJIBAKE.test(current); pass += 1) {
    let segment = ''
    let repaired = ''
    let changed = false
    const flush = () => {
      if (!segment) return
      const candidate = repairMojibakeSegment(segment)
      if (candidate !== segment) changed = true
      repaired += candidate
      segment = ''
    }
    for (const character of current) {
      const codePoint = character.codePointAt(0) ?? 0
      if (codePoint <= 0xff || WINDOWS_1252_BYTES.has(character)) {
        segment += character
      } else {
        flush()
        repaired += character
      }
    }
    flush()
    if (!changed) break
    current = repaired
  }
  return current
}

/**
 * Decode plain-text uploads without assuming UTF-8. Chinese project files are
 * commonly exported by WPS/Excel as UTF-16 or GB18030; forcing UTF-8 writes
 * replacement characters into the knowledge base and every downstream report.
 */
export function decodeTextBuffer(buffer: Buffer): {
  text: string
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'
} {
  if (buffer.subarray(0, 3).equals(UTF8_BOM)) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8' }
  }
  if (buffer.subarray(0, 2).equals(UTF16_LE_BOM)) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf-16le' }
  }
  if (buffer.subarray(0, 2).equals(UTF16_BE_BOM)) {
    return { text: decodeUtf16Be(buffer.subarray(2)), encoding: 'utf-16be' }
  }

  const sampleLength = Math.min(buffer.length, 4096)
  let evenNulls = 0
  let oddNulls = 0
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] !== 0) continue
    if (index % 2 === 0) evenNulls += 1
    else oddNulls += 1
  }
  if (oddNulls > sampleLength * 0.15 && evenNulls < oddNulls / 3) {
    return { text: buffer.toString('utf16le'), encoding: 'utf-16le' }
  }
  if (evenNulls > sampleLength * 0.15 && oddNulls < evenNulls / 3) {
    return { text: decodeUtf16Be(buffer), encoding: 'utf-16be' }
  }

  // UTF-8 must win whenever it is strictly valid. GB18030 can decode many
  // UTF-8 byte sequences into plausible-looking CJK characters, so scoring
  // both candidates by CJK count can silently turn correct Chinese into junk.
  const utf8 = decodeWith('utf-8', buffer)
  if (utf8) return { text: utf8, encoding: 'utf-8' }
  const gb18030 = decodeWith('gb18030', buffer)
  if (buffer.length % 2 === 0) {
    const utf16Candidates = [
      { text: decodeWith('utf-16le', buffer), encoding: 'utf-16le' as const },
      { text: decodeUtf16Be(buffer), encoding: 'utf-16be' as const },
    ].filter((candidate) => candidate.text)
      .sort((left, right) => textScore(right.text) - textScore(left.text))
    const utf16 = utf16Candidates[0]
    // BOM-less, Chinese-only UTF-16 has few or no NUL bytes. Prefer it only
    // when it is materially more readable than the GB18030 interpretation.
    if (utf16 && (!gb18030 || textScore(utf16.text) >= textScore(gb18030) + 2)) return utf16
  }
  if (gb18030) return { text: gb18030, encoding: 'gb18030' }
  return { text: buffer.toString('utf8'), encoding: 'utf-8' }
}

export function normalizeUnicodeText(value: unknown) {
  const raw = String(value ?? '')
    .replace(/^\uFEFF/, '')
  return repairUtf8Mojibake(raw)
    .replace(DISALLOWED_CONTROL, '')
    .normalize('NFC')
}

export function inspectTextQuality(value: unknown) {
  const raw = String(value ?? '')
  const controlCount = (raw.match(DISALLOWED_CONTROL) || []).length
  const text = normalizeUnicodeText(raw)
  const replacementCount = (text.match(/\uFFFD/g) || []).length
  const mojibakeCount = (text.match(new RegExp(SUSPICIOUS_MOJIBAKE.source, 'g')) || []).length
  return {
    text,
    controlCount,
    replacementCount,
    mojibakeCount,
    corrupted: controlCount > 0 || replacementCount > 0 || mojibakeCount > 0,
  }
}

/**
 * Never render mojibake. If a damaged chunk also contains useful readable
 * Chinese, remove only the broken token; otherwise the caller should reject it.
 */
export function cleanCorruptedText(value: unknown) {
  const quality = inspectTextQuality(value)
  const firstCjk = quality.text.search(/[\u3400-\u9FFF]/)
  const damagedPrefix = firstCjk > 0 && quality.text.slice(0, firstCjk).includes('\uFFFD')
  const candidate = damagedPrefix ? quality.text.slice(firstCjk) : quality.text
  const cleaned = candidate
    .replace(/\uFFFD+/g, '')
    .replace(new RegExp(SUSPICIOUS_MOJIBAKE.source, 'g'), ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
  const readableCjk = (cleaned.match(/[\u3400-\u9FFF]/g) || []).length
  return {
    ...quality,
    cleaned,
    usable: !quality.corrupted || readableCjk >= 12,
  }
}

/** Read historical persisted text without propagating irrecoverable bytes into
 * search, AI prompts, exports or workflow-derived records. */
export function readableStoredText(value: unknown): string {
  const quality = cleanCorruptedText(value)
  if (!quality.corrupted) return quality.text.trim()
  return quality.usable ? quality.cleaned.trim() : ''
}

/** Replace already-damaged legacy values at the API boundary instead of
 * allowing replacement-character noise to leak into business screens. */
export function sanitizeTextPayloadForDisplay<T>(value: T, fallback = ''): T {
  if (typeof value === 'string') {
    return safeVisibleText(value, fallback) as T
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeTextPayloadForDisplay(item, fallback)) as T
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof Date) return value
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, sanitizeTextPayloadForDisplay(child, fallback)]),
  ) as T
}
