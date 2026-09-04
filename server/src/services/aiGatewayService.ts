import { observeNonStreamingAiRuntimeRequest } from '../runtime/aiRuntimeTelemetry.js'
import {
  normalizeAiTaskModelUsage,
  recordAiTaskModelCall,
  type AiTaskModelUsage,
} from '../runtime/aiTaskModelUsage.js'

export type AiGatewayMessage = {
  role: 'system' | 'developer' | 'user' | 'assistant'
  content: string
}

type FetchLike = typeof fetch

export function aiGatewayResponseText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const response = payload as { output_text?: unknown; output?: unknown; choices?: unknown }
  if (typeof response.output_text === 'string') return response.output_text.trim()
  if (Array.isArray(response.output)) {
    const text = response.output.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const content = (item as { content?: unknown }).content
      if (!Array.isArray(content)) return []
      return content.flatMap((part) => {
        if (!part || typeof part !== 'object') return []
        const value = (part as { text?: unknown }).text
        return typeof value === 'string' ? [value] : []
      })
    }).join('')
    if (text.trim()) return text.trim()
  }
  if (!Array.isArray(response.choices)) return ''
  return response.choices.flatMap((choice) => {
    if (!choice || typeof choice !== 'object') return []
    const message = (choice as { message?: { content?: unknown; reasoning_content?: unknown } }).message
    const content = message?.content ?? message?.reasoning_content
    if (typeof content === 'string') return [content]
    if (!Array.isArray(content)) return []
    return content.flatMap((part) => (
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? [String((part as { text: string }).text)]
        : []
    ))
  }).join('').trim()
}

export function buildAiResponsesBody(input: {
  model: string
  messages: AiGatewayMessage[]
  maxTokens: number
  json?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high'
}) {
  return {
    model: input.model,
    input: input.messages.map((message) => ({
      role: message.role,
      content: [{ type: 'input_text', text: message.content }],
    })),
    max_output_tokens: input.maxTokens,
    ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
    ...(input.json ? { text: { format: { type: 'json_object' } } } : {}),
  }
}

export function buildAiChatFallbackBody(input: {
  model: string
  messages: AiGatewayMessage[]
  maxTokens: number
}) {
  return {
    model: input.model,
    messages: input.messages,
    max_tokens: input.maxTokens,
  }
}

export function shouldFallbackAiGatewayToChat(status: number) {
  return [400, 404, 405, 415, 422, 501].includes(status)
}

