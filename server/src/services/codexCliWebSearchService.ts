import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

type CodexWebSource = { url: string; title: string }

type CodexWebSearchEnvelope = {
  payload: unknown
  sources: CodexWebSource[]
}

export type CodexCliTopicWebSearchResult = {
  topicKey: string
  text: string
  sources: CodexWebSource[]
  usage: ReturnType<typeof usageFromJsonLines>
}

const CODEX_FACT_VALUE_SCHEMA = {
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'array', items: { type: 'string' } },
  ],
} as const

const CODEX_WEB_SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['payload', 'sources'],
  properties: {
    payload: {
      type: 'object',
      additionalProperties: false,
      required: ['facts', 'gaps', 'conflicts'],
      properties: {
        facts: {
          type: 'array',
          maxItems: 30,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['factKey', 'instanceKey', 'value', 'quote', 'sourceUrls', 'period', 'unit', 'currency', 'scope'],
            properties: {
              factKey: { type: 'string', minLength: 1, maxLength: 128 },
              instanceKey: { anyOf: [{ type: 'string', maxLength: 128 }, { type: 'null' }] },
              value: CODEX_FACT_VALUE_SCHEMA,
              quote: { type: 'string', minLength: 1, maxLength: 2_000 },
              sourceUrls: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', maxLength: 4_000 } },
              period: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }] },
              unit: { anyOf: [{ type: 'string', maxLength: 32 }, { type: 'null' }] },
              currency: { anyOf: [{ type: 'string', maxLength: 16 }, { type: 'null' }] },
              scope: { anyOf: [{ type: 'string', maxLength: 256 }, { type: 'null' }] },
            },
          },
        },
        gaps: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 1_000 } },
        conflicts: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['factKey', 'instanceKey', 'candidates', 'reason'],
            properties: {
              factKey: { type: 'string', minLength: 1, maxLength: 128 },
              instanceKey: { anyOf: [{ type: 'string', maxLength: 128 }, { type: 'null' }] },
              candidates: {
                type: 'array',
                minItems: 2,
                maxItems: 10,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['value', 'quote', 'sourceUrls', 'period', 'unit', 'currency', 'scope'],
                  properties: {
                    value: CODEX_FACT_VALUE_SCHEMA,
                    quote: { type: 'string', minLength: 1, maxLength: 2_000 },
                    sourceUrls: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', maxLength: 4_000 } },
                    period: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }] },
                    unit: { anyOf: [{ type: 'string', maxLength: 32 }, { type: 'null' }] },
                    currency: { anyOf: [{ type: 'string', maxLength: 16 }, { type: 'null' }] },
                    scope: { anyOf: [{ type: 'string', maxLength: 256 }, { type: 'null' }] },
                  },
                },
              },
              reason: { type: 'string', minLength: 1, maxLength: 2_000 },
            },
          },
        },
      },
    },
    sources: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'title'],
        properties: { url: { type: 'string' }, title: { type: 'string' } },
      },
    },
  },
} as const

function usageFromJsonLines(stdout: string) {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadInputTokens = 0
  let reasoningTokens = 0
  for (const line of stdout.split('\n')) {
    let value: unknown
    try { value = JSON.parse(line) } catch { continue }
    const stack: unknown[] = [value]
    while (stack.length) {
      const current = stack.pop()
      if (!current || typeof current !== 'object') continue
      const data = current as Record<string, unknown>
      const usage = data.usage && typeof data.usage === 'object' ? data.usage as Record<string, unknown> : null
      if (usage) {
        inputTokens = Math.max(inputTokens, Number(usage.input_tokens ?? usage.inputTokens) || 0)
        outputTokens = Math.max(outputTokens, Number(usage.output_tokens ?? usage.outputTokens) || 0)
        cacheReadInputTokens = Math.max(
          cacheReadInputTokens,
          Number(usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cacheReadInputTokens) || 0,
        )
        reasoningTokens = Math.max(reasoningTokens, Number(usage.reasoning_tokens ?? usage.reasoningTokens) || 0)
      }
      stack.push(...Object.values(data))
    }
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    reasoningTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens,
  }
}

function normalizeEnvelope(value: unknown): CodexWebSearchEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex CLI 未返回对象')
  const envelope = value as Record<string, unknown>
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    throw new Error('Codex CLI 未返回专题研究 payload')
  }
  const sources = Array.isArray(envelope.sources) ? envelope.sources.flatMap((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return []
    const data = source as Record<string, unknown>
    const url = String(data.url || '').trim()
    if (!/^https?:\/\//i.test(url)) return []
    return [{ url, title: String(data.title || '').trim() }]
  }) : []
  const payload = structuredClone(envelope.payload) as Record<string, unknown>
  const stripNullOptionals = (item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return
    const data = item as Record<string, unknown>
    for (const key of ['instanceKey', 'period', 'unit', 'currency', 'scope']) {
      if (data[key] === null) delete data[key]
    }
  }
  if (Array.isArray(payload.facts)) payload.facts.forEach(stripNullOptionals)
  if (Array.isArray(payload.conflicts)) payload.conflicts.forEach((conflict) => {
    stripNullOptionals(conflict)
    if (conflict && typeof conflict === 'object' && !Array.isArray(conflict)) {
      const candidates = (conflict as Record<string, unknown>).candidates
      if (Array.isArray(candidates)) candidates.forEach(stripNullOptionals)
    }
  })
  return { payload, sources: [...new Map(sources.map((source) => [source.url, source])).values()] }
}

