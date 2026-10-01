import { readProjectFileBuffer } from './projectFileStorageService.js'

export type AsrCapability = {
  configured: boolean
  provider: string | null
  model: string | null
}

export function getDueDiligenceAsrCapability(env: NodeJS.ProcessEnv = process.env): AsrCapability {
  const baseUrl = env.ASR_BASE_URL?.trim()
  const apiKey = env.ASR_API_KEY?.trim()
  const model = env.ASR_MODEL?.trim()
  let provider: string | null = null
  try { provider = baseUrl ? new URL(baseUrl).hostname : null } catch { provider = null }
  return {
    configured: Boolean(baseUrl && provider && apiKey && model),
    provider,
    model: model || null,
  }
}

export async function transcribeDueDiligenceRecording(input: {
  storagePath: string
  fileName: string
  mimeType: string
  env?: NodeJS.ProcessEnv
}) {
  const buffer = await readProjectFileBuffer(input.storagePath)
  return transcribeDueDiligenceBuffer({ buffer, fileName: input.fileName, mimeType: input.mimeType, env: input.env })
}

export async function transcribeDueDiligenceBuffer(input: {
  buffer: Buffer
  fileName: string
  mimeType: string
  env?: NodeJS.ProcessEnv
}) {
  const env = input.env ?? process.env
  const capability = getDueDiligenceAsrCapability(env)
  if (!capability.configured) {
    throw Object.assign(new Error('未配置后台转写服务'), { status: 503, code: 'ASR_NOT_CONFIGURED' })
  }
  const form = new FormData()
  form.append('model', env.ASR_MODEL!)
  form.append('language', 'zh')
  form.append('response_format', 'json')
  form.append('file', new File([input.buffer], input.fileName, { type: input.mimeType || 'application/octet-stream' }))
  const url = `${env.ASR_BASE_URL!.replace(/\/$/, '')}/audio/transcriptions`
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.ASR_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(Math.min(600_000, Math.max(30_000, Number(env.ASR_TIMEOUT_MS) || 180_000))),
  })
  if (!response.ok) throw Object.assign(new Error(`后台转写失败（HTTP ${response.status}）`), { status: 502, code: 'ASR_HTTP_ERROR' })
  const payload = await response.json() as { text?: string }
  const text = payload.text?.trim()
  if (!text) throw Object.assign(new Error('后台转写未返回文字'), { status: 502, code: 'ASR_EMPTY_RESPONSE' })
  return { text, provider: capability.provider || 'openai-compatible', model: capability.model! }
}