async function requestAiGatewayCompletion(input: {
  baseUrl: string
  apiKey?: string
  model: string
  messages: AiGatewayMessage[]
  maxTokens: number
  timeoutMs: number
  json?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high'
  fetchImpl?: FetchLike
}): Promise<{ text: string; usage: AiTaskModelUsage | null }> {
  return observeNonStreamingAiRuntimeRequest('gateway-text', async () => {
    const baseUrl = input.baseUrl.replace(/\/$/, '')
    const fetchImpl = input.fetchImpl ?? fetch
    const headers = {
      'Content-Type': 'application/json',
      ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
    }
    let response = await fetchImpl(`${baseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildAiResponsesBody(input)),
      signal: AbortSignal.timeout(input.timeoutMs),
    })
    if (!response.ok && shouldFallbackAiGatewayToChat(response.status)) {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildAiChatFallbackBody(input)),
        signal: AbortSignal.timeout(input.timeoutMs),
      })
    }
    const raw = await response.text()
    if (!response.ok) {
      const detail = raw.replace(/\s+/g, ' ').slice(0, 500)
      throw Object.assign(
        new Error(`LLM ${response.status}${detail ? `：${detail}` : ''}`),
        { status: response.status },
      )
    }
    let payload: unknown
    try { payload = JSON.parse(raw) } catch { throw new Error('LLM 网关返回了非 JSON 响应') }
    await recordAiTaskModelCall(payload)
    const text = aiGatewayResponseText(payload)
    if (!text) throw new Error('LLM 网关返回空内容')
    return { text, usage: normalizeAiTaskModelUsage(payload) }
  })
}

export async function requestAiGatewayText(input: {
  baseUrl: string
  apiKey?: string
  model: string
  messages: AiGatewayMessage[]
  maxTokens: number
  timeoutMs: number
  json?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high'
  fetchImpl?: FetchLike
}) {
  return (await requestAiGatewayCompletion(input)).text
}

export type AiGatewayWebSearchSource = { url: string; title: string }

function supportsWebSearchActionSourceInclude(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname.toLowerCase() !== 'getways-jumu.zeelin.cn'
  } catch {
    return true
  }
}

export async function requestAiGatewayWebSearchText(input: {
  baseUrl: string
  apiKey?: string
  model: string
  messages: AiGatewayMessage[]
  maxTokens: number
  maxToolCalls?: number
  timeoutMs: number
  fetchImpl?: FetchLike
}) {
  return observeNonStreamingAiRuntimeRequest('gateway-text', async () => {
    const fetchImpl = input.fetchImpl ?? fetch
    const baseUrl = input.baseUrl.replace(/\/$/, '')
    const response = await fetchImpl(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: input.model,
        input: input.messages.map((message) => ({
          role: message.role,
          content: [{ type: 'input_text', text: message.content }],
        })),
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        ...(supportsWebSearchActionSourceInclude(baseUrl)
          ? { include: ['web_search_call.action.sources'] }
          : {}),
        max_tool_calls: Math.max(1, Math.min(input.maxToolCalls || 4, 20)),
        max_output_tokens: input.maxTokens,
      }),
      signal: AbortSignal.timeout(input.timeoutMs),
    })
    const raw = await response.text()
    let payload: unknown
    try { payload = JSON.parse(raw) } catch { throw new Error('联网搜索网关返回了非 JSON 响应') }
    if (!response.ok) {
      const message = payload && typeof payload === 'object'
        ? String((payload as { error?: { message?: unknown } }).error?.message || '')
        : ''
      throw Object.assign(new Error(`联网搜索网关 ${response.status}${message ? `：${message.slice(0, 500)}` : ''}`), {
        status: response.status,
      })
    }
    await recordAiTaskModelCall(payload)
    const text = aiGatewayResponseText(payload)
    if (!text) throw new Error('联网搜索网关返回空内容')
    const output = payload && typeof payload === 'object' && Array.isArray((payload as { output?: unknown }).output)
      ? (payload as { output: unknown[] }).output
      : []
    const sources = new Map<string, AiGatewayWebSearchSource>()
    for (const item of output) {
      if (!item || typeof item !== 'object') continue
      const action = (item as { action?: { sources?: unknown } }).action
      if (Array.isArray(action?.sources)) {
        for (const source of action.sources) {
          if (!source || typeof source !== 'object') continue
          const url = String((source as { url?: unknown }).url || '').trim()
          if (!/^https?:\/\//i.test(url)) continue
          sources.set(url, { url, title: String((source as { title?: unknown }).title || '').trim() })
        }
      }
      const content = (item as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (!part || typeof part !== 'object') continue
        const annotations = (part as { annotations?: unknown }).annotations
        if (!Array.isArray(annotations)) continue
        for (const annotation of annotations) {
          if (!annotation || typeof annotation !== 'object') continue
          const source = annotation as { type?: unknown; url?: unknown; title?: unknown }
          if (source.type !== 'url_citation') continue
          const url = String(source.url || '').trim()
          if (!/^https?:\/\//i.test(url)) continue
          sources.set(url, { url, title: String(source.title || '').trim() })
        }
      }
    }
    return { text, sources: [...sources.values()], usage: normalizeAiTaskModelUsage(payload) }
  })
}

function chatCompatibleUsage(usage: AiTaskModelUsage | null) {
  if (!usage) return undefined
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadInputTokens },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    cache_creation_input_tokens: usage.cacheCreationInputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
  }
}

export async function fetchAiGatewayChatCompatible(
  baseUrl: string,
  options: RequestInit & { body: string },
  fetchImpl: FetchLike = fetch,
  timeoutMs = 120_000,
): Promise<Response> {
  const body = JSON.parse(options.body) as {
    model?: unknown
    messages?: Array<{ role?: unknown; content?: unknown }>
    max_tokens?: unknown
    response_format?: { type?: unknown }
    reasoning_effort?: unknown
  }
  const messages: AiGatewayMessage[] = (body.messages ?? []).map((message) => {
    if (
      !['system', 'developer', 'user', 'assistant'].includes(String(message.role))
      || typeof message.content !== 'string'
    ) {
      throw new Error('Responses 兼容层只接受文本消息')
    }
    return { role: String(message.role) as AiGatewayMessage['role'], content: message.content }
  })
  const headers = new Headers(options.headers)
  const authorization = headers.get('authorization') || ''
  const apiKey = authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined
  try {
    const completion = await requestAiGatewayCompletion({
      baseUrl,
      apiKey,
      model: String(body.model || ''),
      messages,
      maxTokens: Math.max(1, Number(body.max_tokens) || 4096),
      timeoutMs,
      json: body.response_format?.type === 'json_object',
      reasoningEffort: ['low', 'medium', 'high'].includes(String(body.reasoning_effort))
        ? String(body.reasoning_effort) as 'low' | 'medium' | 'high'
        : undefined,
      fetchImpl,
    })
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: completion.text } }],
      usage: chatCompatibleUsage(completion.usage),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    const status = Number((error as { status?: unknown } | null)?.status)
    if (!Number.isFinite(status)) throw error
    return new Response(JSON.stringify({ error: { message: (error as Error).message } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export async function requestAiGatewayVisionText(input: {
  baseUrl: string
  apiKey?: string
  model: string
  prompt: string
  imageDataUrls: string[]
  maxTokens: number
  timeoutMs: number
  fetchImpl?: FetchLike
}) {
  return observeNonStreamingAiRuntimeRequest('gateway-vision', async () => {
    const baseUrl = input.baseUrl.replace(/\/$/, '')
    const fetchImpl = input.fetchImpl ?? fetch
    const headers = {
      'Content-Type': 'application/json',
      ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
    }
    let response = await fetchImpl(`${baseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: input.model,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: input.prompt },
            ...input.imageDataUrls.map((imageUrl) => ({ type: 'input_image', image_url: imageUrl })),
          ],
        }],
        max_output_tokens: input.maxTokens,
      }),
      signal: AbortSignal.timeout(input.timeoutMs),
    })
    if (!response.ok && shouldFallbackAiGatewayToChat(response.status)) {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: input.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: input.prompt },
              ...input.imageDataUrls.map((imageUrl) => ({ type: 'image_url', image_url: { url: imageUrl } })),
            ],
          }],
          max_tokens: input.maxTokens,
        }),
        signal: AbortSignal.timeout(input.timeoutMs),
      })
    }
    const raw = await response.text()
    if (!response.ok) throw Object.assign(new Error(`视觉网关 ${response.status}`), { status: response.status })
    const payload = JSON.parse(raw) as unknown
    await recordAiTaskModelCall(payload)
    const text = aiGatewayResponseText(payload)
    if (!text) throw new Error('视觉网关返回空内容')
    return text
  })
}
