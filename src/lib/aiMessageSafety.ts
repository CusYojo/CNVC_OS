export type SafeAgentPart = {
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

export type SafeAgentMessage = {
  id: string
  role: 'user' | 'assistant'
  parts: SafeAgentPart[]
  timestamp?: string
  malformed: boolean
}

const FORMAL_AI_TASK_CONTROL_TOOL_SUFFIXES = [
  'create_ai_task',
  'get_ai_task_status',
] as const

export function isFormalAiTaskControlPart(part: SafeAgentPart): boolean {
  if (part.type !== 'dynamic-tool') return false
  const toolName = (part.toolName ?? '').trim().toLowerCase()
  return FORMAL_AI_TASK_CONTROL_TOOL_SUFFIXES.some((suffix) => (
    toolName === suffix || toolName.endsWith(`__${suffix}`)
  ))
}

export function isFormalAiTaskReceiptMessage(
  message: SafeAgentMessage,
  taskIds: Iterable<string> = [],
): boolean {
  if (message.role !== 'assistant') return false

  const text = extractTextParts(message).replace(/\s+/g, ' ').trim()
  if (!text) {
    return message.parts.length > 0 && message.parts.every(isFormalAiTaskControlPart)
  }

  // 正式任务已有独立的对话进度消息。Agent 在工具调用前后生成的“任务已创建”
  // 和“正在查询状态”属于重复的编排回执，不再展示任务 ID、固定百分比或内部策略。
  const createdPhrase = '(?:已(?:经)?(?:成功)?创建|创建成功)'
  const creationReceipt = (
    new RegExp(`${createdPhrase}[^。！？\\n]{0,48}(?:正式[^。！？\\n]{0,24})?任务`).test(text)
    || new RegExp(`(?:正式)?[^。！？\\n]{0,48}任务${createdPhrase}`).test(text)
  )
  if (creationReceipt) return true

  const mentionsKnownTask = Array.from(taskIds).some((taskId) => taskId && text.includes(taskId))
  return mentionsKnownTask && /(?:当前进度|执行阶段|任务状态|产物状态|补充资料请求)/.test(text)
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
 * Agent 工具输入和输出来自模型运行时，渲染前必须使用这个无异常版本。
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

export function normalizeAgentPart(value: unknown, index = 0): SafeAgentPart {
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

export function normalizeAgentMessage(value: unknown, index = 0): SafeAgentMessage {
  if (!isRecord(value)) {
    return {
      id: `invalid-message-${index}`,
      role: 'assistant',
      parts: [normalizeAgentPart(value)],
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
  let parts: SafeAgentPart[]
  let malformed = false

  if (Array.isArray(rawParts)) {
    parts = rawParts.map((part, partIndex) => normalizeAgentPart(part, partIndex))
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

export function normalizeAgentMessages(value: unknown): SafeAgentMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .map((message, index) => normalizeAgentMessage(message, index))
    // Agent 运行时会为一次失败/重试的模型调用留下 assistant 消息边界；当模型在
    // 输出任何内容前超时时，这类消息没有可见 part。渲染它们只会产生一排
    // 不断增加的空机器人头像。用户消息仍保留，畸形 assistant 消息也会由
    // unsupported part 显示诊断提示，只有真正空白的 assistant 消息被隐藏。
    .filter((message) => message.role === 'user' || message.parts.some(isRenderableAgentPart))
}

export function isRenderableAgentPart(part: SafeAgentPart): boolean {
  if (part.type === 'text' || part.type === 'reasoning') {
    return Boolean(part.text?.trim())
  }
  // 文件、工具和 unsupported 片段均有对应的可见 UI；即使附件 URL 缺失，
  // MessagePart 也会显示附件说明，不能误判为空消息。
  return part.type === 'file' || part.type === 'dynamic-tool' || part.type === 'unsupported'
}

export function extractTextParts(message: SafeAgentMessage | undefined): string {
  if (!message) return ''
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}
