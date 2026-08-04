export type SafeFluePart = {
  type: string
  text?: string
  url?: string
  filename?: string
  mediaType?: string
  toolName?: string
  state?: string
  input?: unknown
  output?: unknown
  errorText?: string
  originalType?: string
  malformed?: boolean
}

export type SafeFlueMessage = {
  id: string
  role: 'user' | 'assistant'
  parts: SafeFluePart[]
  timestamp?: string
  malformed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function primitiveText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return null
}

/**
 * JSON.stringify 会在循环引用、BigInt、异常 getter / Proxy 等输入上抛错。
 * Flue 工具输入和输出来自外部运行时，渲染前必须使用这个无异常版本。
 */
export function safeStringify(value: unknown, maxLength = 4000, space = 2): string {
  try {
    const seen = new WeakSet<object>()
    const result = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return `${item.toString()}n`
      if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`
      if (typeof item === 'symbol') return item.toString()
      if (item instanceof Error) {
        return { name: item.name, message: item.message, stack: item.stack }
      }
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
      }
      return item
    }, space)
    const text = result === undefined ? String(value ?? '') : result
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n…（内容已截断）` : text
  } catch (error) {
    const reason = error instanceof Error ? error.message : '无法序列化'
    return `[无法安全展示：${reason.slice(0, 160)}]`
  }
}

export function toSafeText(value: unknown, maxLength = 100_000): string {
  const primitive = primitiveText(value)
  if (primitive !== null) return primitive.slice(0, maxLength)
  if (value == null) return ''
  return safeStringify(value, maxLength)
}

function safeProperty(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key]
  } catch {
    return undefined
  }
}

export function normalizeFluePart(value: unknown, index = 0): SafeFluePart {
  if (!isRecord(value)) {
    return {
      type: 'unsupported',
      text: value == null ? '收到空消息片段' : `收到无法识别的消息片段：${toSafeText(value, 200)}`,
      malformed: true,
    }
  }

  const rawType = toSafeText(safeProperty(value, 'type'), 80)
  if (rawType === 'text' || rawType === 'reasoning') {
    return {
      type: rawType,
      text: toSafeText(safeProperty(value, 'text')),
      malformed: typeof safeProperty(value, 'text') !== 'string',
    }
  }

  if (rawType === 'file') {
    const rawUrl = safeProperty(value, 'url')
    const rawMediaType = safeProperty(value, 'mediaType')
    const rawFilename = safeProperty(value, 'filename')
    return {
      type: 'file',
      url: typeof rawUrl === 'string' ? rawUrl : '',
      mediaType: typeof rawMediaType === 'string' ? rawMediaType : '',
      filename: typeof rawFilename === 'string' && rawFilename.trim() ? rawFilename : `附件-${index + 1}`,
      malformed: (rawUrl != null && typeof rawUrl !== 'string') || (rawMediaType != null && typeof rawMediaType !== 'string'),
    }
  }

  if (rawType === 'dynamic-tool') {
    return {
      type: 'dynamic-tool',
      toolName: toSafeText(safeProperty(value, 'toolName'), 120) || 'unknown',
      state: toSafeText(safeProperty(value, 'state'), 80),
      input: safeProperty(value, 'input'),
      output: safeProperty(value, 'output'),
      errorText: toSafeText(safeProperty(value, 'errorText'), 4000),
    }
  }

  return {
    type: 'unsupported',
    originalType: rawType || 'unknown',
    text: `暂不支持的消息类型：${rawType || 'unknown'}`,
    malformed: true,
  }
}

export function normalizeFlueMessage(value: unknown, index = 0): SafeFlueMessage {
  if (!isRecord(value)) {
    return {
      id: `invalid-message-${index}`,
      role: 'assistant',
      parts: [normalizeFluePart(value)],
      malformed: true,
    }
  }

  const rawId = safeProperty(value, 'id')
  const rawRole = safeProperty(value, 'role')
  const rawParts = safeProperty(value, 'parts')
  const rawMetadata = safeProperty(value, 'metadata')
  const rawTimestamp = isRecord(rawMetadata)
    ? safeProperty(rawMetadata, 'timestamp')
    : undefined
  let parts: SafeFluePart[]
  let malformed = false

  if (Array.isArray(rawParts)) {
    parts = rawParts.map((part, partIndex) => normalizeFluePart(part, partIndex))
    malformed = parts.some((part) => part.malformed)
  } else {
    const legacyContent = safeProperty(value, 'content')
    if (legacyContent != null) {
      parts = [{ type: 'text', text: toSafeText(legacyContent), malformed: true }]
    } else {
      parts = [{ type: 'unsupported', text: '消息内容格式不完整', malformed: true }]
    }
    malformed = true
  }

  return {
    id: typeof rawId === 'string' && rawId ? rawId : `message-${index}`,
    role: rawRole === 'user' ? 'user' : 'assistant',
    parts,
    timestamp: typeof rawTimestamp === 'string' && rawTimestamp.trim()
      ? rawTimestamp
      : undefined,
    malformed: malformed || (rawRole !== 'user' && rawRole !== 'assistant'),
  }
}

export function normalizeFlueMessages(value: unknown): SafeFlueMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .map((message, index) => normalizeFlueMessage(message, index))
    // Flue 会为一次失败/重试的模型调用留下 assistant 消息边界；当模型在
    // 输出任何内容前超时时，这类消息没有可见 part。渲染它们只会产生一排
    // 不断增加的空机器人头像。用户消息仍保留，畸形 assistant 消息也会由
    // unsupported part 显示诊断提示，只有真正空白的 assistant 消息被隐藏。
    .filter((message) => message.role === 'user' || message.parts.some(isRenderableFluePart))
}

export function isRenderableFluePart(part: SafeFluePart): boolean {
  if (part.type === 'text' || part.type === 'reasoning') {
    return Boolean(part.text?.trim())
  }
  // 文件、工具和 unsupported 片段均有对应的可见 UI；即使附件 URL 缺失，
  // MessagePart 也会显示附件说明，不能误判为空消息。
  return part.type === 'file' || part.type === 'dynamic-tool' || part.type === 'unsupported'
}

export function extractTextParts(message: SafeFlueMessage | undefined): string {
  if (!message) return ''
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}