export async function requestCodexCliWebSearchText(input: {
  prompt: string
  model: string
  timeoutMs: number
}) {
  const workDir = await mkdtemp(path.join(tmpdir(), 'sbl-codex-web-search-'))
  const schemaPath = path.join(workDir, 'output-schema.json')
  const outputPath = path.join(workDir, 'output.json')
  await writeFile(schemaPath, `${JSON.stringify(CODEX_WEB_SEARCH_SCHEMA)}\n`, { mode: 0o600 })
  const codexBin = process.env.CODEX_BIN?.trim() || 'codex'
  let timeout: NodeJS.Timeout | undefined
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(codexBin, [
        '--search', 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
        '--json', '-m', input.model, '-s', 'read-only', '-C', workDir,
        '--output-schema', schemaPath, '--output-last-message', outputPath, '-',
      ], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000_000) })
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-100_000) })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
      timeout = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
      }, Math.max(30_000, input.timeoutMs))
      child.stdin.end([
        input.prompt,
        '你正在通过 Codex 原生联网搜索执行。最终必须返回宿主 schema 规定的对象：payload 为上述 facts/gaps/conflicts，sources 列出本轮实际查阅且被 payload 引用的直接 HTTP(S) URL 与标题。',
        '所有可选字符串字段仍必须输出；没有值时使用 null。不要输出解释或 Markdown。',
      ].join('\n'))
    })
    let envelope: CodexWebSearchEnvelope | undefined
    try {
      envelope = normalizeEnvelope(JSON.parse(await readFile(outputPath, 'utf8')))
    } catch {
      envelope = undefined
    }
    if (result.code !== 0 && !envelope) {
      throw new Error(
        `Codex CLI 退出码 ${result.code}; stdout=${result.stdout.slice(-4_000)}; stderr=${result.stderr.slice(-2_000)}`,
      )
    }
    if (!envelope) throw new Error('Codex CLI 未生成可校验的输出文件')
    return {
      text: JSON.stringify(envelope.payload),
      sources: envelope.sources,
      usage: usageFromJsonLines(result.stdout),
        budgetMultiplier: 2,
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    await rm(workDir, { recursive: true, force: true })
  }
}

export async function requestCodexCliMultiTopicWebSearchText(input: {
  prompt: string
  model: string
  timeoutMs: number
  topicKeys: string[]
}): Promise<CodexCliTopicWebSearchResult[]> {
  const topicKeys = [...new Set(input.topicKeys.map((value) => value.trim()).filter(Boolean))]
  if (!topicKeys.length) throw new Error('Codex CLI 批量研究缺少专题')
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        minItems: topicKeys.length,
        maxItems: topicKeys.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['topicKey', 'payload', 'sources'],
          properties: {
            topicKey: { type: 'string', enum: topicKeys },
            payload: CODEX_WEB_SEARCH_SCHEMA.properties.payload,
            sources: CODEX_WEB_SEARCH_SCHEMA.properties.sources,
          },
        },
      },
    },
  } as const
  const workDir = await mkdtemp(path.join(tmpdir(), 'sbl-codex-multi-web-search-'))
  const schemaPath = path.join(workDir, 'output-schema.json')
  const outputPath = path.join(workDir, 'output.json')
  await writeFile(schemaPath, `${JSON.stringify(schema)}\n`, { mode: 0o600 })
  const codexBin = process.env.CODEX_BIN?.trim() || 'codex'
  let timeout: NodeJS.Timeout | undefined
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(codexBin, [
        '--search', 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
        '--json', '-m', input.model, '-s', 'read-only', '-C', workDir,
        '--output-schema', schemaPath, '--output-last-message', outputPath, '-',
      ], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000_000) })
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-100_000) })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
      timeout = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
      }, Math.max(60_000, input.timeoutMs))
      child.stdin.end([
        input.prompt,
        `你正在通过 Codex 原生联网搜索执行。最终必须为 ${topicKeys.join(', ')} 各返回且仅返回一个 results 项。`,
        '每个 results.payload 独立包含该专题的 facts/gaps/conflicts；每个 results.sources 只列出该专题实际引用的直接 HTTP(S) URL 与标题。',
        '所有可选字符串字段仍必须输出；没有值时使用 null。不要输出解释或 Markdown。',
      ].join('\n'))
    })
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(outputPath, 'utf8')) } catch { parsed = undefined }
    const rows = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && Array.isArray((parsed as Record<string, unknown>).results)
      ? (parsed as { results: unknown[] }).results
      : []
    const normalized = new Map<string, CodexWebSearchEnvelope>()
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue
      const data = row as Record<string, unknown>
      const topicKey = String(data.topicKey || '').trim()
      if (!topicKeys.includes(topicKey) || normalized.has(topicKey)) continue
      normalized.set(topicKey, normalizeEnvelope({ payload: data.payload, sources: data.sources }))
    }
    if (normalized.size !== topicKeys.length) {
      throw new Error(
        `Codex CLI 批量研究退出码 ${result.code}，返回 ${normalized.size}/${topicKeys.length} 个专题; `
        + `stdout=${result.stdout.slice(-4_000)}; stderr=${result.stderr.slice(-2_000)}`,
      )
    }
    const usage = usageFromJsonLines(result.stdout)
    return topicKeys.map((topicKey, index) => {
      const envelope = normalized.get(topicKey)!
      return {
        topicKey,
        text: JSON.stringify(envelope.payload),
        sources: envelope.sources,
        budgetMultiplier: index === 0 ? topicKeys.length : 1,
        usage: index === 0 ? usage : {
          inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0,
          cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
        },
      }
    })
  } finally {
    if (timeout) clearTimeout(timeout)
    await rm(workDir, { recursive: true, force: true })
  }
}
