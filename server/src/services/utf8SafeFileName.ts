const DEFAULT_MAX_FILE_NAME_BYTES = 255

function sanitizeFileStem(value: string) {
  return value.normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[ .]+$/g, '')
}

function truncateUtf8(value: string, maxBytes: number) {
  let result = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}

export function buildUtf8SafeFileName(input: {
  stem: string
  fallback: string
  prefix?: string
  suffix?: string
  maxBytes?: number
}) {
  const prefix = input.prefix ?? ''
  const suffix = input.suffix ?? ''
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_FILE_NAME_BYTES
  const fixedBytes = Buffer.byteLength(prefix + suffix, 'utf8')
  const stemBudget = maxBytes - fixedBytes
  if (stemBudget <= 0) throw new RangeError('文件名前后缀超过文件系统字节上限')

  const cleaned = sanitizeFileStem(input.stem) || sanitizeFileStem(input.fallback)
  const truncated = truncateUtf8(cleaned, stemBudget).replace(/[ .]+$/g, '')
  const safeStem = truncated || truncateUtf8(sanitizeFileStem(input.fallback), stemBudget)
  if (!safeStem) throw new RangeError('文件名没有可用的 UTF-8 字节空间')
  return `${prefix}${safeStem}${suffix}`
}
